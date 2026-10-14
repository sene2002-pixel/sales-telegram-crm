import { randomUUID } from 'node:crypto';
import { Actor, idSchema, labels, divisionLabels } from '../../shared/contracts';
import { Database, Sql } from '../infra/database';
import { CrmService } from './crm';
import { requireCondition } from '../domain/errors';
import {
  ImportedCompany,
  ImportPrivacyGuard,
  fetchPublicGoogleDocument,
  parseCompanyImport,
} from './company-import-parser';

export const importConfirmPrefix = 'ic';
export const importCancelPrefix = 'ix';
export interface CompanyImportDraftRow extends ImportedCompany {
  disposition: 'create' | 'skip_duplicate';
}
export interface CompanyImportResult {
  created: string[];
  skipped: number;
}
export interface CompanyImportPreview {
  id: string;
  version: number;
  rows: CompanyImportDraftRow[];
  messages: string[];
  replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] };
}
// DDL is installed by the application's additive migration. Only sanitized mapped fields are stored.
export class CompanyImports {
  constructor(
    private db: Database,
    private crm: CrmService,
    private privacy: ImportPrivacyGuard,
  ) {}
  private async actor(actor: Actor, tx: Sql): Promise<Actor> {
    const [current] = await tx.query(
      'SELECT id,telegram_id,name,role,active,supervisor_id FROM users WHERE id=$1',
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
  private async duplicate(tx: Sql, row: ImportedCompany) {
    // Generic disposition exposes no other owner's CRM record or values.
    const found = await tx.query(
      `SELECT id FROM companies WHERE lower(trim(data->>'name'))=lower(trim($1)) OR ($2<>'' AND data->>'inn'=$2) LIMIT 1`,
      [row.data.name, row.data.inn || ''],
    );
    return found.length > 0;
  }
  private preview(record: any): CompanyImportPreview {
    const rows: CompanyImportDraftRow[] = record.draft.rows;
    const chunks: string[] = [];
    let message =
      'Предпросмотр импорта компаний. Пока ничего не сохранено.\nДубли пропускаются, существующие компании не изменяются.\n';
    rows.forEach((row, index) => {
      const details =
        [
          `${index + 1}. ${row.data.name} — ${row.disposition === 'create' ? 'создать' : 'дубль: пропустить'}`,
          `Источник: ${row.source}`,
          ...Object.entries(row.data)
            .filter(([key]) => key !== 'name')
            .map(([key, value]) => {
              const fieldLabel: Record<string, string> = {
                inn: 'ИНН',
                city: 'Город',
                segment: 'Тип',
                industry: 'Отрасль',
                potential: 'Потенциал, ₽',
                stage: 'Стадия',
                revenue: 'Выручка, ₽',
                notes: 'Заметки',
                divisions: 'Направления, ₽',
              };
              const display =
                key === 'divisions'
                  ? Object.entries(value as Record<string, number>)
                      .map(
                        ([division, amount]) =>
                          `${divisionLabels[division] || division}: ${amount}`,
                      )
                      .join('; ')
                  : key === 'segment' || key === 'stage'
                    ? labels[String(value)] || value
                    : value;
              return `${fieldLabel[key] || key}: ${display}`;
            }),
          ...(row.missing.length ? [`Не указано: ${row.missing.join(', ')}`] : []),
          ...(row.data.stage === undefined
            ? [
                'Стадия в источнике не указана: новая запись CRM получит техническую стадию «Новый».',
              ]
            : []),
          ...row.warnings,
        ].join('\n') + '\n\n';
      if (message.length + details.length > 3500) {
        chunks.push(message.trim());
        message = '';
      }
      message += details;
    });
    if (message.trim()) chunks.push(message.trim());
    return {
      id: record.id,
      version: record.version,
      rows,
      messages: chunks,
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: 'Подтвердить импорт',
              callback_data: `${importConfirmPrefix}:${record.id}:${record.version}`,
            },
            {
              text: 'Отменить',
              callback_data: `${importCancelPrefix}:${record.id}:${record.version}`,
            },
          ],
        ],
      },
    };
  }
  async prepare(
    actor: Actor,
    input: { sourceKey: string; bytes: Uint8Array; format: 'xlsx' | 'csv' | 'txt' },
  ): Promise<CompanyImportPreview> {
    requireCondition(/^[\w:-]{1,150}$/.test(input.sourceKey), 400, 'Некорректный источник импорта');
    // Idempotency precedes parsing but still verifies the actual actor, not stale caller role.
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
    const parsed = await parseCompanyImport(input.bytes, input.format, this.privacy);
    return this.db.transaction(async (tx) => {
      await this.actor(actor, tx);
      await tx.query('SELECT pg_advisory_xact_lock(7142531)');
      const [old] = await tx.query('SELECT * FROM company_imports WHERE source_key=$1', [
        input.sourceKey,
      ]);
      if (old) {
        requireCondition(old.author_id === actor.id, 403, 'Импорт недоступен');
        requireCondition(
          old.status === 'pending' && new Date(old.expires_at).getTime() > Date.now(),
          409,
          'Импорт уже завершён или истёк',
        );
        return this.preview(old);
      }
      const names = new Set<string>(),
        inns = new Set<string>(),
        rows: CompanyImportDraftRow[] = [];
      for (const row of parsed) {
        const key = row.data.name.trim().toLocaleLowerCase(),
          inn = row.data.inn || '';
        const duplicate =
          names.has(key) || (!!inn && inns.has(inn)) || (await this.duplicate(tx, row));
        names.add(key);
        if (inn) inns.add(inn);
        rows.push({ ...row, disposition: duplicate ? 'skip_duplicate' : 'create' });
      }
      const [record] = await tx.query(
        `INSERT INTO company_imports(id,author_id,source_key,source_label,draft,status,version,expires_at) VALUES($1,$2,$3,$4,$5,'pending',1,now()+interval '30 minutes') RETURNING *`,
        [
          randomUUID(),
          actor.id,
          input.sourceKey,
          { xlsx: 'XLSX', csv: 'CSV', txt: 'Документ' }[input.format],
          JSON.stringify({ rows }),
        ],
      );
      return this.preview(record);
    });
  }
  async prepareGoogle(actor: Actor, input: { sourceKey: string; url: string }) {
    await this.db.transaction((tx) => this.actor(actor, tx));
    // The remote body never enters diagnostics or storage before local parsing/privacy validation.
    const bytes = await fetchPublicGoogleDocument(input.url);
    return this.prepare(actor, { sourceKey: input.sourceKey, bytes, format: 'txt' });
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
      await tx.query('SELECT pg_advisory_xact_lock(7142531)');
      const [record] = await tx.query('SELECT * FROM company_imports WHERE id=$1 FOR UPDATE', [id]);
      requireCondition(record && record.author_id === current.id, 403, 'Импорт недоступен');
      if (record.status === 'saved') return record.draft.result;
      requireCondition(
        record.status === 'pending' && record.version === version,
        409,
        'Импорт изменён или отменён',
      );
      requireCondition(
        new Date(record.expires_at).getTime() > Date.now(),
        409,
        'Предпросмотр истёк. Отправьте файл заново',
      );
      const result: CompanyImportResult = { created: [], skipped: 0 };
      for (const row of record.draft.rows as CompanyImportDraftRow[]) {
        this.privacy(JSON.stringify(row.data));
        if (row.disposition === 'skip_duplicate' || (await this.duplicate(tx, row))) {
          result.skipped++;
          continue;
        }
        const company = await this.crm.create(
          current,
          { ...row.data, segment: row.data.segment ?? 'unknown' },
          current.id,
          tx,
        );
        result.created.push(company.id);
      }
      await tx.query(
        `UPDATE company_imports SET status='saved',version=version+1,draft=$2 WHERE id=$1`,
        [id, JSON.stringify({ ...record.draft, result })],
      );
      return result;
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
      await this.actor(actor, tx);
      const [record] = await tx.query('SELECT * FROM company_imports WHERE id=$1 FOR UPDATE', [id]);
      requireCondition(record && record.author_id === actor.id, 403, 'Импорт недоступен');
      if (record.status === 'cancelled') return;
      requireCondition(
        record.status === 'pending' && record.version === version,
        409,
        'Импорт уже завершён или изменён',
      );
      await tx.query(
        "UPDATE company_imports SET status='cancelled',draft=$2,version=version+1 WHERE id=$1",
        [id, JSON.stringify({ rows: [] })],
      );
    });
  }
}
