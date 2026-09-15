import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
export function makeConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const config = {
    production,
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    publicUrl: env.PUBLIC_URL || 'http://localhost:5173',
    databaseUrl: env.DATABASE_URL || '',
    dataDir: resolve(env.DATA_DIR || './data'),
    devAuth: env.DEV_AUTH === 'true',
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    botToken: env.BOT_TOKEN || '',
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
    adminTelegramId: env.BOOTSTRAP_ADMIN_TELEGRAM_ID || '',
    apiKey: env.OPENAI_API_KEY || '',
    transcriptionModel: env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    extractionModel: env.EXTRACTION_MODEL || 'gpt-4o-mini',
    worker: env.WORKER_ENABLED !== 'false',
    timezone: env.REPORT_TIMEZONE || 'Europe/Moscow',
    maxVoiceBytes: Number(env.MAX_VOICE_BYTES || 20_000_000),
    maxVoiceSeconds: Number(env.MAX_VOICE_SECONDS || 600),
  };
  new Intl.DateTimeFormat('ru', { timeZone: config.timezone }).format();
  if (
    production &&
    (config.devAuth ||
      !config.databaseUrl ||
      !env.SESSION_SECRET ||
      env.SESSION_SECRET.length < 32 ||
      !config.botToken ||
      config.webhookSecret.length < 32 ||
      !config.adminTelegramId ||
      !config.publicUrl.startsWith('https://'))
  ) {
    throw new Error(
      'Production requires PostgreSQL, HTTPS PUBLIC_URL, SESSION_SECRET and TELEGRAM_WEBHOOK_SECRET (32+ chars), BOT_TOKEN, BOOTSTRAP_ADMIN_TELEGRAM_ID; DEV_AUTH=false',
    );
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error('Invalid PORT');
  return config;
}
export type Config = ReturnType<typeof makeConfig>;
