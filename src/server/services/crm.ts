import { resolveEmployeeFilter } from './employee-filter';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Actor,
  Company,
  companySchema,
  contactSchema,
  CompanyData,
  CrmRecord,
  RecordKind,
  recordSchemas,
  idSchema,
} from '../../shared/contracts';
import { Database, Sql } from '../infra/database';
import { requireCondition } from '../domain/errors';
import { audit } from '../infra/audit';
import { isLeader } from './auth';
import {
  salesUpdateSchema,
  SalesEvent,
  SalesUpdate,
  projectSales,
  confirmed,
  normalizeSales,
} from '../../shared/sales';

export function mapCompany(row: any): Company {
  return {
    ...row.data,
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name || '',
    version: row.version,
    createdAt: String(
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    ),
    updatedAt: row.updated_at,
  };
}
export function mapRecord(row: any): CrmRecord {
  return {
    id: row.id,
    kind: row.kind,
    companyId: row.company_id,
    projectId: row.project_id,
    authorId: row.author_id,
    authorName: row.author_name || '',
    assigneeId: row.assignee_id,
    version: row.version,
    createdAt: row.created_at,
    data: row.data,
    ...(row.kind === 'contact' ? { contactSource: row.contact_source || 'unknown' } : {}),
  };
}
export class CrmService {
  constructor(public db: Database) {}
  async company(actor: Actor, id: string, tx: Sql = this.db, lock = false): Promise<Company> {
    idSchema.parse(id);
    const [row] = await tx.query(
      `SELECT c.*,u.name AS owner_name FROM companies c JOIN users u ON u.id=c.owner_id WHERE c.id=$1 ${lock ? 'FOR UPDATE OF c' : ''}`,
      [id],
    );
    requireCondition(
      row && (isLeader(actor) || row.owner_id === actor.id),
      404,
      'Компания не найдена',
    );
    return mapCompany(row);
  }
  async list(actor: Actor, employeeId?: unknown) {
    const employee = await resolveEmployeeFilter(this.db, actor, employeeId);
    const rows = await this.db.query(
      `SELECT c.*,u.name AS owner_name FROM companies c JOIN users u ON u.id=c.owner_id WHERE ($1::boolean OR c.owner_id=$2) AND ($3::uuid IS NULL OR c.owner_id=$3) ORDER BY c.updated_at DESC`,
      [isLeader(actor), actor.id, employee],
    );
    return rows.map(mapCompany);
  }
  async validateHolding(
    actor: Actor,
    data: CompanyData,
    ownerId: string,
    tx: Sql,
    previous?: Company,
  ) {
    await tx.query('SELECT pg_advisory_xact_lock(7142532)');
    requireCondition(
      data.segment !== 'holding' || (!data.inn && !data.holdingId),
      400,
      'У холдинга нет ИНН и родительского холдинга',
    );
    requireCondition(
      !data.holdingId || data.segment === 'end_client',
      400,
      'Холдинг можно выбрать только для заказчика',
    );
    if (data.holdingId) {
      requireCondition(data.holdingId !== previous?.id, 400, 'Компания не может входить в себя');
      const parent = await this.company(actor, data.holdingId, tx, true);
      requireCondition(
        parent.segment === 'holding' && !parent.archived && parent.ownerId === ownerId,
        400,
        'Выберите доступный холдинг с тем же ответственным',
      );
      requireCondition(!data.archived, 400, 'Сначала отсоедините заказчика от холдинга');
    }
    if (previous) {
      const children = await tx.query(
        "SELECT id FROM companies WHERE data->>'holdingId'=$1 FOR UPDATE",
        [previous.id],
      );
      requireCondition(
        !children.length ||
          (data.segment === 'holding' && !data.archived && ownerId === previous.ownerId),
        409,
        'Сначала отсоедините заказчиков холдинга',
      );
      if (previous.segment !== 'holding' && data.segment === 'holding') {
        const participantProjects = await tx.query(
          "SELECT id FROM records WHERE kind='project' AND NOT deleted AND data->'participants' @> $1::jsonb LIMIT 1",
          [JSON.stringify([{ companyId: previous.id }])],
        );
        requireCondition(
          !participantProjects.length,
          409,
          'Участника проекта нельзя сделать холдингом',
        );

        const commercial = await tx.query(
          "SELECT id FROM records WHERE company_id=$1 AND NOT deleted AND (kind='project' OR (kind='activity' AND data->'sales' IS NOT NULL AND data->'sales'<>'null'::jsonb)) LIMIT 1",
          [previous.id],
        );
        requireCondition(
          !commercial.length,
          409,
          'Компанию с проектами или продажами нельзя сделать холдингом',
        );
      }
    }
  }
  async createWithContacts(actor: Actor, raw: unknown): Promise<Company> {
    const schema = companySchema.extend({
      initialContacts: z.array(contactSchema).max(20).default([]),
    });
    const { initialContacts, ...data } = schema.parse(raw);
    return this.db.transaction(async (tx) => {
      const company = await this.create(actor, data, actor.id, tx);
      for (const contact of initialContacts)
        await this.createRecord(actor, company.id, 'contact', contact, null, tx, {
          contactSource: 'user',
        });
      return company;
    });
  }
  async create(actor: Actor, raw: unknown, ownerId = actor.id, tx?: Sql): Promise<Company> {
    const data = companySchema.parse(raw);
    requireCondition(
      !data.archived || actor.role === 'admin',
      403,
      'Создание в архиве доступно только суперадмину',
    );
    if (!tx) return this.db.transaction((t) => this.create(actor, data, ownerId, t));
    requireCondition(
      ownerId === actor.id || isLeader(actor),
      403,
      'Нельзя назначить другого сотрудника',
    );
    const [owner] = await tx.query('SELECT id FROM users WHERE id=$1 AND active=true', [
      idSchema.parse(ownerId),
    ]);
    requireCondition(owner, 400, 'Ответственный неактивен');
    await this.validateHolding(actor, data, ownerId, tx);
    const id = randomUUID();
    await tx.query('INSERT INTO companies(id,owner_id,data) VALUES($1,$2,$3)', [
      id,
      ownerId,
      JSON.stringify(data),
    ]);
    await audit(tx, actor.id, 'company.created', id, id, { after: data, afterVersion: 1 });
    return this.company(actor, id, tx);
  }
  async update(actor: Actor, id: string, raw: unknown) {
    const { version, data } = z
      .object({ version: z.number().int().positive(), data: companySchema })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142532)');
      const previous = await this.company(actor, id, tx, true);
      await this.validateHolding(actor, data, previous.ownerId, tx, previous);
      requireCondition(previous.version === version, 409, 'Карточка изменена. Обновите страницу');
      if (previous.archived !== data.archived)
        await this.checkArchivePermission(actor, previous, data.archived, tx);
      await tx.query(
        'UPDATE companies SET data=$1,version=version+1,updated_at=now() WHERE id=$2',
        [JSON.stringify(data), id],
      );
      await audit(tx, actor.id, 'company.updated', id, id, {
        before: previous,
        after: data,
        beforeVersion: previous.version,
        afterVersion: previous.version + 1,
      });
      if (previous.archived !== data.archived)
        await audit(tx, actor.id, data.archived ? 'company.archived' : 'company.restored', id, id);
      return this.company(actor, id, tx);
    });
  }
  async assign(actor: Actor, id: string, ownerId: string, version: number) {
    requireCondition(isLeader(actor), 403, 'Назначение доступно руководителю');
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142532)');
      const company = await this.company(actor, id, tx, true);
      await this.validateHolding(actor, company, ownerId, tx, company);
      if (actor.role === 'supervisor') {
        await this.checkArchivePermission(actor, company, true, tx);
        await this.checkArchivePermission(actor, { ...company, ownerId }, true, tx);
      }
      requireCondition(company.version === version, 409, 'Карточка изменена');
      const [owner] = await tx.query('SELECT id FROM users WHERE id=$1 AND active=true', [
        idSchema.parse(ownerId),
      ]);
      requireCondition(owner, 400, 'Ответственный неактивен');
      await tx.query(
        'UPDATE companies SET owner_id=$1,version=version+1,updated_at=now() WHERE id=$2',
        [ownerId, id],
      );
      await tx.query(
        `UPDATE records SET assignee_id=$1,version=version+1 WHERE company_id=$2 AND kind='task' AND data->>'done'='false' AND NOT deleted`,
        [ownerId, id],
      );
      await audit(tx, actor.id, 'company.assigned', id, id, { from: company.ownerId, to: ownerId });
      return this.company(actor, id, tx);
    });
  }
  async detail(actor: Actor, id: string) {
    const company = await this.company(actor, id);
    const records = (
      await this.db.query(
        'SELECT r.*,u.name AS author_name FROM records r JOIN users u ON u.id=r.author_id WHERE r.company_id=$1 AND NOT r.deleted ORDER BY r.created_at DESC',
        [id],
      )
    ).map(mapRecord);
    const events = await this.db.query(
      'SELECT a.id,a.actor_id,a.company_id,a.action,a.entity_id,a.details,a.created_at,u.name AS actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.company_id=$1 ORDER BY a.created_at DESC LIMIT 100',
      [id],
    );
    const holdingMembers =
      company.segment === 'holding'
        ? (await this.list(actor)).filter((c) => c.holdingId === id && !c.archived)
        : [];
    const holdingDivisions: Record<string, number> = {};
    let holdingPotential: number | null = null;
    for (const member of holdingMembers) {
      const amount =
        member.potential ??
        (Object.keys(member.divisions).length
          ? Object.values(member.divisions).reduce<number>((sum, v) => sum + (v ?? 0), 0)
          : null);
      if (amount !== null) holdingPotential = (holdingPotential ?? 0) + amount;
      for (const [key, value] of Object.entries(member.divisions))
        holdingDivisions[key] = (holdingDivisions[key] ?? 0) + (value ?? 0);
    }
    return { company, records, audit: events, holdingMembers, holdingPotential, holdingDivisions };
  }
  async checkArchivePermission(
    actor: Actor,
    company: Company,
    archived: boolean,
    tx: Sql = this.db,
  ) {
    const [current] = await tx.query('SELECT role,active FROM users WHERE id=$1 FOR SHARE', [
      actor.id,
    ]);
    requireCondition(current?.active, 403, 'Доступ заблокирован');
    if (current.role === 'admin') return;
    requireCondition(
      archived && current.role === 'supervisor',
      403,
      archived
        ? 'Удаление доступно руководителю и суперадмину'
        : 'Восстановление доступно только суперадмину',
    );
    const [owner] = await tx.query('SELECT supervisor_id FROM users WHERE id=$1 FOR SHARE', [
      company.ownerId,
    ]);
    requireCondition(
      company.ownerId === actor.id || owner?.supervisor_id === actor.id,
      403,
      'Можно удалить только компании своей команды',
    );
  }
  async setArchived(
    actor: Actor,
    id: string,
    archived: boolean,
    version: number,
    tx?: Sql,
  ): Promise<Company> {
    if (!tx) return this.db.transaction((t) => this.setArchived(actor, id, archived, version, t));
    await tx.query('SELECT pg_advisory_xact_lock(7142532)');
    const company = await this.company(actor, id, tx, true);
    await this.validateHolding(actor, { ...company, archived }, company.ownerId, tx, company);
    await this.checkArchivePermission(actor, company, archived, tx);
    requireCondition(company.version === version, 409, 'Карточка изменена. Обновите страницу');
    requireCondition(
      company.archived !== archived,
      409,
      archived ? 'Компания уже в архиве' : 'Компания уже восстановлена',
    );
    await tx.query(
      "UPDATE companies SET data=jsonb_set(data,'{archived}',$2::jsonb),version=version+1,updated_at=now() WHERE id=$1",
      [id, JSON.stringify(archived)],
    );
    await audit(tx, actor.id, archived ? 'company.archived' : 'company.restored', id, id);
    return this.company(actor, id, tx);
  }
  async records(actor: Actor, kind: RecordKind, employeeId?: unknown) {
    const employee = await resolveEmployeeFilter(this.db, actor, employeeId);
    const rows = await this.db.query(
      `SELECT r.*,u.name AS author_name,c.data->>'name' AS company_name,p.data->>'name' AS project_name FROM records r JOIN companies c ON c.id=r.company_id JOIN users u ON u.id=r.author_id LEFT JOIN records p ON p.id=r.project_id AND p.company_id=r.company_id AND p.kind='project' AND NOT p.deleted WHERE r.kind=$1 AND NOT r.deleted AND ($2::boolean OR c.owner_id=$3) AND ($4::uuid IS NULL OR CASE WHEN r.kind='task' THEN r.assignee_id ELSE c.owner_id END=$4) ORDER BY r.created_at DESC`,
      [kind, isLeader(actor), actor.id, employee],
    );
    return rows.map((r) => ({
      ...mapRecord(r),
      companyName: r.company_name,
      projectName: r.project_name || null,
    }));
  }
  async salesHistory(actor: Actor, companyId: string, tx: Sql = this.db): Promise<SalesEvent[]> {
    await this.company(actor, companyId, tx);
    const rows = await tx.query(
      "SELECT id,data,created_at FROM records WHERE company_id=$1 AND kind='activity' AND NOT deleted ORDER BY created_at,id",
      [companyId],
    );
    return rows.flatMap((r) => {
      const parsed = salesUpdateSchema.safeParse(r.data.sales);
      return parsed.success
        ? [
            {
              id: r.id,
              occurredOn: r.data.occurredOn,
              createdAt: new Date(r.created_at).toISOString(),
              sales: parsed.data,
            },
          ]
        : [];
    });
  }
  async salesPreview(
    actor: Actor,
    companyId: string,
    update: SalesUpdate,
    eventId: string,
    occurredOn: string,
    tx: Sql = this.db,
  ) {
    const company = await this.company(actor, companyId, tx);
    const history = await this.salesHistory(actor, companyId, tx);
    const projection = projectSales([
      ...history,
      {
        id: eventId,
        occurredOn,
        createdAt: new Date().toISOString(),
        sales: normalizeSales(update),
      },
    ]);
    const current = {
      ...projection.current,
      deals: update.deals.map((d, i) =>
        structuredClone(
          projection.deals.find((p) => p.key === projection.eventKeys[eventId]?.[i])?.deal || d,
        ),
      ),
      deferred: update.deferred,
      unknownAnswers: update.unknownAnswers,
    };
    // Manual legacy project values are authoritative context, not fabricated scoring evidence.
    const projects = await tx.query(
      "SELECT data FROM records WHERE company_id=$1 AND kind='project' AND NOT deleted",
      [companyId],
    );
    for (const deal of current.deals) {
      const matches = projects.filter(
        (p) =>
          deal.name &&
          p.data.name?.trim().toLocaleLowerCase('ru') === deal.name.trim().toLocaleLowerCase('ru'),
      );
      if (matches.length !== 1) continue;
      const p = matches[0]!.data;
      if (confirmed(deal.amount) === null && typeof p.amount === 'number')
        deal.amount = { value: p.amount, certainty: 'confirmed' };
      if (confirmed(deal.due) === null && typeof p.due === 'string')
        deal.due = { value: p.due, certainty: 'confirmed' };
    }
    if (
      company.potential === 0 &&
      !update.annualPotential.some((p) => (confirmed(p.amount) || 0) > 0)
    )
      current.deferred = true;
    return { projection, current };
  }
  private async validateRecordLinks(
    actor: Actor,
    companyId: string,
    kind: RecordKind,
    data: any,
    tx: Sql,
    previous?: any,
  ) {
    const owner = await this.company(actor, companyId, tx);
    requireCondition(
      owner.segment !== 'holding' || (kind !== 'project' && !(kind === 'activity' && data.sales)),
      400,
      'Проекты и продажи относятся к заказчику, а не к холдингу',
    );
    const checkContact = async (contactId: string | null, ownerCompanyId: string) => {
      if (!contactId) return;
      const [contact] = await tx.query(
        "SELECT id FROM records WHERE id=$1 AND company_id=$2 AND kind='contact' AND NOT deleted",
        [contactId, ownerCompanyId],
      );
      requireCondition(contact, 400, 'Контакт не принадлежит выбранному клиенту');
    };
    if (kind === 'task' && (!previous || data.contactId !== previous.contactId))
      await checkContact(data.contactId, companyId);
    if (kind === 'project') {
      const seen = new Set<string>();
      for (const participant of data.participants) {
        requireCondition(!seen.has(participant.companyId), 400, 'Участник проекта уже добавлен');
        seen.add(participant.companyId);
        const existing = previous?.participants?.find(
          (p: any) =>
            p.companyId === participant.companyId && p.contactId === participant.contactId,
        );
        if (existing) continue;
        const company = await this.company(actor, participant.companyId, tx);
        requireCondition(!company.archived, 409, 'Участник проекта находится в архиве');
        requireCondition(company.segment !== 'holding', 400, 'Укажите заказчика вместо холдинга');
        await checkContact(participant.contactId, participant.companyId);
      }
    }
  }
  async createRecord(
    actor: Actor,
    companyId: string,
    kind: RecordKind,
    raw: unknown,
    projectId: string | null = null,
    tx?: Sql,
    internal?: { contactSource: 'user' | 'bot' | 'unknown' },
  ): Promise<CrmRecord> {
    const data = recordSchemas[kind].parse(raw);
    if (kind === 'activity' && (data as any).sales)
      (data as any).sales = normalizeSales((data as any).sales);
    if (!tx)
      return this.db.transaction((t) =>
        this.createRecord(actor, companyId, kind, data, projectId, t, internal),
      );
    await tx.query('SELECT pg_advisory_xact_lock(7142532)');
    const company = await this.company(actor, companyId, tx, true);
    requireCondition(!company.archived, 409, 'Сначала восстановите компанию из архива');
    await this.validateRecordLinks(actor, companyId, kind, data, tx);
    if (projectId) {
      const [project] = await tx.query(
        `SELECT id FROM records WHERE id=$1 AND company_id=$2 AND kind='project' AND NOT deleted`,
        [idSchema.parse(projectId), companyId],
      );
      requireCondition(project, 400, 'Проект не принадлежит компании');
    }
    const id = randomUUID();
    const recordData =
      kind === 'task'
        ? { ...data, completedAt: (data as any).done ? new Date().toISOString() : null }
        : data;
    const [row] = await tx.query(
      'INSERT INTO records(id,kind,company_id,project_id,author_id,assignee_id,data,contact_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        id,
        kind,
        companyId,
        projectId,
        actor.id,
        kind === 'task' ? company.ownerId : null,
        JSON.stringify(recordData),
        kind === 'contact' ? internal?.contactSource || 'user' : 'unknown',
      ],
    );
    await audit(tx, actor.id, `${kind}.created`, id, companyId, {
      recordVersion: row.version,
      recordAfter: { data: recordData, contactSource: row.contact_source, deleted: false },
    });
    if (kind === 'activity' && (data as any).sales) {
      const projected = projectSales(await this.salesHistory(actor, companyId, tx)).current;
      const city = confirmed(projected.client.city),
        segment = confirmed(projected.client.segment);
      if (
        (city !== null && city !== company.city) ||
        (segment !== null && segment !== company.segment)
      ) {
        const next = companySchema.parse({
          ...Object.fromEntries(
            Object.keys(companySchema.shape).map((k) => [k, (company as any)[k]]),
          ),
          ...(city !== null ? { city } : {}),
          ...(segment !== null ? { segment } : {}),
        });
        await this.validateHolding(actor, next, company.ownerId, tx, company);
        await tx.query(
          'UPDATE companies SET data=$2,version=version+1,updated_at=now() WHERE id=$1',
          [companyId, JSON.stringify(next)],
        );
        await audit(tx, actor.id, 'company.sales_updated', id, companyId, {
          before: company,
          after: next,
          beforeVersion: company.version,
          afterVersion: company.version + 1,
        });
      }
    }
    return mapRecord(row);
  }
  async updateRecord(actor: Actor, id: string, raw: unknown) {
    const input = z
      .object({ version: z.number().int().positive(), data: z.unknown() })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142532)');
      const [row] = await tx.query('SELECT * FROM records WHERE id=$1 AND NOT deleted', [
        idSchema.parse(id),
      ]);
      requireCondition(row, 404, 'Запись не найдена');
      await this.company(actor, row.company_id, tx, true);
      const [current] = await tx.query('SELECT * FROM records WHERE id=$1 FOR UPDATE', [id]);
      requireCondition(current && !current.deleted, 404, 'Запись не найдена');
      requireCondition(
        current.version === input.version,
        409,
        'Запись изменена. Обновите страницу',
      );
      requireCondition(
        ['contact', 'project', 'task'].includes(row.kind),
        400,
        'Этот тип записи не редактируется',
      );
      const data: any = recordSchemas[row.kind as RecordKind].parse(input.data);
      await this.validateRecordLinks(actor, row.company_id, row.kind, data, tx, current.data);
      if (row.kind === 'task')
        data.completedAt = data.done ? current.data.completedAt || new Date().toISOString() : null;
      const [updated] = await tx.query(
        'UPDATE records SET data=$1,version=version+1 WHERE id=$2 RETURNING *',
        [JSON.stringify(data), id],
      );
      await audit(tx, actor.id, `${row.kind}.updated`, id, row.company_id, {
        before: current.data,
        after: data,
        recordVersion: updated.version,
        recordBefore: { data: current.data, contactSource: current.contact_source, deleted: false },
        recordAfter: { data, contactSource: current.contact_source, deleted: false },
      });
      return mapRecord(updated);
    });
  }
  async taskAdvice(actor: Actor, id: string) {
    const [task] = await this.db.query(
      "SELECT * FROM records WHERE id=$1 AND kind='task' AND NOT deleted",
      [idSchema.parse(id)],
    );
    requireCondition(task, 404, 'Задача не найдена');
    await this.company(actor, task.company_id);
    let projectName = '';
    if (task.project_id) {
      const [project] = await this.db.query(
        "SELECT data FROM records WHERE id=$1 AND company_id=$2 AND kind='project' AND NOT deleted",
        [task.project_id, task.company_id],
      );
      projectName = project?.data?.name || '';
    }
    const history = await this.salesHistory(actor, task.company_id);
    const projection = projectSales(history);
    const normal = (value: string) => value.trim().toLocaleLowerCase('ru');
    const matches = projection.deals.filter(
      (d) => !projectName || normal(d.deal.name || '') === normal(projectName),
    );
    const next = matches.length === 1 ? matches.find((d) => confirmed(d.deal.nextStep)) : undefined;
    if (next) {
      const step = confirmed(next.deal.nextStep),
        blocker = confirmed(next.deal.blocker);
      return {
        text: [step, blocker ? `Обратите внимание: ${blocker}` : null]
          .filter(Boolean)
          .join('. ')
          .slice(0, 1500),
        source: 'confirmed_sales',
        asOf: next.updatedOn,
      };
    }
    const agreement = projection.current.agreements;
    if (confirmed(agreement.nextStep))
      return {
        text: String(confirmed(agreement.nextStep)).slice(0, 1500),
        source: 'confirmed_agreement',
        asOf: history.at(-1)?.occurredOn || null,
      };
    return {
      text: 'Уточните следующий шаг, срок и договорённости с клиентом. Подтвердите результат в чате Pico, чтобы он появился в CRM.',
      source: 'guidance',
      asOf: null,
    };
  }
  async deleteTask(actor: Actor, id: string, raw: unknown) {
    const input = z.object({ version: z.number().int().positive() }).strict().parse(raw);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        "SELECT * FROM records WHERE id=$1 AND kind='task' AND NOT deleted",
        [idSchema.parse(id)],
      );
      requireCondition(row, 404, 'Задача не найдена');
      await this.company(actor, row.company_id, tx, true);
      const [current] = await tx.query(
        "SELECT * FROM records WHERE id=$1 AND kind='task' AND NOT deleted FOR UPDATE",
        [id],
      );
      requireCondition(current, 404, 'Задача не найдена');
      requireCondition(
        current.version === input.version,
        409,
        'Запись изменена. Обновите страницу',
      );
      await tx.query('UPDATE records SET deleted=true,version=version+1 WHERE id=$1', [id]);
      await audit(tx, actor.id, 'task.deleted', id, row.company_id, {
        recordVersion: row.version + 1,
        recordBefore: { data: row.data, contactSource: row.contact_source, deleted: false },
        recordAfter: { data: row.data, contactSource: row.contact_source, deleted: true },
      });
      return { ok: true };
    });
  }
  async deleteContact(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        "SELECT * FROM records WHERE id=$1 AND kind='contact' AND NOT deleted",
        [idSchema.parse(id)],
      );
      requireCondition(row, 404, 'Контакт не найден');
      await this.company(actor, row.company_id, tx, true);
      const deleted = await tx.query(
        'UPDATE records SET deleted=true,version=version+1 WHERE id=$1 AND NOT deleted RETURNING id',
        [id],
      );
      requireCondition(deleted.length, 404, 'Контакт не найден');
      await audit(tx, actor.id, 'contact.deleted', id, row.company_id, {
        recordVersion: row.version + 1,
        recordBefore: { data: row.data, contactSource: row.contact_source, deleted: false },
        recordAfter: { data: row.data, contactSource: row.contact_source, deleted: true },
      });
      return { ok: true };
    });
  }
  async deleteFile(actor: Actor, id: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        `SELECT * FROM records WHERE id=$1 AND kind='file' AND NOT deleted`,
        [idSchema.parse(id)],
      );
      requireCondition(row, 404, 'Файл не найден');
      await this.company(actor, row.company_id, tx, true);
      await tx.query('UPDATE records SET deleted=true WHERE id=$1', [id]);
      await audit(tx, actor.id, 'file.archived', id, row.company_id);
      return { ok: true };
    });
  }
}
