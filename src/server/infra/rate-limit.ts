import { createHash } from 'node:crypto';
import { Sql } from './database';
/** Process-local fixed windows. Never key these counters by unverified user input. */
export class RateLimits {
  private buckets = new Map<string, { count: number; until: number }>();
  constructor(
    private now: () => number = Date.now,
    private capacity = 10000,
  ) {}
  consume(key: string, limit: number): number {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      for (const [k, value] of this.buckets) if (value.until <= now) this.buckets.delete(k);
      if (!bucket && this.buckets.size >= this.capacity) return 60;
      bucket = { count: 0, until: now + 60000 };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return bucket.count > limit ? Math.max(1, Math.ceil((bucket.until - now) / 1000)) : 0;
  }
}

// All instances using the same PostgreSQL database share a fixed window.
export class SharedRateLimits {
  private cleanupAfter = 0;
  constructor(private db: Sql) {}
  async consume(key: string, limit: number): Promise<number> {
    const now = Date.now();
    if (this.cleanupAfter <= now) {
      this.cleanupAfter = now + 60_000;
      await this.db.query('DELETE FROM api_limit_windows WHERE until_at <= now()');
    }
    const hash = createHash('sha256').update(key).digest('hex');
    const [window] = await this.db.query(
      `INSERT INTO api_limit_windows (key,count,until_at)
      VALUES ($1,1,now()+interval '1 minute')
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN api_limit_windows.until_at <= now() THEN 1 ELSE LEAST(api_limit_windows.count+1, $2::int+1) END,
        until_at = CASE WHEN api_limit_windows.until_at <= now() THEN now()+interval '1 minute' ELSE api_limit_windows.until_at END
      RETURNING count, greatest(1,ceil(extract(epoch FROM until_at-now())))::int AS wait`,
      [hash, limit],
    );
    return window.count > limit ? window.wait : 0;
  }
}
