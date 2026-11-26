import { z } from 'zod';
import { Actor, dateSchema, labels, roles } from './contracts';

export const teamMetrics = [
  ['companies', 'Компании'],
  ['openTasks', 'Открыто'],
  ['overdue', 'Просрочено'],
  ['completed', 'Выполнено'],
  ['interactions', 'Контакты'],
] as const;

export type TeamMetric = (typeof teamMetrics)[number][0];
export type TeamStats = Pick<Actor, 'id' | 'role' | 'name' | 'active'> &
  Record<TeamMetric, number> & {
    removedFromTeam?: boolean;
    inactiveCompanies: { id: string; name: string }[];
  };

export const teamExportSchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
    q: z.string().max(200).optional(),
    role: z.enum(roles).optional(),
    sort: z.enum(teamMetrics.map(([key]) => key)).optional(),
    direction: z.enum(['asc', 'desc']).optional(),
  })
  .strict();
export type TeamMetricsFilter = Omit<z.infer<typeof teamExportSchema>, 'from' | 'to'>;

const searchText = (text: string) => text.toLocaleLowerCase('ru').replaceAll('ё', 'е');

export function selectTeamMetrics(rows: readonly TeamStats[], filter: TeamMetricsFilter) {
  const words = searchText(filter.q ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const selected = rows.filter((row) => {
    if (row.removedFromTeam) return false;
    if (filter.role && row.role !== filter.role) return false;
    const text = searchText(row.name + ' ' + labels[row.role]);
    return words.every((word) => text.includes(word));
  });
  const { sort, direction } = filter;
  if (sort) {
    selected.sort(
      (a, b) =>
        (direction === 'asc' ? a[sort] - b[sort] : b[sort] - a[sort]) ||
        a.name.localeCompare(b.name, 'ru') ||
        a.id.localeCompare(b.id),
    );
  }
  return selected;
}
