import { CompanyData } from './contracts';
export type AnalyticsSummary = {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  funnel: { key: string; label: string; count: number }[];
  conversion: number | null;
  conversionDelta: number | null;
  activeClients: number;
  activeDelta: number | null;
  historyIncomplete: number;
};
export type HistoricalCompany = {
  id: string;
  data: CompanyData;
  created_at: string | Date;
  updated_at: string | Date;
};
export type CompanyEvent = {
  company_id: string;
  action: string;
  details: any;
  created_at: string | Date;
};
export function previousRange(from: string, to: string) {
  const first = new Date(from + 'T12:00:00Z'),
    last = new Date(to + 'T12:00:00Z');
  const length = Math.round((+last - +first) / 86400000) + 1;
  const previousTo = new Date(+first - 86400000).toISOString().slice(0, 10);
  const previousFrom = new Date(+first - length * 86400000).toISOString().slice(0, 10);
  return { previousFrom, previousTo };
}
export function summarizeAnalytics(
  companies: HistoricalCompany[],
  events: CompanyEvent[],
  from: string,
  to: string,
  timezone: string,
  now = new Date(),
): AnalyticsSummary {
  const day = (date: string | Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(date));
  const today = day(now),
    range = previousRange(from, to);
  const history = new Map<string, CompanyEvent[]>();
  for (const event of [...events].sort(
    (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
  )) {
    const list = history.get(event.company_id) || [];
    list.push(event);
    history.set(event.company_id, list);
  }
  const snapshot = (company: HistoricalCompany, cutoff: string): CompanyData | null | undefined => {
    if (day(company.created_at) > cutoff) return undefined;
    if (cutoff >= today) return company.data;
    const records = history.get(company.id) || [];
    const birth = records.find((e) => e.action === 'company.created' && e.details?.after);
    const firstUpdate = records.find((e) => e.details?.before?.stage);
    let state: CompanyData | null =
      birth?.details.after ||
      firstUpdate?.details.before ||
      (day(company.updated_at) <= cutoff ? company.data : null);
    for (const event of records) {
      if (day(event.created_at) > cutoff) break;
      if (event.details?.after?.stage) state = event.details.after;
      if (state && event.action === 'company.archived') state = { ...state, archived: true };
      if (state && event.action === 'company.restored') state = { ...state, archived: false };
    }
    return state;
  };
  const metrics = (first: string, last: string) => {
    const states = companies.map((c) => ({ company: c, state: snapshot(c, last) }));
    const incomplete = states.filter((s) => s.state === null).length;
    const active = states.filter((s) => s.state && !s.state.archived);
    const cohort = active.filter(
      (s) => day(s.company.created_at) >= first && day(s.company.created_at) <= last,
    );
    const closed = cohort.filter((s) => s.state!.stage === 'closed').length;
    const conversion = cohort.length && !incomplete ? (closed / cohort.length) * 100 : null;
    return { active, cohort, conversion, incomplete };
  };
  const current = metrics(from, to),
    previous = metrics(range.previousFrom, range.previousTo);
  // These labels keep the actual CRM stage semantics, rather than inventing a sent quote.
  const stageLabels: Record<string, string> = {
    new: 'Новые',
    dialogue: 'В работе',
    proposal: 'Предложение',
    supply: 'Поставки',
    closed: 'Закрыто',
  };
  const funnel = Object.entries(stageLabels).map(([key, label]) => ({
    key,
    label,
    count: current.cohort.filter((c) => c.state!.stage === key).length,
  }));
  return {
    from,
    to,
    ...range,
    funnel,
    conversion: current.conversion,
    conversionDelta:
      current.conversion !== null && previous.conversion !== null
        ? current.conversion - previous.conversion
        : null,
    activeClients: current.active.length,
    activeDelta:
      !current.incomplete && !previous.incomplete && previous.active.length
        ? ((current.active.length - previous.active.length) / previous.active.length) * 100
        : null,
    historyIncomplete: current.incomplete + previous.incomplete,
  };
}
