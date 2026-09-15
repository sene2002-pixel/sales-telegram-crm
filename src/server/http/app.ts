import 'reflect-metadata';
import {
  Body,
  CanActivate,
  Catch,
  Controller,
  Delete,
  ExecutionContext,
  ExceptionFilter,
  Get,
  HttpException,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response, json, static as serveStatic } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { z, ZodError } from 'zod';
import { Config } from '../config';
import { Database } from '../infra/database';
import { AuthService } from '../services/auth';
import { CrmService } from '../services/crm';
import { ReportService, mapReport } from '../services/reports';
import { ReportWorker } from '../services/worker';
import { BotService } from '../services/bot';
import { DashboardService } from '../services/dashboard';
import { ExportService } from '../services/exports';
import { TelegramAdapter } from '../infra/telegram';
import { OpenAiAdapter } from '../infra/ai';
import { DomainError, requireCondition } from '../domain/errors';
import { Actor, idSchema, roles, extractionSchema, RecordKind } from '../../shared/contracts';

export class Services {
  auth: AuthService;
  crm: CrmService;
  reports: ReportService;
  worker: ReportWorker;
  bot: BotService;
  dashboard: DashboardService;
  exports: ExportService;
  constructor(
    public db: Database,
    public config: Config,
  ) {
    this.auth = new AuthService(db, config);
    this.crm = new CrmService(db);
    this.reports = new ReportService(db, this.crm);
    const telegram = new TelegramAdapter(config),
      ai = new OpenAiAdapter(config);
    this.worker = new ReportWorker(db, this.reports, ai, ai, telegram, config);
    this.bot = new BotService(config, this.auth, this.reports, this.crm, telegram);
    this.dashboard = new DashboardService(db, config.timezone);
    this.exports = new ExportService(db, this.dashboard, telegram, config);
  }
}
type AuthedRequest = Request & { actor: Actor };
class AuthGuard implements CanActivate {
  constructor(@Inject(Services) private s: Services) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.actor = await this.s.auth.authenticate(
      (req.headers.authorization || '').replace(/^Bearer /, ''),
    );
    return true;
  }
}
@Catch()
class Errors implements ExceptionFilter {
  catch(error: any, host: any) {
    const res: Response = host.switchToHttp().getResponse();
    let status = 500,
      message = 'Внутренняя ошибка сервера';
    if (error instanceof DomainError) {
      status = error.status;
      message = error.message;
    } else if (error instanceof ZodError) {
      status = 400;
      message = error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(';')
        .slice(0, 1500);
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      message = status === 413 ? 'Файл превышает лимит 10 МБ' : error.message;
    } else if (error.code === '23505') {
      status = 409;
      message =
        'Запись с таким ИНН уже существует. Обратитесь к руководителю или выберите существующую компанию';
    } else if (error.code === '23503') {
      status = 400;
      message = 'Связанная запись не найдена';
    }
    if (status >= 500)
      console.error(
        JSON.stringify({ event: 'request.failed', status, errorType: error.constructor?.name }),
      );
    res.status(status).json({ message });
  }
}
@Controller('api')
class PublicController {
  constructor(@Inject(Services) private s: Services) {}
  @Get('downloads/csv/:token') async csvDownload(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Origin': 'https://web.telegram.org',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    const file = await this.s.exports.read(token);
    res.type('text/csv').attachment(file.filename).send(file.content);
  }
  @Get('health') async health() {
    await this.s.db.query('SELECT 1');
    return { status: 'ok' };
  }
  @Get('config') config() {
    return {
      devAuth: this.s.config.devAuth && !this.s.config.production,
      timezone: this.s.config.timezone,
    };
  }
  @Post('auth/telegram') login(@Body() body: unknown) {
    const input = z.object({ initData: z.string().max(16000) }).parse(body);
    return this.s.auth.telegram(input.initData);
  }
  @Post('auth/dev') dev(@Body() body: unknown, @Req() req: Request) {
    const input = z.object({ role: z.enum(roles) }).parse(body);
    return this.s.auth.dev(input.role, req.socket.remoteAddress || '');
  }
  @Post('telegram/webhook') webhook(@Req() req: Request, @Body() body: unknown) {
    this.s.bot.verify(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
    return this.s.bot.handle(body);
  }
}
@Controller('api')
@UseGuards(AuthGuard)
class CrmController {
  constructor(@Inject(Services) private s: Services) {}
  @Post('dashboard/export-link') exportLink(@Req() r: AuthedRequest, @Body() body: unknown) {
    const input = z.object({ from: z.string(), to: z.string() }).strict().parse(body);
    return this.s.exports.issue(r.actor, input.from, input.to);
  }
  @Post('dashboard/export-bot') exportBot(@Req() r: AuthedRequest, @Body() body: unknown) {
    const input = z.object({ from: z.string(), to: z.string() }).strict().parse(body);
    return this.s.exports.sendToBot(r.actor, input.from, input.to);
  }
  @Get('me') me(@Req() r: AuthedRequest) {
    return r.actor;
  }
  @Get('users') users(@Req() r: AuthedRequest) {
    return this.s.auth.users(r.actor);
  }
  @Post('users') user(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.s.auth.saveUser(r.actor, b);
  }
  @Get('companies') companies(@Req() r: AuthedRequest) {
    return this.s.crm.list(r.actor);
  }
  @Post('companies') create(@Req() r: AuthedRequest, @Body() b: any) {
    return this.s.crm.create(r.actor, b);
  }
  @Get('companies/:id') detail(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.s.crm.detail(r.actor, id);
  }
  @Patch('companies/:id') update(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.s.crm.update(r.actor, id, b);
  }
  @Post('companies/:id/assign') assign(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const input = z.object({ ownerId: idSchema, version: z.number().int().positive() }).parse(b);
    return this.s.crm.assign(r.actor, id, input.ownerId, input.version);
  }
  @Get('records/:kind') records(@Req() r: AuthedRequest, @Param('kind') kind: string) {
    return this.s.crm.records(
      r.actor,
      z.enum(['contact', 'project', 'task', 'activity', 'file']).parse(kind),
    );
  }
  @Post('companies/:id/records/:kind') record(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body() b: unknown,
  ) {
    const input = z
      .object({ data: z.unknown(), projectId: idSchema.nullable().optional() })
      .strict()
      .parse(b);
    return this.s.crm.createRecord(
      r.actor,
      id,
      z.enum(['contact', 'project', 'task', 'activity']).parse(kind),
      input.data,
      input.projectId || null,
    );
  }
  @Patch('records/:id') updateRecord(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.s.crm.updateRecord(r.actor, id, b);
  }
  @Get('reports') reports(@Req() r: AuthedRequest) {
    return this.s.reports.list(r.actor);
  }
  @Get('reports/:id') async report(@Req() r: AuthedRequest, @Param('id') id: string) {
    const report = await this.s.reports.get(r.actor, id);
    return {
      ...mapReport(report),
      candidates: report.draft ? await this.s.reports.candidates(r.actor, report.draft) : [],
    };
  }
  @Post('reports') enqueue(@Req() r: AuthedRequest, @Body() b: unknown) {
    const input = z
      .object({ text: z.string().trim().min(1).max(20_000), requestId: idSchema })
      .strict()
      .parse(b);
    return this.s.reports.enqueue(r.actor, {
      text: input.text,
      sourceKey: `web:${r.actor.id}:${input.requestId}`,
    });
  }
  @Patch('reports/:id') edit(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) {
    const input = z
      .object({ version: z.number().int().positive(), draft: extractionSchema })
      .parse(b);
    return this.s.reports.edit(r.actor, id, input.version, input.draft);
  }
  @Post('reports/:id/confirm') confirm(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.s.reports.confirm(r.actor, id, b);
  }
  @Post('reports/:id/:action') transition(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Param('action') action: string,
  ) {
    return this.s.reports.transition(r.actor, id, z.enum(['retry', 'cancel']).parse(action));
  }
  @Get('dashboard') dashboard(
    @Req() r: AuthedRequest,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.s.dashboard.summary(r.actor, from, to);
  }
  @Get('dashboard/export') async csv(
    @Req() r: AuthedRequest,
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() response: Response,
  ) {
    response
      .type('text/csv')
      .attachment('team-report.csv')
      .send(await this.s.dashboard.csv(r.actor, from, to));
  }
  @Post('companies/:id/files')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 } }),
  )
  async upload(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() b: any,
  ) {
    await this.s.crm.company(r.actor, id);
    requireCondition(file, 400, 'Выберите файл');
    const category = z
      .enum(['docs', 'catalog', 'brochure', 'ref', 'model'])
      .parse(b.category || 'docs');
    const projectId = b.projectId ? idSchema.parse(b.projectId) : null;
    const key = randomUUID(),
      folder = join(this.s.config.dataDir, 'files');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, key), file.buffer, { flag: 'wx', mode: 0o600 });
    try {
      return await this.s.crm.createRecord(
        r.actor,
        id,
        'file',
        {
          name: basename(Buffer.from(file.originalname, 'latin1').toString('utf8')).slice(0, 200),
          category,
          size: file.size,
          key,
        },
        projectId,
      );
    } catch (e) {
      await unlink(join(folder, key));
      throw e;
    }
  }
  @Get('files/:id') async file(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const [row] = await this.s.db.query(
      `SELECT * FROM records WHERE id=$1 AND kind='file' AND NOT deleted`,
      [idSchema.parse(id)],
    );
    requireCondition(row, 404, 'Файл не найден');
    await this.s.crm.company(r.actor, row.company_id);
    const path = join(this.s.config.dataDir, 'files', idSchema.parse(row.data.key));
    response.setHeader('Cache-Control', 'no-store');
    response.type('application/octet-stream').download(path, row.data.name);
  }
  @Delete('files/:id') deleteFile(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.s.crm.deleteFile(r.actor, id);
  }
}
export async function createApp(config: Config, existingDb?: Database) {
  const db = existingDb || new Database(config);
  if (!existingDb) await db.init();
  const services = new Services(db, config);
  @Module({
    controllers: [PublicController, CrmController],
    providers: [{ provide: Services, useValue: services }, AuthGuard],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'], bodyParser: false });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://telegram.org'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
        },
      },
    }),
  );
  app.use(json({ limit: '256kb' }));
  const buckets = new Map<string, { count: number; until: number }>();
  app.use((req: Request, res: Response, next: () => void) => {
    if (!req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-store');
    const ip = req.socket.remoteAddress || 'unknown';
    const key = ip + (req.path.startsWith('/api/auth') ? ':auth' : ':api');
    const now = Date.now();
    if (buckets.size > 10000) for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
    const bucket = buckets.get(key);
    if (!bucket || bucket.until < now) buckets.set(key, { count: 1, until: now + 60000 });
    else if (++bucket.count > (key.endsWith(':auth') ? 30 : 600)) {
      res.status(429).json({ message: 'Слишком много запросов. Повторите через минуту' });
      return;
    }
    next();
  });
  app.useGlobalFilters(new Errors());
  app.use(serveStatic(resolve('dist/web'), { index: 'index.html' }));
  await app.init();
  return { app, services, db };
}
