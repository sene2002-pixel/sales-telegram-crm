import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/http/app';
import { makeConfig } from '../server/config';
import { Actor } from '../shared/contracts';

test('letter generation requires industry confirmation and rejects out-of-list references with bounded retries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-reference-pipeline-'));
  const {
    app,
    db,
    services: s,
  } = await createApp(makeConfig({ DATA_DIR: dir, OPENAI_API_KEY: 'test' }));
  const actor: Actor = {
    id: randomUUID(),
    telegramId: '123',
    name: 'Manager',
    role: 'manager',
    active: true,
  };
  try {
    await db.query('INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4)', [
      actor.id,
      actor.telegramId,
      actor.name,
      actor.role,
    ]);
    const company = await s.crm.create(
      actor,
      { name: 'ООО Тест', industry: 'Производство вентиляции' },
      actor.id,
    );
    const contact = await s.crm.createRecord(actor, company.id, 'contact', {
      name: 'Иванов Иван',
      role: 'Директор',
    });
    const signature = await s.letters.writeSignature(actor, {
      lastName: 'Петров',
      firstName: 'Пётр',
      patronymic: '',
      workPhone: '',
      mobilePhone: '',
      email: '',
    });
    let calls = 0;
    s.letters.ai.request = async (_path, raw) => {
      calls++;
      const input = JSON.parse(JSON.parse(raw as string).input);
      assert.ok(input.referenceCandidates.length);
      assert.ok(
        input.referenceCandidates.every((r: any) => !['mining', 'oil_gas'].includes(r.group)),
      );
      assert.ok(!JSON.stringify(input.referenceCandidates).includes('Амур Минералс'));
      return {
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  recipient: {
                    position_dative: 'Директору',
                    company_name: 'ООО Тест',
                    full_name_dative: 'Иванову Ивану',
                  },
                  reference_ids: ['outside-catalog'],
                  sources: ['https://example.com'],
                }),
              },
            ],
          },
        ],
      };
    };
    const raw = { contactId: contact.id, signatureId: signature.id };
    await assert.rejects(s.letters.create(actor, company.id, raw), /подтвердите отрасль/);
    await assert.rejects(
      s.letters.create(actor, company.id, { ...raw, confirmedIndustry: 'неизвестно' }),
      /подтвердите отрасль/,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      s.letters.create(actor, company.id, {
        ...raw,
        confirmedIndustry: 'Машиностроение/OEM',
        confirmedActivity: 'Производство вентиляции',
      }),
      /проверить референсы/,
    );
    assert.equal(calls, 2);
    assert.equal((await db.query("SELECT * FROM records WHERE kind='file'")).length, 0);
    assert.equal(
      (await db.query("SELECT * FROM audit WHERE action='letter.references_selected'")).length,
      0,
    );
    assert.equal((await db.query('SELECT * FROM letter_numbers')).length, 0);
    if (process.env.LETTER_PYTHON) {
      calls = 0;
      let expectedIds: string[] = [];
      s.letters.ai.request = async (_path, raw) => {
        calls++;
        const input = JSON.parse(JSON.parse(raw as string).input);
        expectedIds = input.referenceCandidates.map((r: any) => r.id);
        return {
          status: 'completed',
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    recipient: {
                      position_dative: 'Директору',
                      company_name: 'ООО Тест',
                      full_name_dative: 'Иванову Ивану',
                    },
                    reference_ids: calls === 1 ? ['wrong-id'] : expectedIds,
                    sources: ['https://example.com'],
                  }),
                },
              ],
            },
          ],
        };
      };
      const result = await s.letters.create(actor, company.id, {
        ...raw,
        confirmedIndustry: 'Машиностроение/OEM',
        confirmedActivity: 'Производство вентиляции',
      });
      assert.equal(calls, 2);
      const [history] = await db.query(
        "SELECT details FROM audit WHERE action='letter.references_selected' AND entity_id=$1",
        [result.record.id],
      );
      assert.deepEqual(history.details.ids, expectedIds);
      assert.equal(result.referenceWarning, undefined);
      const fs = require('node:fs/promises');
      const read = fs.readFile;
      const override = t.mock.method(fs, 'readFile', async (path: any, ...args: any[]) => {
        if (String(path).endsWith('REFERENCES_ESQ.md'))
          return (
            '```reference\n' +
            JSON.stringify({
              id: 'unapproved',
              group: 'defense',
              name: 'Закрытый объект',
              facts: 'ПЧ ESQ',
              profile: '',
              region: '',
              star: false,
              allowed: false,
            }) +
            '\n```'
          );
        return read(path, ...args);
      });
      try {
        const neutral = await s.letters.create(actor, company.id, {
          ...raw,
          confirmedIndustry: 'Машиностроение/OEM',
        });
        assert.deepEqual(expectedIds, []);
        assert.match(neutral.referenceWarning!, /нужен ручной подбор/);
        const [saved] = await db.query(
          "SELECT details FROM audit WHERE action='letter.references_selected' AND entity_id=$1",
          [neutral.record.id],
        );
        assert.deepEqual(saved.details.ids, []);
        assert.equal(saved.details.warning, neutral.referenceWarning);
        assert.ok(
          (await db.query('SELECT payload FROM outbox WHERE chat_id=$1', [actor.telegramId])).some(
            (row) => row.payload.text === neutral.referenceWarning,
          ),
        );
      } finally {
        override.mock.restore();
      }
    }
  } finally {
    await app.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
