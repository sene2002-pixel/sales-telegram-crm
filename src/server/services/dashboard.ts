import { resolveEmployeeFilter } from './employee-filter';
import {
  Actor,
  dateSchema,
  AnalyticsSettings,
  analyticsSettingsInputSchema,
} from '../../shared/contracts';
import { Database } from '../infra/database';
import { requireCondition } from '../domain/errors';
import { isLeader } from './auth';
import { summarizeAnalytics, summarizeClientAnalytics } from '../../shared/analytics';
import { audit } from '../infra/audit';
import { z } from 'zod';
export class DashboardService {
  constructor(
    private db: Database,
    private timezone: string,
  ) {}
  private async currentActor(actor: Actor) {
    const [current] = await this.db.query('SELECT active,role FROM users WHERE id=$1', [actor.id]);
    requireCondition(
      current?.active && current.role === actor.role,
      403,
      'Доступ изменён. Обновите страницу',
    );
  }
  async analyticsSettings(actor: Actor): Promise<AnalyticsSettings> {
    await this.currentActor(actor);
    const [row] = await this.db.query('SELECT * FROM analytics_settings WHERE id=1');
    return {
      revision: row.revision,
      taskDays: row.task_days,
      meetingMonths: row.meeting_months,
      projectMonths: row.project_months,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }
  async updateAnalyticsSettings(actor: Actor, raw: unknown): Promise<AnalyticsSettings> {
    const input = analyticsSettingsInputSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      const [current] = await tx.query('SELECT active,role FROM users WHERE id=$1 FOR UPDATE', [
        actor.id,
      ]);
      requireCondition(
        current?.active && current.role === 'admin' && actor.role === 'admin',
        403,
        'Настройки доступны администратору',
      );
      const [previous] = await tx.query('SELECT * FROM analytics_settings WHERE id=1 FOR UPDATE');
      requireCondition(
        previous.revision === input.revision,
        409,
        'Настройки изменены. Обновите страницу',
      );
      await tx.query(
        'UPDATE analytics_settings SET revision=revision+1,task_days=$1,meeting_months=$2,project_months=$3,updated_at=now() WHERE id=1',
        [input.taskDays, input.meetingMonths, input.projectMonths],
      );
      await audit(tx, actor.id, 'analytics.settings_updated', 'analytics-settings', null, {
        before: {
          revision: previous.revision,
          taskDays: previous.task_days,
          meetingMonths: previous.meeting_months,
          projectMonths: previous.project_months,
        },
        after: { ...input, revision: input.revision + 1 },
      });
    });
    return this.analyticsSettings(actor);
  }
  async analytics(actor: Actor, from: string, to: string, employeeId?: unknown, rawMode?: unknown) {
    await this.currentActor(actor);
    const mode = z.enum(['all', 'range']).parse(rawMode ?? 'range');
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    requireCondition(
      mode === 'all' || (typeof from === 'string' && from <= today),
      400,
      'Начало периода не должно быть в будущем',
    );
    const employee = await resolveEmployeeFilter(this.db, actor, employeeId);
    dateSchema.parse(from);
    dateSchema.parse(to);
    requireCondition(from <= to, 400, 'Неверный период');
    requireCondition(
      (+new Date(to) - +new Date(from)) / 86400000 <= 3660,
      400,
      'Период не должен превышать десять лет',
    );
    const companies = await this.db.query(
      'SELECT id,data,created_at,updated_at FROM companies WHERE ($1::boolean OR owner_id=$2) AND ($3::uuid IS NULL OR owner_id=$3)',
      [isLeader(actor), actor.id, employee],
    );
    const events = await this.db.query(
      "SELECT a.company_id,a.entity_id,a.action,a.details,a.created_at,a.analytics_seq,a.analytics_order_proven FROM audit a JOIN companies c ON c.id=a.company_id WHERE ($1::boolean OR c.owner_id=$2) AND ($3::uuid IS NULL OR c.owner_id=$3) AND a.action IN ('company.created','company.updated','company.sales_updated','company.archived','company.restored','report.applied') ORDER BY a.created_at,a.analytics_seq",
      [isLeader(actor), actor.id, employee],
    );
    const records = await this.db.query(
      "SELECT r.* FROM records r JOIN companies c ON c.id=r.company_id WHERE ($1::boolean OR c.owner_id=$2) AND r.kind IN ('task','contact','project')",
      [isLeader(actor), actor.id],
    );
    const recordEvents = await this.db.query(
      "SELECT a.company_id,a.entity_id,a.action,a.details,a.created_at,a.analytics_seq,a.analytics_order_proven FROM audit a JOIN companies c ON c.id=a.company_id WHERE ($1::boolean OR c.owner_id=$2) AND a.action IN ('task.created','task.updated','task.deleted','contact.created','contact.updated','contact.deleted','project.created','project.updated') ORDER BY a.created_at,a.analytics_seq",
      [isLeader(actor), actor.id],
    );
    const settings = await this.analyticsSettings(actor);
    return {
      ...summarizeAnalytics(companies as any, events as any, from, to, this.timezone),
      clientAnalytics: summarizeClientAnalytics(
        companies as any,
        records as any,
        [...events, ...recordEvents] as any,
        from,
        to,
        this.timezone,
        settings,
        mode,
      ),
    };
  }
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
