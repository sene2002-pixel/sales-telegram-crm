import { Actor, EmployeeFilterOption, idSchema } from '../../shared/contracts';
import { requireCondition } from '../domain/errors';
import { Sql } from '../infra/database';

// A filter narrows the established ACL; it never grants object permissions.
export async function resolveEmployeeFilter(
  db: Sql,
  actor: Actor,
  raw: unknown,
): Promise<string | null> {
  if (raw === undefined || raw === '') return null;
  const id = idSchema.parse(raw);
  const [row] = await db.query(
    `SELECT a.role AS actor_role,a.active AS actor_active,
      e.id,e.role,e.active,e.supervisor_id
     FROM users a LEFT JOIN users e ON e.id=$2 WHERE a.id=$1`,
    [actor.id, id],
  );
  requireCondition(
    row?.actor_active &&
      row.actor_role === actor.role &&
      row.active &&
      (row.actor_role === 'admin' ||
        row.id === actor.id ||
        (row.actor_role === 'supervisor' &&
          row.role === 'manager' &&
          row.supervisor_id === actor.id)),
    403,
    'Сотрудник недоступен для фильтра. Обновите список сотрудников',
  );
  return id;
}

export async function employeeFilterOptions(
  db: Sql,
  actor: Actor,
): Promise<EmployeeFilterOption[]> {
  const rows = await db.query<EmployeeFilterOption>(
    `SELECT e.id,e.name,e.role FROM users a JOIN users e ON e.active AND
      (a.role='admin' OR e.id=a.id OR (a.role='supervisor' AND e.role='manager' AND e.supervisor_id=a.id))
     WHERE a.id=$1 AND a.active AND a.role=$2 ORDER BY e.name,e.id`,
    [actor.id, actor.role],
  );
  // Every active actor can see themselves, even when they have no direct reports.
  requireCondition(rows.length, 403, 'Доступ изменён. Обновите страницу');
  return rows;
}
