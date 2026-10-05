import { randomUUID } from 'node:crypto';
import { DiagnosticLog } from '../infra/diagnostic-log';
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
import { ProcessingStatus } from '../infra/processing-status';
import { TaskMessages } from './task-messages';
import { normalizeSales, projectSales, salesFeedback, salesQuestions } from '../../shared/sales';

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
  readonly processing: ProcessingStatus;
  readonly messages: TaskMessages;
  constructor(
    public db: Database,
    private crm: CrmService,
    private diagnostics?: DiagnosticLog,
    private retentionDays = 30,
  ) {
    this.processing = new ProcessingStatus(db);
    this.messages = new TaskMessages(db);
  }
  async enqueue(
    actor: Actor,
    input: {
      sourceKey: string;
      chatId?: string;
      messageId?: number;
      audioFileId?: string;
      imageFileId?: string;
      text?: string;
      sentAt?: string;
      purpose?: 'dialogue';
    },
  ) {
    requireCondition(
      input.audioFileId ||
        (input.imageFileId && input.purpose === 'dialogue') ||
        (input.text?.trim() && input.text.length <= 20_000),
      400,
      'Нужен текст или голосовое сообщение',
    );
    return this.db.transaction(async (tx) => {
      // Serialize arrival with dialogue callbacks; bind clarification before transcription/AI.
      let editActionId: string | null = null;
      let recipientJob: any = null;
      if (input.purpose === 'dialogue') {
        await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor.id]);
        const [editing] = await tx.query(
          "SELECT id FROM dialogue_actions WHERE user_id=$1 AND status='needs_info' AND snapshot->>'editing'='true' ORDER BY sequence LIMIT 1",
          [actor.id],
        );
        editActionId = editing?.id ?? null;
        if (!editActionId) {
          [recipientJob] = await tx.query(
            "SELECT id,research_version FROM letter_jobs WHERE user_id=$1 AND status='waiting_recipient' ORDER BY created_at LIMIT 1",
            [actor.id],
          );
        }
      }
      const [created] = await tx.query(
        `INSERT INTO reports(id,author_id,source_key,chat_id,audio_file_id,transcript,created_at,purpose,image_file_id,edit_action_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(source_key) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          actor.id,
          input.sourceKey,
          input.chatId || null,
          input.audioFileId || null,
          input.text || null,
          input.sentAt || new Date().toISOString(),
          input.purpose || 'report',
          input.imageFileId || null,
          editActionId,
        ],
      );
      if (created) {
        if (recipientJob)
          await tx.query(
            'UPDATE reports SET recipient_job_id=$2,recipient_job_version=$3 WHERE id=$1',
            [created.id, recipientJob.id, recipientJob.research_version],
          );
        if (input.chatId && input.messageId)
          await this.messages.remember(tx, input.chatId, input.messageId, [
            `source:${input.sourceKey}`,
          ]);
        if (input.purpose === 'dialogue')
          await tx.query(
            `INSERT INTO request_history(report_id,user_id,source_key,edit_action_id,original_text,audio_file_id,image_file_id,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 day')`,
            [
              created.id,
              actor.id,
              input.sourceKey,
              editActionId,
              input.text || null,
              input.audioFileId || null,
              input.imageFileId || null,
              this.retentionDays,
            ],
          );
        await this.diagnostics?.record(
          'report.queued',
          {
            reportId: created.id,
            sourceKey: input.sourceKey,
            kind: input.imageFileId ? 'photo' : input.audioFileId ? 'voice' : 'text',
          },
          tx,
        );
        await audit(tx, actor.id, 'report.received', created.id);
        if (input.chatId)
          await this.processing.begin(
            tx,
            input.sourceKey,
            input.chatId,
            input.imageFileId
              ? 'Распознаю данные изображения…'
              : input.audioFileId
                ? 'Распознаю голосовой запрос…'
                : 'Анализирую информацию…',
          );
        return mapReport(created);
      }
      const [existing] = await tx.query(
        'SELECT * FROM reports WHERE source_key=$1 AND author_id=$2',
        [input.sourceKey, actor.id],
      );
      requireCondition(existing, 409, 'Сообщение уже зарегистрировано');
      await this.diagnostics?.record(
        'report.duplicate',
        { reportId: existing.id, sourceKey: input.sourceKey },
        tx,
      );
      return mapReport(existing);
    });
  }
  async notify(tx: Sql, chatId: string, payload: unknown, taskKey?: string) {
    const id = randomUUID();
    const processingKey = this.processing.key;
    const generation = processingKey ? await this.processing.finish(tx, processingKey) : null;
    await tx.query(
      'INSERT INTO outbox(id,chat_id,payload,trace_id,actor_id,processing_key,processing_generation) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        chatId,
        JSON.stringify(payload),
        this.diagnostics?.context?.traceId || null,
        this.diagnostics?.context?.actorId || null,
        processingKey || null,
        generation || null,
      ],
    );
    await this.diagnostics?.record('notification.queued', { outboxId: id }, tx);
    await tx.query('UPDATE outbox SET task_keys=$2 WHERE id=$1', [
      id,
      JSON.stringify(taskKey ? [taskKey] : this.messages.keys(payload, processingKey)),
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
  async feedback(actor: Actor, draft: Extraction, tx: Sql = this.db) {
    const groups = await this.candidates(actor, draft, tx);
    const responses: string[] = [];
    let questionBudget = 3;
    for (let i = 0; i < draft.blocks.length; i++) {
      const b = draft.blocks[i]!;
      if (!b.sales) {
        responses.push(`${b.companyName}\n${b.summary}`);
        continue;
      }
      const sales = normalizeSales(b.sales);
      const id = `preview:${i}`;
      const current =
        groups[i]?.length === 1
          ? (await this.crm.salesPreview(actor, groups[i]![0]!, sales, id, b.occurredOn, tx))
              .current
          : projectSales([
              { id, occurredOn: b.occurredOn, createdAt: new Date().toISOString(), sales },
            ]).current;
      const questions = salesQuestions(current, i).slice(0, questionBudget);
      questionBudget -= questions.length;
      responses.push(
        `${salesFeedback(b.companyName, { ...current, deferred: true }, i)}\nЧто уточнено: ${b.summary}\n${questions.map((q) => `- ${q}`).join('\n')}`,
      );
    }
    return responses.join('\n\n');
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
        const sales = block.sales ? normalizeSales(block.sales) : null;
        if (sales && !sales.client.city && block.city !== null) sales.client.city={value:block.city,certainty:'confirmed'};
        if (sales && !sales.client.segment && block.segment !== null) sales.client.segment={value:block.segment,certainty:'confirmed'};
        // A supervisor can confirm an old report after reassignment; a manager cannot access a former company.
        const activity = await this.crm.createRecord(
          actor,
          companyId,
          'activity',
          {
            text: block.summary,
            occurredOn: block.occurredOn,
            sales,
          },
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
        } = await this.crm.company(actor, companyId, tx);
        if (!sales && block.city !== null) data.city = block.city;
        if (!sales && block.segment !== null) data.segment = block.segment;
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
      if (action === 'cancel' && r.status === 'cancelled') return { ok: true };
      requireCondition(
        action !== 'cancel' || r.status !== 'saved',
        409,
        'Отчёт уже сохранён. Эта кнопка не удаляет сохранённые данные. Измените их в CRM',
      );
      requireCondition(
        action === 'retry'
          ? r.status === 'failed'
          : ['review', 'queued', 'processing', 'failed'].includes(r.status),
        409,
        'Недопустимое состояние отчёта',
      );
      await tx.query(
        `UPDATE reports SET status=$1,attempts=0,error=NULL,lease_until=NULL,lease_token=NULL,available_at=now(),version=version+1 WHERE id=$2`,
        [action === 'retry' ? 'queued' : 'cancelled', id],
      );
      await audit(tx, actor.id, `report.${action}`, id);
      if (action === 'cancel') await this.processing.finish(tx, r.source_key);
      else if (r.chat_id)
        await this.processing.begin(tx, r.source_key, r.chat_id, 'Повторяю обработку…');
      return { ok: true };
    });
  }
}
