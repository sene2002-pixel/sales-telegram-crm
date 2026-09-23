import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  Actor,
  activitySchema,
  companySchema,
  contactSchema,
  idSchema,
  labels,
  taskSchema,
  validInn,
} from '../../shared/contracts';
import { maxSignatures, signatureSchema } from '../../shared/letters';
import { Config } from '../config';
import { requireCondition } from '../domain/errors';
import { Sql } from '../infra/database';
import { audit } from '../infra/audit';
import { DiagnosticLog } from '../infra/diagnostic-log';
import { isLeader, userProjection } from './auth';
import { CrmService } from './crm';
import { LetterBot } from './letter-bot';
import { LetterService } from './letters';
import { ReportService } from './reports';
import { photoInstructions } from './photo-input';
import { assignDefault, checkedSignature, signatureName } from './signature-choice';
import {
  DialogueAction,
  dialogueActionSchema,
  dialogueInstructions,
  dialoguePlanSchema,
} from './dialogue-plan';

type CompanyContext = { id?: string; name: string; inn: string; city: string };
const editable = ['queued', 'ready', 'selecting', 'needs_info'];
const pending = [...editable, 'executing'];
const queueLimit = 5;
const normalize = (s: string) =>
  s
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const companyName = (s: string) => normalize(s).replace(/^(ооо|ао|пао|оао|зао|ип)\s+/u, '');
const supplied = (data: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null));
const titles: Record<DialogueAction['kind'], string> = {
  letter: 'Подготовить информационное письмо',
  contact_create: 'Создать контакт',
  contact_edit: 'Изменить контакт',
  activity_create: 'Сохранить результат разговора',
  task_create: 'Создать задачу',
  company_create: 'Создать компанию',
  company_import: 'Распознать карточку компании',
  company_update: 'Обновить компанию',
  signature_create: 'Создать подпись',
  signature_edit: 'Изменить подпись',
  signature_delete: 'Удалить подпись',
  signature_default: 'Назначить подпись по умолчанию',
};
const fieldNames: Record<string, string> = {
  name: 'Имя',
  role: 'Должность',
  phone: 'Телефон',
  email: 'Email',
  text: 'Текст',
  occurredOn: 'Дата',
  due: 'Срок',
  lastName: 'Фамилия',
  firstName: 'Имя',
  patronymic: 'Отчество',
  workPhone: 'Рабочий телефон',
  mobilePhone: 'Мобильный телефон',
  city: 'Город',
  inn: 'ИНН',
  industry: 'Отрасль',
  segment: 'Сегмент',
  stage: 'Этап',
  potential: 'Потенциал, ₽',
  notes: 'Примечания',
};
const fieldsText = (data: Record<string, unknown>) =>
  Object.entries(data)
    .filter(([key]) => key in fieldNames)
    .map(
      ([key, value]) =>
        `${fieldNames[key]}: ${value === null || value === '' ? '—' : key === 'stage' || key === 'segment' ? labels[String(value)] || value : value}`,
    )
    .join('\n');

/** The model proposes data only. IDs, ACL, previews and commits belong to this service. */
export class DialogueService {
  constructor(
    private crm: CrmService,
    private reports: ReportService,
    private letters: LetterService,
    private letterBot: LetterBot,
    private config: Config,
    private diagnostics?: DiagnosticLog,
  ) {}
  private async actor(tx: Sql, id: string): Promise<Actor> {
    const [actor] = await tx.query<Actor>(
      `SELECT ${userProjection} FROM users WHERE id=$1 FOR UPDATE`,
      [id],
    );
    requireCondition(actor?.active, 403, 'Доступ отозван');
    return actor;
  }
  private async state(tx: Sql, userId: string) {
    await tx.query('INSERT INTO dialogue_state(user_id) VALUES($1) ON CONFLICT DO NOTHING', [
      userId,
    ]);
    return (
      await tx.query('SELECT * FROM dialogue_state WHERE user_id=$1 FOR UPDATE', [userId])
    )[0];
  }
  private async remember(tx: Sql, userId: string, company: CompanyContext | null) {
    await tx.query(
      'UPDATE dialogue_state SET company=$2,revision=revision+1,updated_at=now() WHERE user_id=$1',
      [userId, company ? JSON.stringify(company) : null],
    );
  }
  private async accessible(tx: Sql, actor: Actor) {
    return tx.query(
      "SELECT id,owner_id,data,version FROM companies WHERE ($1::boolean OR owner_id=$2) AND NOT (data->>'archived')::boolean",
      [isLeader(actor), actor.id],
    );
  }
  private context(row: any): CompanyContext {
    return { id: row.id, name: row.data.name, inn: row.data.inn, city: row.data.city };
  }

  async process(report: any, token: string, text: string, image?: string) {
    // Snapshot under an actor lock; never hold a database transaction across an AI request.
    const input = await this.crm.db.transaction(async (tx) => {
      const actor = await this.actor(tx, report.author_id);
      const state = await this.state(tx, actor.id);
      const available = await this.accessible(tx, actor);
      if (state.company?.id && !available.some((c) => c.id === state.company.id)) {
        await this.remember(tx, actor.id, null);
        state.company = null;
        state.revision++;
      }
      const remembered = available.find((c) => c.id === state.company?.id);
      if (remembered && !isDeepStrictEqual(state.company, this.context(remembered))) {
        state.company = this.context(remembered);
        await this.remember(tx, actor.id, state.company);
        state.revision++;
      }
      const actions = await tx.query(
        'SELECT payload,company,status,snapshot FROM dialogue_actions WHERE user_id=$1 AND status=ANY($2::text[]) ORDER BY sequence',
        [actor.id, editable],
      );
      return { revision: state.revision, company: state.company, actions };
    });
    const messageInput = (context: string) =>
      image
        ? [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: context },
                { type: 'input_image', image_url: image, detail: 'high' },
              ],
            },
          ]
        : context;
    const plan = dialoguePlanSchema.parse(
      await this.letters.structured(
        dialoguePlanSchema,
        dialogueInstructions + (image ? photoInstructions : ''),
        messageInput(
          JSON.stringify({
            message: text,
            sentAt: report.created_at,
            timezone: this.config.timezone,
            lastCompany: input.company
              ? { name: input.company.name, inn: input.company.inn, city: input.company.city }
              : null,
            pending: input.actions.map((a) => ({
              action: a.payload,
              company: a.company
                ? { name: a.company.name, inn: a.company.inn, city: a.company.city }
                : null,
              status: a.status,
              question: a.snapshot?.question || null,
            })),
          }),
        ),
        false,
        false,
        {
          schemaName: 'crm_dialogue',
          maxOutputTokens: 6000,
          ...(/^gpt-4[.o-]/.test(this.config.letterModel) ? { temperature: 0 } : {}),
        },
      ),
    );
    // Photo company data is always a reviewed import, never a blind notes replacement.
    if (image)
      plan.actions = plan.actions.map((action) =>
        action.kind === 'company_create' || action.kind === 'company_update'
          ? { ...action, kind: 'company_import' }
          : action,
      );
    await this.crm.db.transaction(async (tx) => {
      const actor = await this.actor(tx, report.author_id);
      const state = await this.state(tx, actor.id);
      const [current] = await tx.query(
        'SELECT id FROM reports WHERE id=$1 AND lease_token=$2 FOR UPDATE',
        [report.id, token],
      );
      if (!current) return;
      requireCondition(
        state.revision === input.revision,
        409,
        'Контекст изменился, повторяю разбор запроса',
      );
      const open = await tx.query(
        'SELECT * FROM dialogue_actions WHERE user_id=$1 AND status=ANY($2::text[]) ORDER BY sequence',
        [actor.id, pending],
      );
      requireCondition(
        !plan.actions.length ||
          (plan.mode === 'replace'
            ? open.filter((r) => r.status === 'executing').length
            : open.length) +
            plan.actions.length <=
            queueLimit,
        422,
        open.length >= queueLimit && plan.mode !== 'replace'
          ? 'В очереди уже 5 задач. Подтвердите или отмените предыдущие, затем повторите запрос. Новые задачи не добавлены.'
          : `В очереди максимум 5 задач. Сейчас ожидают: ${open.length}; в запросе действий: ${plan.actions.length}. Запрос целиком не добавлен. Уменьшите число действий или сначала завершите предыдущие задачи.`,
      );
      // A prerequisite is a step inside the blocked task, not a new queue slot.
      // Corrections must retain the original task and all following tasks.
      if (plan.mode === 'replace' && open[0]?.resume && plan.actions.length) {
        const row = open[0];
        requireCondition(
          plan.actions[0]!.kind === row.payload.kind &&
            (plan.actions.length === 1 ||
              (plan.actions.length === open.length &&
                plan.actions.slice(1).every((a, i) => {
                  const existing = open[i + 1];
                  return (
                    isDeepStrictEqual(
                      { ...a, company: null },
                      { ...existing.payload, company: null },
                    ) &&
                    (a.company.mode !== 'named' ||
                      (existing.company &&
                        companyName(a.company.name) === companyName(existing.company.name) &&
                        (!a.company.inn || a.company.inn === existing.company.inn) &&
                        (!a.company.city ||
                          normalize(a.company.city) === normalize(existing.company.city))))
                  );
                }))),
          422,
          'Сначала завершите или отмените текущую задачу. Сейчас уточните только данные необходимого действия.',
        );
        row.payload = plan.actions[0];
        row.snapshot = null;
        await tx.query(
          "UPDATE dialogue_actions SET payload=$2,snapshot=NULL,status='queued' WHERE id=$1",
          [row.id, JSON.stringify(row.payload)],
        );
        await this.remember(tx, actor.id, state.company);
        await tx.query(
          "UPDATE reports SET status='cancelled',transcript=NULL,audio_file_id=NULL,image_file_id=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",
          [report.id],
        );
        await this.prepare(tx, actor, row);
        return;
      }
      if (plan.mode === 'replace' && plan.actions.length) {
        await tx.query(
          "UPDATE dialogue_actions SET status='cancelled',payload='{}',snapshot=NULL,resume=NULL,options='[]' WHERE user_id=$1 AND status=ANY($2::text[])",
          [actor.id, editable],
        );
        if (open.length)
          await this.reports.notify(tx, actor.telegramId, {
            text: 'Обновил неподтверждённые действия с учётом уточнения. Старые кнопки больше не действуют. Проверяйте новые подтверждения.',
          });
      }
      let last: CompanyContext | null = state.company;
      for (const [position, action] of plan.actions.entries()) {
        const ref = action.company;
        const bound = action.kind.startsWith('signature_')
          ? null
          : ref.mode === 'named' && ref.name
            ? { name: ref.name, inn: ref.inn, city: ref.city }
            : ref.mode === 'last'
              ? last
              : null;
        if (bound && !action.kind.startsWith('signature_')) last = bound;
        await tx.query(
          'INSERT INTO dialogue_actions(id,user_id,report_id,position,payload,company) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            actor.id,
            report.id,
            position,
            JSON.stringify(action),
            bound ? JSON.stringify(bound) : null,
          ],
        );
      }
      if (plan.discussedCompany?.mode === 'named' && plan.discussedCompany.name)
        last = {
          name: plan.discussedCompany.name,
          inn: plan.discussedCompany.inn,
          city: plan.discussedCompany.city,
        };
      // Resolve only exact, accessible and unique matches. Never guess a company ID.
      if (last && !last.id) {
        const matches = this.matches(await this.accessible(tx, actor), last);
        if (matches.length === 1) last = this.context(matches[0]);
      }
      await this.remember(tx, actor.id, last);
      await tx.query(
        "UPDATE reports SET status='cancelled',transcript=NULL,audio_file_id=NULL,image_file_id=NULL,draft=NULL,error=NULL,lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=$1",
        [report.id],
      );
      if (plan.reply || !plan.actions.length)
        await this.reports.notify(tx, actor.telegramId, {
          text: plan.reply || 'Не знаю такой команды. Уточните задачу или откройте /voice.',
        });
      if (plan.actions.length > 1)
        await this.reports.notify(tx, actor.telegramId, {
          text: `Распознано действий: ${plan.actions.length}. Покажу по очереди; каждое нужно подтвердить отдельно. «Отменить задачу» отменяет только текущую задачу.`,
        });
      if (plan.actions.length && plan.mode !== 'replace' && open.length) {
        const wait =
          open[0].status === 'ready'
            ? 'Выполнение очереди ожидает подтверждения предыдущей команды. Подтвердите её или нажмите «Отменить задачу».'
            : open[0].status === 'selecting'
              ? 'Предыдущая команда ожидает выбора из списка. Сделайте выбор или нажмите «Отменить задачу».'
              : open[0].status === 'needs_info'
                ? 'Предыдущая команда ожидает уточнения данных. Ответьте на вопрос или нажмите «Отменить задачу».'
                : 'Предыдущая команда выполняется. Следующая задача появится только после её завершения.';
        await this.reports.notify(tx, actor.telegramId, {
          text: `Добавлено в очередь задач: ${plan.actions.length}. Перед ними задач: ${open.length}. Всего в очереди: ${open.length + plan.actions.length} из 5.\n${wait}`,
        });
      }
      await this.diagnostics?.record(
        'dialogue.planned',
        { count: plan.actions.length, kinds: plan.actions.map((a) => a.kind), mode: plan.mode },
        tx,
      );
      await this.next(tx, actor);
    });
  }
  private matches(companies: any[], target: CompanyContext) {
    return companies
      .filter((c) =>
        target.inn
          ? c.data.inn === target.inn
          : companyName(c.data.name) === companyName(target.name),
      )
      .filter((c) => !target.city || normalize(c.data.city) === normalize(target.city));
  }
  private async ask(
    tx: Sql,
    actor: Actor,
    row: any,
    text: string,
    remedy?: 'signature_create' | 'company_create' | 'contact_create',
  ) {
    await tx.query("UPDATE dialogue_actions SET status='needs_info',snapshot=$2 WHERE id=$1", [
      row.id,
      JSON.stringify({ question: text, remedy }),
    ]);
    await this.reports.notify(tx, actor.telegramId, {
      text: `Следующая задача: ${titles[row.payload.kind as DialogueAction['kind']]}\n${row.company ? `Компания: ${row.company.name}\n` : ''}${remedy ? 'Выполнить невозможно: ' : ''}${text}\nОтветьте текстом или голосом. Пока ничего не изменено.`,
      reply_markup: {
        inline_keyboard: [
          ...(remedy ? [[{ text: titles[remedy], callback_data: `dr:${row.id}` }]] : []),
          [{ text: 'Отменить задачу', callback_data: `dx:${row.id}` }],
        ],
      },
    });
  }
  private async choices(tx: Sql, actor: Actor, row: any, options: any[], type: string) {
    if (!options.length || options.length > 10)
      return this.ask(
        tx,
        actor,
        row,
        options.length
          ? 'Слишком много совпадений. Уточните название, ФИО, город или ИНН.'
          : 'Подходящих записей нет. Уточните данные.',
      );
    await tx.query(
      "UPDATE dialogue_actions SET status='selecting',options=$2,snapshot=$3 WHERE id=$1",
      [row.id, JSON.stringify(options), JSON.stringify({ choice: type })],
    );
    await this.reports.notify(tx, actor.telegramId, {
      text: `${titles[row.payload.kind as DialogueAction['kind']]}\nВыберите ${type === 'company' ? 'компанию' : type === 'contact' ? 'контакт' : 'подпись'}. После выбора покажу отдельное подтверждение; выбор ещё ничего не изменяет.\n\n${options.map((o, i) => `${i + 1}. ${o.label.slice(0, 240)}`).join('\n')}`,
      reply_markup: {
        inline_keyboard: [
          ...options.map((o, i) => [
            { text: `${i + 1}. ${o.label}`.slice(0, 100), callback_data: `dp:${row.id}:${i}` },
          ]),
          [{ text: 'Отменить задачу', callback_data: `dx:${row.id}` }],
        ],
      },
    });
  }
  private async next(tx: Sql, actor: Actor) {
    const [row] = await tx.query(
      'SELECT * FROM dialogue_actions WHERE user_id=$1 AND status=ANY($2::text[]) ORDER BY sequence LIMIT 1 FOR UPDATE',
      [actor.id, pending],
    );
    if (!row || row.status !== 'queued') return;
    await this.prepare(tx, actor, row);
  }
  /** Durable completion check: generation alone is not completion; Telegram must accept the PDF. */
  async reconcile() {
    const [candidate] = await this.crm.db.query(
      `SELECT d.id,d.user_id FROM dialogue_actions d JOIN users u ON u.id=d.user_id
       JOIN letter_jobs j ON j.source_key='dialogue:' || d.id::text
       WHERE d.status='executing' AND u.active AND j.status IN ('sent','failed','cancelled') ORDER BY d.sequence LIMIT 1`,
    );
    if (!candidate) return;
    await this.crm.db.transaction(async (tx) => {
      const actor = await this.actor(tx, candidate.user_id);
      await this.state(tx, actor.id);
      const [row] = await tx.query(
        "SELECT * FROM dialogue_actions WHERE id=$1 AND status='executing' FOR UPDATE",
        [candidate.id],
      );
      if (!row) return;
      const [job] = await tx.query('SELECT * FROM letter_jobs WHERE source_key=$1', [
        `dialogue:${row.id}`,
      ]);
      if (job.status === 'sent') {
        await tx.query(
          "UPDATE dialogue_actions SET status='done',payload='{}',snapshot=NULL,resume=NULL WHERE id=$1",
          [row.id],
        );
        await audit(tx, actor.id, 'dialogue.letter', row.id);
        await this.reports.notify(tx, actor.telegramId, {
          text: 'Задача выполнена: PDF отправлен в Telegram и сохранён в CRM.',
        });
        await this.next(tx, actor);
      } else if (['failed', 'cancelled'].includes(job.status)) {
        const reason =
          job.error ||
          (job.file_id
            ? 'Не удалось доставить PDF в Telegram.'
            : 'Подготовка письма не завершена.');
        await tx.query("UPDATE dialogue_actions SET status='needs_info',snapshot=$2 WHERE id=$1", [
          row.id,
          JSON.stringify({ jobFailed: true, question: reason }),
        ]);
        await this.reports.notify(tx, actor.telegramId, {
          text: `Задача: подготовить письмо для ${row.company.name}.\nВыполнение остановлено: ${reason}\nСледующие задачи ждут. Уже сохранённые данные остаются в CRM.`,
          reply_markup: {
            inline_keyboard: [
              ...(job.status === 'failed'
                ? [[{ text: 'Повторить задачу', callback_data: `dt:${row.id}` }]]
                : []),
              [{ text: 'Отменить задачу', callback_data: `dx:${row.id}` }],
            ],
          },
        });
      }
      await tx.query('UPDATE dialogue_state SET revision=revision+1 WHERE user_id=$1', [actor.id]);
    });
  }
  private async prepare(tx: Sql, actor: Actor, row: any) {
    let a = dialogueActionSchema.parse(row.payload);
    let snapshot: any = row.snapshot || {};
    // A letter discovers and saves its company/recipient itself. Its first
    // prerequisite is the employee's signature, even when CRM has no company.
    if (a.kind === 'letter') {
      const signatures = await tx.query('SELECT id FROM letter_signatures WHERE user_id=$1', [
        actor.id,
      ]);
      if (!signatures.length)
        return this.ask(
          tx,
          actor,
          row,
          'Нет подписи сотрудника. Сначала создайте подпись. После подтверждения письма найду компанию и получателя и сохраню недостающие данные в CRM. Заранее создавать компанию и контакт не нужно.',
          'signature_create',
        );
    }
    if (!a.kind.startsWith('signature_')) {
      if ((a.kind === 'company_create' || a.kind === 'company_import') && row.company) {
        row.company = {
          ...row.company,
          inn: a.data.inn ?? row.company.inn,
          city: a.data.city ?? row.company.city,
        };
        await tx.query('UPDATE dialogue_actions SET company=$2 WHERE id=$1', [
          row.id,
          JSON.stringify(row.company),
        ]);
      }
      if (!row.company?.name)
        return this.ask(tx, actor, row, 'Для какой компании выполнить действие?');
      if (row.company.inn && !validInn(row.company.inn))
        return this.ask(tx, actor, row, 'Уточните ИНН: распознан некорректный номер.');
      const matches = row.company.id
        ? (await this.accessible(tx, actor)).filter((c) => c.id === row.company.id)
        : this.matches(
            await this.accessible(tx, actor),
            a.kind === 'company_import' ? { ...row.company, city: '' } : row.company,
          );
      if (matches.length > 1)
        return this.choices(
          tx,
          actor,
          row,
          matches.map((c) => ({
            ...this.context(c),
            label: `${c.data.name} · ${c.data.city || 'без города'} · ИНН ${c.data.inn || '—'}`,
          })),
          'company',
        );
      if (a.kind === 'company_import') {
        const oldNotes = matches[0]?.data.notes;
        if (oldNotes && a.data.notes && `${oldNotes}\n${a.data.notes}`.length > 5000)
          return this.ask(
            tx,
            actor,
            row,
            'Примечания вместе с существующими превышают 5000 символов. Уточните, какие новые реквизиты сохранить.',
          );
        a = {
          ...a,
          kind: matches.length ? 'company_update' : 'company_create',
          data: {
            ...a.data,
            notes: a.data.notes ? (oldNotes ? `${oldNotes}\n${a.data.notes}` : a.data.notes) : null,
          },
        };
        row.payload = a;
        await tx.query('UPDATE dialogue_actions SET payload=$2 WHERE id=$1', [
          row.id,
          JSON.stringify(a),
        ]);
      }
      if (a.kind === 'company_create' && matches.length)
        return this.ask(
          tx,
          actor,
          row,
          'Компания уже существует. Уточните, нужно ли обновить её данные.',
        );
      if (!matches.length && a.kind !== 'company_create' && a.kind !== 'letter')
        return this.ask(
          tx,
          actor,
          row,
          'Компания не найдена среди доступных активных компаний. Сначала создайте её в CRM, затем повторите запрос.',
          row.company.id ? undefined : 'company_create',
        );
      if (row.company.id && !matches.length)
        return this.ask(tx, actor, row, 'Компания больше недоступна. Укажите другую компанию.');
      if (matches.length) {
        const c = matches[0];
        row.company = this.context(c);
        snapshot.company = { ...row.company, ownerId: c.owner_id, version: c.version };
        await tx.query('UPDATE dialogue_actions SET company=$2 WHERE id=$1', [
          row.id,
          JSON.stringify(row.company),
        ]);
        const state = await this.state(tx, actor.id);
        if (state.company && companyName(state.company.name) === companyName(row.company.name))
          await this.remember(tx, actor.id, row.company);
      }
    }
    let data: any;
    let notice = '';
    let changes: string | undefined;
    if (a.kind === 'contact_create')
      data = contactSchema.safeParse({
        name: a.data.name || '',
        role: a.data.role || '',
        phone: a.data.phone || '',
        email: a.data.email || '',
      });
    if (a.kind === 'activity_create')
      data = activitySchema.safeParse({ text: a.text, occurredOn: a.occurredOn });
    if (a.kind === 'task_create') data = taskSchema.safeParse({ text: a.text, due: a.due });
    if (a.kind === 'company_create')
      data = companySchema.safeParse({
        ...supplied(a.data),
        name: row.company.name,
        inn: a.data.inn ?? row.company.inn,
        city: a.data.city ?? row.company.city,
      });
    if (a.kind === 'company_update') {
      if (!Object.keys(supplied(a.data)).length)
        return this.ask(tx, actor, row, 'Какие данные компании изменить?');
      const c = await this.crm.company(actor, row.company.id, tx);
      const parsed = companySchema.safeParse(
        Object.fromEntries(Object.keys(companySchema.shape).map((k) => [k, (c as any)[k]])),
      );
      requireCondition(parsed.success, 409, 'Карточка компании некорректна');
      data = companySchema.safeParse({ ...parsed.data, ...supplied(a.data) });
      changes = Object.entries(supplied(a.data))
        .map(
          ([key, value]) =>
            `${fieldNames[key] || key}:\nБыло: ${(parsed.data as any)[key] ?? '—'}\nБудет: ${value ?? '—'}`,
        )
        .join('\n\n');
    }
    if (a.kind === 'contact_edit') {
      if (!snapshot.contact) {
        const contacts = await tx.query(
          "SELECT id,data,version FROM records WHERE company_id=$1 AND kind='contact' AND NOT deleted ORDER BY id",
          [row.company.id],
        );
        const words = normalize(a.targetName).split(' ').filter(Boolean);
        if (!contacts.length)
          return this.ask(
            tx,
            actor,
            row,
            'В компании нет контакта для редактирования. Сначала создайте контакт.',
            'contact_create',
          );
        const matches = contacts.filter(
          (c) => words.length && words.every((w) => normalize(c.data.name).split(' ').includes(w)),
        );
        if (matches.length !== 1)
          return this.choices(
            tx,
            actor,
            row,
            (matches.length ? matches : contacts).map((c) => ({
              ...c,
              label: `${c.data.name} · ${c.data.role || '—'} · ${c.data.phone || '—'}`,
            })),
            'contact',
          );
        snapshot.contact = matches[0];
      }
      if (!Object.keys(supplied(a.data)).length)
        return this.ask(tx, actor, row, 'Что изменить в контакте?');
      data = contactSchema.safeParse({ ...snapshot.contact.data, ...supplied(a.data) });
      notice = `Изменяем контакт: ${snapshot.contact.data.name}\n`;
    }
    if (a.kind.startsWith('signature_') || a.kind === 'letter') {
      const options = await tx.query(
        'SELECT id,data,is_default FROM letter_signatures WHERE user_id=$1 ORDER BY id',
        [actor.id],
      );
      if (a.kind === 'signature_create') {
        if (options.length >= maxSignatures)
          return this.ask(
            tx,
            actor,
            row,
            'Уже есть три подписи. Сначала удалите ненужную в профиле.',
          );
        data = signatureSchema.safeParse(
          Object.fromEntries(Object.entries(a.data).map(([k, v]) => [k, v || ''])),
        );
      } else {
        if (!options.length)
          return this.ask(
            tx,
            actor,
            row,
            'Подписей пока нет. Сначала создайте подпись.',
            a.kind === 'signature_delete' ? undefined : 'signature_create',
          );
        if (!snapshot.signature) {
          const target =
            'targetName' in a ? normalize(a.targetName).split(' ').filter(Boolean) : [];
          const matches = options.filter(
            (s) =>
              target.length &&
              target.every((w) => normalize(signatureName(s.data)).split(' ').includes(w)),
          );
          const selected =
            a.kind === 'letter'
              ? options.find((s) => s.is_default) || (options.length === 1 ? options[0] : null)
              : matches.length === 1
                ? matches[0]
                : null;
          if (!selected)
            return this.choices(
              tx,
              actor,
              row,
              options.map((s) => ({
                ...s,
                label: `${signatureName(s.data)} · ${s.data.email || '—'}`,
              })),
              'signature',
            );
          snapshot.signature = selected;
        }
        if (a.kind === 'letter') {
          snapshot.defaultStep = options.length > 1 && !options.some((s) => s.is_default);
          notice = snapshot.defaultStep
            ? `Сначала назначить подпись по умолчанию: ${signatureName(snapshot.signature.data)}? Письмо запросит отдельное подтверждение.`
            : `Подпись: ${signatureName(snapshot.signature.data)}\nPDF отправлю только вам в Telegram и сохраню в CRM. Компания и подтверждённый получатель будут сохранены по сценарию письма. Клиенту ничего не отправляется.`;
        } else if (a.kind === 'signature_edit') {
          if (!Object.keys(supplied(a.data)).length)
            return this.ask(tx, actor, row, 'Какие поля подписи изменить?');
          data = signatureSchema.safeParse({ ...snapshot.signature.data, ...supplied(a.data) });
          notice = `Изменяем подпись: ${signatureName(snapshot.signature.data)}\n`;
        } else {
          data = signatureSchema.safeParse(snapshot.signature.data);
          if (a.kind === 'signature_delete')
            notice =
              'Удаление нельзя отменить. Готовые PDF не меняются. Другая подпись основной автоматически не станет.\n';
        }
      }
    }
    if (data && !data.success)
      return this.ask(
        tx,
        actor,
        row,
        `Нужно уточнить данные: ${data.error.issues.map((i: any) => fieldNames[String(i.path[0])] || i.path.join('.')).join(', ')}. Для контакта нужно имя, для подписи — фамилия и имя; email и даты должны быть корректными.`,
      );
    snapshot.data = data?.data;
    const [preview] = await tx.query(
      "UPDATE dialogue_actions SET status='ready',snapshot=$2,options='[]',preview_version=preview_version+1 WHERE id=$1 RETURNING preview_version",
      [row.id, JSON.stringify(snapshot)],
    );
    let previewText = `${snapshot.defaultStep ? 'Назначить подпись по умолчанию' : titles[a.kind]}\n${row.company ? `Компания: ${row.company.name}\nГород: ${row.company.city || '—'} · ИНН: ${row.company.inn || '—'}\n` : ''}\n${notice}${data?.success ? (changes ?? fieldsText(data.data)) : ''}\n\nПодтвердите только это действие. Для исправления напишите или надиктуйте уточнение.`;
    while (previewText.length > 3900) {
      await this.reports.notify(tx, actor.telegramId, { text: previewText.slice(0, 3900) });
      previewText = previewText.slice(3900);
    }
    await this.reports.notify(tx, actor.telegramId, {
      text: previewText,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Подтвердить', callback_data: `da:${row.id}:${preview.preview_version}` },
            { text: 'Отменить задачу', callback_data: `dx:${row.id}` },
          ],
        ],
      },
    });
  }

  async callback(
    actorInput: Actor,
    id: string,
    operation: 'confirm' | 'skip' | 'choose' | 'remedy' | 'retry',
    index?: number,
  ) {
    idSchema.parse(id);
    return this.crm.db.transaction(async (tx) => {
      const actor = await this.actor(tx, actorInput.id);
      await this.state(tx, actor.id);
      const [row] = await tx.query(
        'SELECT * FROM dialogue_actions WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [id, actor.id],
      );
      requireCondition(row, 404, 'Действие не найдено');
      if (row.status === 'done' || row.status === 'cancelled') return;
      const [first] = await tx.query(
        'SELECT id FROM dialogue_actions WHERE user_id=$1 AND status=ANY($2::text[]) ORDER BY sequence LIMIT 1',
        [actor.id, pending],
      );
      requireCondition(first?.id === id, 409, 'Сначала завершите предыдущее действие');
      if (operation === 'skip') {
        const [job] = await tx.query('SELECT * FROM letter_jobs WHERE source_key=$1 FOR UPDATE', [
          `dialogue:${row.id}`,
        ]);
        requireCondition(
          !job || !['processing', 'sending'].includes(job.status),
          409,
          'Письмо уже выполняется. Дождитесь результата: безопасно отменить текущую операцию сейчас нельзя.',
        );
        if (job && job.status !== 'sent')
          await tx.query(
            "UPDATE letter_jobs SET status='cancelled',lease_until=NULL,lease_token=NULL WHERE id=$1",
            [job.id],
          );
        await tx.query(
          "UPDATE dialogue_actions SET status=$2,payload='{}',snapshot=NULL,resume=NULL,options='[]' WHERE id=$1",
          [id, job?.status === 'sent' ? 'done' : 'cancelled'],
        );
        if (job) await this.reports.processing.finish(tx, job.source_key);
        await this.reports.notify(tx, actor.telegramId, {
          text:
            job?.status === 'sent'
              ? 'Письмо уже отправлено. Задача завершена; отменить отправку нельзя.'
              : 'Задача отменена. Уже сохранённые данные не удаляются.',
        });
      } else if (operation === 'remedy') {
        requireCondition(
          row.status === 'needs_info' && row.snapshot?.remedy && !row.resume,
          409,
          'Используйте последнее сообщение с причиной блокировки.',
        );
        const kind = row.snapshot.remedy;
        // Recheck facts: another action/profile edit may already have resolved the dependency.
        const resolved =
          kind === 'signature_create'
            ? (await tx.query('SELECT id FROM letter_signatures WHERE user_id=$1', [actor.id]))
                .length > 0
            : kind === 'company_create'
              ? this.matches(await this.accessible(tx, actor), row.company).length > 0
              : (
                  await tx.query(
                    "SELECT id FROM records WHERE company_id=$1 AND kind='contact' AND NOT deleted",
                    [row.company.id],
                  )
                ).length > 0;
        if (resolved) {
          await this.prepare(tx, actor, { ...row, snapshot: null });
          await tx.query('UPDATE dialogue_state SET revision=revision+1 WHERE user_id=$1', [
            actor.id,
          ]);
          return;
        }
        const company =
          kind === 'signature_create'
            ? { mode: 'none', name: '', inn: '', city: '' }
            : {
                mode: 'named',
                name: row.company.name,
                inn: row.company.inn,
                city: row.company.city,
              };
        const data =
          kind === 'signature_create'
            ? {
                lastName: null,
                firstName: null,
                patronymic: null,
                workPhone: null,
                mobilePhone: null,
                email: null,
              }
            : kind === 'company_create'
              ? {
                  city: row.company.city || null,
                  inn: row.company.inn || null,
                  industry: null,
                  segment: null,
                  stage: null,
                  potential: null,
                  notes: null,
                }
              : { name: row.payload.targetName || null, role: null, phone: null, email: null };
        const payload = dialogueActionSchema.parse({ kind, company, data });
        const prerequisiteCompany = kind === 'signature_create' ? null : row.company;
        await tx.query(
          "UPDATE dialogue_actions SET resume=$2,payload=$3,company=$4,snapshot=NULL,status='queued',preview_version=preview_version+1 WHERE id=$1",
          [
            id,
            JSON.stringify({ payload: row.payload, company: row.company }),
            JSON.stringify(payload),
            JSON.stringify(prerequisiteCompany),
          ],
        );
        await this.reports.notify(tx, actor.telegramId, {
          text: `Сначала: ${titles[kind as DialogueAction['kind']]}. Исходная задача остаётся в очереди; после этого вернусь к ней. Отмена отменит всю исходную задачу.`,
        });
        await this.prepare(tx, actor, {
          ...row,
          payload,
          company: prerequisiteCompany,
          snapshot: null,
        });
      } else if (operation === 'retry') {
        requireCondition(
          row.status === 'needs_info' && row.snapshot?.jobFailed,
          409,
          'Используйте актуальное сообщение об ошибке.',
        );
        row.snapshot = null;
        await this.prepare(tx, actor, row);
      } else if (operation === 'choose') {
        requireCondition(
          row.status === 'selecting' &&
            Number.isInteger(index) &&
            index! >= 0 &&
            row.options[index!],
          409,
          'Список устарел. Используйте последнее сообщение',
        );
        const selected = row.options[index!];
        const choice = row.snapshot.choice;
        row.snapshot = {};
        if (choice === 'company') {
          const previousName = row.company.name;
          const c = await this.crm.company(actor, selected.id, tx, true);
          requireCondition(!c.archived, 409, 'Компания в архиве');
          row.company = { id: c.id, name: c.name, city: c.city, inn: c.inn };
          await tx.query('UPDATE dialogue_actions SET company=$2 WHERE id=$1', [
            id,
            JSON.stringify(row.company),
          ]);
          await this.remember(tx, actor.id, row.company);
          // Bind later pronoun references in this same request to the chosen company.
          await tx.query(
            "UPDATE dialogue_actions SET company=$3 WHERE report_id=$1 AND sequence>$2 AND status='queued' AND company->>'name'=$4 AND payload->'company'->>'mode'='last'",
            [row.report_id, row.sequence, JSON.stringify(row.company), previousName],
          );
        } else if (choice === 'signature')
          row.snapshot.signature = await checkedSignature(tx, actor.id, selected);
        else row.snapshot.contact = selected;
        await this.prepare(tx, actor, row);
      } else {
        requireCondition(
          row.status === 'ready',
          409,
          'Сначала уточните данные и проверьте новое подтверждение',
        );
        // The same action may show a new preview after default-signature confirmation.
        // A repeated click on the old preview must never confirm the next step.
        if (index !== undefined) {
          requireCondition(
            Number.isInteger(index) && index > 0,
            400,
            'Используйте кнопку под последним подтверждением',
          );
          if (index !== row.preview_version) return;
        }
        await this.execute(tx, actor, row);
      }
      await tx.query(
        'UPDATE dialogue_state SET revision=revision+1,updated_at=now() WHERE user_id=$1',
        [actor.id],
      );
      await this.next(tx, actor);
    });
  }
  private async execute(tx: Sql, actor: Actor, row: any) {
    const a = dialogueActionSchema.parse(row.payload);
    const s = row.snapshot;
    if (s.company) {
      const c = await this.crm.company(actor, s.company.id, tx, true);
      requireCondition(
        !c.archived && c.version === s.company.version && c.ownerId === s.company.ownerId,
        409,
        'Компания изменилась. Отправьте уточнение, чтобы получить новое подтверждение',
      );
    }
    if (s.signature) await checkedSignature(tx, actor.id, s.signature);
    if (a.kind === 'letter') {
      if (s.defaultStep) {
        await assignDefault(tx, actor.id, s.signature.id);
        await audit(tx, actor.id, 'dialogue.signature_default', row.id);
        row.snapshot = { ...s, defaultStep: false };
        await this.prepare(tx, actor, row);
        return;
      }
      const signatures = await tx.query(
        'SELECT id,is_default FROM letter_signatures WHERE user_id=$1',
        [actor.id],
      );
      const current =
        signatures.find((c) => c.is_default) || (signatures.length === 1 ? signatures[0] : null);
      requireCondition(
        current?.id === s.signature.id,
        409,
        'Основная подпись изменилась. Уточните запрос для нового подтверждения',
      );
      const query = [
        row.company.name,
        row.company.inn ? `ИНН ${row.company.inn}` : '',
        row.company.city,
      ]
        .filter(Boolean)
        .join(', ');
      const [job] = await tx.query('SELECT * FROM letter_jobs WHERE source_key=$1 FOR UPDATE', [
        `dialogue:${row.id}`,
      ]);
      if (job) {
        requireCondition(job.status === 'failed', 409, 'Письмо уже запущено или завершено.');
        await tx.query(
          'UPDATE letter_jobs SET status=$2,attempts=0,error=NULL,signature_id=$3,available_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1',
          [job.id, job.file_id ? 'ready' : 'queued', s.signature.id],
        );
      } else await this.letterBot.enqueue(actor, `dialogue:${row.id}`, query, tx);
      await tx.query("UPDATE dialogue_actions SET status='executing' WHERE id=$1", [row.id]);
      await this.reports.notify(tx, actor.telegramId, {
        text: `Подготовка письма для ${row.company.name} запущена. Следующая задача появится после отправки PDF в Telegram.`,
      });
      return;
    } else if (a.kind === 'signature_create') {
      const existing = await tx.query('SELECT id FROM letter_signatures WHERE user_id=$1', [
        actor.id,
      ]);
      requireCondition(
        existing.length < maxSignatures,
        409,
        'Можно сохранить не более трёх подписей',
      );
      await tx.query('INSERT INTO letter_signatures(id,user_id,data) VALUES($1,$2,$3)', [
        randomUUID(),
        actor.id,
        JSON.stringify(signatureSchema.parse(s.data)),
      ]);
    } else if (a.kind === 'signature_edit') {
      await tx.query('UPDATE letter_signatures SET data=$1 WHERE id=$2 AND user_id=$3', [
        JSON.stringify(signatureSchema.parse(s.data)),
        s.signature.id,
        actor.id,
      ]);
    } else if (a.kind === 'signature_default') await assignDefault(tx, actor.id, s.signature.id);
    else if (a.kind === 'signature_delete')
      await tx.query('DELETE FROM letter_signatures WHERE id=$1 AND user_id=$2', [
        s.signature.id,
        actor.id,
      ]);
    else if (a.kind === 'company_create') {
      await tx.query('SELECT pg_advisory_xact_lock(7142503)');
      requireCondition(
        !this.matches(await this.accessible(tx, actor), row.company).length,
        409,
        'Компания уже появилась в CRM. Уточните запрос',
      );
      const c = await this.crm.create(actor, companySchema.parse(s.data), actor.id, tx);
      const state = await this.state(tx, actor.id);
      if (state.company && companyName(state.company.name) === companyName(c.name))
        await this.remember(tx, actor.id, { id: c.id, name: c.name, city: c.city, inn: c.inn });
    } else if (a.kind === 'company_update') {
      await tx.query(
        'UPDATE companies SET data=$1,version=version+1,updated_at=now() WHERE id=$2',
        [JSON.stringify(companySchema.parse(s.data)), row.company.id],
      );
    } else if (a.kind === 'contact_edit') {
      const [c] = await tx.query(
        "SELECT * FROM records WHERE id=$1 AND company_id=$2 AND kind='contact' AND NOT deleted FOR UPDATE",
        [s.contact.id, row.company.id],
      );
      requireCondition(
        c && c.version === s.contact.version && isDeepStrictEqual(c.data, s.contact.data),
        409,
        'Контакт изменился. Отправьте уточнение для новой проверки',
      );
      await tx.query('UPDATE records SET data=$2,version=version+1 WHERE id=$1', [
        c.id,
        JSON.stringify(contactSchema.parse(s.data)),
      ]);
    } else {
      const kind =
        a.kind === 'contact_create' ? 'contact' : a.kind === 'task_create' ? 'task' : 'activity';
      const duplicates =
        kind === 'contact'
          ? await tx.query(
              "SELECT id FROM records WHERE company_id=$1 AND kind='contact' AND NOT deleted AND data=$2::jsonb",
              [row.company.id, JSON.stringify(s.data)],
            )
          : [];
      if (!duplicates.length)
        await this.crm.createRecord(actor, row.company.id, kind, s.data, null, tx);
    }
    await audit(tx, actor.id, `dialogue.${a.kind}`, row.id, s.company?.id || null);
    if (row.resume) {
      await tx.query(
        "UPDATE dialogue_actions SET payload=$2,company=$3,resume=NULL,snapshot=NULL,status='queued',options='[]',preview_version=preview_version+1 WHERE id=$1",
        [row.id, JSON.stringify(row.resume.payload), JSON.stringify(row.resume.company)],
      );
      await this.reports.notify(tx, actor.telegramId, {
        text: `Выполнено: ${titles[a.kind]}. Возвращаюсь к исходной задаче — проверьте новое подтверждение.`,
      });
      return;
    }
    await tx.query(
      "UPDATE dialogue_actions SET status='done',payload='{}',snapshot=NULL,options='[]' WHERE id=$1",
      [row.id],
    );
    await this.reports.notify(tx, actor.telegramId, {
      text: `Выполнено: ${titles[a.kind]}${row.company ? ` · ${row.company.name}` : ''}.`,
    });
  }
}
