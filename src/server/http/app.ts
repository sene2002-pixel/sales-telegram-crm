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
import { ErrorLog } from '../infra/error-log';
import { DiagnosticLog } from '../infra/diagnostic-log';
import { FileDownloads } from '../services/file-downloads';
import { LetterBot } from '../services/letter-bot';
import { VoiceSignatures } from '../services/voice-signatures';
import { VoiceContacts } from '../services/voice-contacts';
import { AuthService } from '../services/auth';
import { CrmService } from '../services/crm';
import { ReportService, mapReport } from '../services/reports';
import { ReportWorker } from '../services/worker';
import { BotService } from '../services/bot';
import { DialogueService } from '../services/dialogue';
import { DashboardService } from '../services/dashboard';
import { ExportService } from '../services/exports';
import { LetterService } from '../services/letters';
import { TelegramAdapter } from '../infra/telegram';
import { OpenAiAdapter } from '../infra/ai';
import { DomainError, requireCondition } from '../domain/errors';
import { Actor, idSchema, roles, extractionSchema, RecordKind } from '../../shared/contracts';

export class Services {
  diagnostics: DiagnosticLog;
  voiceSignatures: VoiceSignatures;
  voiceContacts: VoiceContacts;
  letterBot: LetterBot;
  fileDownloads: FileDownloads;
  errors: ErrorLog;
  auth: AuthService;
  crm: CrmService;
  reports: ReportService;
  worker: ReportWorker;
  bot: BotService;
  dashboard: DashboardService;
  exports: ExportService;
  letters: LetterService;
  dialogue: DialogueService;
  constructor(
    public db: Database,
    public config: Config,
  ) {
    this.errors = new ErrorLog(db);
    this.diagnostics = new DiagnosticLog(db, config);
    this.auth = new AuthService(db, config);
    this.crm = new CrmService(db);
    this.fileDownloads = new FileDownloads(this.crm, config);
    const ai = new OpenAiAdapter(config, this.diagnostics);
    this.letters = new LetterService(this.crm, config, ai, this.diagnostics);
    this.reports = new ReportService(db, this.crm, this.diagnostics);
    const telegram = new TelegramAdapter(config, this.errors);
    this.voiceSignatures = new VoiceSignatures(db, this.letters, this.reports, config);
    this.voiceContacts = new VoiceContacts(db, this.crm, this.letters, this.reports, config);
    this.letterBot = new LetterBot(
      this.crm,
      this.letters,
      this.reports,
      telegram,
      config,
      this.diagnostics,
    );
    this.dialogue = new DialogueService(
      this.crm,
      this.reports,
      this.letters,
      this.letterBot,
      config,
      this.diagnostics,
    );
    this.worker = new ReportWorker(
      db,
      this.reports,
      ai,
      ai,
      telegram,
      config,
      this.voiceSignatures,
      this.letterBot,
      this.diagnostics,
      this.voiceContacts,
      this.dialogue,
    );
    this.bot = new BotService(
      config,
      this.auth,
      this.reports,
      this.crm,
      telegram,
      this.letterBot,
      this.voiceSignatures,
      this.diagnostics,
      this.voiceContacts,
      this.dialogue,
    );
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
    if (this.s.diagnostics.context) this.s.diagnostics.context.actorId = req.actor.id;
    return true;
  }
}
@Catch()
class Errors implements ExceptionFilter {
  constructor(
    private logs: ErrorLog,
    private diagnostics: DiagnosticLog,
  ) {}
  async catch(error: any, host: any) {
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
    const req = host.switchToHttp().getRequest();
    await this.logs.record(error, {
      event: 'request.failed',
      status,
      requestId: res.locals.requestId,
      actorId: req.actor?.id,
      // Route template only: actual URLs may contain download tokens or user data.
      route: typeof req.route?.path === 'string' ? `${req.method} ${req.route.path}` : undefined,
    });
    await this.diagnostics.record('http.failed', {
      status,
      errorType: error instanceof Error ? error.constructor.name : 'Unknown',
      route: typeof req.route?.path === 'string' ? `${req.method} ${req.route.path}` : undefined,
    });
    res.status(status).json({ message });
  }
}
@Controller('api')
class PublicController {
  constructor(@Inject(Services) private s: Services) {}
  @Get('downloads/files/:token') async fileDownload(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Origin': 'https://web.telegram.org',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    const file = await this.s.fileDownloads.read(token);
    await new Promise<void>((resolve, reject) => {
      res
        .type(file.mime)
        .download(file.path, file.filename, (error) => (error ? reject(error) : resolve()));
    });
  }
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
  @Get('me/signature-drafts') signatureDrafts(@Req() r: AuthedRequest) {
    return this.s.voiceSignatures.list(r.actor);
  }
  @Post('me/signature-drafts/:id/save') saveSignatureDraft(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.s.voiceSignatures.save(r.actor, id, body);
  }
  @Delete('me/signature-drafts/:id') discardSignatureDraft(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
  ) {
    return this.s.voiceSignatures.discard(r.actor, id);
  }
  @Post('files/:id/download-link') downloadLink(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.s.fileDownloads.issue(r.actor, id);
  }
  @Get('me/letter-signatures') signatures(@Req() r: AuthedRequest) {
    return this.s.letters.signatures(r.actor);
  }
  @Post('me/letter-signatures/:id/default') defaultSignature(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
  ) {
    return this.s.letters.setDefault(r.actor, id);
  }
  @Post('me/letter-signatures') createSignature(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.s.letters.writeSignature(r.actor, b);
  }
  @Patch('me/letter-signatures/:id') updateSignature(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.s.letters.writeSignature(r.actor, b, id);
  }
  @Delete('me/letter-signatures/:id') deleteSignature(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
  ) {
    return this.s.letters.deleteSignature(r.actor, id);
  }
  @Get('me/letter-signature') signature(@Req() r: AuthedRequest) {
    return this.s.letters.signature(r.actor).then((signature) => ({ signature }));
  }
  @Post('me/letter-signature') saveSignature(@Req() r: AuthedRequest, @Body() b: unknown) {
    return this.s.letters.saveSignature(r.actor, b);
  }
  @Post('me/letter-signature/recognize')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 } }),
  )
  recognize(@UploadedFile() file: Express.Multer.File) {
    return this.s.letters.recognize(file);
  }
  @Post('companies/:id/letters') letter(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.s.letters.create(r.actor, id, b);
  }
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
  @Post('companies/:id/archive') archive(
    @Req() r: AuthedRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const input = z
      .object({ archived: z.boolean(), version: z.number().int().positive() })
      .strict()
      .parse(b);
    return this.s.crm.setArchived(r.actor, id, input.archived, input.version);
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
  @Delete('contacts/:id') deleteContact(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.s.crm.deleteContact(r.actor, id);
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
  app.use((req: Request, res: Response, next: () => void) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-ID', res.locals.requestId);
    if (!req.path.startsWith('/api') || !services.diagnostics.enabled) return next();
    const traceId = `http:${res.locals.requestId}`,
      started = Date.now();
    res.once('finish', () => {
      void services.diagnostics.run({ traceId, actorId: (req as AuthedRequest).actor?.id }, () =>
        services.diagnostics.record('http.completed', {
          method: req.method,
          route: typeof req.route?.path === 'string' ? req.route.path : undefined,
          status: res.statusCode,
          durationMs: Date.now() - started,
        }),
      );
    });
    void services.diagnostics.run({ traceId }, async () => {
      await services.diagnostics.record('http.started', { method: req.method });
      next();
    });
  });
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
      void services.errors.record(new DomainError(429, 'Превышен лимит запросов'), {
        event: 'request.rate_limited',
        status: 429,
        requestId: res.locals.requestId,
      });
      res.status(429).json({ message: 'Слишком много запросов. Повторите через минуту' });
      return;
    }
    next();
  });
  app.useGlobalFilters(new Errors(services.errors, services.diagnostics));
  app.use(serveStatic(resolve('dist/web'), { index: 'index.html' }));
  await app.init();
  return { app, services, db };
}
