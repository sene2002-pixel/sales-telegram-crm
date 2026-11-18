import { isIP } from 'node:net';
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
function budgetValue(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum = 1_000_000) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${key} must be an integer between 1 and ${maximum}`);
  return value;
}
function fileQuotas(env: NodeJS.ProcessEnv) {
  function limit(name: string, defaultValue: number) {
    const raw = env[name];
    if (raw === undefined || raw === '') return defaultValue;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1)
      throw new Error(`${name} must be a positive safe integer`);
    return Number(raw);
  }
  const enabled = env.FILE_QUOTAS_ENABLED || 'false';
  if (enabled !== 'true' && enabled !== 'false')
    throw new Error('FILE_QUOTAS_ENABLED must be true or false');
  return {
    enabled: enabled === 'true',
    warningPercent: budgetValue(env, 'FILE_QUOTA_WARNING_PERCENT', 80, 100),
    userFiles: limit('FILE_USER_MAX_FILES', 5000),
    userBytes: limit('FILE_USER_MAX_BYTES', 2 * 1024 ** 3),
    companyFiles: limit('FILE_COMPANY_MAX_FILES', 1000),
    companyBytes: limit('FILE_COMPANY_MAX_BYTES', 512 * 1024 ** 2),
    systemFiles: limit('FILE_SYSTEM_MAX_FILES', 100000),
    systemBytes: limit('FILE_SYSTEM_MAX_BYTES', 64 * 1024 ** 3),
    minFreeBytes: limit('FILE_MIN_FREE_BYTES', 512 * 1024 ** 2),
  };
}
export function makeConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const config = {
    production,
    apiDocsEnabled:
      env.API_DOCS_ENABLED === undefined ? !production : env.API_DOCS_ENABLED === 'true',
    apiUserLimit: Number(env.API_RATE_LIMIT_PER_USER || 3000),
    trustedProxies: (env.TRUSTED_PROXY_ADDRESSES || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    apiIpLimit: Number(env.API_RATE_LIMIT_PER_IP || 6000),
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    publicUrl: env.PUBLIC_URL || 'http://localhost:5173',
    databaseUrl: env.DATABASE_URL || '',
    migrateOnStartup: env.DATABASE_MIGRATE_ON_START !== 'false',
    fileQuotas: fileQuotas(env),
    dataDir: resolve(env.DATA_DIR || './data'),
    devAuth: env.DEV_AUTH === 'true',
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    botToken: env.BOT_TOKEN || '',
    telegramApiEnvironment: env.TELEGRAM_API_ENVIRONMENT ?? 'production',
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
    picoStarsEnabled: env.PICO_STARS_ENABLED === 'true',
    picoStarsTermsUrl: (env.PICO_STARS_TERMS_URL || '').trim(),
    picoStarsSupportUsername: (env.PICO_STARS_SUPPORT_USERNAME || '').trim().replace(/^@/, ''),
    adminTelegramId: env.BOOTSTRAP_ADMIN_TELEGRAM_ID || '',
    aiUsageMetrics: env.AI_USAGE_METRICS_ENABLED === 'true',
    aiBudget: {
      enabled: env.AI_BUDGET_ENABLED === 'true',
      userConcurrent: budgetValue(env, 'AI_USER_CONCURRENT', 1),
      systemConcurrent: budgetValue(env, 'AI_SYSTEM_CONCURRENT', 6),
      userMinute: budgetValue(env, 'AI_USER_CALLS_PER_MINUTE', 10),
      userDaily: budgetValue(env, 'AI_USER_CALLS_PER_DAY', 100),
      systemDaily: budgetValue(env, 'AI_SYSTEM_CALLS_PER_DAY', 1000),
      userQueue: budgetValue(env, 'AI_USER_QUEUE', 10),
      systemQueue: budgetValue(env, 'AI_SYSTEM_QUEUE', 100),
      outputTokens: budgetValue(env, 'AI_MAX_OUTPUT_TOKENS', 8000),
      webSearchCalls: budgetValue(env, 'AI_MAX_WEB_SEARCH_CALLS', 2, 3),
    },
    apiKey: env.OPENAI_API_KEY || '',
    sabyAccessToken: env.SABY_ACCESS_TOKEN || '',
    sabyClientId: env.SABY_CLIENT_ID || '',
    sabyClientSecret: env.SABY_CLIENT_SECRET || '',
    sabyServiceKey: env.SABY_SERVICE_KEY || '',
    transcriptionModel: env.TRANSCRIPTION_MODEL || 'gpt-transcribe',
    extractionModel: env.EXTRACTION_MODEL || 'gpt-6-luna',
    letterModel: env.LETTER_MODEL || 'gpt-6-luna',
    worker: env.WORKER_ENABLED !== 'false',
    workerConcurrency: Number(env.WORKER_CONCURRENCY || 3),
    requestRetentionDays: Number(env.REQUEST_RETENTION_DAYS || 30),
    diagnosticUntil: env.DIAGNOSTIC_LOG_UNTIL ? Date.parse(env.DIAGNOSTIC_LOG_UNTIL) : 0,
    timezone: env.REPORT_TIMEZONE || 'Europe/Moscow',
    maxVoiceBytes: Number(env.MAX_VOICE_BYTES || 20_000_000),
    maxVoiceSeconds: Number(env.MAX_VOICE_SECONDS || 600),
  };
  if (!['production', 'test'].includes(config.telegramApiEnvironment))
    throw new Error('TELEGRAM_API_ENVIRONMENT must be production or test');
  if (config.botToken && !/^[A-Za-z0-9_:-]+$/.test(config.botToken))
    throw new Error('BOT_TOKEN must contain only the token supplied by BotFather');
  if (
    (config.picoStarsSupportUsername &&
      !/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(config.picoStarsSupportUsername)) ||
    (config.picoStarsEnabled &&
      (!config.picoStarsSupportUsername || !config.botToken || config.webhookSecret.length < 32))
  ) {
    throw new Error(
      'Pico Stars requires a valid PICO_STARS_SUPPORT_USERNAME, BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (32+ chars)',
    );
  }
  if (config.trustedProxies.some((address) => !isIP(address)))
    throw new Error('TRUSTED_PROXY_ADDRESSES must list individual IPv4 or IPv6 addresses');
  for (const key of [
    'AI_BUDGET_ENABLED',
    'AI_USAGE_METRICS_ENABLED',
    'DATABASE_MIGRATE_ON_START',
  ] as const)
    if (env[key] !== undefined && !['true', 'false'].includes(env[key]!))
      throw new Error(`${key} must be true or false`);
  const termsUrl = config.picoStarsTermsUrl;
  if (termsUrl || config.picoStarsEnabled) {
    const parsed = URL.canParse(termsUrl) ? new URL(termsUrl) : null;
    if (
      !parsed ||
      !/^https:\/\/[^/?#]/i.test(termsUrl) ||
      /[\\\s]/.test(termsUrl) ||
      parsed.username ||
      parsed.password ||
      termsUrl.length > 2048
    )
      throw new Error('PICO_STARS_TERMS_URL must be an absolute HTTPS URL without credentials');
  }
  new Intl.DateTimeFormat('ru', { timeZone: config.timezone }).format();
  for (const [name, value] of [
    ['API_RATE_LIMIT_PER_USER', config.apiUserLimit],
    ['API_RATE_LIMIT_PER_IP', config.apiIpLimit],
  ] as const)
    if (!Number.isInteger(value) || value < 1 || value > 100000)
      throw new Error(`${name} must be an integer between 1 and 100000`);
  if (
    !Number.isInteger(config.workerConcurrency) ||
    config.workerConcurrency < 1 ||
    config.workerConcurrency > 10
  )
    throw new Error('WORKER_CONCURRENCY must be between 1 and 10');
  if (
    !Number.isInteger(config.requestRetentionDays) ||
    config.requestRetentionDays < 1 ||
    config.requestRetentionDays > 365
  )
    throw new Error('REQUEST_RETENTION_DAYS must be between 1 and 365');
  if (
    !Number.isFinite(config.diagnosticUntil) ||
    (env.DIAGNOSTIC_LOG_UNTIL &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        env.DIAGNOSTIC_LOG_UNTIL,
      ))
  )
    throw new Error('Invalid DIAGNOSTIC_LOG_UNTIL: use an ISO date with timezone');
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
