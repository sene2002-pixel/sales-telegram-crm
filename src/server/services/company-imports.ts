import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { classifyHoldingMention } from '../../shared/holding-catalog';
import { companyDisplayName } from '../../shared/company-display-name';
import { Registry, cachedRegistry } from './company-registry';
import {
  normalizedCompanyName,
  importedLegalForm,
  candidateSimilarity,
} from './import-normalization';
import {
  Actor,
  CompanyData,
  companySchema,
  projectSchema,
  idSchema,
  validInn,
  labels,
  divisionLabels,
} from '../../shared/contracts';
import { Database, Sql } from '../infra/database';
import { audit } from '../infra/audit';
import { CrmService } from './crm';
import { requireCondition } from '../domain/errors';
import {
  ImportedCompany as ParsedImportedCompany,
  ImportPrivacyGuard,
  fetchPublicGoogleImport,
  parseCompanyImport,
  parseBusinessContacts,
} from './company-import-parser';

type ImportedCompany = ParsedImportedCompany & {
  raw?: Record<string, string>;
  sourceDate?: string;
  holdingName?: string;
  registryFields?: string[];
  sourceRows?: { source: string; sourceDate?: string; raw?: Record<string, string> }[];
};
const sourceTime = (value?: string) =>
  value && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : undefined;
const equalDay = (a?: string, b?: string) => a?.slice(0, 10) === b?.slice(0, 10);
const union = (a: readonly string[] = [], b: readonly string[] = []) => [
  ...new Map(
    [...a, ...b].filter(Boolean).map((v) => [v.trim().toLocaleLowerCase(), v.trim()]),
  ).values(),
];
const appendNotes = (before: string, next: string | undefined, row: ImportedCompany): string => {
  if (
    !next?.trim() ||
    before
      .split('\n---\n')
      .some((block) => block.replace(/^\[[^\n]*\]\n/, '').trim() === next.trim())
  )
    return before;
  const combined = [
    before,
    `[${row.source}; ${row.sourceDate?.slice(0, 10) || 'дата источника не указана'}]\n${next.trim()}`,
  ]
    .filter(Boolean)
    .join('\n---\n');
  requireCondition(
    combined.length <= 5000,
    400,
    'Комментарии превышают 5000 символов; разделите импорт, данные не обрезаны',
  );
  return combined;
};
const projectNameKey = (name: string) =>
  name
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/^(?:проект|объект|реконструкция)\s+/u, '')
    .replace(/[^а-яa-z0-9]/gu, '');
const identity = (value: string | undefined) =>
  (value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const nameKey = (value: string) => identity(normalizedCompanyName(value));
const legalForm = (row: ImportedCompany) =>
  identity(row.legalForm || (row.data as any).legalForm || importedLegalForm(row.data.name));
const valid = (value: string | undefined) => (value && validInn(value) ? value : '');
const countryKey = (country?: string) =>
  !country || /^(?:россия|рф|ru|russia)$/iu.test(country.trim()) ? 'россия' : identity(country);
const compatible = (a: ImportedCompany, b: ImportedCompany) =>
  countryKey(a.data.country) === countryKey(b.data.country) &&
  !(valid(a.data.inn) && valid(b.data.inn) && a.data.inn !== b.data.inn) &&
  !(legalForm(a) && legalForm(b) && legalForm(a) !== legalForm(b));
const exact = (a: ImportedCompany, b: ImportedCompany) =>
  countryKey(a.data.country) === countryKey(b.data.country) &&
  ((a.data.segment === 'holding' &&
    b.data.segment === 'holding' &&
    nameKey(a.data.name) === nameKey(b.data.name)) ||
    !!(valid(a.data.inn) && a.data.inn === b.data.inn) ||
    (compatible(a, b) &&
      !/^элком$/iu.test(nameKey(a.data.name)) &&
      nameKey(a.data.name) === nameKey(b.data.name) &&
      !!identity(a.data.city) &&
      identity(a.data.city) === identity(b.data.city)));
const supplied = (v: unknown) => v !== undefined && v !== null && v !== '';
const phoneKey = (v: string) => v.replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
const sameContact = (a: any, b: any) =>
  !(a.phone && b.phone && phoneKey(a.phone) !== phoneKey(b.phone)) &&
  (!!(
    a.phone &&
    b.phone &&
    !phoneKey(a.phone).startsWith('7800') &&
    phoneKey(a.phone) === phoneKey(b.phone)
  ) ||
    !!(a.email && b.email && identity(a.email) === identity(b.email)) ||
    !!(a.name && b.name && identity(a.name) === identity(b.name)));
const fillContact = (old: any, next: any) => ({
  ...old,
  ...Object.fromEntries(Object.keys(next).map((k) => [k, supplied(old[k]) ? old[k] : next[k]])),
});
const sourceRow = (c: any): ImportedCompany => ({
  source: 'CRM',
  data: c.data,
  legalForm: c.data.legalForm,
  missing: [],
  warnings: [],
});
// A file has one effective import date. Exact duplicates in that file use maxima, never sums.
function consolidate(rows: ImportedCompany[]) {
  const result: ImportedCompany[] = [];
  for (const row of rows) {
    const previous = result.find((r) => exact(r, row));
    if (!previous) {
      result.push(structuredClone(row));
      continue;
    }
    const merged: any = { ...previous.data };
    const dateA = sourceTime(previous.sourceDate),
      dateB = sourceTime(row.sourceDate);
    const amount = (old: number | undefined, next: number) =>
      dateA !== undefined && dateB !== undefined && !equalDay(previous.sourceDate, row.sourceDate)
        ? dateB > dateA
          ? next
          : (old ?? next)
        : Math.max(old ?? 0, next);
    for (const [key, value] of Object.entries(row.data))
      if (!supplied(merged[key]) && supplied(value)) merged[key] = value;
    for (const key of ['potential', 'revenue'] as const)
      if (typeof row.data[key] === 'number')
        merged[key] = amount(previous.data[key] ?? undefined, row.data[key]!);
    merged.divisions = { ...previous.data.divisions };
    for (const [key, value] of Object.entries(row.data.divisions || {}))
      merged.divisions[key] = amount(merged.divisions[key], value!);
    if (!Object.keys(merged.divisions).length && !previous.data.divisions && !row.data.divisions)
      delete merged.divisions;
    merged.notes = appendNotes(previous.data.notes || '', row.data.notes, row);
    merged.alternativeNames = union(previous.data.alternativeNames, [
      ...(row.data.alternativeNames || []),
      ...(nameKey(previous.data.name) !== nameKey(row.data.name) ? [row.data.name] : []),
    ]);
    requireCondition(
      merged.alternativeNames.length <= 20,
      400,
      'Слишком много альтернативных названий одной компании; разделите файл',
    );
    merged.sites = union(previous.data.sites, row.data.sites).slice(0, 100);
    previous.sourceRows ??= [
      { source: previous.source, sourceDate: previous.sourceDate, raw: previous.raw },
    ];
    previous.sourceRows.push({ source: row.source, sourceDate: row.sourceDate, raw: row.raw });
    if (dateB !== undefined && (dateA === undefined || dateB > dateA))
      previous.sourceDate = row.sourceDate;
    previous.data = merged;
    previous.contacts ??= [];
    for (const contact of row.contacts || []) {
      const match = previous.contacts.find((c) => sameContact(c, contact));
      if (match) Object.assign(match, fillContact(match, contact));
      else previous.contacts.push(contact);
    }
    previous.projects ??= [];
    for (const project of row.projects || []) {
      const old = previous.projects.find(
        (p) =>
          !!p.customerInn &&
          p.customerInn === project.customerInn &&
          projectNameKey(p.data.name) === projectNameKey(project.data.name),
      );
      if (!old) previous.projects.push(project);
      else {
        if (project.data.amount !== null)
          old.data.amount = Math.max(old.data.amount ?? 0, project.data.amount);
        for (const equipment of project.data.equipment) {
          const existing = old.data.equipment.find(
            (e) =>
              e.division === equipment.division && identity(e.name) === identity(equipment.name),
          );
          if (!existing) old.data.equipment.push(equipment);
          else if (equipment.amount !== null)
            existing.amount = Math.max(existing.amount ?? 0, equipment.amount);
        }
      }
    }
    requireCondition(
      previous.contacts.length <= 100 && previous.projects.length <= 100,
      400,
      'Слишком много контактов или проектов в одной компании',
    );
    previous.warnings.push(
      'Одинаковые строки файла объединены; суммы взяты по максимуму, не сложены.',
    );
  }
  return result;
}
export const importConfirmPrefix = 'ic';
export const importCancelPrefix = 'ix';
export const importDecisionPrefix = 'iu';
export const importUndoPrefix = 'iz';
export interface CompanyImportDraftRow extends ImportedCompany {
  disposition: 'create' | 'skip_duplicate' | 'update' | 'ask_same' | 'foreign';
}
type Snapshot = { id: string; owner_id: string; data: CompanyData; version: number };
type ReviewProject = NonNullable<ImportedCompany['projects']>[number] & {
  matches?: (RecordSnapshot & { company_name?: string })[];
  matchIndex?: number;
  separate?: boolean;
};
type InternalRow = Omit<CompanyImportDraftRow, 'projects'> & {
  projects?: ReviewProject[];
  target?: Snapshot;
  foreignInn?: boolean;
  decision?: 'update' | 'parallel' | 'same' | 'separate' | 'skip' | 'access' | 'restore';
  changes?: string[];
  moneyDates?: Record<string, string>;
  projectOnly?: boolean;
  targetRecords?: RecordSnapshot[];
};
type RecordSnapshot = {
  id: string;
  company_id: string;
  data: any;
  version: number;
  deleted: boolean;
  contact_source: string;
  kind: string;
};
type Journal = {
  companies: { before: Snapshot | null; after: Snapshot; records: RecordSnapshot[] }[];
  records: { before: RecordSnapshot | null; after: RecordSnapshot }[];
};
export interface CompanyImportResult {
  created: string[];
  skipped: number;
  updated?: string[];
  contacts?: number;
  projects?: number;
  undoUntil?: string;
  version?: number;
  undone?: boolean;
  unchanged?: boolean;
}
export interface CompanyImportPreview {
  id: string;
  version: number;
  rows: CompanyImportDraftRow[];
  messages: string[];
  replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] };
}
export class CompanyImports {
  constructor(
    private db: Database,
    private crm: CrmService,
    private privacy: ImportPrivacyGuard,
    private registry?: Registry,
  ) {}
  private async actor(actor: Actor, tx: Sql): Promise<Actor> {
    // Match all CRM writers: hierarchy lock precedes actor and company row locks.
    await tx.query('SELECT pg_advisory_xact_lock(7142532)');
    const [current] = await tx.query(
      'SELECT id,telegram_id,name,role,active,supervisor_id FROM users WHERE id=$1 FOR SHARE',
      [idSchema.parse(actor.id)],
    );
    requireCondition(current?.active, 403, 'Импорт недоступен');
    return {
      id: current.id,
      telegramId: current.telegram_id,
      name: current.name,
      role: current.role,
      active: true,
      supervisorId: current.supervisor_id,
    };
  }
  private async locks(tx: Sql) {
    await tx.query('SELECT pg_advisory_xact_lock(7142532)');
    await tx.query('SELECT pg_advisory_xact_lock(7142531)');
  }
  private async pending(actor: Actor, id: string, version: number, tx: Sql) {
    idSchema.parse(id);
    requireCondition(
      Number.isSafeInteger(version) && version > 0,
      400,
      'Некорректная версия импорта',
    );
    const [r] = await tx.query('SELECT * FROM company_imports WHERE id=$1 FOR UPDATE', [id]);
    requireCondition(r && r.author_id === actor.id, 403, 'Импорт недоступен');
    requireCondition(
      r.status === 'pending' &&
        r.version === version &&
        new Date(r.expires_at).getTime() > Date.now(),
      409,
      'Импорт изменён, завершён или истёк',
    );
    return r;
  }
  private async moneyDates(companyId: string, tx: Sql): Promise<Record<string, string>> {
    const events = await tx.query(
      "SELECT details,created_at FROM audit WHERE company_id=$1 AND action IN ('company.created','company.updated','company.imported') ORDER BY created_at DESC,(action='company.imported') DESC,id DESC",
      [companyId],
    );
    const result: Record<string, string> = {};
    for (const event of events) {
      const before = event.details?.before || {},
        after = event.details?.after || {};
      for (const key of [
        'potential',
        'revenue',
        ...Object.keys(after.divisions || {}).map((k) => `division:${k}`),
      ]) {
        if (result[key]) continue;
        const value = key.startsWith('division:') ? after.divisions?.[key.slice(9)] : after[key];
        const old = key.startsWith('division:') ? before.divisions?.[key.slice(9)] : before[key];
        if (value !== undefined && value !== null && !isDeepStrictEqual(value, old))
          result[key] = event.details?.sourceDate || new Date(event.created_at).toISOString();
      }
    }
    return result;
  }
  private mergeData(
    before: CompanyData,
    row: ImportedCompany & { moneyDates?: Record<string, string> },
  ): CompanyData {
    const data: any = { ...before };
    const verified = new Set(row.registryFields || []);
    for (const [key, value] of Object.entries(row.data)) {
      if (
        !supplied(value) ||
        [
          'potential',
          'revenue',
          'divisions',
          'holdingId',
          'archived',
          'notes',
          'alternativeNames',
          'sites',
        ].includes(key)
      )
        continue;
      // Confirmed CRM facts beat a file. Only specifically verified registry fields override.
      if (
        !supplied(data[key]) ||
        (data[key] === 'unknown' && key === 'segment') ||
        verified.has(key)
      )
        data[key] = value;
    }
    const choose = (
      old: number | null | undefined,
      next: number | undefined | null,
      key: string,
    ) => {
      if (next === undefined || next === null) return old;
      if (old === undefined || old === null) return next;
      const incoming = sourceTime(row.sourceDate),
        previous = sourceTime(row.moneyDates?.[key]);
      if (incoming === undefined || previous === undefined) return old;
      if (equalDay(row.sourceDate, row.moneyDates?.[key])) return Math.max(old, next);
      return incoming > previous ? next : old;
    };
    for (const key of ['potential', 'revenue'] as const)
      data[key] = choose(before[key], row.data[key], key);
    data.divisions = { ...before.divisions };
    for (const [key, value] of Object.entries(row.data.divisions || {}))
      data.divisions[key] = choose(data.divisions[key], value, `division:${key}`);
    if (Object.keys(data.divisions).length)
      data.potential = Object.values(data.divisions).reduce<number>(
        (sum, v) => sum + Number(v || 0),
        0,
      );
    data.alternativeNames = union(before.alternativeNames, [
      ...(row.data.alternativeNames || []),
      ...(nameKey(before.name) !== nameKey(row.data.name) ? [row.data.name] : []),
      ...(nameKey(before.name) !== nameKey(data.name) ? [before.name] : []),
    ]).filter((v) => nameKey(v) !== nameKey(data.name));
    requireCondition(
      data.alternativeNames.length <= 20,
      400,
      'Слишком много альтернативных названий; существующие данные не изменены',
    );
    data.sites = union(before.sites, row.data.sites);
    requireCondition(
      data.sites.length <= 100,
      400,
      'Слишком много площадок; существующие данные не изменены',
    );
    data.notes = appendNotes(before.notes, row.data.notes, row);
    if (row.legalForm && (!before.legalForm || verified.has('legalForm')))
      data.legalForm = row.legalForm;
    return companySchema.parse(data);
  }
  private sameProject(
    record: any,
    project: NonNullable<ImportedCompany['projects']>[number],
    parentInn: string | undefined,
    companies: any[],
  ): boolean {
    if (
      record.kind !== 'project' ||
      projectNameKey(record.data.name) !== projectNameKey(project.data.name)
    )
      return false;
    const customer = record.data.participants?.find((p: any) => p.role === 'Заказчик');
    const existingInn = customer
      ? companies.find((c) => c.id === customer.companyId)?.data.inn
      : parentInn;
    return !!project.customerInn && project.customerInn === existingInn;
  }
  private async mergeProject(
    record: any,
    project: NonNullable<ImportedCompany['projects']>[number],
    row: ImportedCompany,
    tx: Sql,
  ) {
    const [event] = await tx.query(
      'SELECT details,created_at FROM audit WHERE entity_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
      [record.id],
    );
    const previousDate =
      event?.details?.sourceDate || (event ? new Date(event.created_at).toISOString() : undefined);
    const incoming = sourceTime(row.sourceDate),
      oldTime = sourceTime(previousDate);
    const choose = (old: number | null | undefined, next: number | null | undefined) => {
      if (next === null || next === undefined) return old;
      if (old === null || old === undefined) return next;
      if (incoming === undefined || oldTime === undefined) return old;
      return equalDay(row.sourceDate, previousDate)
        ? Math.max(old, next)
        : incoming > oldTime
          ? next
          : old;
    };
    const data = { ...record.data };
    for (const [key, value] of Object.entries(project.data))
      if (!supplied(data[key]) && supplied(value)) data[key] = value;
    data.equipment = [...(record.data.equipment || [])].map((e) => ({ ...e }));
    for (const equipment of project.data.equipment) {
      const old = data.equipment.find(
        (e: any) =>
          e.division === equipment.division && identity(e.name) === identity(equipment.name),
      );
      if (old) old.amount = choose(old.amount, equipment.amount);
      else data.equipment.push(equipment);
    }
    data.amount = data.equipment.length
      ? data.equipment.reduce((n: number, e: any) => n + (e.amount ?? 0), 0)
      : choose(record.data.amount, project.data.amount);
    data.notes = appendNotes(record.data.notes || '', project.data.notes, row);
    return data;
  }
  private async attachProjectCandidates(rows: InternalRow[], actor: Actor, tx: Sql) {
    const companies = await tx.query('SELECT id,data FROM companies WHERE owner_id=$1', [actor.id]);
    const records = await tx.query(
      "SELECT r.id,r.company_id,r.data,r.version,r.deleted,r.contact_source,r.kind,c.data->>'name' AS company_name FROM records r JOIN companies c ON c.id=r.company_id WHERE c.owner_id=$1 AND NOT r.deleted AND r.kind='project' AND COALESCE(c.data->>'archived','false')='false'",
      [actor.id],
    );
    for (const row of rows)
      for (const project of row.projects || []) {
        const matches = records.filter((record) => {
          if (
            record.company_id === row.target?.id &&
            this.sameProject(record, project, row.data.inn, companies)
          )
            return false;
          const customer = record.data.participants?.find((p: any) => p.role === 'Заказчик');
          const oldInn = customer
            ? companies.find((c) => c.id === customer.companyId)?.data.inn
            : companies.find((c) => c.id === record.company_id)?.data.inn;
          if (project.customerInn && oldInn && project.customerInn !== oldInn) return false;
          return (
            projectNameKey(record.data.name) === projectNameKey(project.data.name) ||
            candidateSimilarity(record.data.name, project.data.name)
          );
        });
        for (const prior of rows.slice(0, rows.indexOf(row)))
          for (const [p, planned] of (prior.projects || []).entries()) {
            if (
              planned.customerInn &&
              project.customerInn &&
              planned.customerInn !== project.customerInn
            )
              continue;
            if (
              projectNameKey(planned.data.name) === projectNameKey(project.data.name) ||
              candidateSimilarity(planned.data.name, project.data.name)
            )
              matches.push({
                id: `local:${rows.indexOf(prior)}:${p}`,
                company_id: `local:${rows.indexOf(prior)}`,
                data: planned.data,
                version: 0,
                deleted: false,
                contact_source: 'user',
                kind: 'project',
                company_name: prior.data.name,
              });
          }
        if (matches.length) {
          project.matches = matches.slice(0, 10);
          row.warnings.push(
            `Проект «${project.data.name}»: найдены похожие проекты (${matches.length}); без выбора сохранится отдельно`,
          );
        }
      }
  }
  private async classify(row: ImportedCompany, actor: Actor, tx: Sql): Promise<InternalRow> {
    const all = await tx.query('SELECT id,owner_id,data,version FROM companies');
    const matches = all.filter(
      (c) =>
        (exact(row, sourceRow(c)) ||
          (countryKey(row.data.country) === countryKey(c.data.country) &&
            row.data.segment === 'holding' &&
            c.data.segment === 'holding' &&
            !!classifyHoldingMention(row.data.name).holdingName &&
            classifyHoldingMention(row.data.name).holdingName ===
              classifyHoldingMention(c.data.name).holdingName)) &&
        (!c.data.archived || c.owner_id === actor.id),
    );
    const own =
      matches.find((c) => c.owner_id === actor.id && !c.data.archived) ||
      matches.find((c) => c.owner_id === actor.id);
    if (own) {
      (row as InternalRow).moneyDates = await this.moneyDates(own.id, tx);
      const data = this.mergeData(own.data, row);
      const records = await tx.query('SELECT * FROM records WHERE company_id=$1 AND NOT deleted', [
        own.id,
      ]);
      const changes = Object.keys(data)
        .filter((k) => !isDeepStrictEqual((own.data as any)[k], (data as any)[k]))
        .map(
          (k) =>
            `${k}: ${JSON.stringify((own.data as any)[k] ?? '—')} → ${JSON.stringify((data as any)[k])}`,
        );
      for (const c of row.contacts || []) {
        const old = records.find((r) => r.kind === 'contact' && sameContact(r.data, c));
        if (!old) changes.push(`Добавить контакт: ${c.name}`);
        else if (!isDeepStrictEqual(old.data, fillContact(old.data, c)))
          changes.push(`Дополнить контакт: ${c.name}`);
      }
      const ownCompanies = await tx.query('SELECT id,data FROM companies WHERE owner_id=$1', [
        actor.id,
      ]);
      for (const p of row.projects || []) {
        const old = records.find((r) => this.sameProject(r, p, row.data.inn, ownCompanies));
        if (!old) changes.push(`Добавить проект: ${p.data.name}`);
        else if (!isDeepStrictEqual(old.data, await this.mergeProject(old, p, row, tx)))
          changes.push(`Дополнить проект: ${p.data.name}`);
      }
      return {
        ...row,
        disposition: 'skip_duplicate',
        target: own,
        targetRecords: records,
        changes,
      };
    }
    if (matches.length)
      return {
        ...row,
        disposition: 'foreign',
        foreignInn: matches.some((c) => valid(row.data.inn) && c.data.inn === row.data.inn),
      };
    const names = (r: ImportedCompany) => [r.data.name, ...(r.data.alternativeNames || [])];
    const possible = all.find(
      (c) =>
        !c.data.archived &&
        c.owner_id === actor.id &&
        compatible(row, sourceRow(c)) &&
        names(row).some((a) => names(sourceRow(c)).some((b) => candidateSimilarity(a, b))),
    );
    return possible
      ? { ...row, disposition: 'ask_same', target: possible }
      : { ...row, disposition: 'create' };
  }
  private preview(record: any, page = 0): CompanyImportPreview {
    if (record.status === 'saved')
      return {
        id: record.id,
        version: record.version,
        rows: [],
        messages: ['Этот файл уже загружался, изменений нет.'],
        replyMarkup: { inline_keyboard: [] },
      };
    const rows: InternalRow[] = record.draft.rows;
    const chunks: string[] = [];
    const buttons: { text: string; callback_data: string }[][] = [];
    let message = `Предпросмотр импорта компаний. Пока ничего не сохранено.\nНовых: ${rows.filter((r) => r.disposition === 'create').length}; в вашей базе: ${rows.filter((r) => r.disposition === 'skip_duplicate').length}; на проверку: ${rows.filter((r) => r.disposition === 'ask_same').length}; пересечений: ${rows.filter((r) => r.disposition === 'foreign').length}.\nПодтверждённые факты CRM сохраняются; суммы обновляются только из датированного более свежего источника.\n`;
    rows.forEach((row, index) => {
      const state =
        row.disposition === 'foreign'
          ? 'Дубль у другого сотрудника; чужие данные недоступны'
          : row.disposition === 'ask_same'
            ? 'Это одна компания? Без ответа сохранятся отдельно'
            : row.disposition === 'update'
              ? 'Обновить существующую компанию'
              : row.disposition === 'skip_duplicate'
                ? 'Дубль: пропустить'
                : 'Создать';
      const details =
        [
          `${index + 1}. ${row.data.name} — ${state}`,
          `Источник: ${row.source}`,
          ...Object.entries(row.data).map(
            ([k, v]) =>
              `${({ segment: 'Тип', stage: 'Стадия', potential: 'Потенциал, ₽', revenue: 'Выручка, ₽', inn: 'ИНН', city: 'Город', divisions: 'Направления, ₽', notes: 'Заметки', legalForm: 'Организационная форма' } as Record<string, string>)[k] || k}: ${k === 'segment' || k === 'stage' ? labels[String(v)] || v : typeof v === 'object' ? JSON.stringify(v) : v}`,
          ),
          ...(row.changes || []),
          ...(row.missing.length ? [`Не указано: ${row.missing.join(', ')}`] : []),
          ...(row.data.stage === undefined
            ? [
                'Стадия в источнике не указана: новая запись CRM получит техническую стадию «Новый».',
              ]
            : []),
          ...(row.contacts || []).map(
            (c) => `Контакт: ${c.name}; ${c.role}; ${c.phone}; ${c.email}`,
          ),
          ...(row.projects || []).flatMap((p) => [
            `Проект: ${p.data.name}; ${p.data.amount ?? '—'} ₽; срок: ${p.data.due || 'не указан'}`,
            ...(p.matches || []).map(
              (m, i) =>
                `Кандидат ${i + 1}: ${m.data.name}; компания: ${m.company_name || 'своя'}; ${m.data.amount ?? '—'} ₽; срок: ${m.data.due || 'не указан'}`,
            ),
          ]),
          ...row.warnings,
        ].join('\n') + '\n\n';
      if (message.length + details.length > 3500) {
        chunks.push(message.trim());
        message = '';
      }
      message += details;
      const button = (text: string, action: string) => ({
        text: `${index + 1}. ${text}`,
        callback_data: `iu:${record.id}:${record.version}:${index}:${action}`,
      });
      if (row.disposition === 'skip_duplicate' && row.target?.data.archived)
        buttons.push([button('Восстановить и обновить', 'r'), button('Пропустить', 'k')]);
      else if (row.disposition === 'skip_duplicate' && row.target && (row.changes || []).length)
        buttons.push([button('Применить изменения', 'u'), button('Пропустить', 'k')]);
      if (row.disposition === 'ask_same')
        buttons.push([button('Одна компания', 's'), button('Разные компании', 'n')]);
      if (row.disposition === 'foreign')
        buttons.push([button('Создать параллельно', 'p'), button('Запросить доступ', 'a')]);
      for (const [p, project] of (row.projects || []).entries())
        if (project.matches?.length && !project.separate && project.matchIndex === undefined) {
          for (const [candidate, match] of project.matches.entries())
            buttons.push([
              button(
                `Проект ${p + 1}: объединить с «${match.data.name}» (${match.company_name || 'моя компания'})`.slice(
                  0,
                  100,
                ),
                `j${p}m${candidate}`,
              ),
            ]);
          buttons.push([button(`Проект ${p + 1}: сохранить отдельно`, `j${p}n`)]);
        }
    });
    if (message.trim()) chunks.push(message.trim());
    // Keep every choice available without exceeding Telegram's 100-button keyboard limit.
    let count = 0;
    const groups: (typeof buttons)[] = [[]];
    for (const group of buttons) {
      if (count + group.length > 60) {
        groups.push([]);
        count = 0;
      }
      groups[groups.length - 1]!.push(group);
      count += group.length;
    }
    const selectedPage = Math.min(Math.max(0, page), groups.length - 1);
    const keyboard = [...groups[selectedPage]!];
    if (groups.length > 1) {
      const navigation = [];
      if (selectedPage > 0)
        navigation.push({
          text: '← Предыдущие решения',
          callback_data: `iu:${record.id}:${record.version}:0:g${selectedPage - 1}`,
        });
      if (selectedPage + 1 < groups.length)
        navigation.push({
          text: 'Следующие решения →',
          callback_data: `iu:${record.id}:${record.version}:0:g${selectedPage + 1}`,
        });
      keyboard.push(navigation);
      chunks.unshift(
        `Решения: страница ${selectedPage + 1} из ${groups.length}. Неотвеченные вопросы не объединяют компании/проекты автоматически.`,
      );
    }
    keyboard.push([
      { text: 'Подтвердить импорт', callback_data: `ic:${record.id}:${record.version}` },
      { text: 'Отменить', callback_data: `ix:${record.id}:${record.version}` },
    ]);
    const publicRows = rows.map(
      ({
        target,
        targetRecords,
        foreignInn,
        decision,
        changes,
        moneyDates,
        registryFields,
        projectOnly,
        ...row
      }) => ({
        ...row,
        projects: row.projects?.map(({ matches, matchIndex, separate, ...project }) => project),
      }),
    );
    return {
      id: record.id,
      version: record.version,
      rows: publicRows,
      messages: chunks.flatMap((c) => {
        const parts = [];
        for (let i = 0; i < c.length; i += 3500) parts.push(c.slice(i, i + 3500));
        return parts;
      }),
      replyMarkup: { inline_keyboard: keyboard },
    };
  }
  async prepare(
    actor: Actor,
    input: {
      sourceKey: string;
      bytes: Uint8Array;
      format: 'xlsx' | 'csv' | 'txt' | 'docx' | 'ods';
      sourceDate?: string;
    },
  ): Promise<CompanyImportPreview> {
    requireCondition(/^[\w:-]{1,150}$/.test(input.sourceKey), 400, 'Некорректный источник импорта');
    const contentHash = createHash('sha256').update(input.bytes).digest('hex');
    const existing = await this.db.transaction(async (tx) => {
      await this.actor(actor, tx);
      const [r] = await tx.query('SELECT * FROM company_imports WHERE source_key=$1', [
        input.sourceKey,
      ]);
      if (r) {
        requireCondition(r.author_id === actor.id, 403, 'Импорт недоступен');
        requireCondition(
          r.status === 'pending' && new Date(r.expires_at).getTime() > Date.now(),
          409,
          'Импорт уже завершён или истёк',
        );
      }
      if (r) return r;
      const [same] = await tx.query(
        "SELECT * FROM company_imports WHERE author_id=$1 AND status='saved' AND draft->>'contentHash'=$2 AND COALESCE((draft->>'undone')::boolean,false)=false AND COALESCE((draft->'result'->>'unchanged')::boolean,false)=false ORDER BY created_at DESC LIMIT 1",
        [actor.id, contentHash],
      );
      return same;
    });
    if (existing) return this.preview(existing);
    const imported: ImportedCompany[] = await parseCompanyImport(
      input.bytes,
      input.format,
      this.privacy,
      input.sourceDate,
    );
    for (const row of imported)
      for (const project of row.projects || []) {
        if (project.customerCountry && countryKey(project.customerCountry) !== 'россия')
          delete project.customerInn;
      }
    for (const row of imported)
      if (countryKey(row.data.country) !== 'россия' && row.data.inn) {
        delete row.data.inn;
        row.warnings.push(
          'Иностранный регистрационный номер не используется как российский ИНН; исходное значение сохранено в данных источника',
        );
      }
    if (input.sourceDate) {
      requireCondition(sourceTime(input.sourceDate) !== undefined, 400, 'Неверная дата источника');
      for (const row of imported) row.sourceDate ??= input.sourceDate;
    }
    const registry = this.registry ? cachedRegistry(this.registry) : undefined;
    const registryBudget = AbortSignal.timeout(15000);
    let nextRow = 0;
    const enrich = async () => {
      while (nextRow < imported.length && !registryBudget.aborted) {
        const row = imported[nextRow++]!;
        if (
          !registry ||
          (row.data.country && !/^(?:россия|рф|ru|russia)$/iu.test(row.data.country)) ||
          row.data.segment === 'holding' ||
          !row.data.inn ||
          !validInn(row.data.inn)
        )
          continue;
        const found = await registry.lookup(row.data.inn, registryBudget).catch(() => null);
        if (!found) continue;
        row.registryFields = union(row.registryFields, [
          'name',
          'legalForm',
          'registrationCity',
          'okved',
        ]);
        const name = normalizedCompanyName(found.name);
        if (name && name !== row.data.name) {
          const names = [...new Set([...(row.data.alternativeNames || []), row.data.name])].slice(
            0,
            20,
          );
          if (names.every((name) => name.length <= 300)) row.data.alternativeNames = names;
          row.data.name = name;
          row.warnings.push('Название проверено по реестру');
        }
        const city = found.registrationCity || found.city;
        if (city) {
          row.data.registrationCity = city;
          if (!row.data.city) {
            row.data.city = city;
            row.warnings.push('Город найден автоматически');
          }
        }
        if (found.okved && found.okved.length <= 50) row.data.okved = found.okved;
        if (found.legalForm && found.legalForm.length <= 50) {
          row.legalForm = found.legalForm;
          row.data.legalForm = found.legalForm;
        }
        this.privacy(JSON.stringify(row.data));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, imported.length) }, enrich));
    for (const row of imported) {
      if (countryKey(row.data.country) !== 'россия') continue;
      if (row.data.segment && !['unknown', 'holding', 'end_client'].includes(row.data.segment))
        continue;
      const legalForm = row.data.legalForm || row.legalForm;
      const mention = classifyHoldingMention(
        legalForm &&
          !row.data.name.toLocaleLowerCase('ru').startsWith(legalForm.toLocaleLowerCase('ru') + ' ')
          ? `${legalForm} ${row.data.name}`
          : row.data.name,
      );
      if (mention.companyName && mention.holdingName && !mention.isHolding) {
        row.data.name = normalizedCompanyName(mention.companyName);
        row.data.segment = 'end_client';
        row.holdingName = mention.holdingName;
      }
    }
    for (const row of [...imported]) {
      if (
        row.holdingName &&
        row.data.segment !== 'holding' &&
        !imported.some(
          (parent) =>
            parent.data.segment === 'holding' &&
            nameKey(parent.data.name) === nameKey(row.holdingName!),
        )
      )
        imported.unshift({
          source: row.source + ' · холдинг',
          data: { name: row.holdingName, segment: 'holding' },
          warnings: [
            'Холдинг явно указан вместе с юридическим лицом; связь будет создана после подтверждения',
          ],
          missing: [],
        });
    }
    const parsed = consolidate(imported).sort(
      (a, b) => Number(b.data.segment === 'holding') - Number(a.data.segment === 'holding'),
    );
    return this.db.transaction(async (tx) => {
      const current = await this.actor(actor, tx);
      await this.locks(tx);
      const [old] = await tx.query('SELECT * FROM company_imports WHERE source_key=$1', [
        input.sourceKey,
      ]);
      if (old) {
        requireCondition(
          old.author_id === actor.id &&
            old.status === 'pending' &&
            new Date(old.expires_at).getTime() > Date.now(),
          409,
          'Импорт недоступен или завершён',
        );
        return this.preview(old);
      }
      const rows = [];
      for (const row of parsed) rows.push(await this.classify(row, current, tx));
      await this.attachProjectCandidates(rows, current, tx);
      const [record] = await tx.query(
        "INSERT INTO company_imports(id,author_id,source_key,source_label,draft,status,version,expires_at) VALUES($1,$2,$3,$4,$5,'pending',1,now()+interval '30 minutes') RETURNING *",
        [
          randomUUID(),
          actor.id,
          input.sourceKey,
          { xlsx: 'XLSX', csv: 'CSV', txt: 'Документ', docx: 'Google Docs', ods: 'ODS' }[
            input.format
          ],
          JSON.stringify({ rows, contentHash }),
        ],
      );
      return this.preview(record);
    });
  }
  async prepareGoogle(actor: Actor, input: { sourceKey: string; url: string }) {
    const existing = await this.db.transaction(async (tx) => {
      await this.actor(actor, tx);
      const [r] = await tx.query('SELECT * FROM company_imports WHERE source_key=$1', [
        input.sourceKey,
      ]);
      if (r) {
        requireCondition(
          r.author_id === actor.id &&
            r.status === 'pending' &&
            new Date(r.expires_at).getTime() > Date.now(),
          409,
          'Импорт недоступен или завершён',
        );
      }
      return r;
    });
    if (existing) return this.preview(existing);
    const downloaded = await fetchPublicGoogleImport(input.url);
    return this.prepare(actor, {
      sourceKey: input.sourceKey,
      bytes: downloaded.bytes,
      format: downloaded.format,
    });
  }
  async decide(
    actor: Actor,
    id: string,
    version: number,
    index: number,
    action: string,
  ): Promise<CompanyImportPreview> {
    requireCondition(
      Number.isSafeInteger(index) &&
        index >= 0 &&
        (['u', 'k', 's', 'n', 'p', 'a', 'r'].includes(action) ||
          /^j\d{1,2}(?:m\d|n)$/.test(action) ||
          /^g\d{1,3}$/.test(action)),
      400,
      'Некорректное решение',
    );
    return this.db.transaction(async (tx) => {
      const current = await this.actor(actor, tx);
      await this.locks(tx);
      const record = await this.pending(current, id, version, tx);
      if (/^g\d{1,3}$/.test(action)) return this.preview(record, Number(action.slice(1)));
      const row: InternalRow = record.draft.rows[index];
      requireCondition(row, 400, 'Строка не найдена');
      const projectAction = /^j(\d{1,2})(?:m(\d)|n)$/.exec(action);
      if (projectAction) {
        const project = row.projects?.[Number(projectAction[1])];
        requireCondition(project?.matches?.length, 409, 'Решение по проекту устарело');
        if (projectAction[2] === undefined) {
          project.separate = true;
          delete project.matchIndex;
        } else {
          requireCondition(project.matches[Number(projectAction[2])], 400, 'Проект не найден');
          project.matchIndex = Number(projectAction[2]);
          project.separate = false;
        }
      } else if (action === 'u' || action === 's' || action === 'r') {
        requireCondition(
          row.target && row.target.owner_id === current.id,
          403,
          'Импорт недоступен',
        );
        const [target] = await tx.query(
          'SELECT id,owner_id,data,version FROM companies WHERE id=$1 FOR UPDATE',
          [row.target.id],
        );
        requireCondition(
          target && target.owner_id === current.id && target.version === row.target.version,
          409,
          'Компания изменилась; повторите предпросмотр',
        );
        requireCondition(
          action === 's' ? row.disposition === 'ask_same' : row.disposition === 'skip_duplicate',
          409,
          'Решение устарело',
        );
        requireCondition(
          compatible(row, sourceRow(target)) ||
            (row.registryFields?.includes('legalForm') &&
              !!valid(row.data.inn) &&
              row.data.inn === target.data.inn),
          409,
          'Разные ИНН или организационные формы',
        );
        row.moneyDates = await this.moneyDates(target.id, tx);
        row.targetRecords = await tx.query(
          'SELECT * FROM records WHERE company_id=$1 AND NOT deleted',
          [target.id],
        );
        row.changes = Object.keys(this.mergeData(target.data, row))
          .filter(
            (k) =>
              !isDeepStrictEqual(
                (target.data as any)[k],
                (this.mergeData(target.data, row) as any)[k],
              ),
          )
          .map(
            (k) =>
              `${k}: ${JSON.stringify((target.data as any)[k] ?? '—')} → ${JSON.stringify((this.mergeData(target.data, row) as any)[k])}`,
          );
        requireCondition(action !== 'r' || target.data.archived, 409, 'Компания уже восстановлена');
        row.disposition = 'update';
        row.decision = action === 'r' ? 'restore' : action === 's' ? 'same' : 'update';
      } else if (action === 'p') {
        requireCondition(row.disposition === 'foreign', 409, 'Решение устарело');
        row.disposition = 'create';
        row.decision = 'parallel';
      } else if (action === 'n') {
        requireCondition(row.disposition === 'ask_same', 409, 'Решение устарело');
        row.disposition = 'create';
        row.decision = 'separate';
        delete row.target;
      } else {
        row.disposition = 'skip_duplicate';
        row.decision = action === 'a' ? 'access' : 'skip';
        if (action === 'a')
          row.warnings.push(
            'Передайте администратору запрос доступа. Автоматически права не выдаются.',
          );
      }
      const [updated] = await tx.query(
        'UPDATE company_imports SET draft=$2,version=version+1 WHERE id=$1 RETURNING *',
        [id, JSON.stringify(record.draft)],
      );
      return this.preview(updated);
    });
  }
  private async recordSnapshot(tx: Sql, id: string) {
    const [r] = await tx.query(
      'SELECT id,company_id,data,version,deleted,contact_source,kind FROM records WHERE id=$1 FOR UPDATE',
      [id],
    );
    return r as RecordSnapshot;
  }
  async confirm(actor: Actor, id: string, version: number): Promise<CompanyImportResult> {
    idSchema.parse(id);
    requireCondition(
      Number.isSafeInteger(version) && version > 0,
      400,
      'Некорректная версия импорта',
    );
    return this.db.transaction(async (tx) => {
      const current = await this.actor(actor, tx);
      await this.locks(tx);
      const [record] = await tx.query('SELECT * FROM company_imports WHERE id=$1 FOR UPDATE', [id]);
      requireCondition(record && record.author_id === current.id, 403, 'Импорт недоступен');
      if (record.status === 'saved') {
        requireCondition(!record.draft.undone, 409, 'Импорт уже отменён');
        return record.draft.result;
      }
      await this.pending(current, id, version, tx);
      if (record.draft.contentHash) {
        const [completed] = await tx.query(
          "SELECT id FROM company_imports WHERE author_id=$1 AND id<>$2 AND status='saved' AND draft->>'contentHash'=$3 AND COALESCE((draft->>'undone')::boolean,false)=false AND COALESCE((draft->'result'->>'unchanged')::boolean,false)=false LIMIT 1",
          [current.id, id, record.draft.contentHash],
        );
        if (completed) {
          const result: CompanyImportResult = {
            created: [],
            updated: [],
            skipped: record.draft.rows.length,
            unchanged: true,
            version: record.version + 1,
          };
          await tx.query(
            "UPDATE company_imports SET status='saved',version=version+1,draft=$2 WHERE id=$1",
            [
              id,
              JSON.stringify({ ...record.draft, result, journal: { companies: [], records: [] } }),
            ],
          );
          return result;
        }
      }
      const result: CompanyImportResult = { created: [], skipped: 0, updated: [] };
      const journal: Journal = { companies: [], records: [] };
      const applied = new Map<InternalRow, string>();
      const projectResults = new Map<string, string>();
      const holdingFor = async (row: InternalRow) => {
        if (!row.holdingName || row.data.segment === 'holding') return undefined;
        const found = await tx.query(
          "SELECT id,data FROM companies WHERE owner_id=$1 AND data->>'segment'='holding' AND COALESCE(data->>'archived','false')='false'",
          [current.id],
        );
        const holding = found.find((c) => nameKey(c.data.name) === nameKey(row.holdingName!));
        requireCondition(holding, 409, 'Холдинг изменился; повторите предпросмотр');
        return holding.id as string;
      };

      for (const row of record.draft.rows as InternalRow[]) {
        this.privacy(JSON.stringify(row.data));
        for (const c of row.contacts || [])
          parseBusinessContacts([c.name, c.role, c.phone, c.email].join(', '), this.privacy);
        for (const p of row.projects || []) this.privacy(JSON.stringify(p.data));
        row.projectOnly =
          row.disposition === 'skip_duplicate' &&
          !!row.projects?.some((p) => p.matchIndex !== undefined && !p.separate);
        if (
          row.disposition === 'foreign' ||
          (row.disposition === 'skip_duplicate' && !row.projectOnly)
        ) {
          result.skipped++;
          continue;
        }
        let companyId: string,
          before: Snapshot | null = null;
        if (row.disposition === 'update' || row.projectOnly) {
          requireCondition(row.target, 409, 'Повторите предпросмотр');
          const [target] = await tx.query(
            'SELECT id,owner_id,data,version FROM companies WHERE id=$1 FOR UPDATE',
            [row.target.id],
          );
          requireCondition(
            target &&
              target.owner_id === current.id &&
              target.version === row.target.version &&
              isDeepStrictEqual(target.data, row.target.data),
            409,
            'Компания изменилась; повторите предпросмотр',
          );
          requireCondition(
            !target.data.archived || row.decision === 'restore',
            409,
            'Сначала восстановите компанию',
          );
          if (row.targetRecords) {
            const latest = await tx.query(
              'SELECT * FROM records WHERE company_id=$1 AND NOT deleted ORDER BY id FOR UPDATE',
              [target.id],
            );
            requireCondition(
              isDeepStrictEqual(
                JSON.parse(JSON.stringify([...latest].sort((a, b) => a.id.localeCompare(b.id)))),
                [...row.targetRecords].sort((a, b) => a.id.localeCompare(b.id)),
              ),
              409,
              'Контакты или проекты изменились; повторите предпросмотр',
            );
          }
          before = target;
          const data = row.projectOnly
            ? companySchema.parse(target.data)
            : this.mergeData(target.data, row);
          if (row.decision === 'restore') data.archived = false;
          if (!row.projectOnly && !data.holdingId && data.segment === 'end_client')
            data.holdingId = await holdingFor(row);
          await this.crm.validateHolding(
            current,
            data,
            target.owner_id,
            tx,
            await this.crm.company(current, target.id, tx),
          );
          if (!isDeepStrictEqual(data, target.data)) {
            await tx.query(
              'UPDATE companies SET data=$2,version=version+1,updated_at=now() WHERE id=$1',
              [target.id, JSON.stringify(data)],
            );
            await audit(tx, current.id, 'company.updated', target.id, target.id, {
              before: target.data,
              after: data,
              beforeVersion: target.version,
              afterVersion: target.version + 1,
              importId: id,
              sourceDate: row.sourceDate,
              provenance: row.raw,
              sourceRows: row.sourceRows,
            });
          }
          companyId = target.id;
          result.updated!.push(companyId);
        } else {
          const fresh = await this.classify(row, current, tx);
          requireCondition(
            row.decision !== 'parallel' || !fresh.target,
            409,
            'Компания уже появилась в вашей CRM; повторите предпросмотр',
          );
          if (
            row.decision !== 'parallel' &&
            row.decision !== 'separate' &&
            fresh.disposition !== 'create' &&
            fresh.disposition !== 'ask_same'
          ) {
            result.skipped++;
            continue;
          }
          const existingIds = new Set(
            (await tx.query('SELECT id FROM companies WHERE owner_id=$1', [current.id])).map(
              (company) => company.id,
            ),
          );
          const c = await this.crm.create(
            current,
            {
              ...row.data,
              ...(row.holdingName && row.data.segment !== 'holding'
                ? { holdingId: await holdingFor(row) }
                : {}),
              ...(row.legalForm ? { legalForm: row.legalForm } : {}),
              segment: row.data.segment ?? 'unknown',
            },
            current.id,
            tx,
          );
          requireCondition(
            !existingIds.has(c.id),
            409,
            'Существующая компания распознана при сохранении. Повторите предпросмотр и явно выберите обновление; изменения отменены',
          );
          const createdIds = await tx.query('SELECT id FROM companies WHERE owner_id=$1', [
            current.id,
          ]);
          requireCondition(
            createdIds.every((company) => existingIds.has(company.id) || company.id === c.id),
            409,
            'Состав компаний изменился при сохранении. Повторите предпросмотр; незапланированные связи отменены',
          );
          companyId = c.id;
          if (row.sourceDate || row.raw)
            await audit(tx, current.id, 'company.imported', c.id, c.id, {
              importId: id,
              sourceDate: row.sourceDate,
              provenance: row.raw,
              sourceRows: row.sourceRows,
              after: row.data,
            });
          result.created.push(c.id);
        }
        const [after] = await tx.query(
          'SELECT id,owner_id,data,version FROM companies WHERE id=$1',
          [companyId],
        );
        journal.companies.push({ before, after, records: [] });
        applied.set(row, companyId);
      }
      for (const [row, companyId] of applied) {
        let records = await tx.query(
          'SELECT id,company_id,data,version,deleted,contact_source,kind FROM records WHERE company_id=$1 AND NOT deleted FOR UPDATE',
          [companyId],
        );
        for (const contact of row.projectOnly ? [] : row.contacts || []) {
          const old = records.find((r) => r.kind === 'contact' && sameContact(r.data, contact));
          if (old) {
            const data = fillContact(old.data, contact);
            if (!isDeepStrictEqual(data, old.data)) {
              await tx.query('UPDATE records SET data=$2,version=version+1 WHERE id=$1', [
                old.id,
                JSON.stringify(data),
              ]);
              const after = await this.recordSnapshot(tx, old.id);
              journal.records.push({ before: structuredClone(old), after });
              await audit(tx, current.id, 'contact.updated', old.id, companyId, {
                importId: id,
                recordVersion: after.version,
                recordBefore: {
                  data: old.data,
                  contactSource: old.contact_source,
                  deleted: old.deleted,
                },
                recordAfter: {
                  data: after.data,
                  contactSource: after.contact_source,
                  deleted: after.deleted,
                },
              });
              Object.assign(old, after);
            }
          } else {
            const c = await this.crm.createRecord(
              current,
              companyId,
              'contact',
              contact,
              null,
              tx,
              { contactSource: 'user' },
            );
            const after = await this.recordSnapshot(tx, c.id);
            journal.records.push({ before: null, after });
            records.push(after);
            result.contacts = (result.contacts || 0) + 1;
          }
        }
        const ownCompanies = await tx.query('SELECT id,data FROM companies WHERE owner_id=$1', [
          current.id,
        ]);
        for (const [projectIndex, project] of (row.projects || []).entries()) {
          const customerMatches = ownCompanies.filter(
            (company) =>
              !company.data.archived &&
              (!project.customerCountry ||
                countryKey(company.data.country) === countryKey(project.customerCountry)) &&
              (project.customerInn
                ? company.data.inn === project.customerInn
                : !!project.customerName &&
                  [company.data.name, ...(company.data.alternativeNames || [])].some(
                    (name: string) => nameKey(name) === nameKey(project.customerName!),
                  )),
          );
          const customerId = customerMatches.length === 1 ? customerMatches[0]!.id : undefined;
          if (row.projectOnly && (project.matchIndex === undefined || project.separate)) continue;
          const resultKey = `local:${record.draft.rows.indexOf(row)}:${projectIndex}`;
          let reviewed =
            project.matchIndex === undefined ? undefined : project.matches?.[project.matchIndex];
          if (reviewed && !project.separate) {
            if (reviewed.id.startsWith('local:')) {
              const actual = projectResults.get(reviewed.id);
              requireCondition(actual, 409, 'Связанный проект не сохранён; повторите выбор');
              reviewed = await this.recordSnapshot(tx, actual);
            }
            const owner = await this.crm.company(current, reviewed.company_id, tx, true);
            requireCondition(
              owner.ownerId === current.id && !owner.archived,
              403,
              'Проект недоступен',
            );
            const currentRecord = await this.recordSnapshot(tx, reviewed.id);
            const earlier = journal.records.find((r) => r.after.id === reviewed!.id);
            const expected = earlier?.after || reviewed;
            requireCondition(
              currentRecord &&
                currentRecord.version === expected.version &&
                isDeepStrictEqual(currentRecord.data, expected.data) &&
                !currentRecord.deleted,
              409,
              'Проект изменился; повторите предпросмотр',
            );
            if (!journal.companies.some((c) => c.after.id === owner.id)) {
              const [snapshot] = await tx.query(
                'SELECT id,owner_id,data,version FROM companies WHERE id=$1',
                [owner.id],
              );
              journal.companies.push({ before: snapshot, after: snapshot, records: [] });
            }
            const merged = await this.mergeProject(currentRecord, project, row, tx);
            merged.participants = [...(currentRecord.data.participants || [])];
            for (const participantId of new Set([
              owner.id,
              companyId,
              ...(customerId ? [customerId] : []),
            ]))
              if (!merged.participants.some((p: any) => p.companyId === participantId))
                merged.participants.push({
                  companyId: participantId,
                  role:
                    participantId === customerId
                      ? 'Заказчик'
                      : participantId === companyId
                        ? project.participantRole || 'Участник'
                        : 'Участник',
                  contactId: null,
                  currentTask: '',
                  nextStep: '',
                });
            const checked = projectSchema.parse(merged);
            await this.crm.validateRecordLinks(
              current,
              owner.id,
              'project',
              checked,
              tx,
              currentRecord.data,
            );
            await tx.query('UPDATE records SET data=$2,version=version+1 WHERE id=$1', [
              reviewed.id,
              JSON.stringify(checked),
            ]);
            const after = await this.recordSnapshot(tx, reviewed.id);
            if (earlier) earlier.after = after;
            else journal.records.push({ before: currentRecord, after });
            projectResults.set(resultKey, after.id);
            await audit(tx, current.id, 'project.updated', reviewed.id, owner.id, {
              importId: id,
              sourceDate: row.sourceDate,
              recordVersion: after.version,
              recordBefore: {
                data: currentRecord.data,
                contactSource: currentRecord.contact_source,
                deleted: false,
              },
              recordAfter: {
                data: after.data,
                contactSource: after.contact_source,
                deleted: false,
              },
            });
            continue;
          }
          const previous = records.find((r) =>
            this.sameProject(r, project, row.data.inn, ownCompanies),
          );
          if (previous) {
            const data = await this.mergeProject(previous, project, row, tx);
            if (!isDeepStrictEqual(previous.data, data)) {
              await tx.query('UPDATE records SET data=$2,version=version+1 WHERE id=$1', [
                previous.id,
                JSON.stringify(data),
              ]);
              const after = await this.recordSnapshot(tx, previous.id);
              journal.records.push({ before: structuredClone(previous), after });
              await audit(tx, current.id, 'project.updated', previous.id, companyId, {
                importId: id,
                sourceDate: row.sourceDate,
                recordVersion: after.version,
                recordBefore: {
                  data: previous.data,
                  contactSource: previous.contact_source,
                  deleted: false,
                },
                recordAfter: {
                  data: after.data,
                  contactSource: after.contact_source,
                  deleted: false,
                },
              });
              Object.assign(previous, after);
            }
            projectResults.set(resultKey, previous.id);
            continue;
          }
          const data = {
            ...project.data,
            participants: [
              ...(project.participantRole
                ? [
                    {
                      companyId,
                      role: project.participantRole,
                      contactId: null,
                      currentTask: '',
                      nextStep: '',
                    },
                  ]
                : []),
              ...(customerId && customerId !== companyId
                ? [
                    {
                      companyId: customerId,
                      role: 'Заказчик',
                      contactId: null,
                      currentTask: '',
                      nextStep: '',
                    },
                  ]
                : []),
            ],
          };
          const p = await this.crm.createRecord(current, companyId, 'project', data, null, tx);
          const after = await this.recordSnapshot(tx, p.id);
          projectResults.set(resultKey, p.id);
          journal.records.push({ before: null, after });
          records.push(after);
          result.projects = (result.projects || 0) + 1;
        }
      }
      for (const entry of journal.companies) {
        const [after] = await tx.query(
          'SELECT id,owner_id,data,version FROM companies WHERE id=$1',
          [entry.after.id],
        );
        entry.after = after;
        entry.records = await tx.query(
          'SELECT id,company_id,data,version,deleted,contact_source,kind FROM records WHERE company_id=$1 ORDER BY id',
          [entry.after.id],
        );
      }
      result.undoUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      result.version = record.version + 1;
      await tx.query(
        "UPDATE company_imports SET status='saved',version=version+1,draft=$2 WHERE id=$1",
        [id, JSON.stringify({ ...record.draft, result, journal })],
      );
      return result;
    });
  }
  async undo(actor: Actor, id: string, version: number) {
    idSchema.parse(id);
    requireCondition(
      Number.isSafeInteger(version) && version > 0,
      400,
      'Некорректная версия импорта',
    );
    return this.db.transaction(async (tx) => {
      const current = await this.actor(actor, tx);
      await this.locks(tx);
      const [record] = await tx.query('SELECT * FROM company_imports WHERE id=$1 FOR UPDATE', [id]);
      requireCondition(record && record.author_id === current.id, 403, 'Импорт недоступен');
      if (record.draft.undone) return { undone: true };
      requireCondition(
        record.status === 'saved' &&
          record.version === version &&
          record.draft.journal &&
          Date.parse(record.draft.result.undoUntil) > Date.now(),
        409,
        'Отмена недоступна или прошло 24 часа',
      );
      const journal: Journal = record.draft.journal;
      for (const entry of journal.companies) {
        const [company] = await tx.query(
          'SELECT id,owner_id,data,version FROM companies WHERE id=$1 FOR UPDATE',
          [entry.after.id],
        );
        requireCondition(
          company &&
            company.owner_id === current.id &&
            company.version === entry.after.version &&
            isDeepStrictEqual(company.data, entry.after.data),
          409,
          'После импорта компания изменена; отмена остановлена',
        );
        const records = await tx.query(
          'SELECT id,company_id,data,version,deleted,contact_source,kind FROM records WHERE company_id=$1 ORDER BY id FOR UPDATE',
          [company.id],
        );
        requireCondition(
          isDeepStrictEqual(records, entry.records),
          409,
          'После импорта записи изменены; отмена остановлена',
        );
      }
      const created = new Set(journal.companies.filter((e) => !e.before).map((e) => e.after.id));
      for (const entry of journal.companies)
        if (!entry.before) {
          const linked = await tx.query("SELECT id FROM companies WHERE data->>'holdingId'=$1", [
            entry.after.id,
          ]);
          requireCondition(
            linked.every((c) => created.has(c.id)),
            409,
            'После импорта появились связи; отмена остановлена',
          );
        }
      for (const companyId of created) {
        const references = await tx.query(
          "SELECT id FROM records WHERE kind='project' AND NOT deleted AND data->'participants' @> $1::jsonb",
          [JSON.stringify([{ companyId }])],
        );
        requireCondition(
          references.every((r) => journal.records.some((w) => w.after.id === r.id)),
          409,
          'После импорта появились связи с проектами; отмена остановлена',
        );
      }
      for (const entry of journal.companies)
        if (entry.before) {
          await this.crm.validateHolding(
            current,
            entry.before.data,
            entry.before.owner_id,
            tx,
            await this.crm.company(current, entry.after.id, tx),
          );
        }
      for (const entry of journal.records)
        if (!entry.before && entry.after.kind === 'contact') {
          const refs = await tx.query(
            "SELECT id FROM records WHERE NOT deleted AND (data->>'contactId'=$1 OR data->'participants' @> $2::jsonb)",
            [entry.after.id, JSON.stringify([{ contactId: entry.after.id }])],
          );
          requireCondition(
            refs.every((r) => journal.records.some((w) => w.after.id === r.id)),
            409,
            'После импорта появились ссылки на контакт; отмена остановлена',
          );
        }
      for (const entry of journal.records) {
        if (entry.before) {
          await tx.query(
            'UPDATE records SET data=$2,contact_source=$3,deleted=$4,version=version+1 WHERE id=$1',
            [
              entry.after.id,
              JSON.stringify(entry.before.data),
              entry.before.contact_source,
              entry.before.deleted,
            ],
          );
        } else
          await tx.query('UPDATE records SET deleted=true,version=version+1 WHERE id=$1', [
            entry.after.id,
          ]);
        await audit(
          tx,
          current.id,
          entry.before ? `${entry.after.kind}.updated` : `${entry.after.kind}.deleted`,
          entry.after.id,
          entry.after.company_id,
          {
            importId: id,
            recordVersion: entry.after.version + 1,
            recordBefore: {
              data: entry.after.data,
              contactSource: entry.after.contact_source,
              deleted: entry.after.deleted,
            },
            recordAfter: {
              data: entry.before?.data || entry.after.data,
              contactSource: entry.before?.contact_source || entry.after.contact_source,
              deleted: entry.before?.deleted ?? true,
            },
          },
        );
      }
      for (const entry of journal.companies) {
        const data = entry.before
          ? entry.before.data
          : { ...entry.after.data, archived: true, holdingId: null };
        await tx.query(
          'UPDATE companies SET data=$2,version=version+1,updated_at=now() WHERE id=$1',
          [entry.after.id, JSON.stringify(data)],
        );
        await audit(tx, current.id, 'company.updated', entry.after.id, entry.after.id, {
          importId: id,
          before: entry.after.data,
          after: data,
          beforeVersion: entry.after.version,
          afterVersion: entry.after.version + 1,
        });
      }
      await tx.query('UPDATE company_imports SET version=version+1,draft=$2 WHERE id=$1', [
        id,
        JSON.stringify({ ...record.draft, undone: true }),
      ]);
      return { undone: true };
    });
  }
  async cancel(actor: Actor, id: string, version: number) {
    idSchema.parse(id);
    requireCondition(
      Number.isSafeInteger(version) && version > 0,
      400,
      'Некорректная версия импорта',
    );
    return this.db.transaction(async (tx) => {
      const current = await this.actor(actor, tx);
      await this.locks(tx);
      const [r] = await tx.query('SELECT * FROM company_imports WHERE id=$1 FOR UPDATE', [id]);
      requireCondition(r && r.author_id === current.id, 403, 'Импорт недоступен');
      if (r.status === 'cancelled') return;
      await this.pending(current, id, version, tx);
      await tx.query(
        "UPDATE company_imports SET status='cancelled',draft=$2,version=version+1 WHERE id=$1",
        [id, JSON.stringify({ rows: [] })],
      );
    });
  }
}
