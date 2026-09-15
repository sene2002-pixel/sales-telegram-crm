import { createHash, randomBytes } from 'node:crypto';
import { Actor } from '../../shared/contracts';
import { Config } from '../config';
import { Database } from '../infra/database';
import { requireCondition } from '../domain/errors';
import { DashboardService } from './dashboard';
import { isLeader } from './auth';
import { TelegramAdapter } from '../infra/telegram';

export class ExportService {
  constructor(
    private db: Database,
    private dashboard: DashboardService,
    private telegram: TelegramAdapter,
    private config: Config,
  ) {}
  private async snapshot(actor: Actor, from: string, to: string) {
    const content = await this.dashboard.csv(actor, from, to);
    return { content, filename: `team-report-${from}-${to}.csv` };
  }
  async issue(actor: Actor, from: string, to: string) {
    requireCondition(
      this.config.publicUrl.startsWith('https://'),
      503,
      'Для скачивания в Telegram нужен HTTPS',
    );
    const snapshot = await this.snapshot(actor, from, to);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142503)');
      await tx.query('DELETE FROM csv_downloads WHERE expires_at <= now()');
      const rows = await tx.query('SELECT token_hash FROM csv_downloads WHERE owner_id=$1', [
        actor.id,
      ]);
      requireCondition(rows.length < 5, 429, 'Слишком много выгрузок. Подождите пять минут.');
      await tx.query(
        'INSERT INTO csv_downloads(token_hash,owner_id,filename,content,expires_at) VALUES($1,$2,$3,$4,$5)',
        [this.hash(token), actor.id, snapshot.filename, snapshot.content, expiresAt],
      );
    });
    return {
      url: `${this.config.publicUrl.replace(/\/$/, '')}/api/downloads/csv/${token}`,
      filename: snapshot.filename,
      expiresAt: expiresAt.toISOString(),
    };
  }
  async read(token: string) {
    requireCondition(/^[a-f0-9]{64}$/.test(token), 404, 'Ссылка недействительна или истекла');
    const [row] = await this.db.query(
      `SELECT d.filename,d.content,u.role,u.active FROM csv_downloads d JOIN users u ON u.id=d.owner_id WHERE token_hash=$1 AND expires_at>now()`,
      [this.hash(token)],
    );
    requireCondition(row && row.active && isLeader(row), 404, 'Ссылка недействительна или истекла');
    // Restore the CSV BOM explicitly: embedded SQL text decoding may strip it.
    return { filename: row.filename, content: '\uFEFF' + row.content.replace(/^\uFEFF/, '') };
  }
  async sendToBot(actor: Actor, from: string, to: string) {
    requireCondition(isLeader(actor), 403, 'Отчёт доступен руководителю');
    requireCondition(
      /^[1-9]\d+$/.test(actor.telegramId),
      400,
      'Отправка доступна после входа через Telegram',
    );
    const snapshot = await this.snapshot(actor, from, to);
    await this.telegram.sendDocument(actor.telegramId, snapshot.content, snapshot.filename);
    return { sent: true };
  }
  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
