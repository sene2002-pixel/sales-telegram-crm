# Pico bot webhook

Requirement: route CRM commands, messages and web app access through @PicoSalesBot.

Acceptance: runtime bot identity matches, public health succeeds, webhook targets the current PUBLIC_URL, and CRM menu is configured.

Finding: runtime already uses the new bot and current ngrok URL. Generic payload redaction replaced the webhook authentication secret, causing Telegram HTTP 400.

Change: preserve only the configured webhook secret in the top-level secret_token of setWebhook. All other payload fields remain redacted.

Operations: installed webhook directly using runtime credentials after checking public health HTTP 200. No pending updates were dropped.

Validation: Telegram readback confirms the intended webhook, zero pending updates, commands and web app menu. All Node tests passed after integrating current origin/main, including the webhook transport regression. npm run check reached test:ops, where the container's Python failed an existing backup test because TarFile.extractall lacks the filter parameter; the final build step was therefore not reached. Docker production build passed for the public-assets fix before this adapter change. git diff --check passed.

Rollback: revert the adapter exception; bot configuration can be reset with setup-telegram using the intended bot credentials and public URL.
