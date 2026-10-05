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
