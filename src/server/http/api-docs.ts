import { Express, Request, Response } from 'express';
import { openApiDocument } from './openapi-document';

export type ApiDocsOptions = {
  enabled: boolean;
  // Caller must authenticate the session against the DB on every request and require active admin.
  authorize: (request: Request) => Promise<void>;
};
const shell = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pico API reference</title><link rel="stylesheet" href="/api/docs/swagger-ui.css"><link rel="stylesheet" href="/api/docs/docs-shell.css"></head>
<body><main id="docs-login"><h1>Pico API reference</h1><p>Документация доступна действующему администратору. Токен используется только в памяти этой страницы; выполнение API здесь отключено.</p><form id="docs-auth" autocomplete="off"><label for="docs-token">Токен текущей сессии</label><input id="docs-token" type="password" autocomplete="off" maxlength="4096" required spellcheck="false"><button type="submit">Открыть документацию</button></form><p id="docs-status" role="status"></p></main><div id="swagger-ui"></div><script src="/api/docs/swagger-ui-bundle.js" defer></script><script src="/api/docs/docs-bootstrap.js" defer></script></body></html>`;
const css = `body{margin:0;background:#fafafa;font-family:system-ui,sans-serif}#docs-login{max-width:720px;margin:32px auto;padding:16px}#docs-auth{display:flex;flex-wrap:wrap;gap:12px}#docs-auth label{width:100%}#docs-token{flex:1;min-width:160px;font:inherit;padding:10px}#docs-auth button{font:inherit;padding:10px}#docs-status{min-height:24px}.swagger-ui{padding:16px}`;
// No token is put in Swagger's authorization state, storage, links, logs or embedded HTML.
// The schema is fetched with a fresh admin check. No CDN/configUrl/validator can be chosen by URL.
const bootstrap = `'use strict';
(() => {
  const form = document.getElementById('docs-auth');
  const input = document.getElementById('docs-token');
  const status = document.getElementById('docs-status');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    let token = input.value.trim().replace(/^Bearer\\s+/i, '');
    input.value = '';
    if (!token || token.length > 4096) { status.textContent = 'Введите токен сессии.'; return; }
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = 'Проверяем доступ…';
    try {
      const response = await fetch('/api/docs/openapi.json', { cache: 'no-store', credentials: 'omit', headers: { Authorization: 'Bearer ' + token } });
      token = '';
      if (!response.ok) {
        status.textContent = response.status === 401 ? 'Сессия недействительна или истекла.' : response.status === 403 ? 'Документация доступна только действующему администратору.' : 'Не удалось загрузить документацию.';
        return;
      }
      const spec = await response.json();
      window.SwaggerUIBundle({ spec, dom_id: '#swagger-ui', presets: [window.SwaggerUIBundle.presets.apis], supportedSubmitMethods: [], tryItOutEnabled: false, persistAuthorization: false, queryConfigEnabled: false, validatorUrl: null, deepLinking: false, withCredentials: false, syntaxHighlight: false, defaultModelRendering: 'model', defaultModelsExpandDepth: 0 });
      status.textContent = 'Доступ проверен. Выполнение запросов отключено.';
    } catch { status.textContent = 'Не удалось загрузить документацию.'; }
    finally { token = ''; button.disabled = false; }
  });
})();`;
function headers(response: Response) {
  response.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // Route-specific policy is stricter than the application policy; no unsafe inline/eval/CDN.
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
}
export function mountApiDocs(app: Express, options: ApiDocsOptions) {
  const assets: Record<string, { type: string; body?: string; file?: string }> = {
    'swagger-ui-bundle.js': {
      type: 'application/javascript',
      file: require.resolve('swagger-ui-dist/swagger-ui-bundle.js'),
    },
    'swagger-ui.css': { type: 'text/css', file: require.resolve('swagger-ui-dist/swagger-ui.css') },
    'docs-bootstrap.js': { type: 'application/javascript', body: bootstrap },
    'docs-shell.css': { type: 'text/css', body: css },
  };
  // Explicit allowlist, never express.static(docs), filesystem lookup or arbitrary :asset names.
  for (const [name, asset] of Object.entries(assets))
    app.get('/api/docs/' + name, (_request, response) => {
      headers(response);
      if (!options.enabled) {
        response.status(404).json({ message: 'Не найдено' });
        return;
      }
      response.type(asset.type);
      if (asset.file) response.sendFile(asset.file);
      else response.send(asset.body);
    });
  app.get('/api/docs', (_request, response) => {
    headers(response);
    if (!options.enabled) {
      response.status(404).json({ message: 'Не найдено' });
      return;
    }
    response.type('html').send(shell);
  });
  app.get('/api/docs/openapi.json', async (request, response) => {
    headers(response);
    if (!options.enabled) {
      response.status(404).json({ message: 'Не найдено' });
      return;
    }
    try {
      await options.authorize(request);
      response.json(openApiDocument);
    } catch (error) {
      const status =
        typeof (error as any)?.status === 'number' &&
        [401, 403, 429].includes((error as any).status)
          ? (error as any).status
          : 500;
      response.status(status).json({
        message:
          status === 401
            ? 'Необходим вход'
            : status === 403
              ? 'Документация доступна только администратору'
              : status === 429
                ? 'Слишком много запросов'
                : 'Внутренняя ошибка сервера',
      });
    }
  });
}
