import { Sql } from './database';

const units = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : 0;

// Retain only billing quantities. A missing usage field must stay visible in the report.
export async function recordAiUsage(
  db: Sql,
  actorId: string,
  model: string,
  operation: string,
  result: any,
) {
  const usage = result?.usage;
  const audio = operation === 'audio/transcriptions';
  const seconds = usage?.seconds ?? result?.duration;
  const input = units(usage?.input_tokens),
    cached = Math.min(input, units(usage?.input_tokens_details?.cached_tokens));
  const incomplete = audio
    ? !Number.isFinite(seconds)
    : !(Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens));
  const searches = Array.isArray(result?.output)
    ? result.output.filter((o: any) => o?.type === 'web_search_call').length
    : 0;
  await db.query(
    `INSERT INTO ai_usage_daily (day,actor_id,model,operation,calls,input_tokens,cached_tokens,output_tokens,audio_seconds,search_calls,incomplete)
    VALUES ((now() AT TIME ZONE 'UTC')::date,$1,$2,$3,1,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (day,actor_id,model,operation) DO UPDATE SET
      calls=ai_usage_daily.calls+1,input_tokens=ai_usage_daily.input_tokens+excluded.input_tokens,
      cached_tokens=ai_usage_daily.cached_tokens+excluded.cached_tokens,output_tokens=ai_usage_daily.output_tokens+excluded.output_tokens,
      audio_seconds=ai_usage_daily.audio_seconds+excluded.audio_seconds,search_calls=ai_usage_daily.search_calls+excluded.search_calls,
      incomplete=ai_usage_daily.incomplete+excluded.incomplete`,
    [
      actorId,
      model,
      operation,
      input,
      cached,
      units(usage?.output_tokens),
      units(seconds),
      searches,
      incomplete ? 1 : 0,
    ],
  );
}
