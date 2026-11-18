import { randomUUID } from 'node:crypto';
import { Config } from '../config';
import { DomainError, requireCondition } from '../domain/errors';
import { Database } from './database';

export class AiBudgetLimit extends DomainError {
  constructor(public retryAfter: number) {
    super(429, 'Достигнут лимит ИИ. Повторите позже.');
  }
}

// Attempts count even when the provider fails after receiving the request.
export class AiBudget {
  constructor(
    private db: Database,
    private settings: Config['aiBudget'],
  ) {}
  async run<T>(actorId: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (!this.settings.enabled) return operation();
    requireCondition(actorId, 503, 'Не определён ответственный за запрос ИИ');
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142571)');
      const [actor] = await tx.query('SELECT id FROM users WHERE id=$1 AND active FOR SHARE', [
        actorId,
      ]);
      requireCondition(actor, 403, 'Доступ заблокирован');
      await tx.query("DELETE FROM ai_budget_requests WHERE started_at <= now() - interval '1 day'");
      const [used] = await tx.query(
        `SELECT count(*)::int AS daily,
        count(*) FILTER (WHERE actor_id=$1)::int AS user_daily,
        count(*) FILTER (WHERE lease_until>now())::int AS running,
        count(*) FILTER (WHERE actor_id=$1 AND lease_until>now())::int AS user_running,
        count(*) FILTER (WHERE actor_id=$1 AND started_at>now()-interval '1 minute')::int AS user_minute,
        extract(epoch FROM min(started_at)+interval '1 day'-now()) AS daily_wait,
        extract(epoch FROM (min(started_at) FILTER (WHERE actor_id=$1))+interval '1 day'-now()) AS user_wait
        FROM ai_budget_requests`,
        [actorId],
      );
      if (used.daily >= this.settings.systemDaily || used.user_daily >= this.settings.userDaily)
        throw new AiBudgetLimit(
          Math.max(
            1,
            Math.ceil(
              used.user_daily >= this.settings.userDaily ? used.user_wait : used.daily_wait,
            ),
          ),
        );
      if (used.user_minute >= this.settings.userMinute) throw new AiBudgetLimit(60);
      if (
        used.running >= this.settings.systemConcurrent ||
        used.user_running >= this.settings.userConcurrent
      )
        throw new AiBudgetLimit(5);
      // The provider deadline is 90 seconds, including reading its response.
      await tx.query(
        "INSERT INTO ai_budget_requests(id,actor_id,lease_until) VALUES ($1,$2,now()+interval '2 minutes')",
        [id, actorId],
      );
    });
    try {
      return await operation();
    } finally {
      await this.db.query('UPDATE ai_budget_requests SET lease_until=NULL WHERE id=$1', [id]);
    }
  }
}
