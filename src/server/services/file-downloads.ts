import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Actor, idSchema } from '../../shared/contracts';
import { Config } from '../config';
import { requireCondition } from '../domain/errors';
import { CrmService } from './crm';
import { userProjection } from './auth';

export class FileDownloads {
  constructor(
    private crm: CrmService,
    private config: Config,
  ) {}
  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
  private async file(actor: Actor, id: string) {
    const [row] = await this.crm.db.query(
      "SELECT * FROM records WHERE id=$1 AND kind='file' AND NOT deleted",
      [idSchema.parse(id)],
    );
    requireCondition(row, 404, 'Файл не найден');
    await this.crm.company(actor, row.company_id);
    return row;
  }
  async issue(actor: Actor, id: string) {
    const file = await this.file(actor, id);
    const token = randomBytes(32).toString('hex');
    await this.crm.db.transaction(async (tx) => {
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
    const [actor] = await this.crm.db.query<Actor>(
      `SELECT ${userProjection} FROM users WHERE id=$1 AND active`,
      [link.owner_id],
    );
    requireCondition(actor, 404, 'Ссылка недействительна или истекла');
    const file = await this.file(actor, link.file_id);
    return {
      path: join(this.config.dataDir, 'files', idSchema.parse(file.data.key)),
      filename: file.data.name,
      mime: /\.pdf$/i.test(file.data.name) ? 'application/pdf' : 'application/octet-stream',
    };
  }
}
