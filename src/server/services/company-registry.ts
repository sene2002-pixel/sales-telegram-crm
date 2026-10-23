import { validInn } from '../../shared/contracts';
import { importedLegalForm, normalizedCity } from './import-normalization';

/** Minimal projection: raw registry records contain personal data and must never be stored/logged. */
export interface RegistryCompany {
  name: string;
  city?: string;
  registrationCity?: string;
  okved?: string;
  legalForm?: string;
}
export interface Registry {
  lookup(inn: string, signal?: AbortSignal): Promise<RegistryCompany | null>;
}
export interface SabyRegistryOptions {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  serviceKey?: string;
  fetch?: typeof fetch;
}
const maxBody = 1024 * 1024;
function untilAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      resolve(undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', abort);
        resolve(undefined);
      },
    );
  });
}
const bounded = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value)
    ? value.trim()
    : undefined;
function registrationCity(record: Record<string, unknown>): string | undefined {
  const legalAddress = bounded(record.address_legal, 5000);
  const explicit = legalAddress?.match(/(?:^|[,;]\s*)(?:г\.?\s+|город\s+)([^,;]+)/iu)?.[1];
  if (explicit && explicit.length <= 150) return normalizedCity(explicit);
  // Official /req example defines parsed_address as JSON text, including RegionName="Г.МОСКВА".
  const parsed = bounded(record.parsed_address, 10000);
  if (parsed) {
    try {
      const address = JSON.parse(parsed);
      const region = bounded(address?.RegionName, 150);
      if (region && /^(?:г\.|город\s)/iu.test(region)) return normalizedCity(region);
    } catch {
      /* An unknown address shape must not manufacture a city. */
    }
  }
  return undefined;
}

/** Official sources:
 * https://github.com/saby/vok/blob/main/doc/req/req.md
 * https://saby.ru/help/integration/api/auth/service/
 */
export class SabyRegistry implements Registry {
  private readonly http: typeof fetch;
  private cachedToken?: { value: string; until: number };
  private pendingToken?: Promise<string | undefined>;
  constructor(private readonly options: SabyRegistryOptions) {
    this.http = options.fetch ?? fetch;
  }
  private async json(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) return null;
      let response: Response;
      try {
        response = await this.http(url, {
          ...init,
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
        });
      } catch {
        if (!attempt && !signal?.aborted) continue;
        return null;
      }
      if (signal?.aborted) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (response.status >= 500 && response.status <= 599) {
        await response.body?.cancel().catch(() => undefined);
        if (!attempt) continue;
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBody)) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.body) return null;
      const reader = response.body.getReader();
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          if (signal?.aborted) {
            await reader.cancel();
            return null;
          }
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > maxBody) {
            await reader.cancel();
            return null;
          }
          chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        await reader.cancel().catch(() => undefined);
        return null;
      } finally {
        reader.releaseLock();
      }
    }
    return null;
  }
  private async token(signal?: AbortSignal): Promise<string | undefined> {
    const supplied = bounded(this.options.accessToken, 4096);
    if (supplied) return supplied;
    if (signal?.aborted) return undefined;
    if (this.cachedToken && this.cachedToken.until > Date.now()) return this.cachedToken.value;
    if (this.pendingToken) return untilAborted(this.pendingToken, signal);
    const { clientId, clientSecret, serviceKey } = this.options;
    if (!clientId || !clientSecret || !serviceKey) return undefined;
    const pending = (async () => {
      const result = await this.json(
        'https://online.sbis.ru/oauth/service/',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            app_client_id: clientId,
            app_secret: clientSecret,
            secret_key: serviceKey,
          }),
        },
        signal,
      );
      if (!result || typeof result !== 'object' || Array.isArray(result) || signal?.aborted)
        return undefined;
      const body = result as Record<string, unknown>;
      const token = bounded(body.token, 4096) ?? bounded(body.access_token, 4096);
      if (token) this.cachedToken = { value: token, until: Date.now() + 60_000 };
      return token;
    })();
    this.pendingToken = pending;
    try {
      return await untilAborted(pending, signal);
    } finally {
      if (this.pendingToken === pending) this.pendingToken = undefined;
    }
  }
  async lookup(inn: string, signal?: AbortSignal): Promise<RegistryCompany | null> {
    if (!validInn(inn) || signal?.aborted) return null;
    // One five-second budget covers authorization, retries and response bodies together.
    const budget = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000);
    const token = await this.token(budget);
    if (!token || budget.aborted) return null;
    const result = await this.json(
      `https://api.sbis.ru/vok/req?inn=${encodeURIComponent(inn)}`,
      {
        method: 'GET',
        headers: { 'X-SBISAccessToken': token, Accept: 'application/json' },
      },
      budget,
    );
    if (!Array.isArray(result)) return null;
    const matches = result.filter((row) => row && typeof row === 'object' && row.inn === inn);
    if (matches.length !== 1) return null;
    const row = matches[0] as Record<string, unknown>;
    const name = bounded(row.company_short_name, 200) ?? bounded(row.company_name, 200);
    if (!name) return null;
    const city = registrationCity(row);
    const okved = bounded(row.main_okved, 150) ?? bounded(row.okved, 150);
    const legalForm =
      importedLegalForm(name) ?? importedLegalForm(bounded(row.legal_form_text, 200) || '');
    return {
      name,
      ...(city ? { registrationCity: city } : {}),
      ...(okved ? { okved } : {}),
      ...(legalForm ? { legalForm } : {}),
    };
  }
}
/** Instantiate once per import. Cache only the minimal projection, including unsuccessful lookups. */
export function cachedRegistry(registry: Registry): Registry {
  const lookups = new Map<string, Promise<RegistryCompany | null>>();
  return {
    lookup: async (inn, signal) => {
      if (!validInn(inn) || signal?.aborted) return null;
      if (!lookups.has(inn))
        lookups.set(
          inn,
          registry.lookup(inn, signal).catch(() => null),
        );
      const result = await untilAborted(lookups.get(inn)!, signal);
      return result ? { ...result } : null;
    },
  };
}
