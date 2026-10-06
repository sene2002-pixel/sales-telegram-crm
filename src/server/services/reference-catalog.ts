import {
  industryGroups,
  normalizeIndustry,
  referenceAdjacentGroups,
  type IndustryGroup,
  type IndustryId,
} from '../../shared/reference-industries';

export interface ReferenceEntry {
  id: string;
  group: IndustryId;
  name: string;
  facts: string;
  profile: string;
  region: string;
  star: boolean;
  allowed: boolean;
}
export interface SelectedReference extends ReferenceEntry {
  adjacent: boolean;
}
export const neutralReferences =
  'Продукция ESQ применяется на объектах предприятий различных отраслей промышленности и энергетики.';
const banned = /ИБП|HYUNDAI|бесперебойн|строится|планируется|на подходе|деш[её]в/iu;

/** Each fenced reference record is one object. Untagged prose is never selectable. */
export function parseReferenceCatalog(markdown: string): ReferenceEntry[] {
  const records: ReferenceEntry[] = [];
  for (const match of markdown.matchAll(/```reference\s*\n([\s\S]*?)\n```/g)) {
    const value = JSON.parse(match[1]!) as ReferenceEntry;
    if (
      typeof value.id !== 'string' ||
      value.id.length > 80 ||
      !value.id ||
      !/^[a-z0-9-]+$/.test(value.id) ||
      records.some((entry) => entry.id === value.id) ||
      !industryGroups.some((group) => group.id === value.group) ||
      typeof value.name !== 'string' ||
      !value.name.trim() ||
      /[<>\n\r]/.test(value.name) ||
      typeof value.facts !== 'string' ||
      !value.facts.trim() ||
      /[<>\n\r]/.test(value.facts) ||
      typeof value.profile !== 'string' ||
      typeof value.region !== 'string' ||
      /[<>\n\r]/.test(value.region) ||
      typeof value.star !== 'boolean' ||
      typeof value.allowed !== 'boolean'
    ) {
      throw new Error('Invalid reference catalog record');
    }
    records.push(value);
  }
  return records;
}
const words = (text: string) =>
  (
    text
      .toLocaleLowerCase('ru')
      .replace(/ё/g, 'е')
    .replace(/дэс/g, 'дгу')
    .replace(/золот[а-я]*/g, 'золото')
    .replace(/дизель[ -]генератор[а-я]*(?:\s+установ[а-я]*)?/g, 'дгу')
      .match(/дгу|цод|гок|упп|пч|[а-яa-z0-9]{4,}/g) ?? []
  ).filter((word) => !/^(оборудован|производ|предприят|компани|промышлен)/.test(word));
const overlap = (a: string, b: string) =>
  words(a).filter((word) => words(b).some((candidate) => candidate.startsWith(word.slice(0, 5))))
    .length;
export function selectReferences(
  catalog: ReferenceEntry[],
  industry: string,
  options: {
    profile?: string;
    equipment?: string;
    region?: string;
    recentIds?: readonly string[];
  } = {},
): { group: IndustryGroup | null; eligible: ReferenceEntry[]; selected: SelectedReference[] } {
  const group = normalizeIndustry(industry);
  if (!group) return { group: null, eligible: [], selected: [] };
  const eligible = catalog.filter(
    (entry) =>
      entry.allowed &&
      !banned.test(`${entry.name} ${entry.facts}`) &&
      (entry.group === group.id || referenceAdjacentGroups[group.id].includes(entry.group)),
  );
  const rank = (entry: ReferenceEntry) => [
    overlap(options.profile ?? '', entry.profile),
    overlap(options.equipment ?? options.profile ?? '', entry.facts),
    Number(entry.star),
    overlap(options.region ?? '', entry.region),
    Number(!options.recentIds?.includes(entry.id)),
  ];
  const sort = (a: ReferenceEntry, b: ReferenceEntry) => {
    const ar = rank(a),
      br = rank(b);
    for (let i = 0; i < ar.length; i++) if (ar[i] !== br[i]) return br[i]! - ar[i]!;
    return catalog.indexOf(a) - catalog.indexOf(b);
  };
  const main = eligible.filter((entry) => entry.group === group.id).sort(sort);
  const selected: SelectedReference[] = main
    .slice(0, 3)
    .map((entry) => ({ ...entry, adjacent: false }));
  if (main.length < 2) {
    const adjacent = eligible.filter((entry) => entry.group !== group.id).sort(sort)[0];
    if (adjacent) selected.push({ ...adjacent, adjacent: true });
  }
  // Drop only complete, least-relevant objects; never cut a name, quantity, or factual clause.
  while (selected.length > 1 && renderReferences(selected).length > 420)
    selected.splice(selected.length - 1, 1);
  return { group, eligible, selected };
}
export function shortenReferences(selected: readonly SelectedReference[]): SelectedReference[] {
  if (selected.length <= 1) return [...selected];
  const index = selected.findLastIndex((entry) => entry.adjacent);
  return selected.filter((_, i) => i !== (index >= 0 ? index : selected.length - 1));
}
export function renderReferences(
  selected: readonly SelectedReference[],
  options: { maxLength?: number } = {},
): string {
  if (!selected.length) return neutralReferences;
  const original = `Продукция ESQ уже применяется на объектах ${selected.map((entry) => `${entry.name}${entry.region ? ` (${entry.region.replace(/^\((.*)\)$/, '$1')})` : ''} — ${entry.facts.replace(/[.;]+$/, '')}`).join('; ')}.`;
  if (selected.length < 2 || original.length >= 330) return original;
  let expanded = original;
  // Only expand terms defined in the source glossary, never invent project facts to pad a paragraph.
  for (const [short, full] of [
    ['ВЛК', 'выключатели в литом корпусе'],
    ['ПЧ', 'частотные преобразователи'],
    ['УПП', 'устройства плавного пуска'],
    ['БМЗ', 'блочно-модульное здание'],
    ['ЭВН', 'элегазовые выключатели нагрузки'],
    ['ВВ', 'вакуумные выключатели'],
  ]) {
    const candidate = expanded.replace(
      new RegExp(`(?<![А-ЯЁA-Z])${short}(?![А-ЯЁA-Z])`, 'gu'),
      full!,
    );
    if (candidate.length <= (options.maxLength ?? 420)) expanded = candidate;
    if (expanded.length >= 330) break;
  }
  return expanded;
}
