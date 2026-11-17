import { randomUUID } from 'node:crypto';
import { Actor } from '../../shared/contracts';
import { ideaInputSchema, maxIdeaScreenshotBytes, PicoIdea } from '../../shared/pico-ideas';
import { requireCondition } from '../domain/errors';
import { Database, Sql } from '../infra/database';
import { photoMime } from './photo-input';

async function acknowledge(tx: Sql, actorId: string, chatId: string, text: string) {
  if (!/^[1-9]\d+$/.test(chatId)) return;
  await tx.query('INSERT INTO outbox(id,chat_id,payload,actor_id) VALUES($1,$2,$3,$4)', [
    randomUUID(),
    chatId,
    { text },
    actorId,
  ]);
}

export class PicoIdeas {
  constructor(private db: Database) {}

  async submit(actor: Actor, body: unknown, file?: Express.Multer.File) {
    const input = ideaInputSchema.parse(body);
    let screenshotMime: string | null = null;
    if (file) {
      requireCondition(
        file.size <= maxIdeaScreenshotBytes,
        413,
        'Скриншот должен быть не больше 2 МБ',
      );
      screenshotMime = photoMime(file.buffer);
    }
    return this.db.transaction(async (tx) => {
      const [author] = await tx.query(
        'SELECT active,telegram_id FROM users WHERE id=$1 FOR UPDATE',
        [actor.id],
      );
      requireCondition(author?.active, 403, 'Доступ закрыт');
      const [existing] = await tx.query(
        `SELECT id, body=$3 AND topic IS NOT DISTINCT FROM $4::text
           AND screenshot IS NOT DISTINCT FROM $5::bytea AS matches
         FROM pico_ideas WHERE author_id=$1 AND submission_id=$2`,
        [actor.id, input.submissionId, input.text, input.topic ?? null, file?.buffer ?? null],
      );
      if (existing) {
        requireCondition(
          existing.matches,
          409,
          'Идея уже отправлена. Для нового текста откройте форму заново.',
        );
        return { id: existing.id as string };
      }
      const [recent] = await tx.query(
        "SELECT count(*)::int AS total FROM pico_ideas WHERE author_id=$1 AND created_at>now()-interval '1 day'",
        [actor.id],
      );
      requireCondition(recent.total < 10, 429, 'Можно отправить до 10 идей в сутки');
      const id = randomUUID();
      await tx.query(
        'INSERT INTO pico_ideas(id,author_id,submission_id,topic,body,screenshot,screenshot_mime) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          actor.id,
          input.submissionId,
          input.topic ?? null,
          input.text,
          file?.buffer ?? null,
          screenshotMime,
        ],
      );
      await acknowledge(
        tx,
        actor.id,
        author.telegram_id,
        'Спасибо за идею! Мы прочитаем её и ответим вам в боте.',
      );
      return { id };
    });
  }

  async list(actor: Actor, offset: number): Promise<PicoIdea[]> {
    this.admin(actor);
    const rows = await this.db.query(
      `SELECT i.id,u.name,i.topic,i.body,i.screenshot_mime AS screenshot_mime,i.created_at,i.implemented_at
       FROM pico_ideas i JOIN users u ON u.id=i.author_id
       ORDER BY i.created_at DESC,i.id DESC LIMIT 30 OFFSET $1`,
      [offset],
    );
    return rows.map((row) => ({
      id: row.id,
      author: row.name,
      topic: row.topic,
      text: row.body,
      screenshotMime: row.screenshot_mime,
      createdAt: new Date(row.created_at).toISOString(),
      implementedAt: row.implemented_at ? new Date(row.implemented_at).toISOString() : null,
    }));
  }

  async screenshot(actor: Actor, id: string) {
    this.admin(actor);
    const [row] = await this.db.query(
      "SELECT screenshot_mime,encode(screenshot,'base64') AS screenshot FROM pico_ideas WHERE id=$1",
      [id],
    );
    requireCondition(row?.screenshot, 404, 'Скриншот не найден');
    return { mime: row.screenshot_mime as string, bytes: Buffer.from(row.screenshot, 'base64') };
  }

  async markImplemented(actor: Actor, id: string) {
    this.admin(actor);
    return this.db.transaction(async (tx) => {
      const [idea] = await tx.query(
        `SELECT i.author_id,i.implemented_at,u.telegram_id,u.active FROM pico_ideas i
         JOIN users u ON u.id=i.author_id WHERE i.id=$1 FOR UPDATE OF i`,
        [id],
      );
      requireCondition(idea, 404, 'Идея не найдена');
      if (idea.implemented_at) return { ok: true };
      await tx.query('UPDATE pico_ideas SET implemented_at=now() WHERE id=$1', [id]);
      if (idea.active)
        await acknowledge(tx, idea.author_id, idea.telegram_id, 'Ваша идея теперь в Pico');
      return { ok: true };
    });
  }

  private admin(actor: Actor) {
    requireCondition(actor.active && actor.role === 'admin', 403, 'Идеи доступны администратору');
  }
}
