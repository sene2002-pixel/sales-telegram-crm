import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { makeConfig } from '../server/config';
import { createApp } from '../server/http/app';
import { storeCompanyFile } from '../server/services/file-storage';
import { fileQuotaStatus, startFileQuotaMonitor } from '../server/services/file-quota-monitor';
import { randomUUID } from 'node:crypto';

test('file quota settings are opt-in and reject ambiguous limits', () => {
  assert.equal(makeConfig({}).fileQuotas.enabled, false);
  assert.equal(makeConfig({ FILE_QUOTAS_ENABLED: 'true' }).fileQuotas.enabled, true);
  assert.throws(() => makeConfig({ FILE_QUOTAS_ENABLED: 'yes' }), /FILE_QUOTAS_ENABLED/);
  for (const value of ['0', '101', '70.3'])
    assert.throws(
      () => makeConfig({ FILE_QUOTA_WARNING_PERCENT: value }),
      /FILE_QUOTA_WARNING_PERCENT/,
    );
  for (const value of ['-1', '0', '0.5', '1e5', '9007199254740992', 'oops'])
    assert.throws(() => makeConfig({ FILE_SYSTEM_MAX_BYTES: value }), /FILE_SYSTEM_MAX_BYTES/);
});

test('operator file quota samples warn before denial and disclose only aggregate usage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-files-monitor-'));
  const config = makeConfig({
    DATA_DIR: dir,
    DEV_AUTH: 'true',
    FILE_QUOTA_WARNING_PERCENT: '80',
    FILE_USER_MAX_FILES: '5',
    FILE_COMPANY_MAX_FILES: '5',
    FILE_SYSTEM_MAX_FILES: '5',
    FILE_USER_MAX_BYTES: '5',
    FILE_COMPANY_MAX_BYTES: '5',
    FILE_SYSTEM_MAX_BYTES: '10',
    FILE_MIN_FREE_BYTES: '1',
  });
  let queries = 0;
  const unavailable = {
    query: async () => {
      queries++;
      throw new Error('private-path/some-file');
    },
  };
  await startFileQuotaMonitor(unavailable, config)();
  assert.equal(await fileQuotaStatus(unavailable, config), undefined);
  assert.equal(queries, 0);
  config.fileQuotas.enabled = true;
  const { db, app, services: s } = await createApp(config);
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const admin = (await s.auth.dev('admin', '127.0.0.1')).user;
  const user = (await s.auth.dev('manager', '127.0.0.1')).user;
  const a = await s.crm.create(user, { name: 'Секретное название А' }),
    b = await s.crm.create(admin, { name: 'Секретное название Б' });
  assert.equal((await fileQuotaStatus(db, config))!.status, 'ok');
  const record = await storeCompanyFile(
    db,
    config,
    { authorId: user.id, companyId: a.id },
    Buffer.from('priv'),
    (tx, key) =>
      s.crm.createRecord(
        user,
        a.id,
        'file',
        { key, name: 'private-file', category: 'docs', size: 4 },
        null,
        tx,
      ),
  );
  await s.crm.deleteFile(user, record.id);
  await db.query(
    'INSERT INTO file_storage_reservations(key,author_id,company_id,bytes) VALUES($1,$2,$3,4)',
    [randomUUID(), admin.id, b.id],
  );
  const lines: string[] = [];
  t.mock.method(console, 'warn', (value: string) => {
    lines.push(value);
  });
  await startFileQuotaMonitor(db, config)();
  assert.equal(lines.length, 1);
  const sample = JSON.parse(lines[0]!);
  assert.deepEqual(sample, {
    event: 'file_quota.status',
    status: 'warning',
    thresholdPercent: 80,
    system: { files: '2', bytes: '8' },
    userPeak: { files: '1', bytes: '4' },
    companyPeak: { files: '1', bytes: '4' },
    reserved: { files: '1', bytes: '4' },
    availableBytes: sample.availableBytes,
    warnings: ['system.bytes', 'user.bytes', 'company.bytes'],
  });
  assert.ok(/^\d+$/.test(sample.availableBytes));
  Object.assign(config.fileQuotas, {
    userFiles: 1,
    companyFiles: 1,
    systemFiles: 2,
    minFreeBytes: Number.MAX_SAFE_INTEGER,
  });
  const pressure = await fileQuotaStatus(db, config);
  assert.deepEqual(pressure!.warnings, [
    'system.files',
    'system.bytes',
    'user.files',
    'user.bytes',
    'company.files',
    'company.bytes',
    'disk.free',
  ]);
  await startFileQuotaMonitor(unavailable, config)();
  assert.equal(queries, 1);
  assert.deepEqual(JSON.parse(lines[1]!), { event: 'file_quota.status', status: 'unavailable' });
});

test('uploads reserve shared count, bytes and disk headroom and keep archived files charged', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-storage-limits-'));
  const config = makeConfig({ DATA_DIR: dir, DEV_AUTH: 'true' });
  const { app, db, services } = await createApp(config);
  t.after(async () => {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const admin = await services.auth.dev('admin', '127.0.0.1');
  const owner = await services.auth.dev('manager', '127.0.0.1');
  const old = await services.crm.create(owner.user, { name: 'Исторические файлы' });
  const next = await services.crm.create(owner.user, { name: 'Новые файлы' });
  const other = await services.crm.create(admin.user, { name: 'Другая компания' });
  const upload = (token: string, company: string, size = 1) =>
    request(app.getHttpServer())
      .post(`/api/companies/${company}/files`)
      .set('Authorization', 'Bearer ' + token)
      .attach('file', Buffer.alloc(size), 'test.bin');

  // This upload predates enforcement and remains on disk after the existing archive operation.
  const historical = await upload(owner.token, old.id, 4).expect(201);
  await services.crm.deleteFile(owner.user, historical.body.id);
  config.fileQuotas.enabled = true;
  const baseline = { ...config.fileQuotas };
  for (const [limit, value, token, company, scope] of [
    ['userFiles', 1, owner.token, next.id, 'сотрудника'],
    ['userBytes', 4, owner.token, next.id, 'сотрудника'],
    ['companyFiles', 1, admin.token, old.id, 'компании'],
    ['companyBytes', 4, admin.token, old.id, 'компании'],
    ['systemFiles', 1, admin.token, other.id, 'системы'],
    ['systemBytes', 4, admin.token, other.id, 'системы'],
    ['minFreeBytes', Number.MAX_SAFE_INTEGER, admin.token, other.id, 'свободного места'],
  ] as const) {
    Object.assign(config.fileQuotas, baseline, { [limit]: value });
    const refusal = await upload(token, company).expect(507);
    assert.match(refusal.body.message, new RegExp(scope));
  }
  assert.equal((await readdir(join(dir, 'files'))).length, 1);
  assert.equal((await db.query("SELECT id FROM records WHERE kind='file'")).length, 1);

  Object.assign(config.fileQuotas, baseline, { systemFiles: 2, systemBytes: 6 });
  const concurrent = await Promise.all([
    upload(owner.token, next.id, 2),
    upload(admin.token, other.id, 2),
    upload(owner.token, old.id, 2),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 507, 507]);
  const files = await readdir(join(dir, 'files'));
  assert.equal(files.length, 2);
  const lengths = await Promise.all(
    files.map(async (f) => (await readFile(join(dir, 'files', f))).length),
  );
  assert.deepEqual(lengths.sort(), [2, 4]);
  const rows = await db.query("SELECT id FROM records WHERE kind='file' ORDER BY id");
  assert.equal(rows.length, 2);

  // A file write can fail after exclusive creation. Both the new blob and its provisional DB row go away.
  Object.assign(config.fileQuotas, baseline);
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  const openFile = fs.open;
  const fault = t.mock.method(fs, 'open', async (...args: Parameters<typeof openFile>) => {
    const handle = await openFile(...args);
    if (String(args[0]).startsWith(join(dir, 'files') + sep))
      handle.sync = async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      };
    return handle;
  });
  try {
    await upload(owner.token, next.id, 2).expect(507);
  } finally {
    fault.mock.restore();
  }
  assert.deepEqual(await readdir(join(dir, 'files')), files);
  assert.deepEqual(await db.query("SELECT id FROM records WHERE kind='file' ORDER BY id"), rows);
  await upload(owner.token, next.id, 2).expect(201);

  // Pause physical writes in both modes. Normal CRM edits must finish before fsync is released.
  for (const enabled of [true, false]) {
    Object.assign(config.fileQuotas, baseline, { enabled });
    let started!: () => void, release!: () => void;
    const syncing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = t.mock.method(fs, 'open', async (...args: Parameters<typeof openFile>) => {
      const handle = await openFile(...args);
      if (String(args[0]).startsWith(join(dir, 'files') + sep)) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          started();
          await proceed;
          return sync();
        };
      }
      return handle;
    });
    const inFlight = upload(owner.token, next.id).then((r) => r.status);
    let timer: NodeJS.Timeout | undefined;
    try {
      await syncing;
      const edit = services.crm.create(owner.user, {
        name: `Редактирование во время записи ${enabled}`,
      });
      await Promise.race([
        edit,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('File I/O blocked all CRM edits')), 3000);
        }),
      ]);
      if (enabled) {
        const reservations = await db.query('SELECT bytes FROM file_storage_reservations');
        assert.equal(reservations.length, 1);
        assert.equal(Number(reservations[0].bytes), 1);
        const [usage] = await db.query("SELECT count(*) AS count FROM records WHERE kind='file'");
        config.fileQuotas.systemFiles = Number(usage.count) + 1;
        await upload(admin.token, other.id).expect(507);
      }
    } finally {
      clearTimeout(timer);
      release();
      slow.mock.restore();
      assert.equal(await inFlight, 201);
    }
    assert.deepEqual(await db.query('SELECT key FROM file_storage_reservations'), []);
  }
  Object.assign(config.fileQuotas, baseline);

  // Losing the reservation acknowledgement never publishes bytes or leaves quota charged.
  const withoutReply = db.transaction.bind(db);
  let first = true;
  const admissionFault = t.mock.method(
    db,
    'transaction',
    async (fn: Parameters<typeof withoutReply>[0]) => {
      const result = await withoutReply(fn);
      if (first) {
        first = false;
        throw new Error('lost reservation acknowledgement');
      }
      return result;
    },
  );
  try {
    await assert.rejects(
      storeCompanyFile(
        db,
        config,
        { authorId: owner.user.id, companyId: next.id },
        Buffer.from('lost'),
        async () => {
          throw new Error('unexpected publication');
        },
      ),
      /lost reservation acknowledgement/,
    );
  } finally {
    admissionFault.mock.restore();
  }
  assert.deepEqual(await db.query('SELECT key FROM file_storage_reservations'), []);

  // The DB committed, but the writer lost the acknowledgement. The row and its bytes survive.
  const transaction = db.transaction.bind(db);
  let loseReply = true;
  const lostReply = t.mock.method(
    db,
    'transaction',
    async (fn: Parameters<typeof transaction>[0]) => {
      const result = await transaction(fn);
      if (loseReply && result && typeof result === 'object' && 'id' in result) {
        loseReply = false;
        throw new Error('synthetic lost commit acknowledgement');
      }
      return result;
    },
  );
  try {
    const content = Buffer.from('persisted');
    const saved = await storeCompanyFile(
      db,
      config,
      { authorId: owner.user.id, companyId: next.id },
      content,
      (tx, key) =>
        services.crm.createRecord(
          owner.user,
          next.id,
          'file',
          {
            key,
            name: 'confirmed.bin',
            category: 'docs',
            size: content.length,
          },
          null,
          tx,
        ),
    );
    assert.deepEqual(await readFile(join(dir, 'files', saved.data.key)), content);
    assert.deepEqual(await db.query('SELECT id FROM records WHERE id=$1', [saved.id]), [
      { id: saved.id },
    ]);
  } finally {
    lostReply.mock.restore();
  }
});
