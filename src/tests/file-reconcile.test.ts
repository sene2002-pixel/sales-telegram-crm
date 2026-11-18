import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeConfig } from '../server/config';
import { createApp } from '../server/http/app';
import { parseFileRepairArgs, reconcileCompanyFiles } from '../server/reconcile-files';

test('offline file reconciliation requires confirmed keys and protects published and archived bytes', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'crm-offline-files-'));
  const { app, db, services } = await createApp(
    makeConfig({ DATA_DIR: dataDir, DEV_AUTH: 'true' }),
  );
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const manager = (await services.auth.dev('manager', '127.0.0.1')).user;
  const client = await services.crm.create(manager, { name: 'Сверка файлов' });
  const folder = join(dataDir, 'files');
  await mkdir(folder);
  const keys = {
    archive: randomUUID(),
    missing: randomUUID(),
    short: randomUUID(),
    reserved: randomUUID(),
    orphan: randomUUID(),
    empty: randomUUID(),
    special: randomUUID(),
  };
  for (const key of [keys.archive, keys.missing, keys.short]) {
    const record = await services.crm.createRecord(manager, client.id, 'file', {
      key,
      size: 4,
      name: 'sample.bin',
      category: 'docs',
    });
    if (key === keys.archive) await services.crm.deleteFile(manager, record.id);
  }
  for (const key of [keys.reserved, keys.empty])
    await db.query(
      'INSERT INTO file_storage_reservations(key,company_id,author_id,bytes) VALUES($1,$2,$3,4)',
      [key, client.id, manager.id],
    );
  for (const key of [keys.archive, keys.short, keys.reserved, keys.orphan])
    await writeFile(join(folder, key), key === keys.short ? 'x' : 'data');
  await mkdir(join(folder, keys.special));
  await writeFile(join(folder, 'legacy-backup-name'), 'keep');
  assert.deepEqual(parseFileRepairArgs([]), []);
  assert.throws(() => parseFileRepairArgs(['--apply', keys.orphan]), /останов|stopped/);
  assert.throws(() => parseFileRepairArgs(['--apply', '--writers-stopped', '../x']), /UUID/);
  const before = await readdir(folder);
  const report = await reconcileCompanyFiles(db, dataDir);
  const byKey = Object.fromEntries(report.findings.map((row) => [row.key, row.state]));
  assert.deepEqual(byKey, {
    [keys.missing]: 'missing-blob',
    [keys.short]: 'size-mismatch',
    [keys.reserved]: 'unpublished',
    [keys.orphan]: 'unpublished',
    [keys.empty]: 'reservation-only',
    [keys.special]: 'special-entry',
  });
  assert.equal(report.unrecognized, 1);
  assert.deepEqual(report.applied, []);
  for (const protectedKey of [keys.archive, keys.missing, keys.short, keys.special])
    await assert.rejects(
      reconcileCompanyFiles(db, dataDir, [keys.orphan, protectedKey]),
      /не подлежит/,
    );
  assert.deepEqual(await readdir(folder), before);
  assert.equal((await db.query('SELECT key FROM file_storage_reservations')).length, 2);
  const approved = parseFileRepairArgs(['--apply', '--writers-stopped', keys.reserved, keys.empty]);
  const result = await reconcileCompanyFiles(db, dataDir, approved);
  assert.deepEqual(result.applied, approved);
  assert.deepEqual(await db.query('SELECT key FROM file_storage_reservations'), []);
  assert.equal((await readFile(join(folder, keys.archive))).toString(), 'data');
  assert.equal((await readFile(join(folder, keys.orphan))).toString(), 'data');
  const after = await reconcileCompanyFiles(db, dataDir);
  assert.equal(after.published, 3);
  assert.ok(after.findings.every((item) => !approved.includes(item.key)));
});
