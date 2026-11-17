import { z } from 'zod';
import { idSchema } from './contracts';

export const ideaTopics = [
  'Главная',
  'Задачи',
  'Клиенты',
  'Проекты',
  'Аналитика',
  'Другое',
] as const;
export const maxIdeaScreenshotBytes = 2 * 1024 * 1024;
export const ideaInputSchema = z
  .object({
    submissionId: idSchema,
    topic: z.enum(ideaTopics).optional(),
    text: z.string().trim().min(1).max(2000),
  })
  .strict();

export type PicoIdea = {
  id: string;
  author: string;
  topic: string | null;
  text: string;
  screenshotMime: 'image/png' | 'image/jpeg' | null;
  createdAt: string;
  implementedAt: string | null;
};
