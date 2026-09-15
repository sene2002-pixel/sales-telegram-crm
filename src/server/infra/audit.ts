import { randomUUID } from 'node:crypto';
import { Sql } from './database';
export async function audit(
  tx: Sql,
  actorId: string,
  action: string,
  entityId: string,
  companyId: string | null = null,
  details: unknown = {},
) {
  await tx.query(
    'INSERT INTO audit(id,actor_id,company_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), actorId, companyId, action, entityId, JSON.stringify(details)],
  );
}
