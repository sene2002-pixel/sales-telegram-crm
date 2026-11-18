import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Actor, idSchema } from '../../shared/contracts';
import { Config } from '../config';
import { requireCondition } from '../domain/errors';
import { CrmService } from './crm';
import { Sql } from '../infra/database';
import { activeActor } from './auth';

export class FileDownloads {
  constructor(
    private crm: CrmService,
    private config: Config,
  ) {}
  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
  private async file(tx: Sql, actorId: string, id: string) {
    const [row] = await tx.query(
      `SELECT r.data FROM records r JOIN companies c ON c.id=r.company_id
       JOIN users u ON u.id=$2 AND u.active AND (u.role IN ('admin','supervisor') OR u.id=c.owner_id)
       WHERE r.id=$1 AND r.kind='file' AND NOT r.deleted FOR SHARE OF r,c`,
      [idSchema.parse(id), actorId],
    );
    requireCondition(row, 404, 'Файл не найден');
    return row;
  }
  async issue(actor: Actor, id: string) {
    const token = randomBytes(32).toString('hex');
    const file = await this.crm.db.transaction(async (tx) => {
      await activeActor(tx, actor.id);
      const existing = await this.file(tx, actor.id, id);
      await tx.query('SELECT pg_advisory_xact_lock(7142504)');
      await tx.query('DELETE FROM file_downloads WHERE expires_at<=now()');
      const rows = await tx.query('SELECT token_hash FROM file_downloads WHERE owner_id=$1', [
        actor.id,
      ]);
      requireCondition(rows.length < 20, 429, 'Слишком много скачиваний. Подождите пять минут');
      await tx.query(
        "INSERT INTO file_downloads(token_hash,owner_id,file_id,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",
        [this.hash(token), actor.id, id],
      );
      return existing;
    });
    // Resolve against the current Mini App origin, including dynamic tunnel domains.
    return { path: `/api/downloads/files/${token}`, filename: file.data.name };
  }
  async read(token: string) {
    requireCondition(/^[a-f0-9]{64}$/.test(token), 404, 'Ссылка недействительна или истекла');
    const [link] = await this.crm.db.query(
      'SELECT * FROM file_downloads WHERE token_hash=$1 AND expires_at>now()',
      [this.hash(token)],
    );
    requireCondition(link, 404, 'Ссылка недействительна или истекла');
    const file = await this.file(this.crm.db, link.owner_id, link.file_id);
    return {
      path: join(this.config.dataDir, 'files', idSchema.parse(file.data.key)),
      filename: file.data.name,
      mime: /\.pdf$/i.test(file.data.name) ? 'application/pdf' : 'application/octet-stream',
    };
  }
}
