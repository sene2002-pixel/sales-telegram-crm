import { Actor, dateSchema, idSchema } from '../../shared/contracts';
import {
  confirmed,
  directionLabels,
  projectSales,
  salesUpdateSchema,
  SalesEvent,
} from '../../shared/sales';
import { Database } from '../infra/database';
import { requireCondition } from '../domain/errors';
import { isLeader } from './auth';

const statuses: Record<string, string> = {
  implementation: 'в реализации',
  calculation: 'в просчёте',
  tender: 'тендер',
  potential: 'потенциал',
};
const verbs: Record<string, string> = {
  received: 'Получили',
  shipped: 'Отгрузили',
  recalculated: 'Пересчитали',
  approved: 'Согласовали',
  won: 'Забрали',
};
const rubles = (n: number) => `${n.toLocaleString('ru-RU')} руб.`;
const clean = (s: string) =>
  s
    .replace(/[\r\n]+/g, ' ')
    .replace(/[—–]/g, '-')
    .replace(/дешевле/giu, 'выгодно')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '');
export class CommercialReportService {
  constructor(private db: Database) {}
  async generate(actor: Actor, from: string, to: string, authorId?: string) {
    requireCondition(
      isLeader(actor),
      403,
      'Коммерческий отчёт доступен руководителю и администратору',
    );
    dateSchema.parse(from);
    dateSchema.parse(to);
    requireCondition(from <= to, 400, 'Неверный период');
    if (authorId) idSchema.parse(authorId);
    const rows = await this.db.query(
      `SELECT r.id,r.company_id,r.author_id,r.data,r.created_at,c.data AS company_data
      FROM records r JOIN companies c ON c.id=r.company_id
      WHERE r.kind='activity' AND NOT r.deleted
      AND r.data->>'occurredOn'<=$1 ORDER BY r.created_at,r.id`,
      [to],
    );
    const companies = new Map<string, { name: string; events: SalesEvent[]; period: any[] }>();
    for (const r of rows) {
      const parsed = salesUpdateSchema.safeParse(r.data.sales);
      if (!parsed.success) continue;
      const c: { name: string; events: SalesEvent[]; period: any[] } = companies.get(
        r.company_id,
      ) || { name: r.company_data.name, events: [], period: [] };
      c.events.push({
        id: r.id,
        occurredOn: r.data.occurredOn,
        createdAt: new Date(r.created_at).toISOString(),
        sales: parsed.data,
      });
      if (r.data.occurredOn >= from && (!authorId || r.author_id === authorId)) c.period.push(r);
      companies.set(r.company_id, c);
    }
    const totals = { confirmed: 0, in_work: 0, potential: 0 };
    const resultTotals = { confirmed: 0, in_work: 0, potential: 0 };
    const resultApproximate = { confirmed: false, in_work: false, potential: false };
    const resultCount = { confirmed: 0, in_work: 0, potential: 0 };
    const approximate = { confirmed: false, in_work: false, potential: false };
    const clients: { company: string; text: string }[] = [];
    for (const c of companies.values()) {
      const p = projectSales(c.events);
      if (p.current.client.disposition && p.current.client.disposition.status !== 'active')
        continue;
      if (!c.period.length) continue;
      const changed = new Set<string>();
      const results = new Map<
        string,
        {
          dealKey: string | null;
          text: string;
          amount: number | null;
          volume: 'confirmed' | 'in_work' | 'potential' | null;
          approximate: boolean;
        }
      >();
      for (const r of c.period) {
        const s = salesUpdateSchema.parse(r.data.sales);
        for (const key of p.eventKeys[r.id] || []) changed.add(key);
        for (const [i, result] of s.results.entries()) {
          // Repeated extraction of the same dated commercial event does not count twice.
          const key = JSON.stringify([
            r.data.occurredOn,
            result.dealName,
            result.endCustomer,
            result.verb,
            result.detail,
            result.amount,
          ]);
          const amount = confirmed(result.amount);
          const projectKey = p.resultKeys[r.id]?.[i] || null;
          if (projectKey) changed.add(projectKey);
          results.set(key, {
            dealKey: projectKey,
            amount,
            volume: confirmed(result.volume),
            approximate: result.approximate,
            text: `${result.dealName ? `${clean(result.dealName)}: ` : 'Проект не указан: '}${verbs[result.verb]} ${clean(result.detail)}${amount === null ? '' : ` - ${result.approximate ? 'около ' : ''}${rubles(amount)}`}`,
          });
        }
      }
      const lines: string[] = [];
      for (const item of p.deals.filter((d) => changed.has(d.key))) {
        const d = item.deal;
        const amount = confirmed(d.amount),
          category = confirmed(d.volume),
          approx = confirmed(d.approximate) === true;
        // Never infer confirmed volume from a quote, meeting, status or deal amount alone.
        const identified = !!d.name && !item.key.startsWith('ambiguous:');
        if (identified && amount !== null && category) {
          totals[category] += amount;
          approximate[category] ||= approx;
        }
        lines.push(
          `${clean(c.name)} / ${clean(d.name || 'Проект не указан')} (${statuses[confirmed(d.status) || ''] || 'статус не указан'}, ${directionLabels[d.direction || ''] || 'направление не указано'}, ${amount === null ? 'сумма не указана' : `${approx ? 'около ' : ''}${rubles(amount)}`})`,
        );
        if (!identified)
          lines.push('- Привязка проекта не определена; объём не включён в общие суммы');
        const dealResults = [...results.values()].filter((r) => r.dealKey === item.key);
        lines.push(
          ...(dealResults.length
            ? dealResults.map((r) => `- ${r.text}`)
            : ['- Коммерческий результат за период не указан']),
        );
        lines.push(
          `- ${confirmed(d.competitor) ? `Текущий вендор: ${clean(confirmed(d.competitor)!)}` : `Что мешает: ${clean(confirmed(d.blocker) || 'не указано')}`}`,
        );
        lines.push(
          `- Следующий шаг: ${clean(confirmed(d.nextStep) || 'не указано')}; срок: ${confirmed(d.nextDue) || 'не указано'}`,
        );
      }
      if (!lines.length) lines.push(`${clean(c.name)} (данные сделки не указаны)`);
      const unmatched = [...results.values()].filter((r) => !r.dealKey);
      if (unmatched.length)
        lines.push(
          'Результаты клиента без привязки к проекту:',
          ...unmatched.map((r) => `- ${r.text}`),
        );
      for (const r of results.values())
        if (r.amount !== null && r.volume) {
          resultTotals[r.volume] += r.amount;
          resultApproximate[r.volume] ||= r.approximate;
          resultCount[r.volume]++;
        }
      clients.push({ company: c.name, text: lines.join('\n') });
    }
    const headline = `Период ${from} - ${to}. Подтверждённый результат: ${resultCount.confirmed ? `${resultApproximate.confirmed ? 'около ' : ''}${rubles(resultTotals.confirmed)}` : 'не указан'}. Подтверждённый объём сделок: ${approximate.confirmed ? 'около ' : ''}${rubles(totals.confirmed)}.\nВ работе: ${approximate.in_work ? 'около ' : ''}${rubles(totals.in_work)}; потенциал: ${approximate.potential ? 'около ' : ''}${rubles(totals.potential)}.`;
    return {
      from,
      to,
      totals,
      approximate,
      resultTotals,
      resultApproximate,
      clients,
      text:
        headline +
        '\n\n' +
        (clients.map((c) => c.text).join('\n\n') ||
          'Нет структурированных коммерческих данных за период.'),
    };
  }
}
