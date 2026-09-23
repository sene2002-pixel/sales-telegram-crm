import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Actor, Role, roles } from '../../shared/contracts';
import { Config } from '../config';
import { Database, Sql } from '../infra/database';
import { requireCondition } from '../domain/errors';
import { audit } from '../infra/audit';
import { z } from 'zod';

export function verifyTelegram(
  initData: string,
  token: string,
  now = Date.now(),
): { id: string; name: string } {
  requireCondition(token, 503, 'Telegram не настроен');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') || '';
  requireCondition(
    [...params.keys()].length === new Set(params.keys()).size,
    401,
    'Повторные поля авторизации',
  );
  params.delete('hash');
  const source = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(source).digest();
  const received = Buffer.from(hash, 'hex');
  requireCondition(
    received.length === expected.length && timingSafeEqual(received, expected),
    401,
    'Неверная подпись Telegram',
  );
  const age = now / 1000 - Number(params.get('auth_date'));
  requireCondition(
    Number.isFinite(age) && age >= -30 && age <= 3600,
    401,
    'Авторизация устарела. Откройте приложение заново',
  );
  let raw: unknown;
  try {
    raw = JSON.parse(params.get('user') || '{}');
  } catch {
    requireCondition(false, 401, 'Неверные данные пользователя');
  }
  const parsed = z
    .object({
      id: z.number().int().positive().safe(),
      first_name: z.string(),
      last_name: z.string().optional(),
    })
    .safeParse(raw);
  requireCondition(parsed.success, 401, 'Неверные данные пользователя');
  return {
    id: String(parsed.data.id),
    name: [parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(' ').slice(0, 200),
  };
}
export function isLeader(actor: Actor) {
  return actor.role === 'admin' || actor.role === 'supervisor';
}
export const userProjection =
  'id, telegram_id AS "telegramId", name, role, active, supervisor_id AS "supervisorId"';
export class AuthService {
  constructor(
    private db: Database,
    private config: Config,
  ) {}
  async telegram(initData: string) {
    const user = verifyTelegram(initData, this.config.botToken);
    const actor = await this.byTelegram(user.id, user.name);
    return { token: this.issue(actor), user: actor };
  }
  async byTelegram(id: string, name = 'Администратор', tx: Sql = this.db): Promise<Actor> {
    if (id === this.config.adminTelegramId) {
      await tx.query(
        `INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,'admin') ON CONFLICT(telegram_id) DO NOTHING`,
        [randomUUID(), id, name],
      );
    }
    const [user] = await tx.query<Actor>(
      `SELECT ${userProjection} FROM users WHERE telegram_id=$1`,
      [id],
    );
    requireCondition(user?.active, 403, 'Доступ не выдан. Обратитесь к администратору');
    return user;
  }
  issue(actor: Actor) {
    const payload = Buffer.from(
      JSON.stringify({ sub: actor.id, exp: Math.floor(Date.now() / 1000) + 8 * 3600 }),
    ).toString('base64url');
    return `${payload}.${createHmac('sha256', this.config.sessionSecret).update(payload).digest('base64url')}`;
  }
  async authenticate(token: string): Promise<Actor> {
    const [payload, signature, extra] = token.split('.');
    requireCondition(payload && signature && !extra, 401, 'Необходим вход');
    const expected = createHmac('sha256', this.config.sessionSecret).update(payload).digest();
    const received = Buffer.from(signature, 'base64url');
    requireCondition(
      received.length === expected.length && timingSafeEqual(received, expected),
      401,
      'Неверная сессия',
    );
    let session: any;
    try {
      session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch {
      requireCondition(false, 401, 'Неверная сессия');
    }
    requireCondition(
      typeof session.exp === 'number' &&
        session.exp > Date.now() / 1000 &&
        z.uuid().safeParse(session.sub).success,
      401,
      'Сессия истекла',
    );
    const [actor] = await this.db.query<Actor>(`SELECT ${userProjection} FROM users WHERE id=$1`, [
      session.sub,
    ]);
    requireCondition(actor?.active, 403, 'Доступ заблокирован');
    return actor;
  }
  async dev(role: Role, ip: string) {
    requireCondition(
      this.config.devAuth &&
        !this.config.production &&
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip),
      403,
      'Демонстрационный вход отключён',
    );
    const telegramId = `dev-${role}`;
    await this.db.query(
      `INSERT INTO users(id,telegram_id,name,role) VALUES($1,$2,$3,$4) ON CONFLICT(telegram_id) DO NOTHING`,
      [randomUUID(), telegramId, `Демо ${role}`, role],
    );
    const actor = await this.byTelegram(telegramId);
    return { token: this.issue(actor), user: actor };
  }
  async users(actor: Actor) {
    if (!isLeader(actor)) return [actor];
    return this.db.query<Actor>(`SELECT ${userProjection} FROM users ORDER BY name`);
  }
  async saveUser(actor: Actor, raw: unknown) {
    requireCondition(actor.role === 'admin', 403, 'Только администратор управляет сотрудниками');
    const input = z
      .object({
        telegramId: z.string().regex(/^[1-9]\d{0,15}$/),
        name: z.string().trim().min(1).max(200),
        role: z.enum(roles),
        active: z.boolean(),
        supervisorId: z.string().uuid().nullable().optional(),
      })
      .strict()
      .parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7142502)');
      const [existing] = await tx.query<Actor>(
        `SELECT ${userProjection} FROM users WHERE telegram_id=$1 FOR UPDATE`,
        [input.telegramId],
      );
      if (
        existing?.role === 'admin' &&
        existing.active &&
        (input.role !== 'admin' || !input.active)
      ) {
        const admins = await tx.query(`SELECT id FROM users WHERE role='admin' AND active=true`);
        requireCondition(admins.length > 1, 409, 'Нельзя отключить последнего администратора');
      }
      const id = existing?.id || randomUUID();
      const supervisorId =
        input.supervisorId === undefined
          ? input.role === 'manager'
            ? (existing?.supervisorId ?? null)
            : null
          : input.supervisorId;
      if (supervisorId) {
        const [supervisor] = await tx.query(
          "SELECT id FROM users WHERE id=$1 AND role='supervisor' AND active=true",
          [supervisorId],
        );
        requireCondition(
          supervisor && supervisorId !== id && input.role === 'manager',
          400,
          'Руководителя можно назначить менеджеру. Выберите активного руководителя',
        );
      }
      if (existing?.role === 'supervisor' && (input.role !== 'supervisor' || !input.active))
        await tx.query('UPDATE users SET supervisor_id=NULL WHERE supervisor_id=$1', [id]);
      await tx.query(
        `INSERT INTO users(id,telegram_id,name,role,active,supervisor_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(telegram_id) DO UPDATE SET name=$3,role=$4,active=$5,supervisor_id=$6`,
        [id, input.telegramId, input.name, input.role, input.active, supervisorId],
      );
      await audit(tx, actor.id, 'user.updated', id, null, input);
      return { id, ...input, supervisorId };
    });
  }
}
