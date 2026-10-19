import { Config } from '../config';

/** Defense in depth for configured credentials. This is not a general PII/DLP filter. */
export function confidentialValues(config: Config): string[] {
  const values = [
    config.apiKey,
    config.botToken,
    config.sessionSecret,
    config.webhookSecret,
    config.databaseUrl,
    config.sabyAccessToken,
    config.sabyClientSecret,
    config.sabyServiceKey,
  ];
  try {
    const password = new URL(config.databaseUrl).password;
    if (password) values.push(decodeURIComponent(password));
  } catch {
    /* No valid database URL in embedded mode. */
  }
  return [...new Set(values.filter((value) => value.length >= 8))].sort(
    (a, b) => b.length - a.length,
  );
}

export function redactSystemText(text: string, config: Config): string {
  for (const value of confidentialValues(config)) text = text.split(value).join('[REDACTED]');
  return text;
}

/** Clone the wire payload, leaving service/storage objects and credential headers untouched. */
export function redactSystemPayload(
  value: unknown,
  config: Config,
  publicResponse = false,
  preserveInputImages = false,
): any {
  if (typeof value === 'string') return redactSystemText(value, config);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return value.map((item) =>
      redactSystemPayload(item, config, publicResponse, preserveInputImages),
    );
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  // Only the AI adapter opts into this exception for its server-built typed
  // image input. Arbitrary public/business strings still undergo masking.
  // Masking matching base64 fragments would corrupt the image, not inspect it.
  const inputImage =
    !publicResponse &&
    preserveInputImages &&
    object.type === 'input_image' &&
    typeof object.image_url === 'string' &&
    /^data:image\/(?:png|jpeg);base64,/.test(object.image_url);
  // File storage DTOs also occur nested in audit snapshots. Business deal keys
  // have a different shape and must remain intact.
  const fileData =
    publicResponse &&
    typeof object.key === 'string' &&
    typeof object.name === 'string' &&
    typeof object.size === 'number' &&
    typeof object.category === 'string';
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !fileData || ['name', 'size', 'category'].includes(key))
      .map(([key, item]) => [
        key,
        inputImage && key === 'image_url'
          ? item
          : redactSystemPayload(item, config, publicResponse, preserveInputImages),
      ]),
  );
}
