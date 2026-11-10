import { AnalyticsSummary } from '../shared/analytics';
import { api, today, token } from './api';
let session = '';
const requests = new Map<string, Promise<AnalyticsSummary>>();
export function invalidateClientScores() {
  requests.clear();
}
export function loadClientScores(employeeId = '') {
  const captured = token;
  if (session !== captured) {
    session = captured;
    requests.clear();
  }
  const date = today();
  const key = `${employeeId}:${date}`;
  const existing = requests.get(key);
  if (existing) return existing;
  const request = api<AnalyticsSummary>(
    `/analytics?mode=all&from=${date}&to=${date}${employeeId ? `&employeeId=${encodeURIComponent(employeeId)}` : ''}`,
  ).then((result) => {
    if (captured !== token) throw new Error('Сессия изменилась. Обновите страницу.');
    return result;
  });
  requests.set(key, request);
  const clear = () => {
    if (requests.get(key) === request) requests.delete(key);
  };
  void request.then(clear, clear);
  return request;
}
