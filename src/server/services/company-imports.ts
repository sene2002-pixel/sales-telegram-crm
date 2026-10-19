import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { companyDisplayName } from '../../shared/company-display-name';
import { Registry, cachedRegistry } from './company-registry';
import { normalizedCompanyName, importedLegalForm } from './import-normalization';
import {
  Actor,
  CompanyData,
  companySchema,
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
  ImportedCompany,
  ImportPrivacyGuard,
  fetchPublicGoogleDocument,
  parseCompanyImport,
  parseBusinessContacts,
} from './company-import-parser';

const identity = (value: string | undefined) =>
  (value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const nameKey = (value: string) => identity(normalizedCompanyName(value));
const legalForm = (row: ImportedCompany) =>
  identity(row.legalForm || (row.data as any).legalForm || importedLegalForm(row.data.name));
const valid = (value: string | undefined) => (value && validInn(value) ? value : '');
const compatible = (a: ImportedCompany, b: ImportedCompany) =>
  !(valid(a.data.inn) && valid(b.data.inn) && a.data.inn !== b.data.inn) &&
  !(legalForm(a) && legalForm(b) && legalForm(a) !== legalForm(b));
const exact = (a: ImportedCompany, b: ImportedCompany) =>
  !!(valid(a.data.inn) && a.data.inn === b.data.inn) ||
  (compatible(a, b) &&
    nameKey(a.data.name) === nameKey(b.data.name) &&
    !!identity(a.data.city) &&
    identity(a.data.city) === identity(b.data.city));
const supplied = (v: unknown) => v !== undefined && v !== null && v !== '';
const phoneKey = (v: string) => v.replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
const sameContact = (a: any, b: any) =>
  !!(a.phone && b.phone && phoneKey(a.phone) === phoneKey(b.phone)) ||
  !!(a.email && b.email && identity(a.email) === identity(b.email)) ||
  !!(a.name && b.name && identity(a.name) === identity(b.name));
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
    for (const [key, value] of Object.entries(row.data))
      if (!supplied(merged[key]) && supplied(value)) merged[key] = value;
    for (const key of ['potential', 'revenue'] as const)
      if (typeof row.data[key] === 'number')
        merged[key] = Math.max(previous.data[key] ?? 0, row.data[key]!);
    merged.divisions = { ...previous.data.divisions };
    for (const [key, value] of Object.entries(row.data.divisions || {}))
      merged.divisions[key] = Math.max(merged.divisions[key] ?? 0, value!);
    if (!Object.keys(merged.divisions).length && !previous.data.divisions && !row.data.divisions)
      delete merged.divisions;
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
        (p) => identity(p.data.name) === identity(project.data.name),
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
type InternalRow = CompanyImportDraftRow & {
  target?: Snapshot;
  foreignInn?: boolean;
  decision?: 'update' | 'parallel' | 'same' | 'separate' | 'skip' | 'access';
  changes?: string[];
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
  private mergeData(before: CompanyData, row: ImportedCompany): CompanyData {
    const data: any = { ...before };
    for (const [key, value] of Object.entries(row.data))
      if (
        supplied(value) &&
        !['potential', 'revenue', 'divisions', 'holdingId', 'archived'].includes(key)
      )
        data[key] = value;
    for (const key of ['potential', 'revenue'] as const)
      if (before[key] == null && row.data[key] != null) data[key] = row.data[key];
    data.divisions = { ...before.divisions };
    for (const [key, value] of Object.entries(row.data.divisions || {}))
      if (data.divisions[key] === undefined) data.divisions[key] = value;
    if (row.legalForm) data.legalForm = row.legalForm;
    return companySchema.parse(data);
  }
  private async classify(row: ImportedCompany, actor: Actor, tx: Sql): Promise<InternalRow> {
    const all = await tx.query(
      "SELECT id,owner_id,data,version FROM companies WHERE COALESCE((data->>'archived')::boolean,false)=false",
    );
    const matches = all.filter((c) => exact(row, sourceRow(c)));
    const own = matches.find((c) => c.owner_id === actor.id);
    if (own) {
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
      for (const p of row.projects || [])
        if (
          !records.some(
            (r) => r.kind === 'project' && identity(r.data.name) === identity(p.data.name),
          )
        )
          changes.push(`Добавить проект: ${p.data.name}`);
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
    const possible = all.find(
      (c) =>
        c.owner_id === actor.id &&
        compatible(row, sourceRow(c)) &&
        (nameKey(row.data.name) === nameKey(c.data.name) ||
          (nameKey(row.data.name).length >= 5 &&
            nameKey(c.data.name).length >= 5 &&
            (nameKey(row.data.name).includes(nameKey(c.data.name)) ||
              nameKey(c.data.name).includes(nameKey(row.data.name))))) &&
        (!row.data.city || !c.data.city || identity(row.data.city) === identity(c.data.city)),
    );
    return possible
      ? { ...row, disposition: 'ask_same', target: possible }
      : { ...row, disposition: 'create' };
  }
  private preview(record: any): CompanyImportPreview {
    const rows: InternalRow[] = record.draft.rows;
    const chunks: string[] = [];
    const buttons: { text: string; callback_data: string }[][] = [];
    let message =
      'Предпросмотр импорта компаний. Пока ничего не сохранено.\nИзменения применятся только после подтверждения. Суммы существующей CRM имеют приоритет.\n';
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
          ...(row.projects || []).map((p) => `Проект: ${p.data.name}; ${p.data.amount ?? '—'} ₽`),
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
      if (row.disposition === 'skip_duplicate' && row.target && (row.changes || []).length)
        buttons.push([button('Применить изменения', 'u'), button('Пропустить', 'k')]);
      if (row.disposition === 'ask_same')
        buttons.push([button('Одна компания', 's'), button('Разные компании', 'n')]);
      if (row.disposition === 'foreign')
        buttons.push([
          button(row.foreignInn ? 'Параллельно: ИНН уже занят' : 'Создать параллельно', 'p'),
          button('Запросить доступ', 'a'),
        ]);
    });
    if (message.trim()) chunks.push(message.trim());
    buttons.push([
      { text: 'Подтвердить импорт', callback_data: `ic:${record.id}:${record.version}` },
      { text: 'Отменить', callback_data: `ix:${record.id}:${record.version}` },
    ]);
    const publicRows = rows.map(
      ({ target, targetRecords, foreignInn, decision, changes, ...row }) => row,
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
      replyMarkup: { inline_keyboard: buttons },
    };
  }
  async prepare(
    actor: Actor,
    input: { sourceKey: string; bytes: Uint8Array; format: 'xlsx' | 'csv' | 'txt' | 'docx' },
  ): Promise<CompanyImportPreview> {
    requireCondition(/^[\w:-]{1,150}$/.test(input.sourceKey), 400, 'Некорректный источник импорта');
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
      return r;
    });
    if (existing) return this.preview(existing);
    const imported = await parseCompanyImport(input.bytes, input.format, this.privacy);
    const registry = this.registry ? cachedRegistry(this.registry) : undefined;
    const registryBudget = AbortSignal.timeout(15000);
    let nextRow = 0;
    const enrich = async () => {
      while (nextRow < imported.length && !registryBudget.aborted) {
        const row = imported[nextRow++]!;
        if (!registry || row.data.segment === 'holding' || !row.data.inn || !validInn(row.data.inn))
          continue;
        const found = await registry.lookup(row.data.inn, registryBudget).catch(() => null);
        if (!found) continue;
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
    const parsed = consolidate(imported);
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
      const [record] = await tx.query(
        "INSERT INTO company_imports(id,author_id,source_key,source_label,draft,status,version,expires_at) VALUES($1,$2,$3,$4,$5,'pending',1,now()+interval '30 minutes') RETURNING *",
        [
          randomUUID(),
          actor.id,
          input.sourceKey,
          { xlsx: 'XLSX', csv: 'CSV', txt: 'Документ', docx: 'Google Docs' }[input.format],
          JSON.stringify({ rows }),
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
    const bytes = await fetchPublicGoogleDocument(input.url, 'docx');
    return this.prepare(actor, { sourceKey: input.sourceKey, bytes, format: 'docx' });
  }
  async decide(
    actor: Actor,
    id: string,
    version: number,
    index: number,
    action: string,
  ): Promise<CompanyImportPreview> {
    requireCondition(
      Number.isSafeInteger(index) && index >= 0 && ['u', 'k', 's', 'n', 'p', 'a'].includes(action),
      400,
      'Некорректное решение',
    );
    return this.db.transaction(async (tx) => {
      const current = await this.actor(actor, tx);
      await this.locks(tx);
      const record = await this.pending(current, id, version, tx);
      const row: InternalRow = record.draft.rows[index];
      requireCondition(row, 400, 'Строка не найдена');
      if (action === 'u' || action === 's') {
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
          compatible(row, sourceRow(target)),
          409,
          'Разные ИНН или организационные формы',
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
        row.disposition = 'update';
        row.decision = action === 's' ? 'same' : 'update';
      } else if (action === 'p') {
        requireCondition(row.disposition === 'foreign', 409, 'Решение устарело');
        requireCondition(
          !row.foreignInn,
          409,
          'Такой ИНН уже существует. Запросите доступ у администратора',
        );
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
      'SELECT id,company_id,data,version,deleted,contact_source,kind FROM records WHERE id=$1',
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
      const result: CompanyImportResult = { created: [], skipped: 0, updated: [] };
      const journal: Journal = { companies: [], records: [] };
      const applied = new Map<InternalRow, string>();
      for (const row of record.draft.rows as InternalRow[]) {
        this.privacy(JSON.stringify(row.data));
        for (const c of row.contacts || [])
          parseBusinessContacts([c.name, c.role, c.phone, c.email].join(', '), this.privacy);
        for (const p of row.projects || []) this.privacy(JSON.stringify(p.data));
        if (['skip_duplicate', 'foreign'].includes(row.disposition)) {
          result.skipped++;
          continue;
        }
        let companyId: string,
          before: Snapshot | null = null;
        if (row.disposition === 'update') {
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
          requireCondition(!target.data.archived, 409, 'Сначала восстановите компанию');
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
          const data = this.mergeData(target.data, row);
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
          const c = await this.crm.create(
            current,
            {
              ...row.data,
              ...(row.legalForm ? { legalForm: row.legalForm } : {}),
              segment: row.data.segment ?? 'unknown',
            },
            current.id,
            tx,
          );
          companyId = c.id;
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
        for (const contact of row.contacts || []) {
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
        for (const project of row.projects || []) {
          if (
            records.some(
              (r) => r.kind === 'project' && identity(r.data.name) === identity(project.data.name),
            )
          )
            continue;
          const customer = [...applied].find(
            ([r]) => r.data.inn && r.data.inn === project.customerInn,
          );
          const data = {
            ...project.data,
            participants:
              customer && customer[1] !== companyId
                ? [
                    {
                      companyId: customer[1],
                      role: 'Заказчик',
                      contactId: null,
                      currentTask: '',
                      nextStep: '',
                    },
                  ]
                : [],
          };
          const p = await this.crm.createRecord(current, companyId, 'project', data, null, tx);
          const after = await this.recordSnapshot(tx, p.id);
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
          references.every((r) => journal.records.some((w) => w.after.id === r.id && !w.before)),
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
            refs.every((r) => journal.records.some((w) => !w.before && w.after.id === r.id)),
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
