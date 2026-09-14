import { Actor, dateSchema } from '../../shared/contracts';
import { Database } from '../infra/database';
import { requireCondition } from '../domain/errors';
import { isLeader } from './auth';
export class DashboardService {
  constructor(
    private db: Database,
    private timezone: string,
  ) {}
  async summary(actor: Actor, from: string, to: string) {
    requireCondition(isLeader(actor), 403, 'Отчёт доступен руководителю');
    dateSchema.parse(from);
    dateSchema.parse(to);
    requireCondition(from <= to, 400, 'Неверный период');
    const users = await this.db.query('SELECT id,name,role,active FROM users ORDER BY name');
    const companies = await this.db.query('SELECT id,owner_id,data FROM companies');
    const records = await this.db.query(
      `SELECT * FROM records WHERE kind IN ('task','activity') AND NOT deleted`,
    );
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const day = (v: string) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: this.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(v));
    return users.map((u) => {
      const owned = companies.filter((c) => c.owner_id === u.id && !c.data.archived);
      const tasks = records.filter((r) => r.kind === 'task' && r.assignee_id === u.id);
      return {
        ...u,
        companies: owned.length,
        openTasks: tasks.filter((t) => !t.data.done).length,
        overdue: tasks.filter((t) => !t.data.done && t.data.due && t.data.due < today).length,
        completed: tasks.filter(
          (t) =>
            t.data.done &&
            t.data.completedAt &&
            day(t.data.completedAt) >= from &&
            day(t.data.completedAt) <= to,
        ).length,
        interactions: records.filter(
          (r) =>
            r.kind === 'activity' &&
            r.author_id === u.id &&
            r.data.occurredOn >= from &&
            r.data.occurredOn <= to,
        ).length,
        inactiveCompanies: owned
          .filter(
            (c) =>
              !records.some(
                (r) =>
                  r.kind === 'activity' && r.company_id === c.id && r.data.occurredOn >= cutoff,
              ),
          )
          .map((c) => ({ id: c.id, name: c.data.name })),
      };
    });
  }
  async csv(actor: Actor, from: string, to: string) {
    const rows = await this.summary(actor, from, to);
    const cell = (v: unknown) =>
      '"' +
      String(v)
        .replace(/^[=+\-@\t\r]/, "'$&")
        .replaceAll('"', '""') +
      '"';
    return (
      '\uFEFF' +
      [
        [
          'Сотрудник',
          'Компаний',
          'Открыто задач',
          'Просрочено',
          'Выполнено за период',
          'Контактов за период',
          'Без активности 14 дней',
        ],
        ...rows.map((r) => [
          r.name,
          r.companies,
          r.openTasks,
          r.overdue,
          r.completed,
          r.interactions,
          r.inactiveCompanies.length,
        ]),
      ]
        .map((row) => row.map(cell).join(';'))
        .join('\r\n')
    );
  }
}
