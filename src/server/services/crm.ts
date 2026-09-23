import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Actor,
  Company,
  companySchema,
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
  async list(actor: Actor) {
    const rows = await this.db.query(
      `SELECT c.*,u.name AS owner_name FROM companies c JOIN users u ON u.id=c.owner_id WHERE ($1::boolean OR c.owner_id=$2) ORDER BY c.updated_at DESC`,
      [isLeader(actor), actor.id],
    );
    return rows.map(mapCompany);
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
    const id = randomUUID();
    await tx.query('INSERT INTO companies(id,owner_id,data) VALUES($1,$2,$3)', [
      id,
      ownerId,
      JSON.stringify(data),
    ]);
    await audit(tx, actor.id, 'company.created', id, id);
    return this.company(actor, id, tx);
  }
  async update(actor: Actor, id: string, raw: unknown) {
    const { version, data } = z
      .object({ version: z.number().int().positive(), data: companySchema })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      const previous = await this.company(actor, id, tx, true);
      requireCondition(previous.version === version, 409, 'Карточка изменена. Обновите страницу');
      if (previous.archived !== data.archived)
        await this.checkArchivePermission(actor, previous, data.archived, tx);
      await tx.query(
        'UPDATE companies SET data=$1,version=version+1,updated_at=now() WHERE id=$2',
        [JSON.stringify(data), id],
      );
      await audit(tx, actor.id, 'company.updated', id, id, { before: previous, after: data });
      if (previous.archived !== data.archived)
        await audit(tx, actor.id, data.archived ? 'company.archived' : 'company.restored', id, id);
      return this.company(actor, id, tx);
    });
  }
  async assign(actor: Actor, id: string, ownerId: string, version: number) {
    requireCondition(isLeader(actor), 403, 'Назначение доступно руководителю');
    return this.db.transaction(async (tx) => {
      const company = await this.company(actor, id, tx, true);
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
      'SELECT a.*,u.name AS actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100',
      [id],
    );
    return { company, records, audit: events };
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
    const company = await this.company(actor, id, tx, true);
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
  async records(actor: Actor, kind: RecordKind) {
    const rows = await this.db.query(
      `SELECT r.*,u.name AS author_name,c.data->>'name' AS company_name FROM records r JOIN companies c ON c.id=r.company_id JOIN users u ON u.id=r.author_id WHERE r.kind=$1 AND NOT r.deleted AND ($2::boolean OR c.owner_id=$3) ORDER BY r.created_at DESC`,
      [kind, isLeader(actor), actor.id],
    );
    return rows.map((r) => ({ ...mapRecord(r), companyName: r.company_name }));
  }
  async createRecord(
    actor: Actor,
    companyId: string,
    kind: RecordKind,
    raw: unknown,
    projectId: string | null = null,
    tx?: Sql,
  ): Promise<CrmRecord> {
    const data = recordSchemas[kind].parse(raw);
    if (!tx)
      return this.db.transaction((t) =>
        this.createRecord(actor, companyId, kind, data, projectId, t),
      );
    const company = await this.company(actor, companyId, tx, true);
    requireCondition(!company.archived, 409, 'Сначала восстановите компанию из архива');
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
      'INSERT INTO records(id,kind,company_id,project_id,author_id,assignee_id,data) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [
        id,
        kind,
        companyId,
        projectId,
        actor.id,
        kind === 'task' ? company.ownerId : null,
        JSON.stringify(recordData),
      ],
    );
    await audit(tx, actor.id, `${kind}.created`, id, companyId);
    return mapRecord(row);
  }
  async updateRecord(actor: Actor, id: string, raw: unknown) {
    const input = z
      .object({ version: z.number().int().positive(), data: z.unknown() })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
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
      if (row.kind === 'task')
        data.completedAt = data.done ? current.data.completedAt || new Date().toISOString() : null;
      const [updated] = await tx.query(
        'UPDATE records SET data=$1,version=version+1 WHERE id=$2 RETURNING *',
        [JSON.stringify(data), id],
      );
      await audit(tx, actor.id, `${row.kind}.updated`, id, row.company_id, {
        before: current.data,
        after: data,
      });
      return mapRecord(updated);
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
      await audit(tx, actor.id, 'contact.deleted', id, row.company_id);
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
