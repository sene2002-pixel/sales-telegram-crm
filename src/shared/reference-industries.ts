export const industryGroups = [
  { id: 'oil-gas', label: 'Нефтегаз' },
  { id: 'chemical', label: 'Химия' },
  { id: 'mining', label: 'Горнодобыча' },
  { id: 'metallurgy', label: 'Металлургия' },
  { id: 'power-generation', label: 'Энергетика — генерация' },
  { id: 'power-grids', label: 'Энергетика — сети' },
  { id: 'data-telecom', label: 'ЦОД/телеком' },
  { id: 'utilities', label: 'ЖКХ' },
  { id: 'food', label: 'Пищевая/АПК' },
  { id: 'construction', label: 'Строительство' },
  { id: 'commercial', label: 'Коммерческая недвижимость' },
  { id: 'residential', label: 'Жилая недвижимость' },
  { id: 'materials', label: 'Стройматериалы' },
  { id: 'oem', label: 'Машиностроение/OEM' },
  { id: 'switchboards', label: 'Щитовое производство' },
  { id: 'defense', label: 'Оборонный и военный сектор' },
  { id: 'public', label: 'Госсектор' },
] as const;
export type IndustryGroup = (typeof industryGroups)[number];
export type IndustryId = IndustryGroup['id'];
export const referenceAdjacentGroups: Record<IndustryId, readonly IndustryId[]> = {
  'oil-gas': ['chemical', 'power-generation', 'power-grids', 'oem'],
  chemical: ['oil-gas'],
  mining: ['metallurgy'],
  metallurgy: ['mining'],
  'power-generation': ['utilities'],
  'power-grids': ['data-telecom'],
  'data-telecom': ['power-generation', 'power-grids'],
  utilities: ['power-generation', 'power-grids'],
  food: ['construction'],
  construction: ['materials'],
  commercial: ['construction'],
  residential: ['construction'],
  materials: ['construction'],
  oem: ['switchboards'],
  switchboards: ['oem'],
  defense: ['oem', 'public'],
  public: ['construction'],
};
const normalized = (value: string) =>
  value
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
const aliases: Partial<Record<IndustryId, string[]>> = {
  'power-generation': ['энергетика - генерация', 'генерация', 'тэц', 'грэс'],
  'power-grids': ['энергетика - сети', 'электросети', 'сети и сбыт'],
  'oil-gas': ['нефть и газ', 'нефтегазовая промышленность'],
  chemical: ['химическая промышленность', 'нефтехимия', 'фарма'],
  mining: ['горнодобывающая промышленность', 'золотодобыча', 'угледобыча'],
  'data-telecom': ['цод / телеком', 'цод', 'it', 'информационные технологии', 'связь'],
  food: ['пищевая / апк', 'пищевая промышленность', 'апк'],
  oem: [
    'машиностроение / oem',
    'машиностроение',
    'дгу',
    'дэс',
    'производство дгу',
    'производство дизель-генераторных установок',
  ],
  defense: ['опк', 'оборонная промышленность'],
  public: ['госсектор и прочее'],
};
export function normalizeIndustry(value: string | null | undefined): IndustryGroup | null {
  const key = normalized(value ?? '');
  return (
    industryGroups.find(
      (group) =>
        normalized(group.id) === key ||
        normalized(group.label) === key ||
        aliases[group.id]?.some((alias) => normalized(alias) === key),
    ) ?? null
  );
}
