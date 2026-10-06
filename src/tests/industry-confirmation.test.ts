import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor } from '../shared/contracts';
import { industryGroups } from '../shared/reference-industries';
import { LetterBot } from '../server/services/letter-bot';
import { TelegramAdapter } from '../server/infra/telegram';

test('industry choice requires owner, valid choice and fresh confirmation; missing industry cannot run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-industry-'));
  const config = makeConfig({ DATA_DIR: dir, BOT_TOKEN: 'test' });
  const { app, services: s, db } = await createApp(config);
  try {
    const actor: Actor = {
      id: randomUUID(),
      telegramId: '12345',
      name: 'Manager',
      role: 'manager',
      active: true,
    };
    const other: Actor = { ...actor, id: randomUUID(), telegramId: '54321' };
    for (const user of [actor, other])
      await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
        user.id,
        user.telegramId,
        user.name,
        user.role,
      ]);
    const bot = new LetterBot(s.crm, s.letters, s.reports, new TelegramAdapter(config), config);
    const id = randomUUID();
    const research = {
      status: 'found',
      company: {
        name: 'ООО Ромашка',
        inn: '7707083893',
        city: 'Москва',
        industry: '',
        activity: 'Производство вентиляционного оборудования',
      },
      recipient: { name: 'Иванов Иван Иванович', role: 'Директор' },
      sources: ['https://example.com'],
    };
    await db.query(
      "INSERT INTO letter_jobs(id,source_key,user_id,chat_id,query,status,research,research_version) VALUES($1,$2,$3,$4,'Ромашка','waiting_company',$5,1)",
      [id, `industry:${id}`, actor.id, actor.telegramId, JSON.stringify(research)],
    );
    await bot.reviewCompany(actor, id, 'ly', 1);
    let [job] = await db.query('SELECT * FROM letter_jobs WHERE id=$1', [id]);
    assert.equal(job.status, 'waiting_company');
    assert.equal(job.research_confirmed, false);
    assert.match(JSON.stringify(await db.query('SELECT payload FROM outbox')), /Выберите отрасль/);
    await assert.rejects(
      bot.reviewCompany(other, id, 'lg', 1, industryGroups[0].id),
      /Задача не найдена/,
    );
    await assert.rejects(bot.reviewCompany(actor, id, 'lg', 1, 'unknown'), /Выберите отрасль/);
    await bot.reviewCompany(actor, id, 'lg', 1, industryGroups[0].id);
    [job] = await db.query('SELECT * FROM letter_jobs WHERE id=$1', [id]);
    assert.equal(job.research.company.industry, industryGroups[0].label);
    assert.deepEqual(job.research.recipient, research.recipient);
    assert.equal(job.research.company.inn, research.company.inn);
    assert.equal(job.research.company.activity, research.company.activity);
    assert.equal(job.research_confirmed, false);
    assert.equal(job.status, 'waiting_company');
    assert.equal(job.research_version, 2);
    await assert.rejects(bot.reviewCompany(actor, id, 'ly', 1), /Используйте последнее/);
    await assert.rejects(
      bot.reviewCompany(actor, id, 'lg', 1, industryGroups[1].id),
      /Используйте последнее/,
    );
    await bot.reviewCompany(actor, id, 'ly', 2);
    [job] = await db.query('SELECT * FROM letter_jobs WHERE id=$1', [id]);
    assert.equal(job.status, 'queued');
    assert.equal(job.research_confirmed, true);
    assert.equal((await db.query('SELECT * FROM companies')).length, 0);
    assert.equal((await db.query('SELECT * FROM dialogue_actions')).length, 0);
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
