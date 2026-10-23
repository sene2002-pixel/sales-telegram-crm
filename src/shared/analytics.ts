import { CompanyData } from './contracts';
export type AnalyticsSummary = {
  clientAnalytics?: ClientAnalytics;
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

export type ClientLevel = 'new' | 'acquaintance' | 'development' | 'partner' | 'ours';
export type MetricComparison = {
  kind: 'none' | 'percent' | 'new' | 'unavailable';
  percent: number | null;
  tone: 'neutral' | 'positive' | 'negative';
};
export type ClientScore = {
  id: string;
  score: number;
  level: ClientLevel;
  base: {
    task: boolean;
    contacts: boolean;
    potential: boolean;
    meeting: boolean;
    project: boolean;
  };
  regularity: { task: boolean; meeting: boolean; project: boolean };
};
export type ClientAnalytics = {
  ruleVersion: 1;
  asOf: string;
  settings: import('./contracts').AnalyticsSettings;
  clientFunnel: { key: ClientLevel; label: string; count: number }[];
  clients: ClientScore[];
  metrics: {
    potential: { value: number | null; companies: number; delta: MetricComparison };
    projects: { value: number | null; count: number; delta: MetricComparison };
    growth: { value: number | null; share: number | null; delta: MetricComparison };
    active: { value: number | null; total: number; delta: MetricComparison };
  };
  historyIncomplete: number;
  contactSourcesUnknown: number;
};
export type AnalyticsRecord = {
  id: string;
  company_id: string;
  kind: string;
  data: any;
  contact_source: string;
  created_at: string | Date;
  version: number;
  deleted: boolean;
};
export type AnalyticsEvent = CompanyEvent & {
  entity_id: string;
  analytics_seq?: number;
  analytics_order_proven?: boolean;
};
export function compareMetric(
  current: number | null,
  previous: number | null,
  all = false,
): MetricComparison {
  if (all) return { kind: 'none', percent: null, tone: 'neutral' };
  if (current === null || previous === null)
    return { kind: 'unavailable', percent: null, tone: 'neutral' };
  if (previous === 0)
    return {
      kind: current > 0 ? 'new' : 'none',
      percent: null,
      tone: 'neutral',
    };
  const raw = ((current - previous) / previous) * 100;
  const percent = Math.abs(raw) < 1 ? 0 : raw;
  return {
    kind: 'percent',
    percent,
    tone: percent > 0 ? 'positive' : percent < 0 ? 'negative' : 'neutral',
  };
}
export function companyPotential(
  data: Pick<CompanyData, 'potential' | 'divisions'>,
): number | null {
  if (data.potential !== null && data.potential !== undefined) return data.potential;
  const amounts = Object.values(data.divisions || {}).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  return amounts.length ? amounts.reduce((sum, value) => sum + value, 0) : null;
}
export function projectPotential(data: any): number | null {
  if (typeof data.amount === 'number') return data.amount;
  const amounts = (data.equipment || []).map((r: any) => r.amount);
  if (!amounts.length || amounts.some((v: any) => typeof v !== 'number')) return null;
  return amounts.reduce((sum: number, value: number) => sum + value, 0);
}
function subtractCalendarMonths(day: string, months: number) {
  const [year, month, date] = day.split('-').map(Number);
  const first = new Date(Date.UTC(year!, month! - 1 - months, 1));
  const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date!, end));
  return first.toISOString().slice(0, 10);
}
export function summarizeClientAnalytics(
  companies: HistoricalCompany[],
  records: AnalyticsRecord[],
  events: AnalyticsEvent[],
  from: string,
  to: string,
  timezone: string,
  settings: import('./contracts').AnalyticsSettings,
  mode: 'all' | 'range' = 'range',
  now = new Date(),
): ClientAnalytics {
  const day = (date: string | Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(date));
  const withinCutoff = (date: string | Date, cutoff: string) =>
    day(date) <= cutoff && +new Date(date) <= +now;
  const today = day(now),
    asOf = to < today && mode !== 'all' ? to : today;
  const ordered = [...events].sort((a, b) => {
    const dateDifference = +new Date(a.created_at) - +new Date(b.created_at);
    if (dateDifference) return dateDifference;
    if (
      a.analytics_order_proven &&
      b.analytics_order_proven &&
      a.analytics_seq !== undefined &&
      b.analytics_seq !== undefined
    )
      return Number(a.analytics_seq) - Number(b.analytics_seq);
    if (a.entity_id !== b.entity_id) return 0;
    const revision = (event: AnalyticsEvent) =>
      event.details?.recordVersion ??
      (event.action.endsWith('.created') ? 0 : (event.details?.before?.version ?? 0));
    return revision(a) - revision(b);
  });
  const companyEvents = (id: string) =>
    ordered.filter(
      (e) =>
        e.company_id === id && (e.action.startsWith('company.') || e.action === 'report.applied'),
    );
  const ambiguousHistory = (id: string, cutoff: string, first?: string) => {
    const groups = new Map<string, AnalyticsEvent[]>();
    for (const event of companyEvents(id)) {
      if (!withinCutoff(event.created_at, cutoff) || (first && day(event.created_at) < first))
        continue;
      const timestamp = new Date(event.created_at).toISOString();
      groups.set(timestamp, [...(groups.get(timestamp) || []), event]);
    }
    return [...groups.values()].some(
      (group) =>
        group.length > 1 &&
        !group.every((event) => event.analytics_order_proven && event.analytics_seq !== undefined),
    );
  };
  const recordEvents = (id: string) =>
    ordered.filter((e) => e.entity_id === id && /^(task|contact|project)\./.test(e.action));
  const applyCompany = (state: CompanyData | null, event: AnalyticsEvent): CompanyData | null => {
    if (event.details?.after?.stage) return event.details.after;
    if (event.action === 'report.applied' && event.details?.before) {
      const before = state || event.details.before,
        block = event.details.block;
      if (!block) return null;
      return {
        ...before,
        ...(block.stage !== null ? { stage: block.stage } : {}),
        ...(block.potential !== null ? { potential: block.potential } : {}),
        divisions: {
          ...before.divisions,
          ...Object.fromEntries((block.divisions || []).map((d: any) => [d.key, d.amount])),
        },
      };
    }
    if (state && event.action === 'company.archived') return { ...state, archived: true };
    if (state && event.action === 'company.restored') return { ...state, archived: false };
    return state;
  };
  const companyAt = (
    company: HistoricalCompany,
    cutoff: string,
  ): CompanyData | null | undefined => {
    if (!withinCutoff(company.created_at, cutoff)) return undefined;
    if (cutoff >= today && +new Date(company.updated_at) <= +now) return company.data;
    if (ambiguousHistory(company.id, cutoff)) return null;
    const history = companyEvents(company.id);
    const first = history.find((e) => e.details?.after?.stage || e.details?.before?.stage);
    let state: CompanyData | null =
      first?.action === 'company.created'
        ? first.details.after
        : first?.details.before || (day(company.updated_at) <= cutoff ? company.data : null);
    for (const event of history)
      if (withinCutoff(event.created_at, cutoff)) state = applyCompany(state, event);
    return state;
  };
  const recordAt = (
    record: AnalyticsRecord,
    cutoff: string,
  ): { data: any; source: string; deleted: boolean } | null | undefined => {
    if (!withinCutoff(record.created_at, cutoff)) return undefined;
    if (
      cutoff >= today &&
      !recordEvents(record.id).some((event) => +new Date(event.created_at) > +now)
    )
      return {
        data: record.data,
        source: record.contact_source || 'unknown',
        deleted: record.deleted,
      };
    const history = recordEvents(record.id);
    const grouped = new Map<string, AnalyticsEvent[]>();
    for (const event of history.filter((event) => withinCutoff(event.created_at, cutoff))) {
      const timestamp = new Date(event.created_at).toISOString();
      grouped.set(timestamp, [...(grouped.get(timestamp) || []), event]);
    }
    if (
      [...grouped.values()].some(
        (group) =>
          group.length > 1 &&
          !group.every(
            (event) => event.analytics_order_proven && event.analytics_seq !== undefined,
          ) &&
          !group.every(
            (event) =>
              Number.isInteger(event.details?.recordVersion) && event.details.recordVersion > 0,
          ),
      )
    )
      return null;

    const first = history.find(
      (e) => e.details?.recordAfter || e.details?.recordBefore || e.details?.before,
    );
    let state: any = first?.action.endsWith('.created')
      ? first.details.recordAfter
      : first?.details.recordBefore ||
        (first?.details.before
          ? { data: first.details.before, contactSource: record.contact_source, deleted: false }
          : record.version === 1 && !record.deleted
            ? { data: record.data, contactSource: record.contact_source, deleted: false }
            : null);
    for (const event of history) {
      if (!withinCutoff(event.created_at, cutoff)) continue;
      if (event.details?.recordAfter) state = event.details.recordAfter;
      else if (event.details?.after && state) state = { ...state, data: event.details.after };
      else if (event.action.endsWith('.deleted') && state) state = { ...state, deleted: true };
    }
    return state
      ? { data: state.data, source: state.contactSource || 'unknown', deleted: !!state.deleted }
      : null;
  };
  const level = (score: number): ClientLevel =>
    score === 0
      ? 'new'
      : score <= 2
        ? 'acquaintance'
        : score <= 5
          ? 'development'
          : score <= 7
            ? 'partner'
            : 'ours';
  const companyIds = new Set(companies.map((company) => company.id));
  const involves = (record: AnalyticsRecord, data: any) =>
    companyIds.has(record.company_id) ||
    (record.kind === 'project' &&
      data?.participants?.some((participant: any) => companyIds.has(participant.companyId)));
  const relevantRecords = records.filter(
    (record) =>
      involves(record, record.data) ||
      recordEvents(record.id).some(
        (event) =>
          involves(record, event.details?.recordBefore?.data || event.details?.before) ||
          involves(record, event.details?.recordAfter?.data || event.details?.after),
      ),
  );
  const snapshot = (cutoff: string) => {
    const states = companies.map((company) => ({ company, data: companyAt(company, cutoff) }));
    const visible = states.filter((entry) => entry.data && !entry.data.archived);
    const recordStates = relevantRecords.map((record) => ({
      record,
      state: recordAt(record, cutoff),
    }));
    const alive = recordStates.filter((entry) => entry.state && !entry.state.deleted);
    const projects = alive.filter(
      (entry) =>
        entry.record.kind === 'project' &&
        visible.some(
          (c) =>
            c.company.id === entry.record.company_id ||
            entry.state!.data.participants?.some((p: any) => p.companyId === c.company.id),
        ),
    );
    const taskCutoff = new Date(+new Date(cutoff + 'T12:00:00Z') - settings.taskDays * 86400000)
      .toISOString()
      .slice(0, 10);
    const meetingCutoff = subtractCalendarMonths(cutoff, settings.meetingMonths),
      projectCutoff = subtractCalendarMonths(cutoff, settings.projectMonths);
    const scores: ClientScore[] = visible.map(({ company, data }) => {
      const own = alive.filter((entry) => entry.record.company_id === company.id);
      const tasks = own.filter((entry) => entry.record.kind === 'task');
      const meetings = tasks.filter(
        (entry) => entry.state!.data.type === 'meeting' && entry.state!.data.done === true,
      );
      const linkedProjects = projects.filter(
        (entry) =>
          entry.record.company_id === company.id ||
          entry.state!.data.participants?.some((p: any) => p.companyId === company.id),
      );
      const base = {
        task: tasks.length > 0,
        contacts:
          own.filter((entry) => entry.record.kind === 'contact' && entry.state!.source === 'user')
            .length > 1,
        potential: companyPotential(data!) !== null,
        meeting: meetings.length > 0,
        project: linkedProjects.length > 0,
      };
      const regularity = {
        task: tasks.some((entry) => day(entry.record.created_at) >= taskCutoff),
        meeting: meetings.some((entry) => day(entry.record.created_at) >= meetingCutoff),
        project: linkedProjects.some((entry) => day(entry.record.created_at) >= projectCutoff),
      };
      const score = [...Object.values(base), ...Object.values(regularity)].filter(Boolean).length;
      return { id: company.id, score, level: level(score), base, regularity };
    });
    const companyIncomplete = states.filter((entry) => entry.data === null).length;
    const recordIncomplete = recordStates.filter((entry) => entry.state === null).length;
    const projectIncomplete = recordStates.filter(
      (entry) => entry.record.kind === 'project' && entry.state === null,
    ).length;
    return {
      visible,
      alive,
      projects,
      scores,
      companyIncomplete,
      recordIncomplete,
      projectIncomplete,
      incomplete: companyIncomplete + recordIncomplete,
    };
  };
  const startDay = (first: string) =>
    new Date(+new Date(first + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  const holdingChildrenByDay = new Map<string, Set<string>>();
  const holdingsWithChildrenAt = (cutoff: string) => {
    let ids = holdingChildrenByDay.get(cutoff);
    if (!ids) {
      ids = new Set<string>();
      for (const company of companies) {
        const state = companyAt(company, cutoff);
        if (state && !state.archived && state.holdingId) ids.add(state.holdingId);
      }
      holdingChildrenByDay.set(cutoff, ids);
    }
    return ids;
  };
  const period = (first: string, last: string, all = false) => {
    const end = snapshot(last),
      start = snapshot(startDay(first));
    const ids = new Set(end.visible.map((entry) => entry.company.id));
    const eligibleEvents = ordered.filter(
      (event) =>
        ids.has(event.company_id) &&
        day(event.created_at) >= first &&
        withinCutoff(event.created_at, last),
    );
    let potential: number | null = 0;
    let potentialCompanies = new Set<string>();
    const financialEntries = end.visible.filter(
      (entry) =>
        entry.data!.segment !== 'holding' ||
        !end.visible.some((child) => child.data!.holdingId === entry.company.id),
    );
    if (all) {
      potential = end.companyIncomplete
        ? null
        : financialEntries.reduce((sum, entry) => sum + (companyPotential(entry.data!) || 0), 0);
      potentialCompanies = new Set(
        financialEntries
          .filter((entry) => companyPotential(entry.data!) !== null)
          .map((entry) => entry.company.id),
      );
    } else {
      for (const event of eligibleEvents.filter(
        (e) =>
          e.action === 'company.created' ||
          e.action === 'company.updated' ||
          e.action === 'company.sales_updated' ||
          e.action === 'report.applied',
      )) {
        if (event.details?.holdingAllocation) continue;
        const before =
          event.action === 'company.created'
            ? 0
            : event.details?.analyticsBefore || event.details?.before
              ? companyPotential(event.details.analyticsBefore || event.details.before)
              : undefined;
        const afterData = applyCompany(event.details?.before || null, event);
        // A group's temporary estimate stops contributing once linked customers are present.
        if (
          afterData?.segment === 'holding' &&
          holdingsWithChildrenAt(day(event.created_at)).has(event.company_id)
        )
          continue;
        const after = afterData ? companyPotential(afterData) : undefined;
        if (before === undefined || after === undefined) {
          potential = null;
          continue;
        }
        const increase = Math.max(0, (after || 0) - (before || 0));
        if (increase > 0) {
          if (potential !== null) potential += increase;
          potentialCompanies.add(event.company_id);
        }
      }
      if (
        end.companyIncomplete ||
        start.companyIncomplete ||
        end.visible.some((entry) => ambiguousHistory(entry.company.id, last, first))
      )
        potential = null;
    }
    const periodProjects = end.projects.filter(
      (entry) =>
        all || (day(entry.record.created_at) >= first && day(entry.record.created_at) <= last),
    );
    const projectAmounts = periodProjects.map((entry) => projectPotential(entry.state!.data));
    const projectValue = projectAmounts.some((value) => value === null)
      ? null
      : projectAmounts.reduce<number>((sum, value) => sum + (value || 0), 0);
    const startLevels = new Map(start.scores.map((score) => [score.id, score.level]));
    const levels: ClientLevel[] = ['new', 'acquaintance', 'development', 'partner', 'ours'];
    const grew = end.scores.filter((score) =>
      all
        ? score.level !== 'new'
        : levels.indexOf(score.level) > levels.indexOf(startLevels.get(score.id) || 'new'),
    ).length;
    const activityEvents = ordered.filter(
      (event) =>
        /^(task|contact|project)\.(created|updated)$/.test(event.action) &&
        withinCutoff(event.created_at, last) &&
        (all || (day(event.created_at) >= first && withinCutoff(event.created_at, last))),
    );
    const activeIds = new Set(
      activityEvents.map((event) => event.company_id).filter((id) => ids.has(id)),
    );
    // An action belongs to every proven participant at that action, even if later removed.
    for (const event of activityEvents.filter((event) => event.action.startsWith('project.'))) {
      const snapshots = [
        event.details?.recordBefore?.data || event.details?.before,
        event.details?.recordAfter?.data || event.details?.after,
      ];
      for (const snapshot of snapshots)
        for (const participant of snapshot?.participants || [])
          if (ids.has(participant.companyId)) activeIds.add(participant.companyId);
    }
    for (const entry of end.alive) {
      if (!['task', 'contact', 'project'].includes(entry.record.kind)) continue;
      const hasAction =
        all ||
        (day(entry.record.created_at) >= first && day(entry.record.created_at) <= last) ||
        activityEvents.some((event) => event.entity_id === entry.record.id);
      if (!hasAction) continue;
      if (ids.has(entry.record.company_id)) activeIds.add(entry.record.company_id);
      if (entry.record.kind === 'project')
        for (const participant of entry.state!.data.participants || [])
          if (ids.has(participant.companyId)) activeIds.add(participant.companyId);
    }
    return {
      ...end,
      potential,
      potentialCompanies: potentialCompanies.size,
      projectValue: end.projectIncomplete || end.companyIncomplete ? null : projectValue,
      projectCount: periodProjects.length,
      growth: !all && (start.incomplete || end.incomplete) ? null : grew,
      active: !all && end.incomplete ? null : activeIds.size,
    };
  };
  const all = mode === 'all',
    current = period(from, asOf, all),
    range = previousRange(from, asOf),
    previous = period(range.previousFrom, range.previousTo);
  const labels: Record<ClientLevel, string> = {
    new: 'Новый',
    acquaintance: 'Знакомство',
    development: 'Развитие',
    partner: 'Партнёр',
    ours: 'Наш клиент',
  };
  return {
    ruleVersion: 1,
    asOf,
    settings,
    clients: current.scores,
    clientFunnel: (Object.keys(labels) as ClientLevel[]).map((key) => ({
      key,
      label: labels[key],
      count: current.scores.filter((score) => score.level === key).length,
    })),
    metrics: {
      potential: {
        value: current.potential,
        companies: current.potentialCompanies,
        delta: compareMetric(current.potential, previous.potential, all),
      },
      projects: {
        value: current.projectValue,
        count: current.projectCount,
        delta: compareMetric(current.projectValue, previous.projectValue, all),
      },
      growth: {
        value: current.growth,
        share:
          current.growth === null || !current.scores.length
            ? null
            : (current.growth / current.scores.length) * 100,
        delta: compareMetric(current.growth, previous.growth, all),
      },
      active: {
        value: current.active,
        total: current.scores.length,
        delta: compareMetric(current.active, previous.active, all),
      },
    },
    historyIncomplete: current.incomplete + (all ? 0 : previous.incomplete),
    contactSourcesUnknown: current.alive.filter(
      (entry) =>
        entry.record.kind === 'contact' &&
        entry.state!.source === 'unknown' &&
        current.scores.some((score) => score.id === entry.record.company_id),
    ).length,
  };
}
