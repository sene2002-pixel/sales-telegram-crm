import { createHash } from 'node:crypto';
import type {
  HandoffCompany,
  HandoffPerson,
  HandoffQueue,
  HandoffTask,
  RemovalHandoff,
} from '../../shared/client-handoff';
import {
  assignCompanyHandoffSchema,
  assignHandoffSchema,
  removalHandoffSchema,
} from '../../shared/client-handoff';
import { Actor, idSchema, Role } from '../../shared/contracts';
import { requireCondition } from '../domain/errors';
import { audit } from '../infra/audit';
import { Database, Sql } from '../infra/database';
import { activeActor, AuthService, isLeader, readAsActor, removableTeamMember } from './auth';
import { activeHandoffCompany, CrmService, openHandoffTask } from './crm';

type Person = HandoffPerson & { role: Role; supervisorId: string | null };
type Former = {
  former_id: string;
  former_name: string;
  former_role: Role;
  former_supervisor_id: string | null;
};
type TaskWork = HandoffCompany['tasks'][number] & { version: number };
type ProjectWork = HandoffCompany['projects'][number] & { version: number };
type CompanyWork = Omit<HandoffCompany, 'projects' | 'tasks' | 'revision'> & {
  projects: ProjectWork[];
  tasks: TaskWork[];
};
type StandaloneWork = HandoffTask & { currentOwnerId: string; ownerCanReceive: boolean };
type Work = { companies: CompanyWork[]; tasks: StandaloneWork[] };
type Scope = { memberId?: string; companyId?: string; taskId?: string };
type CompanyRow = Former & { id: string; name: string; version: number };
type StandaloneRow = Former &
  TaskWork & { company_id: string; company_name: string; current_owner_id: string };

const identity = ({ id, name }: HandoffPerson): HandoffPerson => ({ id, name });
const formerPerson = (row: Former): Person => ({
  id: row.former_id,
  name: row.former_name,
  role: row.former_role,
  supervisorId: row.former_supervisor_id,
});
const compareDue = (a: string | null, b: string | null) =>
  (a ?? '9999-99-99').localeCompare(b ?? '9999-99-99');
const compareWork = (
  a: { id: string; due: string | null },
  b: { id: string; due: string | null },
) => compareDue(a.due, b.due) || a.id.localeCompare(b.id);
const nearestDue = ({ projects, tasks }: CompanyWork) =>
  compareDue(projects[0]?.due ?? null, tasks[0]?.due ?? null) <= 0
    ? (projects[0]?.due ?? null)
    : (tasks[0]?.due ?? null);
const fingerprint = (data: unknown) =>
  createHash('sha256').update(JSON.stringify(data)).digest('hex');
const companyRevision = ({ id, version, projects, tasks }: CompanyWork) =>
  fingerprint([
    id,
    version,
    projects.map((project) => [project.id, project.version]),
    tasks.map((task) => [task.id, task.version]),
  ]);

function teamCandidates(people: Person[], former: Person): Person[] {
  const hasLeader = people.some(
    (person) => person.id === former.supervisorId && person.role !== 'manager',
  );
  return people.filter((person) => {
    if (person.id === former.id) return false;
    if (former.role !== 'manager')
      return person.role !== 'manager' || person.supervisorId === former.id;
    if (!former.supervisorId)
      return person.role === 'admin' || (person.role === 'manager' && !person.supervisorId);
    const withinTeam =
      (person.id === former.supervisorId && person.role !== 'manager') ||
      (person.role === 'manager' && person.supervisorId === former.supervisorId);
    // A former leader no longer in CRM may leave no live team to take custody.
    return withinTeam || (!hasLeader && person.role === 'admin');
  });
}

export class ClientHandoffService {
  constructor(
    private db: Database,
    private auth: AuthService,
    private crm: CrmService,
  ) {}

  async queue(actor: Actor): Promise<HandoffQueue> {
    return readAsActor(this.db, actor, async (tx, current) => {
      this.requireLeader(current);
      const { companies, tasks } = await this.work(tx, current);
      return {
        companies: companies.map((company) => ({
          ...company,
          revision: companyRevision(company),
          projects: company.projects.map(({ version: _, ...project }) => project),
          tasks: company.tasks.map(({ version: _, ...task }) => task),
        })),
        tasks: tasks.map(({ currentOwnerId: _, ownerCanReceive: __, ...task }) => task),
      };
    });
  }

  async previewRemoval(actor: Actor, id: string): Promise<RemovalHandoff> {
    return readAsActor(this.db, actor, async (tx, current) => {
      const member = await removableTeamMember(tx, current, id);
      return this.removalPreview(member, await this.work(tx, current, { memberId: member.id }));
    });
  }

  async remove(actor: Actor, id: string, raw?: unknown) {
    // Existing bare DELETE requests retain the deferred behavior. A supplied object is strict.
    if (
      raw === undefined ||
      (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !Object.keys(raw).length)
    )
      return this.auth.removeTeamMember(actor, id);
    const input = removalHandoffSchema.parse(raw);
    await this.auth.removeTeamMember(actor, id, async (tx, current, member) => {
      const work = await this.work(tx, current, { memberId: member.id });
      const preview = this.removalPreview(member, work);
      requireCondition(
        preview.revision === input.revision,
        409,
        'Данные для передачи изменились. Обновите окно удаления',
      );
      requireCondition(
        !preview.unassignableTaskCount,
        409,
        'У отдельных задач нет активного ответственного за компанию. Удалите сотрудника и распределите их позже',
      );
      if (work.companies.length) {
        const recipientId = input.recipientId;
        requireCondition(recipientId, 400, 'Выберите нового ответственного за компании');
        this.requireCandidate(preview.candidates, recipientId);
        for (const company of work.companies)
          await this.crm.assignInTransaction(
            tx,
            current,
            company.id,
            recipientId,
            company.version,
            member.id,
          );
      }
      for (const task of work.tasks) await this.writeTask(tx, current, task, task.currentOwnerId);
    });
  }

  async assignCompany(actor: Actor, id: string, raw: unknown) {
    const input = assignCompanyHandoffSchema.parse(raw);
    await this.write(actor, async (tx, current) => {
      const {
        companies: [company],
      } = await this.work(tx, current, { companyId: idSchema.parse(id) });
      requireCondition(company, 404, 'Компания не найдена в очереди передачи');
      requireCondition(
        input.revision === companyRevision(company),
        409,
        'Работа по компании изменилась. Обновите очередь',
      );
      this.requireCandidate(company.candidates, input.recipientId);
      await this.crm.assignInTransaction(
        tx,
        current,
        company.id,
        input.recipientId,
        input.version,
        company.formerOwner.id,
      );
    });
  }

  async assignTask(actor: Actor, id: string, raw: unknown) {
    const input = assignHandoffSchema.parse(raw);
    await this.write(actor, async (tx, current) => {
      const {
        tasks: [task],
      } = await this.work(tx, current, { taskId: idSchema.parse(id) });
      requireCondition(task, 404, 'Задача не найдена в очереди передачи');
      requireCondition(task.version === input.version, 409, 'Задача изменилась. Обновите очередь');
      this.requireCandidate(task.candidates, input.recipientId);
      await this.writeTask(tx, current, task, input.recipientId);
    });
  }

  private async write(actor: Actor, change: (tx: Sql, current: Actor) => Promise<void>) {
    this.requireLeader(actor);
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142502)');
      await tx.query('SELECT pg_advisory_xact_lock(7142532)');
      const current = await activeActor(tx, actor.id);
      requireCondition(current.role === actor.role, 403, 'Доступ изменён. Обновите страницу');
      await change(tx, current);
    });
  }

  private requireLeader(actor: Actor) {
    requireCondition(
      isLeader(actor),
      403,
      'Очередь передачи доступна руководителю и администратору',
    );
  }

  private requireCandidate(candidates: HandoffPerson[], id: string) {
    requireCondition(
      candidates.some((person) => person.id === id),
      403,
      'Сотрудник недоступен для назначения',
    );
  }

  private async writeTask(tx: Sql, actor: Actor, task: StandaloneWork, recipientId: string) {
    const [saved] = await tx.query(
      `UPDATE records r SET assignee_id=$1,version=version+1
       WHERE id=$2 AND assignee_id=$3 AND version=$4 AND ${openHandoffTask('r')} RETURNING version`,
      [recipientId, task.id, task.formerAssignee.id, task.version],
    );
    requireCondition(saved, 409, 'Задача изменилась. Обновите очередь');
    await audit(tx, actor.id, 'task.assigned', task.id, task.companyId, {
      from: task.formerAssignee.id,
      to: recipientId,
      version: saved.version,
    });
  }

  private removalPreview(member: Actor, work: Work): RemovalHandoff {
    const candidates = work.companies[0]?.candidates ?? [];
    const affected = {
      member: member.id,
      companies: work.companies.map(companyRevision),
      tasks: work.tasks.map(({ id, version, currentOwnerId, ownerCanReceive }) => [
        id,
        version,
        currentOwnerId,
        ownerCanReceive,
      ]),
    };
    return {
      companyCount: work.companies.length,
      projectCount: work.companies.reduce((sum, item) => sum + item.projects.length, 0),
      taskCount: work.companies.reduce((sum, item) => sum + item.tasks.length, work.tasks.length),
      separateTaskCount: work.tasks.length,
      unassignableTaskCount: work.tasks.filter((task) => !task.ownerCanReceive).length,
      candidates,
      suggestedRecipientId:
        candidates.find((person) => person.id === member.supervisorId)?.id ?? null,
      revision: fingerprint(affected),
    };
  }

  private async work(tx: Sql, actor: Actor, scope: Scope = {}): Promise<Work> {
    const args = [actor.id, actor.role === 'admin', scope.memberId ?? null] as const;
    const visibleSource = `($2::boolean OR (u.role='manager' AND u.supervisor_id=$1))
       AND (CASE WHEN $3::uuid IS NULL THEN u.team_removed_at IS NOT NULL
                 ELSE u.id=$3 AND u.team_removed_at IS NULL END)`;
    const formerFields =
      'u.id AS former_id,u.name AS former_name,u.role AS former_role,u.supervisor_id AS former_supervisor_id';
    const companyRows = scope.taskId
      ? []
      : await tx.query<CompanyRow>(
          `SELECT c.id,c.version,c.data->>'name' AS name,${formerFields}
           FROM companies c JOIN users u ON u.id=c.owner_id
           WHERE ${visibleSource} AND ${activeHandoffCompany('c')}
             AND ($4::uuid IS NULL OR c.id=$4)`,
          [...args, scope.companyId ?? null],
        );
    const standalone = scope.companyId
      ? []
      : await tx.query<StandaloneRow>(
          `SELECT r.id,r.version,r.data->>'text' AS text,r.data->>'due' AS due,
                  c.id AS company_id,c.data->>'name' AS company_name,c.owner_id AS current_owner_id,${formerFields}
           FROM records r JOIN companies c ON c.id=r.company_id JOIN users u ON u.id=r.assignee_id
           WHERE ${visibleSource} AND ${activeHandoffCompany('c')} AND ${openHandoffTask('r')}
             AND c.owner_id<>u.id AND ($4::uuid IS NULL OR r.id=$4)`,
          [...args, scope.taskId ?? null],
        );
    if (!companyRows.length && !standalone.length) return { companies: [], tasks: [] };
    const people = await tx.query<Person>(
      'SELECT id,name,role,supervisor_id AS "supervisorId" FROM users WHERE active AND team_removed_at IS NULL ORDER BY name,id',
    );
    const activeById = new Map(people.map((person) => [person.id, person]));
    const eligibleById = new Map<string, Person[]>();
    const eligible = (former: Person) => {
      const cached = eligibleById.get(former.id);
      if (cached) return cached;
      const candidates = teamCandidates(people, former);
      eligibleById.set(former.id, candidates);
      return candidates;
    };
    const portfolio = new Map(
      companyRows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          version: row.version,
          formerOwner: identity(formerPerson(row)),
          projects: [],
          tasks: [],
          candidates: eligible(formerPerson(row)).map(identity),
        } satisfies CompanyWork as CompanyWork,
      ]),
    );
    if (portfolio.size) {
      const related = await tx.query<{
        kind: 'project' | 'task';
        company_id: string;
        id: string;
        version: number;
        title: string;
        due: string | null;
        stage: ProjectWork['stage'];
      }>(
        `SELECT r.kind,r.company_id,r.id,r.version,r.data->>'due' AS due,
                COALESCE(r.data->>'name',r.data->>'text') AS title,COALESCE(r.data->>'stage','new') AS stage
         FROM records r JOIN companies c ON c.id=r.company_id WHERE r.company_id=ANY($1::uuid[])
           AND ((r.kind='project' AND NOT r.deleted AND COALESCE(r.data->>'stage','new') <> 'closed')
                OR (${openHandoffTask('r')} AND r.assignee_id=c.owner_id))`,
        [[...portfolio.keys()]],
      );
      for (const { kind, company_id, id, version, title, stage, due } of related) {
        const company = portfolio.get(company_id)!;
        if (kind === 'project') company.projects.push({ id, version, name: title, stage, due });
        else company.tasks.push({ id, version, text: title, due });
      }
    }
    const companies = [...portfolio.values()];
    for (const company of companies) {
      company.projects.sort(compareWork);
      company.tasks.sort(compareWork);
    }
    companies.sort((a, b) => compareDue(nearestDue(a), nearestDue(b)) || a.id.localeCompare(b.id));
    const tasks = standalone
      .map((row): StandaloneWork => {
        const former = formerPerson(row);
        const owner = activeById.get(row.current_owner_id);
        const candidates = eligible(former).filter(
          (person) => person.role !== 'manager' || person.id === row.current_owner_id,
        );
        if (owner && !candidates.some((person) => person.id === owner.id))
          candidates.unshift(owner);
        return {
          id: row.id,
          version: row.version,
          text: row.text,
          due: row.due,
          companyId: row.company_id,
          companyName: row.company_name,
          formerAssignee: identity(former),
          candidates: candidates.map(identity),
          currentOwnerId: row.current_owner_id,
          ownerCanReceive: Boolean(owner),
        };
      })
      .sort(compareWork);
    return { companies, tasks };
  }
}
