import { randomUUID } from 'node:crypto';
import { mkdir, open, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CrmRecord } from '../../shared/contracts';
import { Config } from '../config';
import { DomainError, requireCondition } from '../domain/errors';
import { Database, Sql } from '../infra/database';

type FileOwner = { companyId: string; authorId: string };

// Publication replaces the reservation in one transaction. Both readers use the same union.
export const fileUsageRows = `SELECT company_id, author_id, (data->>'size')::bigint AS bytes, false AS pending
        FROM records WHERE kind='file'
      UNION ALL SELECT company_id, author_id, bytes, true FROM file_storage_reservations`;

export function availableFileBytes(
  disk: { bavail: bigint; bsize: bigint },
  pendingBytes: string,
  pendingNonempty: string,
) {
  return (
    disk.bavail * disk.bsize - BigInt(pendingBytes) - BigInt(pendingNonempty) * (disk.bsize - 1n)
  );
}

async function reserveFile(
  tx: Sql,
  limits: Config['fileQuotas'],
  owner: FileOwner,
  folder: string,
  key: string,
  bytes: number,
) {
  // All application instances serialize admission only. Neither file writes nor fsync hold this lock.
  await tx.query('SELECT pg_advisory_xact_lock(7142573)');
  const [usage] = await tx.query(
    `WITH usage AS (${fileUsageRows})
     SELECT count(*) AS system_count, COALESCE(sum(bytes),0) AS system_bytes,
      count(*) FILTER (WHERE company_id=$1) AS company_count,
      COALESCE(sum(bytes) FILTER (WHERE company_id=$1),0) AS company_bytes,
      count(*) FILTER (WHERE author_id=$2) AS user_count,
      COALESCE(sum(bytes) FILTER (WHERE author_id=$2),0) AS user_bytes,
      COALESCE(sum(bytes) FILTER (WHERE pending),0) AS pending_bytes,
      count(*) FILTER (WHERE pending AND bytes > 0) AS pending_files
     FROM usage`,
    [owner.companyId, owner.authorId],
  );
  for (const [count, size, maxCount, maxBytes, scope] of [
    [usage.user_count, usage.user_bytes, limits.userFiles, limits.userBytes, 'сотрудника'],
    [
      usage.company_count,
      usage.company_bytes,
      limits.companyFiles,
      limits.companyBytes,
      'компании',
    ],
    [usage.system_count, usage.system_bytes, limits.systemFiles, limits.systemBytes, 'системы'],
  ] as const)
    requireCondition(
      BigInt(count) < BigInt(maxCount) && BigInt(size) + BigInt(bytes) <= BigInt(maxBytes),
      507,
      `Достигнут лимит хранения файлов ${scope}`,
    );
  const disk = await statfs(folder, { bigint: true });
  const blocks = (BigInt(bytes) + disk.bsize - 1n) / disk.bsize;
  // Concurrent blobs may already be partly written; reserve their full size plus block rounding.
  const available = availableFileBytes(disk, usage.pending_bytes, usage.pending_files);
  requireCondition(
    available - blocks * disk.bsize >= BigInt(limits.minFreeBytes),
    507,
    'Недостаточно свободного места для сохранения файла',
  );
  await tx.query(
    'INSERT INTO file_storage_reservations(key,author_id,company_id,bytes) VALUES($1,$2,$3,$4)',
    [key, owner.authorId, owner.companyId, bytes],
  );
}

export async function storeCompanyFile(
  db: Database,
  config: Config,
  owner: FileOwner,
  content: Buffer,
  register: (tx: Sql, key: string) => Promise<CrmRecord>,
) {
  const folder = join(config.dataDir, 'files');
  const key = randomUUID();
  const path = join(folder, key);
  const limits = config.fileQuotas;
  const enforce = limits.enabled;
  let created = false;
  let registered: CrmRecord | undefined;
  let reserved = false;
  try {
    await mkdir(folder, { recursive: true });
    if (enforce)
      await db.transaction(async (tx) => {
        await reserveFile(tx, limits, owner, folder, key, content.length);
        reserved = true;
      });

    // Only a committed CRM record makes this private random filename downloadable.
    const file = await open(path, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }

    return await db.transaction(async (tx) => {
      // Follow the hierarchy lock order shared by CRM authorization, links and letter metadata.
      await tx.query('SELECT pg_advisory_xact_lock(7142532)');
      registered = await register(tx, key);
      if (reserved) {
        const released = await tx.query(
          'DELETE FROM file_storage_reservations WHERE key=$1 RETURNING key',
          [key],
        );
        requireCondition(released.length, 409, 'Резерв файла изменился. Повторите сохранение');
      }
      return registered;
    });
  } catch (error) {
    if (registered) {
      const record = registered;
      // Wait out an ambiguous COMMIT before deleting a blob that might already be published.
      const committed = await db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(7142532)');
        return (await tx.query('SELECT id FROM records WHERE id=$1', [record.id])).length > 0;
      });
      if (committed) return record;
    }
    if (created) await unlink(path);
    if (reserved)
      await db.transaction(async (tx) => {
        // The initial reservation can also lose its COMMIT reply.
        await tx.query('SELECT pg_advisory_xact_lock(7142573)');
        await tx.query('DELETE FROM file_storage_reservations WHERE key=$1', [key]);
      });
    if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC')
      throw new DomainError(507, 'Недостаточно свободного места для сохранения файла');
    throw error;
  }
}
