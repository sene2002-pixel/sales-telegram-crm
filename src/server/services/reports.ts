import { randomUUID } from 'node:crypto';
import {
  Actor,
  Report,
  Extraction,
  extractionSchema,
  confirmSchema,
  idSchema,
  companySchema,
} from '../../shared/contracts';
import { Database, Sql } from '../infra/database';
import { CrmService } from './crm';
import { requireCondition } from '../domain/errors';
import { isLeader } from './auth';
import { audit } from '../infra/audit';

export function mapReport(r: any): Report {
  return {
    id: r.id,
    authorId: r.author_id,
    authorName: r.author_name || '',
    status: r.status,
    version: r.version,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    transcript: r.transcript,
    draft: r.draft,
    error: r.error,
    attempts: r.attempts,
  };
}
export class ReportService {
  constructor(
    public db: Database,
    private crm: CrmService,
  ) {}
  async enqueue(
    actor: Actor,
    input: {
      sourceKey: string;
      chatId?: string;
      audioFileId?: string;
      text?: string;
      sentAt?: string;
    },
  ) {
    requireCondition(
      input.audioFileId || (input.text?.trim() && input.text.length <= 20_000),
      400,
      'Нужен текст или голосовое сообщение',
    );
    return this.db.transaction(async (tx) => {
      const [created] = await tx.query(
        `INSERT INTO reports(id,author_id,source_key,chat_id,audio_file_id,transcript,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_key) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          actor.id,
          input.sourceKey,
          input.chatId || null,
          input.audioFileId || null,
          input.text || null,
          input.sentAt || new Date().toISOString(),
        ],
      );
      if (created) {
        await audit(tx, actor.id, 'report.received', created.id);
        if (input.chatId)
          await this.notify(tx, input.chatId, {
            text: 'Отчёт принят. Подготовлю черновик для проверки.',
          });
        return mapReport(created);
      }
      const [existing] = await tx.query(
        'SELECT * FROM reports WHERE source_key=$1 AND author_id=$2',
        [input.sourceKey, actor.id],
      );
      requireCondition(existing, 409, 'Сообщение уже зарегистрировано');
      return mapReport(existing);
    });
  }
  async notify(tx: Sql, chatId: string, payload: unknown) {
    await tx.query('INSERT INTO outbox(id,chat_id,payload) VALUES($1,$2,$3)', [
      randomUUID(),
      chatId,
      JSON.stringify(payload),
    ]);
  }
  async list(actor: Actor) {
    return (
      await this.db.query(
        `SELECT r.*,u.name AS author_name FROM reports r JOIN users u ON u.id=r.author_id WHERE ($1::boolean OR r.author_id=$2) AND r.purpose='report' ORDER BY r.created_at DESC LIMIT 200`,
        [isLeader(actor), actor.id],
      )
    ).map(mapReport);
  }
  async get(actor: Actor, id: string, tx: Sql = this.db, lock = false) {
    const [r] = await tx.query(`SELECT * FROM reports WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [
      idSchema.parse(id),
    ]);
    requireCondition(
      r && r.purpose === 'report' && (isLeader(actor) || r.author_id === actor.id),
      404,
      'Отчёт не найден',
    );
    return r;
  }
  async edit(actor: Actor, id: string, version: number, draft: Extraction) {
    return this.db.transaction(async (tx) => {
      const r = await this.get(actor, id, tx, true);
      requireCondition(
        r.status === 'review' && r.version === version,
        409,
        'Черновик изменён или уже обработан',
      );
      const [updated] = await tx.query(
        'UPDATE reports SET draft=$1,version=version+1 WHERE id=$2 RETURNING *',
        [JSON.stringify(extractionSchema.parse(draft)), id],
      );
      await audit(tx, actor.id, 'report.edited', id);
      return mapReport(updated);
    });
  }
  async candidates(actor: Actor, draft: Extraction, tx: Sql = this.db) {
    const groups: string[][] = [];
    for (const block of draft.blocks) {
      const rows = await tx.query(
        `SELECT id FROM companies WHERE ($1::boolean OR owner_id=$2) AND (($3::text IS NOT NULL AND $3<>'' AND data->>'inn'=$3) OR (($3::text IS NULL OR $3='') AND lower(data->>'name')=lower($4)))`,
        [isLeader(actor), actor.id, block.inn, block.companyName],
      );
      groups.push(rows.map((r) => r.id));
    }
    return groups;
  }
  async confirmCurrent(actor: Actor, id: string, expectedVersion?: number) {
    const r = await this.get(actor, id);
    if (r.status === 'saved') return { id, status: 'saved', result: r.result };
    requireCondition(
      expectedVersion === undefined || expectedVersion === r.version,
      409,
      'Черновик изменён. Проверьте актуальную версию в CRM',
    );
    requireCondition(r.status === 'review' && r.draft, 409, 'Черновик ещё не готов');
    const groups = await this.candidates(actor, r.draft);
    requireCondition(
      groups.every((g) => g.length <= 1),
      409,
      'Несколько компаний с таким названием. Выберите компанию в CRM',
    );
    return this.confirm(actor, id, {
      version: r.version,
      draft: r.draft,
      companyIds: groups.map((g) => g[0] || null),
    });
  }
  async confirm(actor: Actor, id: string, raw: unknown) {
    const input = confirmSchema.parse(raw);
    requireCondition(
      input.companyIds.length === input.draft.blocks.length,
      400,
      'Для каждого блока выберите компанию',
    );
    return this.db.transaction(async (tx) => {
      const r = await this.get(actor, id, tx, true);
      if (r.status === 'saved') return { id, status: 'saved', result: r.result };
      requireCondition(
        r.status === 'review' && r.version === input.version,
        409,
        'Черновик изменён или уже обработан',
      );
      // Serialize cross-report matching/new-company creation to prevent duplicate companies from concurrent confirmations.
      await tx.query('SELECT pg_advisory_xact_lock(7142503)');
      const [author] = await tx.query<Actor>(
        'SELECT id,name,role,active,telegram_id AS "telegramId" FROM users WHERE id=$1',
        [r.author_id],
      );
      requireCondition(author?.active, 409, 'Автор отчёта неактивен');
      const result: { companyId: string; activityId: string }[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < input.draft.blocks.length; i++) {
        const block = input.draft.blocks[i]!;
        let companyId = input.companyIds[i];
        if (!companyId) {
          const [matches] = await this.candidates(actor, { blocks: [block], warnings: [] }, tx);
          requireCondition(
            !matches?.length,
            409,
            'Компания уже существует. Выберите её в черновике',
          );
          const newData = companySchema.parse({
            name: block.companyName,
            inn: block.inn || '',
            city: block.city || '',
            segment: block.segment || 'end_client',
            stage: block.stage || 'new',
            potential: block.potential,
            divisions: Object.fromEntries(block.divisions.map((d) => [d.key, d.amount])),
          });
          const company = await this.crm.create(actor, newData, author.id, tx);
          companyId = company.id;
        }
        requireCondition(!seen.has(companyId), 400, 'Объедините блоки одной компании');
        seen.add(companyId);
        const company = await this.crm.company(actor, companyId, tx, true);
        // A supervisor can confirm an old report after reassignment; a manager cannot access a former company.
        const activity = await this.crm.createRecord(
          actor,
          companyId,
          'activity',
          { text: block.summary, occurredOn: block.occurredOn },
          null,
          tx,
        );
        await tx.query('UPDATE records SET author_id=$1,data=data || $2::jsonb WHERE id=$3', [
          author.id,
          JSON.stringify({ reportId: id }),
          activity.id,
        ]);
        for (const contact of block.contacts) {
          const duplicates = await tx.query(
            `SELECT id FROM records WHERE company_id=$1 AND kind='contact' AND NOT deleted AND lower(data->>'name')=lower($2) AND coalesce(data->>'phone','')=$3 AND coalesce(data->>'email','')=$4`,
            [companyId, contact.name, contact.phone || '', contact.email || ''],
          );
          if (!duplicates.length)
            await this.crm.createRecord(
              actor,
              companyId,
              'contact',
              {
                name: contact.name,
                role: contact.role || '',
                phone: contact.phone || '',
                email: contact.email || '',
              },
              null,
              tx,
            );
        }
        for (const task of block.tasks)
          await this.crm.createRecord(actor, companyId, 'task', { ...task, done: false }, null, tx);
        const {
          id: _id,
          ownerId: _owner,
          ownerName: _name,
          version: _version,
          createdAt: _created,
          updatedAt: _updated,
          ...data
        } = company;
        if (block.stage !== null) data.stage = block.stage;
        if (block.potential !== null) data.potential = block.potential;
        for (const d of block.divisions) data.divisions[d.key] = d.amount;
        await tx.query(
          'UPDATE companies SET data=$1,version=version+1,updated_at=now() WHERE id=$2',
          [JSON.stringify(data), companyId],
        );
        await audit(tx, actor.id, 'report.applied', id, companyId, {
          authorId: author.id,
          before: company,
          block,
        });
        result.push({ companyId, activityId: activity.id });
      }
      await tx.query(
        `UPDATE reports SET status='saved',version=version+1,draft=$1,result=$2,error=NULL WHERE id=$3`,
        [JSON.stringify(input.draft), JSON.stringify(result), id],
      );
      if (r.chat_id)
        await this.notify(tx, r.chat_id, {
          text: 'Отчёт сохранён. Компании и задачи доступны в CRM.',
        });
      return { id, status: 'saved', result };
    });
  }
  async transition(actor: Actor, id: string, action: 'cancel' | 'retry') {
    return this.db.transaction(async (tx) => {
      const r = await this.get(actor, id, tx, true);
      requireCondition(
        action === 'retry'
          ? r.status === 'failed'
          : ['review', 'queued', 'failed'].includes(r.status),
        409,
        'Недопустимое состояние отчёта',
      );
      await tx.query(
        `UPDATE reports SET status=$1,attempts=0,error=NULL,lease_until=NULL,lease_token=NULL,available_at=now(),version=version+1 WHERE id=$2`,
        [action === 'retry' ? 'queued' : 'cancelled', id],
      );
      await audit(tx, actor.id, `report.${action}`, id);
      return { ok: true };
    });
  }
}
