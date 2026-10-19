# Pico bot webhook

Requirement: route CRM commands, messages and web app access through @PicoSalesBot.

Acceptance: runtime bot identity matches, public health succeeds, webhook targets the current PUBLIC_URL, and CRM menu is configured.

Finding: runtime already uses the new bot and current ngrok URL. Generic payload redaction replaced the webhook authentication secret, causing Telegram HTTP 400.

Change: preserve only the configured webhook secret in the top-level secret_token of setWebhook. All other payload fields remain redacted.

Operations: installed webhook directly using runtime credentials after checking public health HTTP 200. No pending updates were dropped.

Validation: pending regression check and final Telegram configuration readback.

Rollback: revert the adapter exception; bot configuration can be reset with setup-telegram using the intended bot credentials and public URL.
