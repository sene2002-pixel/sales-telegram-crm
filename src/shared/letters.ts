import { z } from 'zod';
const field = z
  .string()
  .trim()
  .max(120)
  .refine((v) => !/[<>\r\n]/.test(v), 'Введите одну строку без разметки');
export const signatureSchema = z
  .object({
    lastName: field.min(1),
    firstName: field.min(1),
    patronymic: field,
    workPhone: field,
    mobilePhone: field,
    email: z.union([z.literal(''), z.email().max(120)]),
  })
  .strict();
export const cardSchema = signatureSchema.extend({ lastName: field, firstName: field });
export type Signature = z.infer<typeof signatureSchema>;
export const noContacts = 'Для создания письма необходимо добавить хотя бы один контакт';
