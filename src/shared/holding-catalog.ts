/** Confirmed ownership only: «Инструкция-Холдинг» and approved REFERENCES_ESQ.md records. */
export const holdingCatalog = [
  {
    name: 'ТГК-1',
    aliases: ['ТГК-1', 'ТГК 1'],
    companies: ['ПАО «ТГК-1»', 'АО «ТГК-1»', 'ООО «ГЭХ-Закупки»'],
  },
  {
    name: 'РМК',
    aliases: ['РМК', 'Русская медная компания'],
    companies: ['Кыштымский МЭЗ', 'Михеевский ГОК', 'Карабашмедь', 'ООО «Амур Минералс»'],
  },
  {
    name: 'СИБУР',
    aliases: ['СИБУР'],
    companies: ['ПАО «СИБУР Холдинг»', 'ПАО «Нижнекамскнефтехим»', 'Красноярский завод СК'],
  },
  { name: 'РУСАЛ', aliases: ['РУСАЛ'], companies: ['ООО «ЭН+ Торговый дом»'] },
  { name: 'НЛМК', aliases: ['НЛМК'], companies: ['НЛМК-Урал'] },
  ...['Евраз', 'Интер РАО'].map((name) => ({ name, aliases: [name], companies: [] as string[] })),
] as const;
const normalize = (name: string) =>
  name
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[«»"“”]/g, '')
    .replace(/[‐‑–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
const legalForm = /^(?:пао|оао|ао|ооо|зао)\s+/iu;
const stripLegal = (name: string) => normalize(name).replace(legalForm, '');
const groupFor = (name: string) =>
  holdingCatalog.find((group) =>
    group.aliases.some((alias) => normalize(alias) === normalize(name)),
  );
function entityFor(name: string) {
  const value = normalize(name);
  const matches = holdingCatalog.flatMap((group) => {
    const suffix = ` (${normalize(group.name)})`;
    const candidate = value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
    return group.companies
      .filter((company) => {
        const canonical = normalize(company);
        if (candidate === canonical) return true;
        // A bare group name is not the same thing as the legal entity with that name.
        if (!legalForm.test(candidate))
          return stripLegal(canonical) === candidate && !groupFor(candidate);
        if (
          legalForm.test(canonical) &&
          candidate.match(legalForm)?.[0] !== canonical.match(legalForm)?.[0]
        )
          return false;
        return stripLegal(candidate) === stripLegal(canonical);
      })
      .map((company) => ({
        holdingName: group.name,
        companyName: company,
        isHolding: false as const,
      }));
  });
  return matches.length === 1 ? matches[0] : undefined;
}
const siteOnly = (text: string) =>
  /^(?:(?:филиал|цех|площадка)\s+[^,;:]{1,150}|(?:[\p{L}\d-]+\s+){0,3}(?:ТЭЦ|ГРЭС))$/iu.test(
    text.trim(),
  );
export interface HoldingMention {
  holdingName?: string;
  companyName?: string;
  sites?: string[];
  isHolding?: boolean;
}
export function classifyHoldingMention(name: string): HoldingMention {
  const original = name.trim();
  const group = groupFor(original);
  if (group) return { holdingName: group.name, isHolding: true };
  const entity = entityFor(original);
  if (entity) return entity;
  // An explicit owner + site is parsed before looking for a group/entity pair.
  const ownerSite = /^(.*?)\s*(?:[,;:]|\s[-–—]\s)\s*([^,;:]+)$/u.exec(original);
  if (ownerSite && ownerSite[1]!.trim() && siteOnly(ownerSite[2]!)) {
    const owner = ownerSite[1]!.trim(),
      site = ownerSite[2]!.trim();
    const ownerGroup = groupFor(owner);
    if (ownerGroup) return { holdingName: ownerGroup.name, isHolding: true, sites: [site] };
    const ownerEntity = entityFor(owner);
    return { ...(ownerEntity || { companyName: owner, isHolding: false }), sites: [site] };
  }
  // Group-to-entity linkage must be stated explicitly, not inferred from a substring.
  const text = normalize(original);
  for (const known of holdingCatalog)
    for (const alias of known.aliases) {
      const prefix = normalize(alias);
      if (!text.startsWith(prefix)) continue;
      const rest = original.slice(alias.length).replace(/^\s*[-–—:]\s*/, '');
      if (rest === original.slice(alias.length) || !rest) continue;
      if (siteOnly(rest)) return { holdingName: known.name, isHolding: true, sites: [rest] };
      const knownEntity = entityFor(rest);
      if (knownEntity) return knownEntity.holdingName === known.name ? knownEntity : {};
      if (legalForm.test(normalize(rest)))
        return { holdingName: known.name, companyName: rest, isHolding: false };
    }
  if (siteOnly(original) && !legalForm.test(text)) return { sites: [original] };
  // Match the entire source example grammar; a verb does not authorize substring ownership.
  const narrative =
    /^(?:был[аи]?|были|посетил[аи]?)\s+(?:(?:на|в|у)\s+)?(.+?)(?:,\s*это\s+(.+))?$/iu.exec(
      original,
    );
  if (narrative) {
    const named = normalize(narrative[1]!);
    const candidate = named === 'карабашмеди' ? entityFor('Карабашмедь') : entityFor(narrative[1]!);
    const statedGroup = narrative[2] ? groupFor(narrative[2]) : undefined;
    if (candidate && (!narrative[2] || statedGroup?.name === candidate.holdingName))
      return candidate;
  }
  return {};
}
/** Same confirmed catalogue as CRM, with exact approved legal names/ownership annotations. */
export function referenceHoldingKey(name: string): string | undefined {
  return classifyHoldingMention(name).holdingName;
}
