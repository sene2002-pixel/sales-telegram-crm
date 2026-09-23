import { z } from 'zod';

export const roles = ['manager', 'supervisor', 'admin'] as const;
export type Role = (typeof roles)[number];
export interface Actor {
  id: string;
  name: string;
  role: Role;
  telegramId: string;
  active: boolean;
  supervisorId?: string | null;
}
export const segments = ['shchitovik', 'oem', 'end_client', 'contractor'] as const;
export const stages = ['new', 'dialogue', 'proposal', 'supply', 'closed'] as const;
export const divisions = ['lv', 'mv', 'drives', 'cells', 'heat', 'services'] as const;
export const labels: Record<string, string> = {
  manager: 'Менеджер',
  supervisor: 'Руководитель',
  admin: 'Администратор',
  shchitovik: 'Щитовик',
  oem: 'OEM',
  end_client: 'Конечный заказчик',
  contractor: 'Подрядчик',
  new: 'Новый',
  dialogue: 'Диалог',
  proposal: 'Предложение',
  supply: 'Поставки',
  closed: 'Завершён',
  lv: '0,4 кВ',
  mv: '6–35 кВ',
  drives: 'ПЧ / УПП',
  cells: 'КСО / КРУ',
  heat: 'Теплотехника',
  services: 'Услуги',
  queued: 'В очереди',
  processing: 'Обрабатывается',
  review: 'На подтверждении',
  saved: 'Сохранён',
  cancelled: 'Отменён',
  failed: 'Ошибка',
  docs: 'Документация',
  catalog: 'Каталог',
  brochure: 'Брошюра',
  ref: 'Референс',
  model: '3D модель',
};
export function validInn(value: string): boolean {
  if (!/^\d{10}$|^\d{12}$/.test(value)) return false;
  const d = [...value].map(Number);
  const check = (weights: number[], index: number) =>
    (weights.reduce((s, w, i) => s + w * d[i]!, 0) % 11) % 10 === d[index];
  return d.length === 10
    ? check([2, 4, 10, 3, 5, 9, 4, 6, 8], 9)
    : check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11);
}
export const idSchema = z.string().uuid();
const text = z.string().trim().max(5000);
const name = z.string().trim().min(1).max(200);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const date = new Date(v + 'T12:00:00Z');
    return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === v;
  }, 'Некорректная дата');
const money = z.number().finite().min(0).max(1e12);
export const companySchema = z
  .object({
    name,
    inn: z
      .string()
      .trim()
      .refine((v) => !v || validInn(v), 'Некорректный ИНН')
      .default(''),
    city: z.string().trim().max(150).default(''),
    segment: z.enum(segments).default('end_client'),
    industry: z.string().trim().max(150).default(''),
    stage: z.enum(stages).default('new'),
    archived: z.boolean().default(false),
    revenue: money.nullable().default(null),
    potential: money.nullable().default(null),
    divisions: z.partialRecord(z.enum(divisions), money).default({}),
    notes: text.default(''),
  })
  .strict();
export type CompanyData = z.infer<typeof companySchema>;
export interface Company extends CompanyData {
  id: string;
  ownerId: string;
  ownerName: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export const contactSchema = z
  .object({
    name,
    role: z.string().max(200).default(''),
    phone: z.string().max(100).default(''),
    email: z.union([z.literal(''), z.email()]).default(''),
  })
  .strict();
export const projectSchema = z
  .object({
    name,
    amount: money.nullable().default(null),
    due: dateSchema.nullable().default(null),
    stage: z.enum(stages).default('new'),
    notes: text.default(''),
  })
  .strict();
export const taskSchema = z
  .object({
    text: name,
    due: dateSchema.nullable().default(null),
    done: z.boolean().default(false),
  })
  .strict();
export const activitySchema = z.object({ text: text.min(1), occurredOn: dateSchema }).strict();
export const fileSchema = z.object({
  name,
  category: z.enum(['docs', 'catalog', 'brochure', 'ref', 'model']),
  size: z.number(),
  key: z.string(),
});
export const recordSchemas = {
  contact: contactSchema,
  project: projectSchema,
  task: taskSchema,
  activity: activitySchema,
  file: fileSchema,
};
export type RecordKind = keyof typeof recordSchemas;
export interface CrmRecord {
  id: string;
  kind: RecordKind;
  companyId: string;
  projectId: string | null;
  authorId: string;
  authorName: string;
  assigneeId: string | null;
  version: number;
  createdAt: string;
  data: Record<string, any>;
}
// All extraction properties are required and nullable where unknown: compatible with strict JSON Schema.
export const extractionBlockSchema = z
  .object({
    companyName: name,
    inn: z.string().nullable(),
    city: z.string().max(150).nullable(),
    segment: z.enum(segments).nullable(),
    stage: z.enum(stages).nullable(),
    potential: money.nullable(),
    divisions: z.array(z.object({ key: z.enum(divisions), amount: money })).max(6),
    summary: text.min(1),
    occurredOn: dateSchema,
    contacts: z
      .array(
        z.object({
          name,
          role: z.string().max(200).nullable(),
          phone: z.string().max(100).nullable(),
          email: z.string().max(200).nullable(),
        }),
      )
      .max(20),
    tasks: z.array(z.object({ text: name, due: dateSchema.nullable() })).max(20),
  })
  .strict();
export const extractionSchema = z
  .object({
    blocks: z.array(extractionBlockSchema).min(1).max(10),
    warnings: z.array(z.string().max(500)).max(20),
  })
  .strict();
export type Extraction = z.infer<typeof extractionSchema>;
export const confirmSchema = z
  .object({
    version: z.number().int().positive(),
    draft: extractionSchema,
    companyIds: z.array(idSchema.nullable()).max(10),
  })
  .strict();
export interface Report {
  id: string;
  authorId: string;
  authorName: string;
  status: string;
  version: number;
  createdAt: string;
  transcript: string | null;
  draft: Extraction | null;
  error: string | null;
  attempts: number;
}
export interface CompanyDetail {
  company: Company;
  records: CrmRecord[];
  audit: any[];
}
