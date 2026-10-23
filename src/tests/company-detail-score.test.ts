import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { companySchema } from '../shared/contracts';

test('detail scores match analytics, reflect current settings, respect ACL and preserve website', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'company-detail-score-'));
  const {
    app,
    db,
    services: s,
  } = await createApp(
    makeConfig({
      NODE_ENV: 'test',
      DEV_AUTH: 'true',
      WORKER_ENABLED: 'false',
      DATA_DIR: dir,
      DATABASE_URL: '',
      BOT_TOKEN: '',
      OPENAI_API_KEY: '',
      SESSION_SECRET: 'local-detail-score-test-secret-at-least-32-characters',
    }),
  );
  try {
    const manager = (await s.auth.dev('manager', '127.0.0.1')).user;
    const admin = (await s.auth.dev('admin', '127.0.0.1')).user;
    const company = await s.crm.create(manager, {
      name: 'Компания',
      website: 'https://example.test/path',
    });
    assert.equal(
      (await s.crm.detail(manager, company.id)).company.website,
      'https://example.test/path',
    );
    assert.equal((await s.crm.detail(manager, company.id)).clientScore?.score, 0);
    await s.crm.createRecord(manager, company.id, 'contact', { name: 'Первый' });
    await s.crm.createRecord(manager, company.id, 'contact', { name: 'Второй' });
    const task = await s.crm.createRecord(manager, company.id, 'task', {
      text: 'Звонок',
      due: '2026-01-01',
      type: 'call',
    });
    await db.query("UPDATE records SET created_at=now()-interval '40 days' WHERE id=$1", [task.id]);
    const before = (await s.crm.detail(manager, company.id)).clientScore!;
    const currentSettings = await s.dashboard.analyticsSettings(admin);
    await s.dashboard.updateAnalyticsSettings(admin, {
      revision: currentSettings.revision,
      taskDays: 60,
      meetingMonths: currentSettings.meetingMonths,
      projectMonths: currentSettings.projectMonths,
    });
    const detail = await s.crm.detail(manager, company.id);
    assert.equal(detail.clientScore!.score, before.score + (before.regularity.task ? 0 : 1));
    assert.equal(detail.clientScore!.regularity.task, true);
    const today = new Date().toISOString().slice(0, 10);
    const analytics = await s.dashboard.analytics(manager, today, today, undefined, 'all');
    assert.deepEqual(
      detail.clientScore,
      analytics.clientAnalytics.clients.find((c) => c.id === company.id),
    );
    const foreign = await s.crm.create(admin, { name: 'Чужая' });
    await assert.rejects(s.crm.detail(manager, foreign.id));
    const { id, ownerId, ownerName, version, createdAt, updatedAt, ...data } = detail.company;
    const updated = await s.crm.update(manager, company.id, {
      version: detail.company.version,
      data: { ...data, website: 'http://example.test/new' },
    });
    assert.equal(
      (await s.crm.detail(manager, company.id)).company.website,
      'http://example.test/new',
    );
    await s.crm.setArchived(admin, company.id, true, updated.version);
    assert.equal((await s.crm.detail(admin, company.id)).clientScore, null);
    assert.equal(companySchema.parse({ name: 'Legacy' }).website, '');
    assert.equal(
      companySchema.safeParse({ name: 'Bad', website: 'javascript:alert(1)' }).success,
      false,
    );
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
