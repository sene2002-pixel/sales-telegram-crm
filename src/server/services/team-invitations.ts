import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Actor } from '../../shared/contracts';
import { Database, Sql } from '../infra/database';
import { audit } from '../infra/audit';
import { requireCondition } from '../domain/errors';
import { userProjection } from './auth';
const projection =
  'id, created_at AS "createdAt", expires_at AS "expiresAt", supervisor_id AS "supervisorId", revoked_at AS "revokedAt", used_at AS "usedAt"';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export class TeamInvitations {
  constructor(private db: Database) {}
  private async issuer(tx: Sql, actor: Actor) {
    const [current] = await tx.query<Actor>(
      `SELECT ${userProjection} FROM users WHERE id=$1 FOR SHARE`,
      [actor.id],
    );
    requireCondition(
      current?.active && ['admin', 'supervisor'].includes(current.role),
      403,
      'Приглашать сотрудников могут администратор и руководитель',
    );
    return current;
  }
  async list(actor: Actor) {
    return this.db.transaction(async (tx) => {
      const current = await this.issuer(tx, actor);
      return tx.query(
        `SELECT ${projection} FROM team_invitations WHERE ($2::boolean OR (created_by=$1 AND supervisor_id=$1)) ORDER BY created_at DESC LIMIT 100`,
        [actor.id, current.role === 'admin'],
      );
    });
  }
  async create(actor: Actor, raw: unknown, botUsername: string) {
    const input = z.object({ supervisorId: z.uuid().optional() }).strict().parse(raw);
    requireCondition(
      /^[A-Za-z0-9_]{5,32}$/.test(botUsername),
      503,
      'Не удалось определить Telegram-бота',
    );
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142502)');
      const current = await this.issuer(tx, actor);
      requireCondition(
        current.role === 'admin' || !input.supervisorId || input.supervisorId === current.id,
        403,
        'Можно приглашать только в свою команду',
      );
      const supervisorId = current.role === 'supervisor' ? current.id : input.supervisorId;
      requireCondition(supervisorId, 400, 'Выберите руководителя команды');
      const [supervisor] = await tx.query(
        "SELECT id FROM users WHERE id=$1 AND role='supervisor' AND active=true FOR SHARE",
        [supervisorId],
      );
      requireCondition(supervisor, 400, 'Выберите активного руководителя');
      const [count] = await tx.query(
        'SELECT count(*)::int AS total FROM team_invitations WHERE created_by=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now()',
        [current.id],
      );
      requireCondition(
        count.total < 20,
        429,
        'Достигнут лимит активных приглашений. Отзовите ненужные ссылки',
      );
      const id = randomUUID(),
        token = randomBytes(32).toString('base64url');
      const [row] = await tx.query(
        `INSERT INTO team_invitations(id,token_hash,created_by,supervisor_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours') RETURNING ${projection}`,
        [id, digest(token), current.id, supervisorId],
      );
      await audit(tx, current.id, 'invitation.created', id, null, { supervisorId });
      return { ...row, url: `https://t.me/${botUsername}?start=invite_${token}` };
    });
  }
  async revoke(actor: Actor, id: string) {
    z.uuid().parse(id);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142502)');
      const current = await this.issuer(tx, actor);
      const [row] = await tx.query(
        `UPDATE team_invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND ($3::boolean OR (created_by=$2 AND supervisor_id=$2)) AND used_at IS NULL RETURNING ${projection}`,
        [id, actor.id, current.role === 'admin'],
      );
      requireCondition(row, 404, 'Активное приглашение не найдено');
      await audit(tx, actor.id, 'invitation.revoked', id);
      return row;
    });
  }
  async redeem(token: string, telegramId: string, name: string) {
    requireCondition(
      /^[A-Za-z0-9_-]{43}$/.test(token) &&
        /^[1-9]\d{0,15}$/.test(telegramId) &&
        BigInt(telegramId) <= BigInt(Number.MAX_SAFE_INTEGER),
      400,
      'Приглашение недействительно',
    );
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142502)');
      const [invite] = await tx.query(
        'SELECT * FROM team_invitations WHERE token_hash=$1 FOR UPDATE',
        [digest(token)],
      );
      requireCondition(invite, 400, 'Приглашение недействительно или истекло');
      const [existing] = await tx.query<Actor>(
        `SELECT ${userProjection} FROM users WHERE telegram_id=$1 FOR UPDATE`,
        [telegramId],
      );
      if (invite.used_at) {
        requireCondition(
          existing?.active && invite.used_by === existing.id,
          409,
          'Приглашение уже использовано',
        );
        return { alreadyJoined: true };
      }
      requireCondition(
        !invite.revoked_at && new Date(invite.expires_at).getTime() > Date.now(),
        400,
        'Приглашение недействительно или истекло',
      );
      const [issuer] = await tx.query<Actor>(
        `SELECT ${userProjection} FROM users WHERE id=$1 FOR SHARE`,
        [invite.created_by],
      );
      requireCondition(
        issuer?.active &&
          (issuer.role === 'admin' ||
            (issuer.role === 'supervisor' && issuer.id === invite.supervisor_id)),
        400,
        'Приглашение больше не действует',
      );
      const [supervisor] = await tx.query(
        "SELECT id FROM users WHERE id=$1 AND role='supervisor' AND active=true FOR SHARE",
        [invite.supervisor_id],
      );
      requireCondition(supervisor, 400, 'Приглашение больше не действует');
      requireCondition(
        !existing,
        409,
        'Вы уже добавлены в CRM. Для изменения команды обратитесь к администратору',
      );
      const id = randomUUID();
      await tx.query(
        "INSERT INTO users(id,telegram_id,name,role,active,supervisor_id) VALUES($1,$2,$3,'manager',true,$4)",
        [
          id,
          telegramId,
          name.trim().slice(0, 200) || `Telegram ID ${telegramId}`,
          invite.supervisor_id,
        ],
      );
      await tx.query('UPDATE team_invitations SET used_at=now(),used_by=$2 WHERE id=$1', [
        invite.id,
        id,
      ]);
      await audit(tx, id, 'invitation.accepted', invite.id, null, {
        createdBy: invite.created_by,
        supervisorId: invite.supervisor_id,
      });
      return { alreadyJoined: false };
    });
  }
}
