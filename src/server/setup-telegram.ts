import { makeConfig } from './config';
import { TelegramAdapter } from './infra/telegram';
async function main() {
  const config = makeConfig();
  if (
    !config.publicUrl.startsWith('https://') ||
    !config.botToken ||
    config.webhookSecret.length < 32
  )
    throw new Error('Required: HTTPS PUBLIC_URL, BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (32+ chars)');
  const telegram = new TelegramAdapter(config);
  await telegram.call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Начать работу' },
      { command: 'help', description: 'Как отправить отчёт' },
      { command: 'crm', description: 'Открыть CRM' },
      { command: 'tasks', description: 'Мои задачи' },
    ],
  });
  await telegram.call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Открыть CRM', web_app: { url: config.publicUrl } },
  });
  await telegram.call('setWebhook', {
    url: `${config.publicUrl}/api/telegram/webhook`,
    secret_token: config.webhookSecret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  });
  console.log('Webhook, команды и меню CRM настроены');
}
main().catch(() => {
  console.error('Настройка Telegram не удалась. Проверьте HTTPS, токен и секрет webhook');
  process.exitCode = 1;
});
