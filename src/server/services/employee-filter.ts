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
  const [current] = await db.query('SELECT role,active FROM users WHERE id=$1', [actor.id]);
  requireCondition(
    current?.active && current.role === actor.role,
    403,
    'Доступ изменён. Обновите страницу',
  );
  return db.query<EmployeeFilterOption>(
    `SELECT id,name,role FROM users WHERE active AND
      ($1::boolean OR id=$2 OR ($3::boolean AND role='manager' AND supervisor_id=$2)) ORDER BY name,id`,
    [current.role === 'admin', actor.id, current.role === 'supervisor'],
  );
}
