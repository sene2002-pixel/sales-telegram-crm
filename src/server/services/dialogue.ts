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
import { assignDefault, checkedSignature, signatureName } from './signature-choice';
import {
  DialogueAction,
  dialogueActionSchema,
  dialogueInstructions,
  dialoguePlanSchema,
} from './dialogue-plan';

type CompanyContext = { id?: string; name: string; inn: string; city: string };
const pending = ['queued', 'ready', 'selecting', 'needs_info'];
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

  async process(report: any, token: string, text: string) {
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
        [actor.id, pending],
      );
      return { revision: state.revision, company: state.company, actions };
    });
    const plan = dialoguePlanSchema.parse(
      await this.letters.structured(
        dialoguePlanSchema,
        dialogueInstructions,
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
        false,
        false,
        {
          schemaName: 'crm_dialogue',
          maxOutputTokens: 6000,
          ...(/^gpt-4[.o-]/.test(this.config.letterModel) ? { temperature: 0 } : {}),
        },
      ),
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
        'SELECT id FROM dialogue_actions WHERE user_id=$1 AND status=ANY($2::text[])',
        [actor.id, pending],
      );
      requireCondition(
        (plan.mode === 'replace' ? 0 : open.length) + plan.actions.length <= 24,
        422,
        'Сначала подтвердите или отмените ожидающие действия',
      );
      if (plan.mode === 'replace' && plan.actions.length) {
        await tx.query(
          "UPDATE dialogue_actions SET status='cancelled',payload='{}',snapshot=NULL,options='[]' WHERE user_id=$1 AND status=ANY($2::text[])",
          [actor.id, pending],
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
        "UPDATE reports SET status='cancelled',transcript=NULL,audio_file_id=NULL,draft=NULL,error=NULL,lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=$1",
        [report.id],
      );
      if (plan.reply || !plan.actions.length)
        await this.reports.notify(tx, actor.telegramId, {
          text: plan.reply || 'Не знаю такой команды. Уточните задачу или откройте /voice.',
        });
      if (plan.actions.length > 1)
        await this.reports.notify(tx, actor.telegramId, {
          text: `Распознано действий: ${plan.actions.length}. Покажу по очереди; каждое нужно подтвердить отдельно. «Пропустить» отменяет только текущее действие.`,
        });
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
  private async ask(tx: Sql, actor: Actor, row: any, text: string) {
    await tx.query("UPDATE dialogue_actions SET status='needs_info',snapshot=$2 WHERE id=$1", [
      row.id,
      JSON.stringify({ question: text }),
    ]);
    await this.reports.notify(tx, actor.telegramId, {
      text: `${titles[row.payload.kind as DialogueAction['kind']]}\n${row.company ? `Компания: ${row.company.name}\n` : ''}${text}\nОтветьте текстом или голосом. Пока ничего не изменено.`,
      reply_markup: {
        inline_keyboard: [[{ text: 'Пропустить это действие', callback_data: `dx:${row.id}` }]],
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
          [{ text: 'Пропустить', callback_data: `dx:${row.id}` }],
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
  private async prepare(tx: Sql, actor: Actor, row: any) {
    const a = dialogueActionSchema.parse(row.payload);
    let snapshot: any = row.snapshot || {};
    if (!a.kind.startsWith('signature_')) {
      if (a.kind === 'company_create' && row.company) {
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
        : this.matches(await this.accessible(tx, actor), row.company);
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
    }
    if (a.kind === 'contact_edit') {
      if (!snapshot.contact) {
        const contacts = await tx.query(
          "SELECT id,data,version FROM records WHERE company_id=$1 AND kind='contact' AND NOT deleted ORDER BY id",
          [row.company.id],
        );
        const words = normalize(a.targetName).split(' ').filter(Boolean);
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
          return this.ask(tx, actor, row, 'Подписей пока нет. Сначала создайте подпись.');
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
    await this.reports.notify(tx, actor.telegramId, {
      text: `${snapshot.defaultStep ? 'Назначить подпись по умолчанию' : titles[a.kind]}\n${row.company ? `Компания: ${row.company.name}\nГород: ${row.company.city || '—'} · ИНН: ${row.company.inn || '—'}\n` : ''}\n${notice}${data?.success ? fieldsText(a.kind === 'company_update' ? supplied(a.data) : data.data) : ''}\n\nПодтвердите только это действие. Для исправления напишите или надиктуйте уточнение.`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Подтвердить', callback_data: `da:${row.id}:${preview.preview_version}` },
            { text: 'Пропустить', callback_data: `dx:${row.id}` },
          ],
        ],
      },
    });
  }

  async callback(
    actorInput: Actor,
    id: string,
    operation: 'confirm' | 'skip' | 'choose',
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
        await tx.query(
          "UPDATE dialogue_actions SET status='cancelled',payload='{}',snapshot=NULL,options='[]' WHERE id=$1",
          [id],
        );
        await this.reports.notify(tx, actor.telegramId, {
          text: 'Действие пропущено. Данные не изменены.',
        });
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
      await this.letterBot.enqueue(actor, `dialogue:${row.id}`, query, tx);
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
    await tx.query(
      "UPDATE dialogue_actions SET status='done',payload='{}',snapshot=NULL,options='[]' WHERE id=$1",
      [row.id],
    );
    await this.reports.notify(tx, actor.telegramId, {
      text:
        a.kind === 'letter'
          ? `Подготовка письма для ${row.company.name} запущена. PDF придёт сюда.`
          : `Выполнено: ${titles[a.kind]}${row.company ? ` · ${row.company.name}` : ''}.`,
    });
  }
}
