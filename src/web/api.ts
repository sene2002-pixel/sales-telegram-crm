export let token = sessionStorage.getItem('crm-session') || '';
export function setToken(value: string) {
  token = value;
  if (value) sessionStorage.setItem('crm-session', value);
  else sessionStorage.removeItem('crm-session');
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ message: 'Сервер недоступен' }));
    throw new Error(data.message || 'Ошибка запроса');
  }
  return response.json();
}
export async function download(path: string, name: string) {
  const telegram = window.Telegram?.WebApp;
  if (telegram?.initData && /^\/files\/[^/]+$/.test(path)) {
    if (!telegram.downloadFile || !telegram.isVersionAtLeast?.('8.0'))
      throw new Error('Обновите Telegram для скачивания файлов');
    if (window.location.protocol !== 'https:')
      throw new Error('Для скачивания в Telegram нужен HTTPS');
    const file = await api<{ path: string; filename: string }>(`${path}/download-link`, 'POST');
    const url = new URL(file.path, window.location.origin).href;
    await new Promise<void>((resolve, reject) => {
      telegram.downloadFile!({ url, file_name: file.filename }, (accepted) =>
        accepted ? resolve() : reject(new Error('Скачивание отменено')),
      );
    });
    return;
  }
  const response = await fetch('/api' + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }
  const url = URL.createObjectURL(await response.blob()),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const money = (n: number | null | undefined) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        maximumFractionDigits: 0,
      }).format(n);
