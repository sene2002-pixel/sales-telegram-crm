import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeConfig } from '../server/config';
import { Database } from '../server/infra/database';
import { recordAiUsage } from '../server/infra/ai-usage';

test('monthly cost inputs retain numeric usage and count missing provider metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-usage-'));
  const db = new Database(makeConfig({ DATA_DIR: dir }));
  await db.init();
  t.after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const id = randomUUID();
  await db.query(
    "INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,'Cost sample','manager')",
    [id, id],
  );
  for (let i = 0; i < 2; i++)
    await recordAiUsage(db, id, 'gpt-6-luna', 'responses', {
      usage: {
        input_tokens: 1000,
        output_tokens: 250,
        input_tokens_details: { cached_tokens: 300 },
      },
      output: [
        { type: 'web_search_call' },
        { type: 'message', text: 'synthetic content excluded' },
      ],
    });
  await recordAiUsage(db, id, 'gpt-transcribe', 'audio/transcriptions', { usage: { seconds: 18 } });
  await recordAiUsage(db, id, 'gpt-transcribe', 'audio/transcriptions', {
    text: 'synthetic transcript excluded',
  });
  const rows = await db.query('SELECT * FROM ai_usage_daily WHERE actor_id=$1 ORDER BY model', [
    id,
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    ['calls', 'input_tokens', 'cached_tokens', 'output_tokens', 'search_calls'].map((k) =>
      Number(rows[0][k]),
    ),
    [2, 2000, 600, 500, 2],
  );
  assert.equal(Number(rows[1].audio_seconds), 18);
  assert.equal(Number(rows[1].incomplete), 1);
  assert.ok(!JSON.stringify(rows).includes('synthetic'));
});
