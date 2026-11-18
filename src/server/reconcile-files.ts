import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { makeConfig } from './config';
import { Database, Sql } from './infra/database';

const blobKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Finding = {
  key: string;
  state:
    | 'reservation-only'
    | 'unpublished'
    | 'missing-blob'
    | 'size-mismatch'
    | 'published-reservation'
    | 'special-entry';
  reservedAt?: string;
};

function repairable(finding: Finding) {
  return finding.state === 'reservation-only' || finding.state === 'unpublished';
}

async function inspect(tx: Sql, folder: string) {
  const records = await tx.query<{ key: string; size: string }>(
    "SELECT data->>'key' AS key, data->>'size' AS size FROM records WHERE kind='file'",
  );
  const reservations = await tx.query<{ key: string; created_at: Date }>(
    'SELECT key, created_at FROM file_storage_reservations',
  );
  const entries = await readdir(folder, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );

  const published = new Map(records.map((row) => [row.key, row.size]));
  const reserved = new Map(
    reservations.map((row) => [row.key, new Date(row.created_at).toISOString()]),
  );
  const paths = new Set(entries.map((entry) => entry.name));
  const keys = new Set([...published.keys(), ...reserved.keys(), ...paths]);
  const findings: Finding[] = [];
  let unrecognized = 0;
  for (const key of [...keys].sort()) {
    if (!blobKey.test(key)) {
      unrecognized++;
      continue;
    }
    const file = paths.has(key) ? await lstat(join(folder, key)) : null;
    const size = published.get(key);
    const reservedAt = reserved.get(key);
    let state: Finding['state'] | undefined;
    if (file && (!file.isFile() || file.nlink !== 1)) state = 'special-entry';
    else if (published.has(key)) {
      if (!file) state = 'missing-blob';
      else if (String(file.size) !== size) state = 'size-mismatch';
      else if (reservedAt) state = 'published-reservation';
    } else state = file ? 'unpublished' : 'reservation-only';
    if (state) findings.push({ key, state, ...(reservedAt ? { reservedAt } : {}) });
  }
  return { published: records.length, reservations: reservations.length, unrecognized, findings };
}

export async function reconcileCompanyFiles(
  db: Database,
  dataDir: string,
  confirmedKeys: string[] = [],
) {
  const folder = join(dataDir, 'files');
  if (!confirmedKeys.length) return { ...(await inspect(db, folder)), applied: [] };
  if (
    !confirmedKeys.every((key) => blobKey.test(key)) ||
    new Set(confirmedKeys).size !== confirmedKeys.length
  )
    throw new Error('Для применения нужны уникальные UUID из отчёта');

  // Offline only. Exclude newly admitted or published files while rechecking the confirmed keys.
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7142573)');
    await tx.query('SELECT pg_advisory_xact_lock(7142532)');
    if (!(await lstat(folder)).isDirectory())
      throw new Error('Для применения требуется обычный каталог DATA_DIR/files');
    const report = await inspect(tx, folder);
    const candidates = new Map(report.findings.filter(repairable).map((row) => [row.key, row]));
    for (const key of confirmedKeys)
      if (!candidates.has(key)) throw new Error(`Ключ ${key} не подлежит автоматической коррекции`);
    for (const key of confirmedKeys) {
      if (candidates.get(key)!.state === 'unpublished') await unlink(join(folder, key));
      await tx.query('DELETE FROM file_storage_reservations WHERE key=$1', [key]);
    }
    return { ...report, applied: confirmedKeys };
  });
}

export function parseFileRepairArgs(args: string[]) {
  if (!args.length) return [];
  if (
    args[0] !== '--apply' ||
    args[1] !== '--writers-stopped' ||
    args.length < 3 ||
    !args.slice(2).every((key) => blobKey.test(key))
  )
    throw new Error(
      'Запустите без аргументов для отчёта или с --apply --writers-stopped UUID [UUID ...]',
    );
  return args.slice(2);
}

async function main() {
  const keys = parseFileRepairArgs(process.argv.slice(2));
  const config = makeConfig();
  if (
    !config.databaseUrl &&
    !(await lstat(join(config.dataDir, 'postgres', 'PG_VERSION'))).isFile()
  )
    throw new Error('Локальная база данных не найдена');
  const db = new Database(config);
  try {
    await db.init({ migrate: false });
    console.log(JSON.stringify(await reconcileCompanyFiles(db, config.dataDir, keys), null, 2));
  } finally {
    await db.close();
  }
}
if (require.main === module)
  main().catch((error) => {
    // Avoid printing driver errors which may include connection credentials.
    const message = String(error.message);
    console.error(
      /^(Запустите|Для применения|Ключ |Локальная база)/.test(message)
        ? message
        : 'Не удалось сверить хранилище. Проверьте доступ, миграции и путь DATA_DIR.',
    );
    process.exitCode = 1;
  });
