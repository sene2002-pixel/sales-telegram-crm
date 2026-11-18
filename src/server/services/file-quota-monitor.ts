import type { BigIntStatsFs } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../config';
import type { Sql } from '../infra/database';
import { availableFileBytes, fileUsageRows } from './file-storage';

type Scope = 'system' | 'user' | 'company';
type Totals = { files: string; bytes: string };

// A fresh installation may not have received a file yet. The nearest existing parent is its volume.
async function storageDisk(folder: string): Promise<BigIntStatsFs> {
  for (let path = folder; ; path = dirname(path)) {
    try {
      return await statfs(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    }
  }
}

export async function fileQuotaStatus(db: Sql, config: Config) {
  const limits = config.fileQuotas;
  if (!limits.enabled) return undefined;
  // A single statement observes the same snapshot for pending and published items. Only maxima
  // leave the database; the highest count and highest byte usage may belong to different groups.
  const rows = await db.query<{
    scope: Scope;
    files: string;
    bytes: string;
    pending_files: string;
    pending_nonempty: string;
    pending_bytes: string;
  }>(`WITH usage AS (${fileUsageRows}), counted AS (
    SELECT CASE WHEN GROUPING(author_id)=0 THEN 'user' WHEN GROUPING(company_id)=0 THEN 'company' ELSE 'system' END AS scope,
    count(*) AS files, coalesce(sum(bytes),0) AS bytes, count(*) FILTER (WHERE pending) AS pending_files,
    count(*) FILTER (WHERE pending AND bytes>0) AS pending_nonempty, coalesce(sum(bytes) FILTER (WHERE pending),0) AS pending_bytes
    FROM usage GROUP BY GROUPING SETS ((), (author_id), (company_id)))
    SELECT scope, max(files)::text AS files, max(bytes)::text AS bytes, max(pending_files)::text AS pending_files,
    max(pending_nonempty)::text AS pending_nonempty, max(pending_bytes)::text AS pending_bytes FROM counted GROUP BY scope`);
  const totals = (scope: Scope): Totals => {
    const row = rows.find((r) => r.scope === scope);
    return { files: row?.files ?? '0', bytes: row?.bytes ?? '0' };
  };
  const system = rows.find((r) => r.scope === 'system')!;
  const disk = await storageDisk(join(config.dataDir, 'files'));
  const free = availableFileBytes(disk, system.pending_bytes, system.pending_nonempty);
  const warnings: string[] = [];
  const threshold = BigInt(limits.warningPercent);
  for (const scope of ['system', 'user', 'company'] as const) {
    const used = totals(scope);
    if (BigInt(used.files) * 100n >= BigInt(limits[`${scope}Files`]) * threshold)
      warnings.push(scope + '.files');
    if (BigInt(used.bytes) * 100n >= BigInt(limits[`${scope}Bytes`]) * threshold)
      warnings.push(scope + '.bytes');
  }
  if (BigInt(limits.minFreeBytes) * 100n >= free * threshold) warnings.push('disk.free');
  return {
    event: 'file_quota.status',
    status: warnings.length ? 'warning' : 'ok',
    thresholdPercent: limits.warningPercent,
    system: totals('system'),
    userPeak: totals('user'),
    companyPeak: totals('company'),
    reserved: { files: system.pending_files, bytes: system.pending_bytes },
    availableBytes: String(free > 0n ? free : 0n),
    warnings,
  };
}

export function startFileQuotaMonitor(db: Sql, config: Config) {
  if (!config.fileQuotas.enabled) return async () => {};
  let active: Promise<void> | undefined;
  const poll = () => {
    if (active) return;
    active = fileQuotaStatus(db, config)
      .then((sample) => {
        if (!sample) return;
        const line = JSON.stringify(sample);
        if (sample.warnings.length) console.warn(line);
        else console.info(line);
      })
      .catch(() => {
        console.warn(JSON.stringify({ event: 'file_quota.status', status: 'unavailable' }));
      })
      .finally(() => {
        active = undefined;
      });
  };
  poll();
  const timer = setInterval(poll, 5 * 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await active;
  };
}
