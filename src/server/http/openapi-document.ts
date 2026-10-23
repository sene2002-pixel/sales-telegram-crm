import { z } from 'zod';
import {
  companySchema,
  contactSchema,
  projectSchema,
  taskSchema,
  activitySchema,
  fileSchema,
  extractionSchema,
  confirmSchema,
  analyticsSettingsInputSchema,
  idSchema,
  roles,
  stages,
  dateSchema,
} from '../../shared/contracts';
import { signatureSchema, cardSchema } from '../../shared/letters';

// Input schemas are derived from the same validators used by the HTTP services.
// Descriptions also document refinements (calendar dates, INN checksum, ACL) which JSON Schema cannot enforce.
type Schema = Record<string, any>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const jsonSchema = (schema: z.ZodType): Schema => {
  const { $schema: _, ...result } = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
  });
  return result;
};
const string: Schema = { type: 'string' },
  boolean: Schema = { type: 'boolean' },
  number: Schema = { type: 'number' };
const uuid = { type: 'string', format: 'uuid' },
  date = { type: 'string', format: 'date' },
  timestamp = { type: 'string', format: 'date-time' };
const integer = { type: 'integer' },
  positiveInteger = { type: 'integer', minimum: 1 };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (schema: Schema): Schema => ({ type: 'array', items: schema });
const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
  additionalProperties = false,
): Schema => ({ type: 'object', properties, required, additionalProperties });
const recordKinds = ['contact', 'project', 'task', 'activity', 'file'];
const namedInput = {
  CompanyInput: companySchema,
  ContactInput: contactSchema,
  ProjectInput: projectSchema,
  TaskInput: taskSchema,
  ActivityInput: activitySchema,
  FileData: fileSchema.omit({ key: true }).strict(),
  Extraction: extractionSchema,
  ReportConfirmation: confirmSchema,
  SignatureInput: signatureSchema,
  RecognizedCard: cardSchema,
  AnalyticsSettingsInput: analyticsSettingsInputSchema,
};
const companyMetadata = {
  id: uuid,
  ownerId: uuid,
  ownerName: string,
  version: positiveInteger,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const schemas: Record<string, Schema> = Object.fromEntries(
  Object.entries(namedInput).map(([key, value]) => [key, jsonSchema(value)]),
);
schemas.Error = object({ message: string });
schemas.Ok = object({ ok: { const: true } });
schemas.Actor = object(
  {
    id: uuid,
    telegramId: string,
    name: string,
    role: { type: 'string', enum: [...roles] },
    active: boolean,
    supervisorId: nullable(uuid),
  },
  ['id', 'telegramId', 'name', 'role', 'active'],
);
schemas.Session = object({
  token: {
    type: 'string',
    description:
      'Подписанная сервером сессия на 8 часов; не JWT. Только текущий активный сотрудник.',
  },
  user: ref('Actor'),
});
const companyOutput = jsonSchema(companySchema);
schemas.Company = object({ ...companyOutput.properties, ...companyMetadata }, [
  ...(companyOutput.required || []),
  ...Object.keys(companyMetadata),
]);
schemas.SavedSignature = object(
  { ...schemas.SignatureInput!.properties, id: uuid, isDefault: boolean },
  [...schemas.SignatureInput!.required, 'id'],
);
schemas.TaskData = object(
  { ...schemas.TaskInput!.properties, completedAt: { ...nullable(timestamp), readOnly: true } },
  [...schemas.TaskInput!.required],
);
schemas.ActivityData = object({ ...schemas.ActivityInput!.properties, reportId: uuid }, [
  ...schemas.ActivityInput!.required,
]);
schemas.Record = object(
  {
    id: uuid,
    kind: { type: 'string', enum: recordKinds },
    companyId: uuid,
    projectId: nullable(uuid),
    authorId: uuid,
    authorName: string,
    assigneeId: nullable(uuid),
    version: positiveInteger,
    createdAt: timestamp,
    data: {
      anyOf: ['ContactInput', 'ProjectInput', 'TaskData', 'ActivityData', 'FileData'].map(ref),
    },
    contactSource: {
      type: 'string',
      enum: ['user', 'bot', 'unknown'],
      readOnly: true,
      description:
        'Только у контактов. Серверный источник, не принимается в data; редактирование его не изменяет.',
    },
  },
  [
    'id',
    'kind',
    'companyId',
    'projectId',
    'authorId',
    'authorName',
    'assigneeId',
    'version',
    'createdAt',
    'data',
  ],
);
schemas.AuditEvent = object({
  id: uuid,
  actor_id: nullable(uuid),
  company_id: nullable(uuid),
  action: string,
  entity_id: string,
  details: { type: 'object', additionalProperties: true },
  created_at: timestamp,
  actor_name: nullable(string),
});
schemas.CompanyDetail = object({
  clientScore: nullable(ref('ClientScore')),
  company: ref('Company'),
  records: array(ref('Record')),
  audit: array(ref('AuditEvent')),
});
schemas.SignatureDraft = object({ id: uuid, data: ref('RecognizedCard'), transcript: string });
schemas.Report = object({
  id: uuid,
  authorId: uuid,
  authorName: string,
  status: {
    type: 'string',
    enum: ['queued', 'processing', 'review', 'saved', 'cancelled', 'failed'],
  },
  version: positiveInteger,
  createdAt: timestamp,
  transcript: nullable(string),
  draft: nullable(ref('Extraction')),
  error: nullable(string),
  attempts: integer,
});
schemas.ReportDetail = object(
  { ...schemas.Report!.properties, candidates: array(array(uuid)), feedback: string },
  [...schemas.Report!.required, 'candidates', 'feedback'],
);
schemas.ReportSaved = object({
  id: uuid,
  status: { const: 'saved' },
  result: array(object({ companyId: uuid, activityId: uuid })),
});
schemas.EmployeeOption = object({
  id: uuid,
  name: string,
  role: { type: 'string', enum: [...roles] },
});
schemas.AnalyticsSettings = object(
  { ...schemas.AnalyticsSettingsInput!.properties, updatedAt: nullable(timestamp) },
  [...schemas.AnalyticsSettingsInput!.required, 'updatedAt'],
);
schemas.MetricComparison = object({
  kind: { type: 'string', enum: ['none', 'percent', 'new', 'unavailable'] },
  percent: nullable(number),
  tone: { type: 'string', enum: ['neutral', 'positive', 'negative'] },
});
const metric = (properties: Record<string, Schema>) =>
  object({ ...properties, delta: ref('MetricComparison') });
const levelKeys = ['new', 'acquaintance', 'development', 'partner', 'ours'];
schemas.ClientScore = object({
  id: uuid,
  score: { type: 'integer', minimum: 0, maximum: 8 },
  level: { type: 'string', enum: levelKeys },
  base: object({
    task: boolean,
    contacts: boolean,
    potential: boolean,
    meeting: boolean,
    project: boolean,
  }),
  regularity: object({ task: boolean, meeting: boolean, project: boolean }),
});
schemas.ClientAnalytics = object({
  ruleVersion: { const: 1 },
  asOf: date,
  settings: ref('AnalyticsSettings'),
  clientFunnel: array(
    object({ key: { type: 'string', enum: levelKeys }, label: string, count: integer }),
  ),
  clients: array(ref('ClientScore')),
  metrics: object({
    potential: metric({ value: nullable(number), companies: integer }),
    projects: metric({ value: nullable(number), count: integer }),
    growth: metric({ value: nullable(integer), share: nullable(number) }),
    active: metric({ value: nullable(integer), total: integer }),
  }),
  historyIncomplete: integer,
  contactSourcesUnknown: integer,
});
schemas.AnalyticsSummary = object({
  from: date,
  to: date,
  previousFrom: date,
  previousTo: date,
  funnel: array(
    object({ key: { type: 'string', enum: [...stages] }, label: string, count: integer }),
  ),
  conversion: nullable(number),
  conversionDelta: nullable(number),
  activeClients: integer,
  activeDelta: nullable(number),
  historyIncomplete: integer,
  clientAnalytics: ref('ClientAnalytics'),
});
schemas.DashboardRow = object({
  id: uuid,
  name: string,
  role: { type: 'string', enum: [...roles] },
  active: boolean,
  companies: integer,
  openTasks: integer,
  overdue: integer,
  completed: integer,
  interactions: integer,
  inactiveCompanies: array(object({ id: uuid, name: string })),
});
const volumes = object({ confirmed: number, in_work: number, potential: number });
const approximate = object({ confirmed: boolean, in_work: boolean, potential: boolean });
schemas.CommercialReport = object({
  from: date,
  to: date,
  totals: volumes,
  approximate,
  resultTotals: volumes,
  resultApproximate: approximate,
  clients: array(object({ company: string, text: string })),
  text: string,
});
schemas.TaskAdvice = object({
  text: string,
  source: { type: 'string', enum: ['confirmed_sales', 'confirmed_agreement', 'guidance'] },
  asOf: nullable(date),
});
schemas.LetterResult = object(
  {
    record: ref('Record'),
    sources: array({ type: 'string', format: 'uri' }),
    referenceWarning: string,
  },
  ['record', 'sources'],
);
schemas.FileLink = object({
  path: {
    type: 'string',
    description:
      'Относительная ссылка с одноразовым по сроку секретным opaque token; 5 минут, не публиковать.',
  },
  filename: string,
});
schemas.CsvLink = object({
  url: { type: 'string', format: 'uri' },
  filename: string,
  expiresAt: timestamp,
});
const sender = object(
  { id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, first_name: string },
  ['id'],
  true,
);
schemas.TelegramUpdate = object(
  {
    update_id: integer,
    message: object(
      {
        message_id: integer,
        date: integer,
        from: sender,
        chat: object({
          id: {
            type: 'integer',
            minimum: -Number.MAX_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          type: string,
        }),
        text: { type: 'string', maxLength: 20000 },
        caption: { type: 'string', maxLength: 20000 },
        photo: array(
          object(
            { file_id: string, width: number, height: number, file_size: number },
            ['file_id', 'width', 'height'],
            true,
          ),
        ),
        document: object(
          {
            file_id: string,
            file_name: { type: 'string', maxLength: 255 },
            mime_type: string,
            file_size: number,
          },
          ['file_id'],
          true,
        ),
        voice: object(
          { file_id: string, duration: number, file_size: number },
          ['file_id', 'duration'],
          true,
        ),
      },
      ['message_id', 'date', 'from', 'chat'],
      true,
    ),
    callback_query: object(
      {
        id: string,
        from: sender,
        data: string,
        message: object({
          chat: object({
            id: {
              type: 'integer',
              minimum: -Number.MAX_SAFE_INTEGER,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            type: string,
          }),
        }),
      },
      ['id', 'from'],
      true,
    ),
  },
  ['update_id'],
  true,
);

const paths: Record<string, any> = {};
const operationIds = new Set<string>();
const allRoles = [...roles];
const errorDescriptions: Record<number, string> = {
  400: 'Невалидные данные или недопустимая операция',
  401: 'Отсутствует/истекла/неверна сессия или webhook-secret',
  403: 'Доступ не выдан/отозван либо роль/фильтр недоступны',
  404: 'Объект недоступен или ссылка истекла (не раскрывает чужую запись)',
  409: 'Конфликт версии, состояния или лимита записей',
  413: 'Превышен предел тела/файла',
  422: 'Не удалось достоверно подготовить содержимое',
  429: 'Превышен лимит запросов; повторить после Retry-After',
  500: 'Ошибка сервера; диагностические подробности скрыты',
  502: 'Внешний сервис не смог завершить запрос',
  503: 'Необходимый сервис не настроен/недоступен',
};
const response = (schema: Schema, description = 'Успешный ответ', media = 'application/json') => ({
  description,
  content: { [media]: { schema } },
});
const jsonBody = (schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
});
const query = (name: string, schema: Schema, description: string, required = false) => ({
  name,
  in: 'query',
  required,
  description,
  schema,
});
const employeeQuery = query(
  'employeeId',
  uuid,
  'Не расширяет ACL: менеджер — только себя; руководитель — себя и активных прямых менеджеров; администратор — любого активного сотрудника. Отсутствие/пустая строка сохраняет прежний общий доступ.',
);
const periodQueries = [
  query('from', date, 'Начало периода включительно, YYYY-MM-DD; реальная календарная дата.', true),
  query('to', date, 'Конец периода включительно; from <= to.', true),
];
function add(
  method: string,
  path: string,
  id: string,
  summary: string,
  tag: string,
  result: Schema,
  options: {
    body?: any;
    description?: string;
    queries?: any[];
    roles?: string[];
    public?: boolean;
    security?: any[];
    errors?: number[];
    media?: string;
    deprecated?: boolean;
    parameters?: Record<string, Schema>;
  } = {},
) {
  if (operationIds.has(id)) throw new Error('Duplicate OpenAPI operation ID');
  operationIds.add(id);
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema:
      options.parameters?.[match[1]!] ||
      (match[1] === 'token' ? { type: 'string', pattern: '^[a-f0-9]{64}$' } : uuid),
    description:
      match[1] === 'token'
        ? 'Opaque token из выданной краткоживущей ссылки; не bearer-сессия.'
        : 'Идентификатор существующей доступной записи.',
  }));
  const statuses = options.errors || [400, 401, 403, 404, 409, 429, 500];
  const responses: Record<string, any> = {
    [method === 'post' ? '201' : '200']: response(result, 'Успешный ответ', options.media),
  };
  for (const status of statuses)
    responses[String(status)] = {
      ...response(ref('Error'), errorDescriptions[status]),
      ...(status === 429
        ? {
            headers: {
              'Retry-After': { description: 'Задержка в секундах перед повтором', schema: integer },
            },
          }
        : {}),
    };
  paths[path] ||= {};
  paths[path][method] = {
    operationId: id,
    summary,
    tags: [tag],
    description:
      options.description ||
      'Сервер проверяет актуальный доступ и допустимость операции; UI не является контролем прав.',
    security: options.security ?? (options.public ? [] : [{ SessionBearer: [] }]),
    'x-roles': options.roles ?? (options.public ? [] : allRoles),
    parameters: [...parameters, ...(options.queries || [])],
    responses,
    ...(options.body ? { requestBody: options.body } : {}),
    ...(options.deprecated ? { deprecated: true } : {}),
  };
}
const versionBody = jsonBody(
  jsonSchema(z.object({ version: z.number().int().positive() }).strict()),
);
const binary = { type: 'string', format: 'binary' };
add(
  'get',
  '/downloads/files/{token}',
  'downloadFileToken',
  'Скачать файл по краткоживущей ссылке',
  'Скачивания',
  binary,
  {
    public: true,
    media: 'application/octet-stream',
    errors: [404, 429, 500],
    description:
      'Ссылка действует 5 минут; при чтении повторно проверяется активность автора и текущий доступ к компании. PDF выдаётся application/pdf, остальные файлы application/octet-stream. Ответ attachment, no-store и no-referrer.',
  },
);
add(
  'get',
  '/downloads/csv/{token}',
  'downloadCsvToken',
  'Скачать снимок CSV по ссылке',
  'Скачивания',
  binary,
  {
    public: true,
    media: 'text/csv',
    errors: [404, 429, 500],
    description:
      'Снимок CSV с UTF-8 BOM. Срок 5 минут, повторная проверка активного руководителя/администратора. Не изменяет CRM.',
  },
);
add(
  'get',
  '/health',
  'health',
  'Проверить доступность БД',
  'Публичное API',
  object({ status: { const: 'ok' } }),
  { public: true, errors: [429, 500] },
);
add(
  'get',
  '/config',
  'publicConfig',
  'Получить безопасную конфигурацию интерфейса',
  'Публичное API',
  object({ devAuth: boolean, timezone: string }),
  {
    public: true,
    errors: [429, 500],
    description:
      'Только возможность локального демонстрационного входа и часовой пояс. Секреты/адрес БД не выдаются.',
  },
);
add(
  'post',
  '/auth/telegram',
  'loginTelegram',
  'Войти через подписанный Telegram initData',
  'Авторизация',
  ref('Session'),
  {
    public: true,
    body: jsonBody(jsonSchema(z.object({ initData: z.string().max(16000) }))),
    errors: [400, 401, 403, 429, 500],
    description:
      'Проверяются подпись, возраст и размер initData, затем активность допущенного сотрудника. Не принимает произвольный userId/роль. Не пересылайте initData в примеры или журналы.',
  },
);
add(
  'post',
  '/auth/dev',
  'loginDevelopment',
  'Локальный демонстрационный вход',
  'Авторизация',
  ref('Session'),
  {
    public: true,
    body: jsonBody(jsonSchema(z.object({ role: z.enum(roles) }))),
    errors: [400, 403, 429, 500],
    description:
      'Только DEV_AUTH=true вне production и прямой loopback peer. В production всегда запрещён.',
  },
);
add(
  'post',
  '/telegram/webhook',
  'telegramWebhook',
  'Принять Telegram update',
  'Telegram',
  ref('Ok'),
  {
    public: true,
    security: [{ TelegramWebhookSecret: [] }],
    body: jsonBody(ref('TelegramUpdate')),
    errors: [400, 401, 413, 429, 500, 502, 503],
    description:
      'Обязательный X-Telegram-Bot-Api-Secret-Token. Рабочие операции только в private чате, с допущенным активным отправителем; повторная доставка обрабатывается идемпотентно. Callback повторно проверяет владельца, состояние и версию. Прототип платежей не является частью API.',
  },
);
add('get', '/me', 'currentActor', 'Получить актуального сотрудника', 'Сотрудники', ref('Actor'), {
  errors: [401, 403, 429, 500],
});
add(
  'get',
  '/users',
  'listUsers',
  'Получить доступные метаданные сотрудников',
  'Сотрудники',
  array(ref('Actor')),
  {
    description:
      'Менеджер получает только себя; руководитель/администратор — список сотрудников. Чтение не даёт права менять роли.',
  },
);
const userInput = jsonSchema(
  z
    .object({
      telegramId: z.string().regex(/^[1-9]\d{0,15}$/),
      name: z.string().trim().min(1).max(200),
      role: z.enum(roles),
      active: z.boolean(),
      supervisorId: idSchema.nullable().optional(),
    })
    .strict(),
);
add(
  'post',
  '/users',
  'saveUser',
  'Создать или обновить доступ сотрудника по Telegram ID',
  'Сотрудники',
  ref('Actor'),
  {
    roles: ['admin'],
    body: jsonBody(userInput),
    description:
      'Администратор; upsert по telegramId. Защита последнего активного администратора, проверка активного руководителя для manager. Не отдаёт доступ произвольным данным другим ролям.',
  },
);
add(
  'post',
  '/users/admit',
  'admitUser',
  'Допустить сотрудника по Telegram ID',
  'Сотрудники',
  ref('Actor'),
  {
    roles: ['admin'],
    body: jsonBody(
      jsonSchema(z.object({ telegramId: z.string().regex(/^[1-9]\d{0,15}$/) }).strict()),
    ),
    description:
      'Создаёт активного manager, имя-плейсхолдер до доверенного Telegram-профиля. Повторный ID — 409, существующие права не перезаписываются. ID должен помещаться в safe integer.',
  },
);
add(
  'get',
  '/employee-filter/options',
  'employeeOptions',
  'Получить разрешённые варианты фильтра сотрудника',
  'Сотрудники',
  array(ref('EmployeeOption')),
  { errors: [401, 403, 429, 500], description: employeeQuery.description },
);
add(
  'get',
  '/companies',
  'listCompanies',
  'Список компаний в исходном ACL',
  'Компании',
  array(ref('Company')),
  {
    queries: [employeeQuery],
    description:
      'Менеджер — свои компании; руководитель/администратор — глобальная исходная видимость. employeeId сужает по владельцу, не расширяет доступ.',
  },
);
add(
  'post',
  '/companies',
  'createCompany',
  'Создать компанию с владельцем текущей сессии',
  'Компании',
  ref('Company'),
  {
    body: jsonBody(ref('CompanyInput')),
    description:
      'В HTTP нет ownerId. Реквизиты и ИНН проверяются сервером (включая контрольную сумму). Начальный архив разрешён только администратору.',
  },
);
add(
  'get',
  '/companies/{id}',
  'companyDetail',
  'Карточка компании, записи и последние 100 событий',
  'Компании',
  ref('CompanyDetail'),
  {
    description:
      'Сохраняет исходный ACL. Чужая недоступная компания — 404. Служебный глобальный порядок аудита и файловые storage keys не сериализуются.',
  },
);
add(
  'patch',
  '/companies/{id}',
  'updateCompany',
  'Изменить полную карточку по версии',
  'Компании',
  ref('Company'),
  {
    body: jsonBody(
      jsonSchema(z.object({ version: z.number().int().positive(), data: companySchema }).strict()),
    ),
    description:
      'Полные data с дефолтами валидатора; stale version — 409. Изменение archived дополнительно проверяет архивные полномочия.',
  },
);
add(
  'post',
  '/companies/{id}/assign',
  'assignCompany',
  'Переназначить владельца компании',
  'Компании',
  ref('Company'),
  {
    roles: ['supervisor', 'admin'],
    body: jsonBody(
      jsonSchema(z.object({ ownerId: idSchema, version: z.number().int().positive() })),
    ),
    description:
      'Только руководитель/администратор; руководитель ограничен своей компанией/прямой командой с обеих сторон переназначения. Новый владелец активен, версия актуальна. Открытые задачи переводятся новому владельцу, завершённые сохраняют исполнителя.',
  },
);
add(
  'post',
  '/companies/{id}/archive',
  'archiveCompany',
  'Архивировать или восстановить компанию',
  'Компании',
  ref('Company'),
  {
    roles: ['supervisor', 'admin'],
    body: jsonBody(
      jsonSchema(
        z.object({ archived: z.boolean(), version: z.number().int().positive() }).strict(),
      ),
    ),
    description:
      'Архив: администратор либо руководитель собственной/командной компании; восстановление — только администратор. Версионная операция, записи не уничтожаются.',
  },
);
add(
  'get',
  '/records/{kind}',
  'listRecords',
  'Список доступных записей типа',
  'Записи',
  array(ref('Record')),
  {
    parameters: { kind: { type: 'string', enum: recordKinds } },
    queries: [employeeQuery],
    description:
      'Контакты/проекты/файлы/активности фильтруются по владельцу компании; задачи — по assigneeId, в том числе завершённые. Исходный ACL остаётся по компании. Мягко удалённые записи исключены.',
  },
);
add(
  'post',
  '/companies/{id}/records/{kind}',
  'createRecord',
  'Создать контакт, проект, задачу или активность',
  'Записи',
  ref('Record'),
  {
    parameters: { kind: { type: 'string', enum: recordKinds.filter((kind) => kind !== 'file') } },
    body: jsonBody(
      object(
        {
          data: { anyOf: ['ContactInput', 'ProjectInput', 'TaskInput', 'ActivityInput'].map(ref) },
          projectId: nullable(uuid),
        },
        ['data'],
      ),
    ),
    description:
      'Схема data выбирается по kind, anyOf описывает допустимые варианты, а не право заменить kind. projectId и все ссылки контактов/участников проверяются по компании/ACL. Файлы — только multipart upload. contactSource задаёт сервер и не принимается от клиента.',
  },
);
add(
  'patch',
  '/records/{id}',
  'updateRecord',
  'Изменить контакт, проект или задачу по версии',
  'Записи',
  ref('Record'),
  {
    body: jsonBody(
      object({
        version: positiveInteger,
        data: { anyOf: ['ContactInput', 'ProjectInput', 'TaskInput'].map(ref) },
      }),
    ),
    description:
      'Только contact/project/task; нельзя редактировать activity/file этим маршрутом. Версия и ссылки проверяются, исторические неизменённые связи могут сохраняться. Источник контакта не изменяется; completedAt задачи устанавливает сервер.',
  },
);
add('delete', '/tasks/{id}', 'deleteTask', 'Мягко удалить задачу по версии', 'Задачи', ref('Ok'), {
  body: versionBody,
});
add(
  'get',
  '/tasks/{id}/advice',
  'taskAdvice',
  'Получить совет из подтверждённых данных',
  'Задачи',
  ref('TaskAdvice'),
  {
    description:
      'Подтверждённые project-sales/договорённость либо явная общая guidance; без внешнего AI и без сохранения предложенного действия.',
  },
);
add('delete', '/contacts/{id}', 'deleteContact', 'Мягко удалить контакт', 'Записи', ref('Ok'));
add('delete', '/files/{id}', 'archiveFile', 'Архивировать файл в CRM', 'Файлы', ref('Ok'), {
  description: 'Мягкое удаление доступной записи; не передаёт право на чужую компанию.',
});
add('get', '/reports', 'listReports', 'Получить доступные отчёты', 'Отчёты', array(ref('Report')), {
  queries: [employeeQuery],
  description:
    'Менеджер видит свои отчёты, руководитель/администратор — глобальные; employeeId сужает по автору.',
});
add(
  'get',
  '/reports/{id}',
  'reportDetail',
  'Отчёт с кандидатами компаний и обратной связью',
  'Отчёты',
  ref('ReportDetail'),
  {
    description:
      'Право автора/руководителя; кандидаты проверяются в ACL компаний. Обратная связь основана на подтверждённых сведениях и не сохраняет изменения.',
  },
);
add(
  'post',
  '/reports',
  'enqueueReport',
  'Поставить текстовый отчёт в очередь',
  'Отчёты',
  ref('Report'),
  {
    body: jsonBody(
      jsonSchema(
        z.object({ text: z.string().trim().min(1).max(20000), requestId: idSchema }).strict(),
      ),
    ),
    description:
      'requestId — клиентский UUID идемпотентности, sourceKey привязан к текущему actorId. Создаёт черновик/очередь, не подтверждает CRM и не гарантирует завершение AI.',
  },
);
add(
  'patch',
  '/reports/{id}',
  'editReport',
  'Изменить черновик отчёта по версии',
  'Отчёты',
  ref('Report'),
  {
    body: jsonBody(
      jsonSchema(z.object({ version: z.number().int().positive(), draft: extractionSchema })),
    ),
    description:
      'Автор/руководитель и допустимое состояние review; схему Extraction валидирует сервер. Автоматического подтверждения нет.',
  },
);
add(
  'post',
  '/reports/{id}/confirm',
  'confirmReport',
  'Подтвердить черновик и применить к CRM',
  'Отчёты',
  ref('ReportSaved'),
  {
    body: jsonBody(ref('ReportConfirmation')),
    description:
      'companyIds по одному на блок: null разрешает поиск/создание, UUID выбирает доступную компанию. Совпадение количества, актуальная версия/state, активный автор и права на компании проверяются в транзакции. Повтор saved возвращает прежний результат без дублей.',
  },
);
add(
  'post',
  '/reports/{id}/{action}',
  'transitionReport',
  'Повторить обработку или отменить отчёт',
  'Отчёты',
  ref('Ok'),
  {
    parameters: { action: { type: 'string', enum: ['retry', 'cancel'] } },
    description:
      'retry только failed, cancel только queued/processing/review/failed; автор/руководитель, подтверждённые отчёты этим маршрутом не отменяются.',
  },
);
add(
  'get',
  '/me/signature-drafts',
  'listSignatureDrafts',
  'Получить свои ожидающие создания подписи',
  'Подписи',
  array(ref('SignatureDraft')),
);
add(
  'post',
  '/me/signature-drafts/{id}/save',
  'saveSignatureDraft',
  'Подтвердить свои данные подписи',
  'Подписи',
  {
    anyOf: [
      ref('SavedSignature'),
      object({ ok: { const: true }, deleted: { const: true }, id: uuid }),
    ],
  },
  {
    body: jsonBody(ref('SignatureInput')),
    description:
      'Владелец черновика, активный сотрудник, актуальное состояние. Повтор saved идемпотентен; не более трёх подписей. Создание не передаёт чужую подпись.',
  },
);
add(
  'delete',
  '/me/signature-drafts/{id}',
  'discardSignatureDraft',
  'Отклонить свой черновик подписи',
  'Подписи',
  ref('Ok'),
);
add(
  'get',
  '/me/letter-signatures',
  'listSignatures',
  'Получить до трёх собственных подписей',
  'Подписи',
  array(ref('SavedSignature')),
);
add(
  'post',
  '/me/letter-signatures',
  'createSignature',
  'Создать собственную подпись',
  'Подписи',
  ref('SavedSignature'),
  { body: jsonBody(ref('SignatureInput')) },
);
add(
  'patch',
  '/me/letter-signatures/{id}',
  'updateSignature',
  'Изменить собственную подпись',
  'Подписи',
  ref('SavedSignature'),
  { body: jsonBody(ref('SignatureInput')) },
);
add(
  'delete',
  '/me/letter-signatures/{id}',
  'deleteSignature',
  'Удалить собственную подпись',
  'Подписи',
  ref('Ok'),
);
add(
  'post',
  '/me/letter-signatures/{id}/default',
  'defaultSignature',
  'Назначить собственную подпись по умолчанию',
  'Подписи',
  array(ref('SavedSignature')),
);
add(
  'get',
  '/me/letter-signature',
  'legacySignature',
  'Получить единственную/основную подпись (совместимость)',
  'Подписи',
  object({ signature: nullable(ref('SignatureInput')) }),
  { deprecated: true },
);
add(
  'post',
  '/me/letter-signature',
  'legacySaveSignature',
  'Сохранить единственную подпись (совместимость)',
  'Подписи',
  ref('SignatureInput'),
  {
    deprecated: true,
    body: jsonBody(ref('SignatureInput')),
    description: '409 при более одной существующей подписи; используйте plural endpoints.',
  },
);
const imageUpload = object({
  file: {
    type: 'string',
    format: 'binary',
    description: 'JPEG или PNG по сигнатуре содержимого; не более 10 МиБ.',
  },
});
add(
  'post',
  '/me/letter-signature/recognize',
  'recognizeSignature',
  'Распознать визитку в редактируемые данные',
  'Подписи',
  ref('RecognizedCard'),
  {
    body: { required: true, content: { 'multipart/form-data': { schema: imageUpload } } },
    errors: [400, 401, 403, 413, 422, 429, 502, 503, 500],
    description:
      'Ровно один file, без дополнительных multipart полей. Возвращает данные без автоматического сохранения; нечитаемые поля пустые. Сервис распознавания требует настройки AI.',
  },
);
add(
  'post',
  '/companies/{id}/letters',
  'createLetter',
  'Создать PDF письма для выбранного контакта',
  'Письма',
  ref('LetterResult'),
  {
    body: jsonBody(
      jsonSchema(
        z
          .object({
            contactId: idSchema,
            signatureId: idSchema.optional(),
            confirmedIndustry: z.string().trim().min(1).max(150).optional(),
            confirmedActivity: z.string().trim().max(150).optional(),
          })
          .strict(),
      ),
    ),
    errors: [400, 401, 403, 404, 409, 422, 429, 502, 503, 500],
    description:
      'Только доступная неархивная компания, контакт именно этой компании, собственная подпись, подтверждённая отрасль. Отраслевые референсы выбирает сервер, PDF сохраняется в CRM. HTTP endpoint не отправляет письмо клиенту. Role-only Главному энергетику — отдельный подтверждённый внутренний Telegram-сценарий, не параметр HTTP body.',
  },
);
add(
  'post',
  '/companies/{id}/files',
  'uploadCompanyFile',
  'Загрузить файл компании',
  'Файлы',
  ref('Record'),
  {
    body: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: object(
            {
              file: {
                type: 'string',
                format: 'binary',
                description: 'Один файл до 10 МиБ; имя нормализуется сервером.',
              },
              category: {
                type: 'string',
                enum: ['docs', 'catalog', 'brochure', 'ref', 'model'],
                default: 'docs',
              },
              projectId: uuid,
            },
            ['file'],
          ),
        },
      },
    },
    errors: [400, 401, 403, 404, 409, 413, 429, 500],
    description:
      'Один file и до двух текстовых полей category/projectId. Доступ и проект проверяются; при ошибке файл убирается, запись не создаётся.',
  },
);
add(
  'post',
  '/files/{id}/download-link',
  'issueFileDownloadLink',
  'Создать краткоживущую ссылку на файл',
  'Файлы',
  ref('FileLink'),
  {
    description:
      'Доступная неудалённая запись и компания. До20 ссылок на сотрудника, срок5минут; скачивание повторно проверяет текущие права. Секретный token хранится вБД только как hash, вответе относительный path, не storagekey.',
  },
);
add(
  'get',
  '/files/{id}',
  'downloadFileSession',
  'Скачать доступный файл по bearer-сессии',
  'Файлы',
  binary,
  {
    media: 'application/octet-stream',
    description:
      'Проверка активного сотрудника, доступной компании и неудалённой записи; ответ attachment и no-store.',
  },
);
add(
  'get',
  '/analytics/settings',
  'getAnalyticsSettings',
  'Получить общие настройки регулярности',
  'Аналитика',
  ref('AnalyticsSettings'),
  {
    errors: [401, 403, 429, 500],
    description: 'Доступно всем текущим активным ролям; общие пороги, не персональные настройки.',
  },
);
add(
  'put',
  '/analytics/settings',
  'putAnalyticsSettings',
  'Изменить настройки аналитики по revision',
  'Аналитика',
  ref('AnalyticsSettings'),
  {
    roles: ['admin'],
    body: jsonBody(ref('AnalyticsSettingsInput')),
    description:
      'Свежая активная роль admin внутри транзакции. revision обязателен, stale — 409. taskDays1–365, meetingMonths/projectMonths1–24; текущие настройки применяются к обеим сторонам исторического сравнения, аудит фиксируется.',
  },
);
add(
  'get',
  '/analytics',
  'getAnalytics',
  'Получить аналитические метрики и восьмибалльную воронку',
  'Аналитика',
  ref('AnalyticsSummary'),
  {
    queries: [
      ...periodQueries,
      employeeQuery,
      query(
        'mode',
        { type: 'string', enum: ['all', 'range'], default: 'range' },
        'range для совместимости; all — текущие totals без сравнений. Требует валидных from/to даже в all.',
      ),
    ],
    description:
      'Период включительный до 10 лет; будущее начало range запрещено, будущий конец ограничен asOf. legacy funnel/conversion остаются ручными CRM стадиями; новая восьмибалльная модель — clientAnalytics. Score контактов учитывает >1 proven user contacts, не bot/unknown; встреча только done meeting, регулярность по creationdate. Неполная/неоднозначная история — null/unavailable, не ноль. Периодный потенциал — сумма положительных подтверждённых приростов; проекты — созданные за период по состоянию на конец, рост — уникальные поднявшие уровень клиенты.',
  },
);
add(
  'get',
  '/dashboard',
  'teamDashboard',
  'Получить показатели сотрудников за период',
  'Команда',
  array(ref('DashboardRow')),
  {
    roles: ['supervisor', 'admin'],
    queries: periodQueries,
    description:
      'Глобальная исходная видимость руководителя/администратора; employeeId здесь не поддерживается. Завершённые задачи по исполнителю/дате завершения, активности по автору/occurredOn.',
  },
);
add(
  'get',
  '/dashboard/commercial',
  'commercialReport',
  'Сформировать коммерческий отчёт',
  'Команда',
  ref('CommercialReport'),
  {
    roles: ['supervisor', 'admin'],
    queries: [
      ...periodQueries,
      employeeQuery,
      query('authorId', uuid, 'Дополнительный автор; при employeeId должен совпадать, иначе400.'),
    ],
    description:
      'Объёмы confirmed/in_work/potential отдельно от конкретных results; неподтверждённые/непривязанные объёмы не становятся выручкой, текущий no_potential/unassigned исключается. Только чтение.',
  },
);
const periodBody = jsonBody(jsonSchema(z.object({ from: dateSchema, to: dateSchema }).strict()));
add(
  'get',
  '/dashboard/export',
  'downloadTeamCsv',
  'Получить CSV команды по bearer-сессии',
  'Команда',
  binary,
  {
    roles: ['supervisor', 'admin'],
    queries: periodQueries,
    media: 'text/csv',
    description:
      'UTF-8 BOM, attachment team-report.csv; CSV-формулы экранируются. Нет employeeId-фильтра.',
  },
);
add(
  'post',
  '/dashboard/export-link',
  'issueTeamCsvLink',
  'Создать краткоживущую ссылку на CSV',
  'Команда',
  ref('CsvLink'),
  {
    roles: ['supervisor', 'admin'],
    body: periodBody,
    description:
      'Снимок текущего периода, 5 минут, максимум5 ссылок на сотрудника. При скачивании роль и активность перепроверяются.',
  },
);
add(
  'post',
  '/dashboard/export-bot',
  'sendTeamCsvToBot',
  'Отправить CSV текущему сотруднику в Telegram',
  'Команда',
  object({ sent: { const: true } }),
  {
    roles: ['supervisor', 'admin'],
    body: periodBody,
    errors: [400, 401, 403, 429, 502, 503, 500],
    description:
      'Только реальный числовой Telegram ID текущей авторизованной сессии (не dev actor). Отправляет пользователю, не другому сотруднику; требуется настроенный бот. В Swagger UI выполнение отключено.',
  },
);

// Deliberately synthetic, mutation-free examples; no sessions, personal contacts or external addresses.
schemas.CompanyInput!.examples = [{ name: 'ООО «Пример»', inn: '', potential: 0, divisions: {} }];
schemas.ContactInput!.examples = [
  { name: 'Примеров Иван Иванович', role: 'Инженер', phone: '', email: '' },
];
schemas.TaskInput!.examples = [
  { text: 'Уточнить срок по согласованному проекту', type: 'call', due: null, done: false },
];
schemas.AnalyticsSettingsInput!.examples = [
  { revision: 1, taskDays: 14, meetingMonths: 3, projectMonths: 1 },
];

export const openApiDocument = {
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
  info: {
    title: 'Pico CRM HTTP API',
    version: '0.1.0',
    description:
      'Документация фактических существующих HTTP endpoints. Серверная авторизация является источником прав; внутренние Telegram callback-команды не являются дополнительными HTTP endpoints. Все примеры синтетические; реальные сессии, initData, секреты webhook и download links не включаются.',
  },
  servers: [
    {
      url: '/api',
      description: 'Текущий origin приложения; никаких production адресов в артефакте.',
    },
  ],
  tags: [
    'Публичное API',
    'Авторизация',
    'Telegram',
    'Скачивания',
    'Сотрудники',
    'Компании',
    'Записи',
    'Задачи',
    'Отчёты',
    'Подписи',
    'Письма',
    'Файлы',
    'Аналитика',
    'Команда',
  ].map((name) => ({ name })),
  security: [{ SessionBearer: [] }],
  paths,
  components: {
    securitySchemes: {
      SessionBearer: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Pico signed session',
        description:
          'Сессия /auth/telegram; dev сессии только loopback внеproduction. Сервер читает текущие роль/active.',
      },
      TelegramWebhookSecret: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Telegram-Bot-Api-Secret-Token',
        description: 'Секрет configured webhook; никогда не вводите его в общие примеры.',
      },
    },
    schemas,
  },
} as const;
