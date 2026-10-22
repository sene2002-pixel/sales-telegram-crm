import { fromBuffer, Entry, ZipFile } from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import {
  CompanyData,
  companySchema,
  contactSchema,
  projectSchema,
  validInn,
  labels,
  segments,
  stages,
  divisions,
  equipmentKeys,
  divisionLabels,
} from '../../shared/contracts';
import {
  importedLegalForm,
  normalizedCompanyName,
  normalizedInn,
  normalizedCity,
  normalizedSegment,
  normalizedMoneyColumn,
  normalizedPhones,
  normalizedImportDate,
} from './import-normalization';
import { normalizeLayout } from './import-table-layout';
import { classifyHoldingMention } from '../../shared/holding-catalog';
import { companyDisplayName } from '../../shared/company-display-name';
import { requireCondition, DomainError } from '../domain/errors';

export const companyImportLimits = {
  bytes: 2 * 1024 * 1024,
  expanded: 8 * 1024 * 1024,
  entries: 100,
  rows: 100,
  preambleRows: 20,
  columns: 30,
  cell: 1000,
} as const;
// Required by the caller: no import is allowed to bypass the application privacy policy.
export type ImportPrivacyGuard = (text: string) => void;
// Recognize the existing unanchored ASCII email pattern in linear time.
// Domain runs cannot overlap: '@' is not a domain character. Only the
// immediately preceding local-part character is needed for an unanchored match.
function containsEmail(text: string): boolean {
  const word = (c: number) =>
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
  const letter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  for (let i = 1; i < text.length; i++) {
    if (text.charCodeAt(i) !== 64) continue;
    const previous = text.charCodeAt(i - 1);
    if (!word(previous) && previous !== 46 && previous !== 43 && previous !== 45) continue;
    for (let j = i + 1; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (!word(c) && c !== 46 && c !== 45) break;
      if (c === 46 && j > i + 1 && letter(text.charCodeAt(j + 1)) && letter(text.charCodeAt(j + 2)))
        return true;
    }
  }
  return false;
}
export function assertImportPrivacy(text: string) {
  requireCondition(
    !containsEmail(text) &&
      !/\+\d[\d ()-]{8,}\d|(?:пароль|password|api[_ -]?key|secret|токен)\s*[:=]|\bsk-[a-z0-9_-]{10,}|Bearer\s+\S+|(?:диагноз|паспорт|домашн(?:ий|его)\s+адрес|дата\s+рождения|состояние\s+здоровья)/i.test(
        text,
      ),
    400,
    'Импортируйте только сведения о компаниях, без личных контактов и секретов',
  );
}

export type ImportedCompany = {
  legalForm?: string;
  raw?: Record<string, string>;
  sourceDate?: string;
  holdingName?: string;
  registryFields?: string[];
  source: string;
  data: Partial<CompanyData> & { name: string };
  missing: string[];
  warnings: string[];
  contacts?: ReturnType<typeof contactSchema.parse>[];
  projects?: {
    data: ReturnType<typeof projectSchema.parse>;
    source: string;
    customerInn?: string;
    customerName?: string;
    customerCountry?: string;
    participantRole?: string;
  }[];
};
const baseFields = [
  'name',
  'inn',
  'city',
  'segment',
  'industry',
  'potential',
  'stage',
  'revenue',
  'notes',
  'website',
  'country',
  'region',
] as const;
type Field = (typeof baseFields)[number] | `division:${(typeof divisions)[number]}`;
const aliases: Record<string, Field> = Object.assign(Object.create(null), {
  website: 'website',
  сайт: 'website',
  страна: 'country',
  country: 'country',
  регион: 'region',
  region: 'region',
  клиент: 'name',
  'клиент тн пч': 'name',
  'клиент тн эд': 'name',
  контрагент: 'name',
  stage: 'stage',
  стадия: 'stage',
  этап: 'stage',
  revenue: 'revenue',
  выручка: 'revenue',
  'выручка руб': 'revenue',
  'выручка млн руб': 'revenue',
  'выручка млн': 'revenue',
  notes: 'notes',
  комментарий: 'notes',
  заметки: 'notes',
  примечание: 'notes',
  name: 'name',
  company: 'name',
  название: 'name',
  компания: 'name',
  'название компании': 'name',
  наименование: 'name',
  inn: 'inn',
  инн: 'inn',
  city: 'city',
  город: 'city',
  segment: 'segment',
  type: 'segment',
  тип: 'segment',
  'тип клиента': 'segment',
  сегмент: 'segment',
  industry: 'industry',
  отрасль: 'industry',
  potential: 'potential',
  потенциал: 'potential',
  'потенциал руб': 'potential',
  'потенциал млн руб': 'potential',
  'потенциал млн': 'potential',
});
const normalize = (s: string) =>
  s
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[–—−]/g, '-')
    .replace(/[()₽.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
for (const d of divisions)
  for (const alias of [d, labels[d], divisionLabels[d]])
    if (alias) {
      for (const suffix of [
        '',
        ' руб',
        ' млн руб',
        ' млн ₽',
        ' тыс',
        ' тыс руб',
        ' тыс ₽',
        ' млрд',
        ' млрд руб',
        ' млн',
        ' лям',
        ' кк',
        ' м',
        ' к',
        ' тр',
        ' т р',
        ' р',
        ' мл',
      ])
        aliases[normalize(alias + suffix)] = `division:${d}`;
    }
export function normalizeImportedInn(value: string): string {
  return normalizedInn(value) || '';
}
for (const field of ['potential', 'revenue'] as const)
  for (const alias of [field, field === 'potential' ? 'потенциал' : 'выручка'])
    for (const suffix of [
      ' тыс',
      ' тыс руб',
      ' тыс ₽',
      ' млн ₽',
      ' млрд',
      ' млрд руб',
      ' мл',
      ' лям',
      ' кк',
      ' м',
      ' к',
      ' тр',
      ' т р',
      ' р',
    ])
      aliases[normalize(alias + suffix)] = field;
const arr = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
function xml(text: string) {
  requireCondition(
    !/<!DOCTYPE|<!ENTITY/i.test(text),
    400,
    'Импорт с XML-сущностями не поддерживается',
  );
  let depth = 0,
    nodes = 0;
  // Advance monotonically. A regex searching for '>' at every '<a' start
  // has quadratic failure cost on an unterminated, attacker-controlled sheet.
  for (let cursor = 0; cursor < text.length;) {
    const start = text.indexOf('<', cursor);
    if (start < 0) break;
    const closing = text[start + 1] === '/';
    const c = text.charCodeAt(start + (closing ? 2 : 1));
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
      cursor = start + 1;
      continue;
    }
    const end = text.indexOf('>', start + 1);
    requireCondition(end >= 0, 400, 'Повреждённый XML в таблице');
    requireCondition(++nodes <= 25000, 400, 'Слишком сложный XML в таблице');
    if (closing) depth--;
    else if (text[end - 1] !== '/') depth++;
    requireCondition(depth >= 0 && depth <= 32, 400, 'Слишком вложенный XML в таблице');
    cursor = end + 1;
  }
  requireCondition(XMLValidator.validate(text) === true, 400, 'Повреждённый XML в таблице');
  return new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    trimValues: false,
  }).parse(text);
}
function entity(s: string): string {
  return s
    .replace(
      /&(?:amp|lt|gt|quot|apos);/g,
      (v) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[v]!,
    )
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, v) => {
      const n = v[0].toLowerCase() === 'x' ? parseInt(v.slice(1), 16) : Number(v);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    });
}
function textNode(v: any): string {
  if (v == null) return '';
  if (typeof v !== 'object') return entity(String(v));
  return (
    arr(v.t).map(textNode).join('') ||
    arr(v.r).map(textNode).join('') ||
    (v['#text'] ? entity(String(v['#text'])) : '')
  );
}
/** Remove forbidden free-text facts before retaining raw values; business contacts are parsed locally. */
export function sanitizeImportedCell(value: string): string {
  return value
    .split(/\r?\n|;(?=\s*(?:пароль|логин|паспорт|дата рождения|диагноз|домашний адрес))/iu)
    .filter(
      (line) =>
        /^\s*логин и пароль скинут[.!]?\s*$/iu.test(line) ||
        !/(?:пароль|password|api[_ -]?key|secret|токен|логин|login|паспорт|дата\s+рождения|диагноз|домашн(?:ий|его)\s+адрес|состояние\s+здоровья|семейн(?:ое|ый)\s+положение)\s*[:=–—-]?/iu.test(
          line,
        ),
    )
    .filter((line) => !/\b(?:sk-[a-z0-9_-]{10,}|Bearer\s+\S+)/i.test(line))
    .join('\n');
}
const emptyCell = (value: string) => /^(?:[-—–]+|нет|н\/?д|нд|\?|уточнить)?$/iu.test(value.trim());
function isNameHeader(value: string) {
  return aliases[normalize(value)] === 'name';
}
function extractCompanyNameCell(value: string): Record<string, any> {
  let name = value
    .trim()
    .replace(/‚/g, ',')
    .replace(/^\d+_\s*|^\(к\)\s*/iu, '');
  const facts: Record<string, any> = {};
  const foreign = /^(Беларусь|Казахстан|Китай|Белоруссия)\s*(?:[-–—:]\s*|(?=ООО|ТОО))/iu.exec(name);
  if (foreign) {
    facts.country = foreign[1] === 'Белоруссия' ? 'Беларусь' : foreign[1];
    name = name.slice(foreign[0].length).trim();
  }
  if (/(?:^|\s)ТОО(?=\s|$)/u.test(name) && !facts.country) facts.country = 'Казахстан';
  const inn = /(?:^|[\s,;(])ИНН\s*:?\s*([\d '.eE+–—-]{9,30})/iu.exec(name);
  if (inn) {
    const candidate = normalizedInn(inn[1]!.trim());
    if (candidate) facts.inn = candidate;
    name = name.replace(inn[0], ' ').trim();
  }
  const knownCities =
    /^(?:Москва|Санкт-Петербург|СПб|Спб|Мск|Казань|Омск|Тула|Рязань|Екатеринбург|Екб|Нижний Новгород|Новосибирск|Алматы|Астана)$/iu;
  name = name.replace(/\(([^()]*)\)/g, (whole, content: string) => {
    const segment = normalizedSegment(content.trim());
    if (segment) {
      facts.segment = segment;
      return '';
    }
    const pieces = content.split(',').map((v) => v.trim());
    const city = pieces.find((v) => knownCities.test(v.replace(/^г\.?\s*/iu, '')));
    if (city) {
      facts.city = normalizedCity(city);
      const alias = pieces.filter((v) => v !== city).join(' ');
      if (alias) facts.alternativeNames = [...(facts.alternativeNames || []), alias];
      return '';
    }
    const money = normalizedMoneyColumn([content], 'руб')[0]?.amount;
    if (money !== undefined && /руб|₽/iu.test(content)) {
      facts.revenue = money;
      return '';
    }
    if (/^[А-ЯЁA-Z][А-ЯЁA-Z0-9-]{1,12}$/.test(content)) {
      facts.alternativeNames = [...(facts.alternativeNames || []), content];
      return '';
    }
    return whole;
  });
  const citySuffix = /\s*(?:\||\sг\.?\s+)\s*([^|,;]+)$/iu.exec(name);
  if (citySuffix && knownCities.test(citySuffix[1]!.trim())) {
    facts.city = normalizedCity(citySuffix[1]!);
    name = name.slice(0, citySuffix.index).trim();
  }
  const full = /^(.+?)\s+(?:ООО|АО|ПАО|ЗАО|ОАО)\s+[«"](.+)[»"]$/u.exec(name);
  if (full) {
    facts.alternativeNames = [...(facts.alternativeNames || []), normalizedCompanyName(full[2]!)];
    name = full[1]!;
  }
  facts.name = normalizedCompanyName(name).replace(/\s+/g, ' ').trim();
  return facts;
}
function projectColumn(headers: string[]) {
  return headers.findIndex((h) =>
    /^(?:проект|название проекта|объект|название объекта|строительный объект)$/iu.test(h.trim()),
  );
}
function customerColumn(headers: string[]) {
  return headers.findIndex((h) =>
    /^(?:заказчик|заказчик проекта|название заказчика|конечный заказчик)$/iu.test(h.trim()),
  );
}
function isTableHeader(row: string[]) {
  // A project is never interpreted as a company name. Its owner/customer is explicit.
  return (
    row.some(isNameHeader) ||
    (projectColumn(row) >= 0 && customerColumn(row) >= 0) ||
    row.some((h) => /^(?:договор|счет|счёт|документ)$/iu.test(h.trim()))
  );
}

function parseProjectTable(
  headers: string[],
  rows: string[][],
  source: string,
  privacy: ImportPrivacyGuard,
  sourceRows: number[],
  sourceDate?: string,
): ImportedCompany[] {
  const col = (pattern: RegExp) => headers.findIndex((h) => pattern.test(h.trim()));
  const projectCol = projectColumn(headers),
    ownerCol = headers.findIndex(isNameHeader);
  const customerCol = customerColumn(headers);
  const innCol = col(/^(?:ИНН|ИНН компании|ИНН контрагента)$/iu);
  const customerInnCol = col(/^(?:ИНН заказчика|ИНН конечного заказчика)$/iu);
  const segmentCol = col(/^(?:тип|тип клиента|тип компании|категория)$/iu);
  const cityCol = col(/^(?:город|город компании|город клиента)$/iu);
  const projectCityCol = col(/^город проекта$/iu);
  const stageCol = col(/^(?:стадия|этап|стадия проекта|статус проекта)$/iu);
  const dateCol = col(
    /^(?:реализация|срок реализации|срок проекта|срок|решение до|дата поставки)$/iu,
  );
  const amountCol = col(/^(?:сумма|сумма проекта|бюджет|стоимость)(?:\s.*)?$/iu);
  const equipmentColumns = headers.flatMap((h, i) => {
    const field = aliases[normalize(h)];
    return field?.startsWith('division:') && equipmentKeys.includes(field.slice(9) as any)
      ? [
          {
            index: i,
            division: field.slice(9),
            values: normalizedMoneyColumn(
              rows.map((r) => r[i] || ''),
              h,
            ),
          },
        ]
      : [];
  });
  const contactFields = [
    /^(?:фио|контакт фио|имя контакта|контактное лицо)$/iu,
    /^(?:должность|позиция контакта)$/iu,
    /^(?:телефон|телефоны|phone|тел\.)$/iu,
    /^(?:e-?mail|email|почта|электронная почта)$/iu,
  ].map((pattern) => col(pattern));
  const combinedContact = col(/^контакты?$/iu);
  const contactColumns = new Set([...contactFields, combinedContact].filter((i) => i >= 0));
  const countryCol = col(/^(?:страна|страна компании)$/iu),
    regionCol = col(/^(?:регион|регион компании)$/iu);
  const customerCityCol = col(/^город заказчика$/iu),
    customerCountryCol = col(/^страна заказчика$/iu),
    customerRegionCol = col(/^регион заказчика$/iu);
  const amountValues =
    amountCol < 0
      ? []
      : normalizedMoneyColumn(
          rows.map((r) => r[amountCol] || ''),
          headers[amountCol]!,
        );
  const roles = headers.flatMap((h, i) =>
    /^(?:подрядчик|щитовик\s*\/\s*(?:оэм|oem)|интегратор|проектный институт)$/iu.test(h.trim())
      ? [i]
      : [],
  );
  const output: ImportedCompany[] = [];
  // One identity rule for owners, customers and participants; missing geography is not
  // copied between them. Conflicting explicit legal forms/INNs/countries stay distinct.
  const identities: {
    name: string;
    form: string;
    inn?: string;
    country: string;
    city: string;
    region: string;
    company: ImportedCompany;
  }[] = [];
  const countryKey = (value: string) =>
    !value.trim() || /^(?:россия|рф|ru|russia)$/iu.test(value.trim())
      ? 'ru'
      : value.trim().toLowerCase();
  let projectCount = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!,
      projectName = (row[projectCol] || '').trim();
    if (!row.some((v) => v.trim()) || /^(?:итого|всего|итог)(?:\s|:|$)/iu.test(projectName))
      continue;
    row.forEach((value, i) => {
      if (!contactColumns.has(i)) {
        privacy(value);
        requireCondition(!/^\s*[=+@]/.test(value), 400, 'Формулы запрещены');
      }
    });
    const contacts =
      combinedContact >= 0 ? parseBusinessContacts(row[combinedContact] || '', privacy) : [];
    if (contactFields[0]! >= 0 && row[contactFields[0]!]?.trim())
      contacts.push(
        ...parseBusinessContacts(contactFields.map((i) => row[i] || '').join(','), privacy),
      );
    requireCondition(
      row.every((v) => v.length <= companyImportLimits.cell) &&
        row.length <= companyImportLimits.columns,
      400,
      'Таблица превышает лимит колонок или размера ячейки',
    );
    const customerName = (row[customerCol] || '').trim();
    const ownerName = (row[ownerCol] || '').trim() || customerName;
    requireCondition(
      Boolean(ownerName),
      400,
      `Строка ${sourceRows[index]}: у проекта нужна компания или заказчик`,
    );
    requireCondition(
      Boolean(projectName),
      400,
      `Строка ${sourceRows[index]}: не указано название проекта`,
    );
    requireCondition(++projectCount <= 100, 400, 'В таблице допускается до 100 проектов');
    const raw = Object.fromEntries(headers.map((h, i) => [`${i + 1}. ${h}`, row[i] || '']));
    const notes: string[] = [];
    if (customerName)
      notes.push(
        `Заказчик из источника: ${customerName}${row[customerCountryCol]?.trim() ? `; страна: ${row[customerCountryCol]!.trim()}` : ''}`,
      );
    const incompleteContact =
      contacts.length === 0 && [...contactColumns].some((i) => row[i]?.trim());
    if (incompleteContact)
      notes.push(
        'Неполный контакт: ФИО не указано; исходные контактные поля сохранены для проверки.',
      );
    notes.push(
      ...[...contactColumns].flatMap((i) => safeContactInstructions(row[i] || '', privacy)),
    );
    const knownColumns = new Set([
      projectCol,
      ownerCol,
      customerCol,
      innCol,
      customerInnCol,
      cityCol,
      projectCityCol,
      stageCol,
      dateCol,
      amountCol,
      countryCol,
      regionCol,
      segmentCol,
      ...roles,
      ...contactColumns,
      ...equipmentColumns.map((c) => c.index),
    ]);
    headers.forEach((h, i) => {
      if (!knownColumns.has(i) && row[i]?.trim()) notes.push(`${h}: ${row[i]}`);
    });
    const warnings: string[] = [];
    if (incompleteContact)
      warnings.push('Контакт без ФИО сохранён в примечании проекта; имя не придумано.');
    let stage: (typeof stages)[number] = 'new';
    if (row[stageCol]?.trim()) {
      const original = row[stageCol]!.trim();
      const found = stages.find(
        (value) =>
          value === original || (labels[value] || value).toLowerCase() === original.toLowerCase(),
      );
      if (found) stage = found;
      else {
        notes.push(`Стадия из источника: ${original}`);
        warnings.push('Неизвестная стадия сохранена в примечании; техническая стадия — новая.');
      }
    }
    if (row[dateCol]?.trim()) {
      const original = row[dateCol]!.trim(),
        month = normalizedImportDate(original, sourceDate);
      notes.push(
        `${headers[dateCol]}${month ? ' (месяц)' : ' (исходное значение)'}: ${month || original}`,
      );
      if (!month) warnings.push('Срок сохранён без догадки о дне или годе.');
    }
    const money = amountValues[index];
    if (money?.warning) warnings.push(money.warning);
    if (money?.note) notes.push(money.note);
    const equipment = equipmentColumns.flatMap((c) => {
      const value = c.values[index];
      if (value?.warning) warnings.push(value.warning);
      if (value?.note) notes.push(`${headers[c.index]}: ${value.note}`);
      return row[c.index]?.trim()
        ? [{ division: c.division, name: headers[c.index], amount: value?.amount ?? null }]
        : [];
    });
    const project = projectSchema.safeParse({
      name: projectName,
      amount: money?.amount ?? null,
      stage,
      notes: notes.join('\n'),
      city: row[projectCityCol] || '',
      equipment,
    });
    requireCondition(
      project.success,
      400,
      `Строка ${sourceRows[index]}: некорректные сведения проекта`,
    );
    const makeCompany = (
      name: string,
      inn: string,
      role?: string,
      geography: 'owner' | 'customer' | 'none' = 'none',
    ): ImportedCompany => {
      const city =
        geography === 'owner'
          ? row[cityCol] ||
            (!(ownerCol >= 0 && row[ownerCol]?.trim()) ? row[customerCityCol] || '' : '')
          : geography === 'customer'
            ? row[customerCityCol] || ''
            : '';
      const country =
        geography === 'owner'
          ? row[countryCol] ||
            (!(ownerCol >= 0 && row[ownerCol]?.trim()) ? row[customerCountryCol] || '' : '')
          : geography === 'customer'
            ? row[customerCountryCol] || ''
            : '';
      const region =
        geography === 'owner'
          ? row[regionCol] ||
            (!(ownerCol >= 0 && row[ownerCol]?.trim()) ? row[customerRegionCol] || '' : '')
          : geography === 'customer'
            ? row[customerRegionCol] || ''
            : '';
      const candidate = parseSingleCompanyTable(
        [
          ['Компания', 'ИНН', 'Город', 'Тип', 'Страна', 'Регион'],
          [name, inn, city, role || '', country, region],
        ],
        source,
        privacy,
      )[0]!;
      if (countryKey(candidate.data.country || '') !== 'ru') delete candidate.data.inn;
      const identity = {
        name: candidate.data.name.toLowerCase(),
        form: candidate.legalForm || '',
        inn: candidate.data.inn || undefined,
        country: countryKey(candidate.data.country || ''),
        city: candidate.data.city || '',
        region: (candidate.data.region || '').toLowerCase(),
      };
      const compatible = identities.filter((existing) => {
        if (existing.country !== identity.country) return false;
        if (existing.form && identity.form && existing.form !== identity.form) return false;
        if (existing.inn && identity.inn) return existing.inn === identity.inn;
        return (
          existing.name === identity.name &&
          (!existing.city || !identity.city || existing.city === identity.city) &&
          (!existing.region || !identity.region || existing.region === identity.region)
        );
      });
      let company = compatible.length === 1 ? compatible[0]!.company : undefined;
      if (!company) {
        company = candidate;
        company.source = `${source} · строка ${sourceRows[index]}`;
        company.raw = raw;
        company.sourceDate = sourceDate;
        identities.push({ ...identity, company });
        output.push(company);
      }
      if (compatible.length === 1) {
        const cached = compatible[0]!;
        if (!company.data.inn && identity.inn) company.data.inn = identity.inn;
        if (!company.data.city && candidate.data.city) company.data.city = candidate.data.city;
        if (!company.data.country && candidate.data.country)
          company.data.country = candidate.data.country;
        if (!company.data.region && candidate.data.region)
          company.data.region = candidate.data.region;
        if (!company.legalForm && identity.form) company.legalForm = identity.form;
        cached.inn ||= identity.inn;
        cached.form ||= identity.form;
        cached.city ||= identity.city;
        cached.region ||= identity.region;
      }
      if (role && !company.data.segment)
        company.data.segment = segments.find((s) => s === normalizedSegment(role));
      return company;
    };
    const owner = makeCompany(
      ownerName,
      ownerCol >= 0 && row[ownerCol]?.trim() ? row[innCol] || '' : row[customerInnCol] || '',
      ownerCol >= 0 && row[ownerCol]?.trim() ? row[segmentCol] || '' : 'Конечный заказчик',
      'owner',
    );
    const customerInn = normalizedInn(row[customerInnCol] || '');
    const customer = customerName
      ? makeCompany(customerName, row[customerInnCol] || '', 'Конечный заказчик', 'customer')
      : undefined;
    const customerCountry = (customer?.data.country || '').trim();
    const foreignCustomer = customerCountry && !/^(?:россия|рф|ru|russia)$/iu.test(customerCountry);
    const metadata = {
      data: project.data!,
      source: `${source} · строка ${sourceRows[index]}`,
      customerName: customerName || undefined,
      customerCountry: customerCountry || undefined,
      customerInn:
        !foreignCustomer && customerInn && validInn(customerInn) ? customerInn : undefined,
    };
    owner.projects ||= [];
    owner.projects.push(metadata);
    owner.warnings.push(...warnings);
    if (contacts.length) owner.contacts = [...(owner.contacts || []), ...contacts];

    for (const roleCol of roles)
      if (row[roleCol]?.trim()) {
        const role = headers[roleCol]!.trim(),
          participant = makeCompany(row[roleCol]!, '', role);
        if (participant === owner) continue;
        participant.projects ||= [];
        participant.projects.push({
          ...metadata,
          data: structuredClone(metadata.data),
          participantRole: role,
        });
        participant.warnings.push(...warnings);
      }
  }
  return output;
}

export function parseCompanyTable(
  rows: string[][],
  source: string,
  privacy: ImportPrivacyGuard,
  sourceRows?: number[],
  sourceDate?: string,
): ImportedCompany[] {
  let rowNumbers = sourceRows?.slice() || rows.map((_, index) => index + 1);
  requireCondition(
    rows.length <= 2000 && rows.every((r) => r.length <= 100),
    400,
    'Слишком сложная таблица',
  );
  let removed = false;
  let forbiddenColumns = new Set<number>();
  rows = rows.map((row) => {
    if (isTableHeader(row))
      forbiddenColumns = new Set(
        row.flatMap((value, col) =>
          sanitizeImportedCell(value) !== value ||
          /^(?:пароль|логин|паспорт|дата рождения|домашний адрес|здоровье|диагноз|password|login|api[_ -]?key|secret|токен|код доступа)$/iu.test(
            value.trim(),
          )
            ? [col]
            : [],
        ),
      );
    return row.map((value, col) => {
      const clean = forbiddenColumns.has(col) ? '' : sanitizeImportedCell(value);
      removed ||= clean !== value;
      return emptyCell(clean) ? '' : clean;
    });
  });
  // Collapse a two-level equipment header before locating actual data rows.
  for (let row = 0; row < rows.length - 1; row++) {
    const parent = rows[row]!,
      child = rows[row + 1]!;
    const nameCol = parent.findIndex(isNameHeader);
    if (
      nameCol < 0 ||
      (child[nameCol]?.trim() && child[nameCol] !== parent[nameCol]) ||
      !child.some((v) => /^(?:0[,.]4|6\s*[–—-]\s*35)(?:\s*кв)?$/iu.test(v.trim()))
    )
      continue;
    rows[row] = parent.map((v, col) => (child[col]?.trim() ? `${v} ${child[col]}`.trim() : v));
    rows.splice(row + 1, 1);
    rowNumbers.splice(row + 1, 1);
  }
  // Columns that are empty across the source separate independent side-by-side tables.
  const width = Math.max(0, ...rows.map((r) => r.length));
  const regions: [number, number][] = [];
  let first = -1;
  for (let col = 0; col <= width; col++) {
    const used = col < width && rows.some((r) => (r[col] || '').trim());
    if (used && first < 0) first = col;
    if (!used && first >= 0) {
      regions.push([first, col]);
      first = -1;
    }
  }
  const output: ImportedCompany[] = [];
  for (const [left, right] of regions) {
    const originalRegion = rows.map((r) => r.slice(left, right));
    const originalStarts = originalRegion.flatMap((row, i) => (isTableHeader(row) ? [i] : []));
    const layouts =
      originalStarts.length > 1
        ? originalStarts.map((start, i) => {
            const from = i === 0 ? 0 : start,
              end = originalStarts[i + 1] ?? originalRegion.length;
            return normalizeLayout(originalRegion.slice(from, end), rowNumbers.slice(from, end));
          })
        : [normalizeLayout(originalRegion, rowNumbers)];
    const layout = {
      rows: layouts.flatMap((l) => l.rows),
      sourceRows: layouts.flatMap((l) => l.sourceRows),
      warnings: [...new Set(layouts.flatMap((l) => l.warnings))],
    };
    const region = layout.rows;
    const regionRowNumbers = layout.sourceRows;
    const originalByRow = new Map(
      rowNumbers.map((number, index) => [number, originalRegion[index]!]),
    );
    const retainOriginal = (record: ImportedCompany, number: number) => {
      if (layout.warnings.length) {
        record.warnings.push(...layout.warnings);
        record.raw = {
          ...record.raw,
          ...Object.fromEntries(
            (originalByRow.get(number) || []).map((cell, i) => [`Исходная ячейка ${i + 1}`, cell]),
          ),
        };
      }
    };
    const starts = region.flatMap((row, i) => (isTableHeader(row) ? [i] : []));
    if (!starts.length) continue;
    region.slice(0, starts[0]).forEach((row) =>
      row.forEach((cell) => {
        privacy(cell);
        requireCondition(!/^\s*[=+@]/.test(cell), 400, 'Формулы запрещены');
      }),
    );
    for (let block = 0; block < starts.length; block++) {
      const start = starts[block]!,
        end = starts[block + 1] ?? region.length;
      const header = region[start]!.slice();
      if (projectColumn(header) >= 0) {
        const parsed = parseProjectTable(
          header,
          region.slice(start + 1, end),
          `${source} · проекты`,
          privacy,
          regionRowNumbers.slice(start + 1, end),
          sourceDate,
        );
        parsed.forEach((record) =>
          retainOriginal(record, Number(/строка (\d+)$/.exec(record.source)?.[1])),
        );
        if (removed)
          parsed.forEach((row) =>
            row.warnings.push('Запрещённые личные сведения или секреты удалены до сохранения.'),
          );
        output.push(...parsed);
        continue;
      }
      const nameCol = header.findIndex(isNameHeader);
      let segment = '';
      const segmentCol = header.findIndex((h) => aliases[normalize(h)] === 'segment');
      const contextCol = segmentCol >= 0 ? segmentCol : header.length;
      const data: string[][] = [];
      const extraContacts = new Map<number, ReturnType<typeof contactSchema.parse>[]>();
      const contactIndexes = header.flatMap((h, i) =>
        /^(?:контакты?|фио|контакт фио|контактное лицо|имя контакта|должность|позиция контакта|телефон(?:ы)?|phone|тел\.|e-?mail|почта|электронная почта)$/iu.test(
          h.trim(),
        )
          ? [i]
          : [],
      );
      const combinedContact = header.findIndex((h) => /^контакты?$/iu.test(h.trim()));
      const contactFields = [
        /^(?:фио|контакт фио|имя контакта|контактное лицо)$/iu,
        /^(?:должность|позиция контакта)$/iu,
        /^(?:телефон|телефоны|phone|тел\.)$/iu,
        /^(?:e-?mail|email|почта|электронная почта)$/iu,
      ].map((pattern) => header.findIndex((h) => pattern.test(h.trim())));

      const dataSourceRows: number[] = [];
      for (const [offset, original] of region.slice(start + 1, end).entries()) {
        const row = original.slice(),
          name = (row[nameCol] || '').trim();
        if (
          /^(?:итого|всего|общий итог|покупают|не покупают)(?:\s|:|$)/iu.test(name) ||
          !row.some((v) => v.trim())
        )
          continue;
        if (row.filter((v) => v.trim()).length === 1 && normalizedSegment(name)) {
          segment = normalizedSegment(name)!;
          continue;
        }
        if (!name) {
          // Only pure contact continuation rows inherit the preceding company.
          // Unrelated data without an identity must never be assigned by guesswork.
          if (
            data.length &&
            contactIndexes.length &&
            row.every((v, i) => !v.trim() || contactIndexes.includes(i))
          ) {
            const contacts =
              combinedContact >= 0
                ? parseBusinessContacts(row[combinedContact] || '', privacy)
                : [];
            if (contactFields[0]! >= 0 && (row[contactFields[0]!] || '').trim())
              contacts.push(
                ...parseBusinessContacts(contactFields.map((i) => row[i] || '').join(','), privacy),
              );
            if (contacts.length)
              extraContacts.set(data.length - 1, [
                ...(extraContacts.get(data.length - 1) || []),
                ...contacts,
              ]);
          }
          continue;
        }
        if (segment && !row[contextCol]) row[contextCol] = segment;
        data.push(row);
        dataSourceRows.push(regionRowNumbers[start + 1 + offset]!);
      }
      if (segmentCol < 0 && data.some((r) => r[contextCol])) header.push('Тип клиента');
      if (!data.length) continue;
      // The 100-company limit applies to actual rows, not preambles or skipped totals.
      const parsed = parseSingleCompanyTable(
        [header, ...data],
        `${source}${starts.length > 1 || regions.length > 1 ? ` · таблица ${block + 1}` : ''}`,
        privacy,
      );
      parsed.forEach((record, index) => {
        if (extraContacts.has(index))
          record.contacts = [...(record.contacts || []), ...extraContacts.get(index)!];
        record.source = record.source.replace(/строка \d+$/, `строка ${dataSourceRows[index]}`);
        retainOriginal(record, dataSourceRows[index]!);
      });
      if (removed)
        parsed.forEach((r) =>
          r.warnings.push('Запрещённые личные сведения или секреты удалены до сохранения.'),
        );
      output.push(...parsed);
    }
  }
  requireCondition(
    output.length && output.length <= companyImportLimits.rows,
    400,
    'Нужно от 1 до 100 компаний с заголовком «Компания»',
  );
  return output;
}
function parseSingleCompanyTable(
  rows: string[][],
  source: string,
  privacy: ImportPrivacyGuard,
): ImportedCompany[] {
  requireCondition(
    rows.length > 1 &&
      rows.length <= companyImportLimits.rows + companyImportLimits.preambleRows + 1,
    400,
    'Таблица должна содержать заголовок и до 100 компаний',
  );
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => aliases[normalize(cell)] === 'name'),
  );
  requireCondition(
    headerIndex >= 0 && headerIndex <= companyImportLimits.preambleRows,
    400,
    'Нужна колонка «Название компании» в первых 21 строках',
  );
  requireCondition(
    rows.every(
      (row) =>
        row.length <= companyImportLimits.columns &&
        row.every((value) => value.length <= companyImportLimits.cell),
    ),
    400,
    'Таблица превышает лимит колонок или размера ячейки',
  );
  // Validate discarded preamble too; it is untrusted source text.
  rows.slice(0, headerIndex).forEach((row) =>
    row.forEach((cell) => {
      privacy(cell);
      requireCondition(!/^\s*[=+@]/.test(cell), 400, 'Формулы запрещены');
    }),
  );
  rows = rows.slice(headerIndex);
  requireCondition(
    rows.slice(1).filter((row) => row.some((value) => value.trim())).length <=
      companyImportLimits.rows,
    400,
    'Таблица должна содержать до 100 компаний',
  );
  const originalHeaders = rows[0]!;
  const contactColumn = originalHeaders.findIndex((h) => /^(?:контакты|контакт)$/iu.test(h.trim()));
  const fieldColumn = (pattern: RegExp) => originalHeaders.findIndex((h) => pattern.test(h.trim()));
  const personCol = fieldColumn(/^(?:фио|контакт фио|имя контакта|контактное лицо)$/iu);
  const roleCol = fieldColumn(/^(?:должность|позиция контакта)$/iu);
  const phoneCol = fieldColumn(/^(?:телефон|телефоны|phone|тел\.)$/iu);
  const emailCol = fieldColumn(/^(?:e-?mail|email|почта|электронная почта)$/iu);
  const cityCol = originalHeaders.findIndex((h) => aliases[normalize(h)] === 'city');
  const contactColumns = new Set(
    [contactColumn, personCol, roleCol, phoneCol, emailCol].filter((i) => i >= 0),
  );
  const originalRows = rows;
  const contactRows = rows.slice(1).map((row) => {
    const contacts =
      contactColumn >= 0
        ? parseBusinessContacts(row[contactColumn] || '', privacy, row[cityCol] || '')
        : [];
    if (personCol >= 0 && row[personCol]?.trim())
      contacts.push(
        ...parseBusinessContacts(
          [row[personCol] || '', row[roleCol] || '', row[phoneCol] || '', row[emailCol] || ''].join(
            ',',
          ),
          privacy,
          row[cityCol] || '',
        ),
      );
    return contacts;
  });
  const safeRows = rows.map((row) =>
    row.map((value, col) => (contactColumns.has(col) ? '' : value)),
  );
  rows = safeRows;
  for (const row of rows) {
    requireCondition(
      row.length <= companyImportLimits.columns,
      400,
      'В таблице слишком много колонок',
    );
    for (const value of row) {
      requireCondition(
        value.length <= companyImportLimits.cell,
        400,
        'Слишком длинное значение в таблице',
      );
      privacy(value);
      requireCondition(!/^\s*[=+@]/.test(value), 400, 'Формулы в импортируемой таблице запрещены');
    }
  }
  const header = rows[0]!.map(normalize),
    mapped = header.map((h) => aliases[h]);
  requireCondition(mapped.includes('name'), 400, 'Нужна колонка «Название компании»');
  requireCondition(
    new Set(mapped.filter(Boolean)).size === mapped.filter(Boolean).length,
    400,
    'Колонки с одним значением не должны повторяться',
  );
  requireCondition(
    !header.some((h) =>
      /(?:телефон|phone|email|e mail|почта|контакт|фио|паспорт|дата рождения|домашн|health|здоров)/i.test(
        h,
      ),
    ),
    400,
    'Колонки с личными данными не поддерживаются',
  );
  const unknown = header.filter((h, i) => h && !mapped[i]);
  const moneyColumns = new Map<number, ReturnType<typeof normalizedMoneyColumn>>();
  mapped.forEach((field, col) => {
    if (field && (field === 'potential' || field === 'revenue' || field.startsWith('division:')))
      moneyColumns.set(
        col,
        normalizedMoneyColumn(
          rows.slice(1).map((row) => row[col] || ''),
          rows[0]![col] || '',
        ),
      );
  });
  const result: ImportedCompany[] = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]!;
    if (!row.some((v) => v.trim()) && !contactRows[index - 1]?.length) continue;
    const data: any = {};
    const rowWarnings: string[] = [],
      rangeNotes: string[] = [...contactColumns].flatMap((col) =>
        safeContactInstructions(originalRows[index]?.[col] || '', privacy),
      );
    let legalForm: string | undefined;
    mapped.forEach((field, col) => {
      const value = (row[col] || '').trim();
      if (!field || !value) return;
      if (field === 'segment') {
        const key =
          normalizedSegment(value) ||
          segments.find((s) => s === value || normalize(labels[s] || s) === normalize(value));
        if (key) data.segment = key;
        if (!key) {
          if (
            /^(?:энергетика|нефтегаз|нефтехимия|металлургия|горнодобывающая промышленность|химическая промышленность)$/iu.test(
              value,
            )
          )
            data.industry ||= value;
          else rangeNotes.push(`Тип из источника: ${value}`);
          rowWarnings.push('Тип из источника сохранён без предположения о роли клиента');
        }
      } else if (field === 'stage') {
        const key = stages.find(
          (s) => s === value || normalize(labels[s] || s) === normalize(value),
        );
        if (key) data.stage = key;
        else rowWarnings.push('Неизвестная стадия пропущена');
      } else if (field === 'potential' || field === 'revenue' || field.startsWith('division:')) {
        const money = moneyColumns.get(col)![index - 1]!;
        if (money.warning) rowWarnings.push(`${rows[0]![col]}: ${money.warning}`);
        if (money.note) rangeNotes.push(`${rows[0]![col]}: ${money.note}`);
        if (money.amount === undefined) return;
        if (field.startsWith('division:')) {
          data.divisions ??= {};
          data.divisions[field.slice(9)] = money.amount;
        } else data[field] = money.amount;
      } else if (field === 'inn') {
        const inn = normalizedInn(value);
        if (inn) data.inn = inn;
        else rowWarnings.push('Некорректный ИНН пропущен');
      } else if (field === 'name') {
        legalForm = importedLegalForm(value);
        if (legalForm) data.legalForm = legalForm;
        const extracted = extractCompanyNameCell(value);
        for (const [key, fact] of Object.entries(extracted))
          if (data[key] === undefined || key === 'name') data[key] = fact;
      } else if (field === 'city') {
        const [city, ...region] = value.split(',').map((v) => v.trim());
        data.city = normalizedCity(city!);
        if (region.length) data.region = region.join(', ');
      } else data[field] = value;
    });
    const additional = header.flatMap((h, col) =>
      !mapped[col] &&
      /(?:комментар|примечан|заметк|действи|вопрос|следующий шаг|менеджер|моп|якорн)/iu.test(h) &&
      row[col]?.trim()
        ? [`${/(?:менеджер|моп)/iu.test(h) ? 'Вёл' : originalHeaders[col]}: ${row[col]}`]
        : [],
    );
    if (additional.length)
      data.notes = [data.notes || '', ...additional].filter(Boolean).join('\n').slice(0, 5000);
    if (rangeNotes.length)
      data.notes = [data.notes || '', ...rangeNotes].filter(Boolean).join('\n').slice(0, 5000);
    requireCondition(
      typeof data.name === 'string' && data.name.trim(),
      400,
      `Строка ${index + 1}: нет названия компании`,
    );
    const originalName =
      originalRows[index]?.[mapped.findIndex((field) => field === 'name')] || data.name;
    const holding = classifyHoldingMention(originalName);
    const eligibleHolding =
      (!data.country || /^(?:россия|рф|ru|russia)$/iu.test(data.country)) &&
      (!data.segment || data.segment === 'holding' || data.segment === 'end_client');
    if (holding.isHolding && eligibleHolding && !data.inn) {
      data.segment = 'holding';
    }
    if (holding.companyName && eligibleHolding) data.name = holding.companyName;
    if (holding.sites?.length) data.sites = holding.sites;
    if (holding.holdingName && !holding.isHolding && eligibleHolding) data.segment = 'end_client';
    const checked = companySchema.safeParse(data);
    requireCondition(
      checked.success,
      400,
      `Строка ${index + 1}: проверьте ИНН, размеры и значения полей`,
    );
    result.push({
      source: `${source} · строка ${index + headerIndex + 1}`,
      ...(legalForm ? { legalForm } : {}),
      ...(holding.holdingName && eligibleHolding && !holding.isHolding
        ? { holdingName: holding.holdingName }
        : {}),
      data,
      raw: Object.fromEntries(
        originalHeaders.map((h, col) => [
          h || `Колонка ${col + 1}`,
          originalRows[index]?.[col] || '',
        ]),
      ),
      missing: baseFields
        .filter((f) => data[f] === undefined)
        .map(
          (f) =>
            ({
              name: 'Название',
              inn: 'ИНН',
              city: 'Город',
              segment: 'Тип',
              industry: 'Отрасль',
              potential: 'Потенциал',
              stage: 'Стадия',
              revenue: 'Выручка',
              notes: 'Заметки',
              website: 'Сайт',
              country: 'Страна',
              region: 'Регион',
            })[f],
        ),
      warnings: [
        ...rowWarnings,
        ...(unknown.length
          ? [`Не импортированы колонки: ${unknown.length} (${unknown.join(', ').slice(0, 400)})`]
          : []),
      ],
      ...(contactRows[index - 1]?.length ? { contacts: contactRows[index - 1] } : {}),
    });
  }
  requireCondition(result.length, 400, 'В таблице нет компаний');
  return result;
}
function csv(text: string): string[][] {
  const lines = text.split(/\r?\n/, companyImportLimits.preambleRows + 1);
  let delimiter = '';
  for (const line of lines) {
    const candidate = ['\t', ';', ','].find((separator) =>
      line
        .split(separator)
        .some(
          (cell) =>
            isNameHeader(cell.trim().replace(/^"|"$/g, '')) ||
            projectColumn([cell.trim().replace(/^"|"$/g, '')]) >= 0,
        ),
    );
    if (candidate) {
      delimiter = candidate;
      break;
    }
  }
  const first = lines[0] || '';
  delimiter ||= first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',';
  const rows: string[][] = [],
    row: string[] = [];
  let cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        requireCondition(quoted || !cell, 400, 'Некорректные кавычки в CSV');
        quoted = !quoted;
      }
    } else if (!quoted && (c === delimiter || c === '\n' || c === '\r')) {
      row.push(cell);
      cell = '';
      if (c !== delimiter) {
        rows.push([...row]);
        row.length = 0;
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
      requireCondition(
        rows.length <= 2000 && row.length <= companyImportLimits.columns,
        400,
        'Таблица превышает лимит строк или колонок',
      );
    } else cell += c;
    requireCondition(cell.length <= 1000, 400, 'Слишком длинное значение в таблице');
  }
  requireCondition(!quoted, 400, 'Незакрытые кавычки в CSV');
  if (cell || row.length) {
    row.push(cell);
    rows.push([...row]);
  }
  return rows;
}
async function unzip(
  bytes: Buffer,
  policy: 'xlsx' | 'docx' | 'ods' = 'xlsx',
): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    let zip: ZipFile | undefined,
      total = 0,
      count = 0,
      finished = false;
    const out = new Map<string, string>();
    const fail = (e: unknown) => {
      if (finished) return;
      finished = true;
      zip?.close();
      reject(e instanceof DomainError ? e : new DomainError(400, 'Повреждённый XLSX'));
    };
    const timer = setTimeout(() => fail(new DomainError(400, 'Таблица слишком сложная')), 5000);
    const doneFail = (e: unknown) => {
      clearTimeout(timer);
      fail(e);
    };
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, file) => {
        if (error || !file) return doneFail(error);
        zip = file;
        file.on('error', doneFail);
        file.on('end', () => {
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            resolve(out);
          }
        });
        file.on('entry', (entry: Entry) => {
          try {
            requireCondition(
              policy !== 'ods' || !/(?:^|\/)(?:Basic|Scripts)\//i.test(entry.fileName),
              400,
              'Макросы ODS запрещены',
            );
            requireCondition(
              ++count <= 100 && entry.uncompressedSize <= companyImportLimits.expanded,
              400,
              'XLSX превышает лимиты',
            );
            requireCondition(
              !(entry.generalPurposeBitFlag & 1) &&
                !entry.fileName.includes('..') &&
                !/vbaProject|externalLinks|\.bin$/i.test(entry.fileName),
              400,
              'Макросы и внешние ссылки запрещены',
            );
            requireCondition(!out.has(entry.fileName), 400, 'Повторяющаяся часть XLSX');
            requireCondition(
              total + entry.uncompressedSize <= companyImportLimits.expanded,
              400,
              'Слишком большой распакованный XLSX',
            );
            requireCondition(
              entry.uncompressedSize / Math.max(1, entry.compressedSize) <= 100,
              400,
              'Слишком высокая степень сжатия XLSX',
            );
            file.openReadStream(entry, (err, stream) => {
              if (err || !stream) return doneFail(err);
              const chunks: Buffer[] = [];
              let length = 0;
              stream.on('error', doneFail);
              stream.on('data', (chunk: Buffer) => {
                length += chunk.length;
                total += chunk.length;
                if (total > companyImportLimits.expanded) {
                  stream.destroy();
                  doneFail(new DomainError(400, 'Слишком большой распакованный XLSX'));
                } else chunks.push(chunk);
              });
              stream.on('end', () => {
                if (finished) return;
                try {
                  requireCondition(length === entry.uncompressedSize, 400, 'Повреждённый XLSX');
                  const content = Buffer.concat(chunks).toString('utf8');
                  if (entry.fileName.endsWith('.xml') || entry.fileName.endsWith('.rels')) {
                    if (/TargetMode\s*=\s*["']External/i.test(content)) {
                      const relationships =
                        policy === 'docx' && entry.fileName.endsWith('.rels')
                          ? arr(xml(content).Relationships?.Relationship)
                          : [];
                      requireCondition(
                        relationships.length > 0 &&
                          relationships.every(
                            (r) =>
                              r['@_TargetMode'] !== 'External' ||
                              (String(r['@_Type']).endsWith('/hyperlink') &&
                                /^(?:https?:|mailto:)/i.test(String(r['@_Target']))),
                          ),
                        400,
                        'Внешние связи и объекты не поддерживаются',
                      );
                    }
                    out.set(entry.fileName, content);
                  }
                  file.readEntry();
                } catch (e) {
                  doneFail(e);
                }
              });
            });
          } catch (e) {
            doneFail(e);
          }
        });
        file.readEntry();
      },
    );
  });
}
export async function parseCompanyImport(
  bytes: Uint8Array,
  format: 'xlsx' | 'csv' | 'txt' | 'docx' | 'ods',
  privacy: ImportPrivacyGuard,
  sourceDate?: string,
): Promise<ImportedCompany[]> {
  requireCondition(
    bytes.length > 0 && bytes.length <= companyImportLimits.bytes,
    413,
    'Файл должен быть не больше 2 МБ',
  );
  if (format === 'docx') return parseGoogleDocx(Buffer.from(bytes), privacy);
  if (format === 'ods')
    return parseOdsImport(await unzip(Buffer.from(bytes), 'ods'), privacy, sourceDate);
  if (format !== 'xlsx') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new DomainError(400, 'Отправьте текст в кодировке UTF-8');
    }
    if (
      format === 'csv' ||
      /^(?:название(?: компании)?|наименование|компания|name|company|проект|объект|заказчик)[\t;,]/i.test(
        text.trim(),
      )
    )
      return parseCompanyTable(csv(text), 'Таблица', privacy, undefined, sourceDate);
    if (!text.includes(':'))
      return parseCompanyTable(
        [
          ['name'],
          ...text
            .trim()
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => [line.trim()]),
        ],
        'Документ',
        privacy,
      );
    const blocks = text.trim().split(/\r?\n\s*\r?\n/);
    requireCondition(
      blocks.length <= companyImportLimits.rows,
      400,
      'Документ должен содержать до 100 компаний',
    );
    const companies: ImportedCompany[] = [];
    for (const [index, block] of blocks.entries()) {
      // Retain each original header: it carries monetary units and division identity.
      // A block is normalized separately because another company may use different units.
      const headers: string[] = [],
        values: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        const match = /^([^:]{1,80}):\s*(.*)$/.exec(line);
        requireCondition(
          match,
          400,
          'Google Docs: используйте строки «Название: …», «ИНН: …» и пустую строку между компаниями',
        );
        headers.push(match[1]!);
        values.push(match[2]!);
      }
      const parsed = parseCompanyTable([headers, values], 'Документ', privacy);
      companies.push(
        ...parsed.map((company) => ({ ...company, source: `Документ · блок ${index + 1}` })),
      );
    }
    return companies;
  }
  const parts = await unzip(Buffer.from(bytes));
  const template = parsePicoTemplate(parts, privacy);
  if (template) return template;
  return parseGenericXlsx(parts, privacy, sourceDate);
}
function excelColumn(value: string) {
  return [...value].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}
function parseGenericXlsx(
  parts: Map<string, string>,
  privacy: ImportPrivacyGuard,
  contextDate?: string,
): ImportedCompany[] {
  requireCondition(parts.has('xl/workbook.xml'), 400, 'Это не XLSX-книга');
  const shared = arr(xml(parts.get('xl/sharedStrings.xml') || '<sst/>').sst?.si).map(textNode);
  const workbook = xml(parts.get('xl/workbook.xml')!).workbook;
  const hidden = new Set(
    arr(workbook?.sheets?.sheet)
      .filter((sh) => sh['@_state'] === 'hidden' || sh['@_state'] === 'veryHidden')
      .map((sh) => String(sh['@_id'])),
  );
  const relationships = arr(
    xml(parts.get('xl/_rels/workbook.xml.rels') || '<Relationships/>').Relationships?.Relationship,
  );
  const hiddenPaths = new Set(
    relationships
      .filter((r) => hidden.has(String(r['@_Id'])))
      .map((r) => 'xl/' + String(r['@_Target']).replace(/^\/?xl\//, '')),
  );
  const sheets = [...parts.keys()]
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path) && !hiddenPaths.has(path))
    .sort();
  const result: ImportedCompany[] = [];
  let sourceDate = contextDate;
  const core = parts.get('docProps/core.xml');
  if (core) {
    const date = xml(core).coreProperties?.modified;
    if (
      typeof date === 'string' &&
      /^\d{4}-\d{2}-\d{2}T/.test(date) &&
      Number.isFinite(Date.parse(date))
    )
      sourceDate = date;
  }
  let skipped = 0;
  for (const [index, path] of sheets.entries()) {
    const sheet = xml(parts.get(path)!).worksheet;
    const rows = new Map<number, string[]>();
    const hiddenRows = new Set<number>();
    for (const row of arr(sheet?.sheetData?.row)) {
      const number = Number(row['@_r']);
      requireCondition(
        Number.isInteger(number) && number > 0 && number <= 1000000,
        400,
        'Некорректная строка XLSX',
      );
      if (String(row['@_hidden']) === '1' || String(row['@_hidden']) === 'true') {
        hiddenRows.add(number);
        continue;
      }
      const rowCells = arr(row.c);
      if (
        rowCells.some((cell) =>
          /^(?:итого|всего|общий итог)(?:\s|:|$)/iu.test(
            cell['@_t'] === 's'
              ? shared[Number(cell.v)] || ''
              : cell['@_t'] === 'inlineStr'
                ? textNode(cell.is)
                : textNode(cell.v),
          ),
        )
      )
        continue;
      const cells: string[] = [];
      for (const cell of rowCells) {
        requireCondition(cell.f === undefined, 400, 'Формулы в XLSX запрещены; сохраните значения');
        const ref = /^([A-Z]+)\d+$/.exec(cell['@_r'] || '');
        requireCondition(ref, 400, 'Некорректная ячейка XLSX');
        const col = excelColumn(ref[1]!);
        requireCondition(col < 100, 400, 'В таблице слишком много колонок');
        const value =
          cell['@_t'] === 's'
            ? shared[Number(cell.v)]
            : cell['@_t'] === 'inlineStr'
              ? textNode(cell.is)
              : textNode(cell.v);
        requireCondition(
          value !== undefined && cells[col] === undefined,
          400,
          'Повреждённая или повторяющаяся ячейка XLSX',
        );
        cells[col] = value;
      }
      rows.set(
        number,
        Array.from({ length: cells.length }, (_, col) => cells[col] || ''),
      );
      requireCondition(rows.size <= 2000, 400, 'Слишком много строк в таблице');
    }
    let expandedCells = 0;
    const mergedRanges = arr(sheet?.mergeCells?.mergeCell);
    requireCondition(mergedRanges.length <= 500, 400, 'Слишком много объединённых диапазонов');
    for (const merge of mergedRanges) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(merge['@_ref'] || '');
      requireCondition(m, 400, 'Некорректный объединённый диапазон');
      const left = excelColumn(m[1]!),
        right = excelColumn(m[3]!),
        top = Number(m[2]),
        bottom = Number(m[4]);
      requireCondition(
        right >= left &&
          right < 100 &&
          bottom >= top &&
          bottom - top < 2000 &&
          (right - left + 1) * (bottom - top + 1) <= 6000,
        400,
        'Слишком большой объединённый диапазон',
      );
      expandedCells += (right - left + 1) * (bottom - top + 1);
      requireCondition(expandedCells <= 30000, 400, 'Слишком много объединённых ячеек');
      if (hiddenRows.has(top)) continue;
      const value = rows.get(top)?.[left] || '';
      for (let r = top; r <= bottom; r++) {
        if (hiddenRows.has(r)) continue;
        const values = rows.get(r) || [];
        requireCondition(
          rows.has(r) || rows.size < 2000,
          400,
          'Слишком много строк после раскрытия ячеек',
        );
        rows.set(r, values);
        for (let c = left; c <= right; c++) if (!values[c]) values[c] = value;
      }
    }
    const orderedRows = [...rows].sort(([a], [b]) => a - b);
    const tableRows = orderedRows.map(([, row]) => row);
    if (!tableRows.some(isTableHeader)) {
      skipped++;
      continue;
    }
    result.push(
      ...parseCompanyTable(
        tableRows,
        `XLSX · лист ${index + 1}`,
        privacy,
        orderedRows.map(([number]) => number),
        sourceDate,
      ),
    );
  }
  requireCondition(
    result.length > 0 && result.length <= 100,
    400,
    'В книге нужны таблицы с колонкой «Компания», до 100 компаний',
  );
  if (skipped)
    result.forEach((row) => row.warnings.push(`Пропущено листов без таблицы компаний: ${skipped}`));
  if (core) {
    const date = xml(core).coreProperties?.modified;
    if (
      typeof date === 'string' &&
      /^\d{4}-\d{2}-\d{2}T/.test(date) &&
      Number.isFinite(Date.parse(date))
    )
      result.forEach((row) => (row.sourceDate = date));
  }
  return result;
}
function parseOdsImport(
  parts: Map<string, string>,
  privacy: ImportPrivacyGuard,
  contextDate?: string,
): ImportedCompany[] {
  requireCondition(
    parts.has('content.xml') &&
      ![...parts.keys()].some((k) => /(?:^|\/)(?:Basic|Scripts)\//i.test(k)),
    400,
    'Нужна ODS-таблица без макросов',
  );
  const content = parts.get('content.xml')!;
  xml(content); // Shared XML complexity/entity checks apply before the ordered representation.
  const ordered = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    preserveOrder: true,
    parseTagValue: false,
    processEntities: false,
    trimValues: false,
  }).parse(content);
  const collect = (nodes: any[], key: string): any[] =>
    nodes.flatMap((node) =>
      Object.entries(node).flatMap(([name, children]) =>
        name === key
          ? [node]
          : name !== ':@' && Array.isArray(children)
            ? collect(children, key)
            : [],
      ),
    );
  const text = (nodes: any[]): string =>
    nodes
      .map((node) =>
        Object.entries(node)
          .filter(([key]) => key !== ':@')
          .map(([key, value]) =>
            key === '#text'
              ? entity(String(value))
              : key === 'line-break' || key === 'p'
                ? (Array.isArray(value) ? text(value) : '') + '\n'
                : key === 'tab'
                  ? '\t'
                  : key === 's'
                    ? ' '.repeat(Math.min(100, Math.max(1, Number(node[':@']?.['@_c'] || 1))))
                    : Array.isArray(value)
                      ? text(value)
                      : '',
          )
          .join(''),
      )
      .join('');
  const styleTrees = [ordered];
  if (parts.has('styles.xml')) {
    xml(parts.get('styles.xml')!);
    styleTrees.push(
      new XMLParser({
        ignoreAttributes: false,
        removeNSPrefix: true,
        preserveOrder: true,
        processEntities: false,
      }).parse(parts.get('styles.xml')!),
    );
  }
  const hiddenStyles = new Set<string>();
  for (const tree of styleTrees)
    for (const style of collect(tree, 'style')) {
      if (
        collect(style.style || [], 'table-properties').some(
          (property) => property[':@']?.['@_display'] === 'false',
        )
      )
        hiddenStyles.add(style[':@']?.['@_name']);
    }
  const result: ImportedCompany[] = [];
  for (const [index, tableNode] of collect(ordered, 'table').entries()) {
    const attrs = tableNode[':@'] || {},
      table = tableNode.table || [];
    if (
      attrs['@_display'] === 'false' ||
      attrs['@_visibility'] === 'collapse' ||
      hiddenStyles.has(attrs['@_style-name'])
    )
      continue;
    requireCondition(
      !collect(table, 'table').length,
      400,
      'Вложенные таблицы ODS не поддерживаются',
    );
    const rows: string[][] = [];
    const spans = new Map<number, Map<number, string>>();
    let rowIndex = 0,
      expanded = 0;
    for (const rowNode of collect(table, 'table-row')) {
      const rowAttrs = rowNode[':@'] || {},
        row = rowNode['table-row'] || [];
      const values: string[] = [];
      let col = 0;
      for (const cellNode of row) {
        const covered = cellNode['covered-table-cell'] !== undefined;
        if (!covered && cellNode['table-cell'] === undefined) continue;
        const cellAttrs = cellNode[':@'] || {};
        requireCondition(
          cellAttrs['@_formula'] === undefined,
          400,
          'Формулы в ODS запрещены; сохраните значения',
        );
        const value = covered
          ? spans.get(rowIndex)?.get(col) || ''
          : text(cellNode['table-cell'] || []) ||
            String(
              cellAttrs['@_string-value'] ??
                cellAttrs['@_value'] ??
                cellAttrs['@_date-value'] ??
                '',
            );
        const repeated = Number(cellAttrs['@_number-columns-repeated'] || 1);
        requireCondition(
          Number.isInteger(repeated) && repeated > 0,
          400,
          'Повреждённая ODS-таблица',
        );
        if (!value && repeated + col > 100) break;
        requireCondition(repeated + col <= 100, 400, 'Слишком много колонок ODS');
        const wide = Number(cellAttrs['@_number-columns-spanned'] || 1),
          high = Number(cellAttrs['@_number-rows-spanned'] || 1);
        requireCondition(
          Number.isInteger(wide) &&
            Number.isInteger(high) &&
            wide > 0 &&
            high > 0 &&
            wide <= 100 &&
            high <= 2000 &&
            col + wide <= 100,
          400,
          'Некорректное объединение ODS',
        );
        expanded += wide * high * repeated;
        requireCondition(expanded <= 30000, 400, 'Слишком много объединённых ячеек ODS');
        for (let n = 0; n < repeated; n++, col++) {
          values[col] = covered ? spans.get(rowIndex)?.get(col) || '' : value;
          if (!covered && (wide > 1 || high > 1))
            for (let r = rowIndex; r < rowIndex + high; r++) {
              const inherited = spans.get(r) || new Map<number, string>();
              spans.set(r, inherited);
              for (let c = col; c < col + wide; c++) inherited.set(c, value);
            }
        }
      }
      const repeated = Number(rowAttrs['@_number-rows-repeated'] || 1);
      const empty = !values.some((v) => v.trim());
      if (empty && repeated > 2000) {
        rowIndex++;
        continue;
      }
      requireCondition(
        Number.isInteger(repeated) && repeated > 0 && rowIndex + repeated <= 2000,
        400,
        'Слишком много строк ODS',
      );
      for (let n = 0; n < repeated; n++, rowIndex++) {
        if (rowAttrs['@_visibility'] === 'collapse' || rowAttrs['@_visibility'] === 'filter')
          continue;
        const inherited = spans.get(rowIndex);
        const copy = values.slice();
        if (inherited) for (const [c, value] of inherited) if (!copy[c]) copy[c] = value;
        rows.push(copy);
        spans.delete(rowIndex);
      }
    }
    if (rows.some(isTableHeader))
      result.push(
        ...parseCompanyTable(rows, `ODS · лист ${index + 1}`, privacy, undefined, contextDate),
      );
  }
  requireCondition(
    result.length > 0 && result.length <= 100,
    400,
    'В ODS нужна таблица компаний, до 100 строк',
  );
  return result;
}
export async function fetchPublicGoogleDocument(
  raw: string,
  format: 'txt' | 'docx' = 'txt',
): Promise<Uint8Array> {
  requireCondition(
    /^https:\/\/docs\.google\.com\/document\//.test(raw),
    400,
    'Нужна публичная ссылка Google Docs',
  );
  return fetchGoogleExport(raw, format);
}
export async function fetchPublicGoogleImport(
  raw: string,
): Promise<{ bytes: Uint8Array; format: 'docx' | 'xlsx' }> {
  const format = /^https:\/\/docs\.google\.com\/document\//i.test(raw) ? 'docx' : 'xlsx';
  const bytes = await fetchGoogleExport(raw, format);
  requireCondition(
    bytes[0] === 0x50 && bytes[1] === 0x4b,
    400,
    'Google не вернул файл. Откройте доступ по ссылке (Читатель) или пришлите экспорт',
  );
  return { bytes, format };
}
async function fetchGoogleExport(
  raw: string,
  format: 'txt' | 'docx' | 'xlsx',
): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError(400, 'Нужна публичная ссылка Google Docs');
  }
  requireCondition(
    url.protocol === 'https:' &&
      ['docs.google.com', 'drive.google.com'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port,
    400,
    'Поддерживаются только публичные Google Docs',
  );
  const documentMatch =
    /^\/document\/d\/([A-Za-z0-9_-]{10,200})(?:\/edit|\/export|\/view)?\/?$/.exec(url.pathname);
  const sheetMatch =
    /^\/spreadsheets\/d\/([A-Za-z0-9_-]{10,200})(?:\/edit|\/export|\/view|\/htmlview)?\/?$/.exec(
      url.pathname,
    );
  const fileMatch = /^\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/view)?\/?$/.exec(url.pathname);
  requireCondition(
    (url.hostname === 'docs.google.com' && (documentMatch || sheetMatch)) ||
      (url.hostname === 'drive.google.com' && fileMatch),
    400,
    'Отправьте обычную ссылку Google Docs, Sheets или файл XLSX на Drive',
  );
  requireCondition(
    [...url.searchParams.keys()].every((k) => ['usp', 'format', 'gid', 'tab'].includes(k)),
    400,
    'Используйте обычную ссылку без токенов доступа',
  );
  const hostname = fileMatch ? 'drive.usercontent.google.com' : 'docs.google.com';
  const exportPath = fileMatch
    ? `/download?id=${fileMatch[1]}&export=download`
    : sheetMatch
      ? `/spreadsheets/d/${sheetMatch[1]}/export?format=xlsx`
      : `/document/d/${documentMatch![1]}/export?format=${format}`;
  const ips = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DomainError(400, 'Адрес документа недоступен')),
      5000,
    );
    lookup(hostname, { all: true, family: 4 }).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        clearTimeout(timer);
        reject(new DomainError(400, 'Адрес документа недоступен'));
      },
    );
  });
  const publicIp = (ip: string) => {
    const p = ip.split('.').map(Number);
    return (
      p.length === 4 &&
      p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      p[0] !== 0 &&
      p[0] !== 10 &&
      p[0] !== 127 &&
      p[0]! >= 1 &&
      p[0]! < 224 &&
      !(p[0] === 169 && p[1] === 254) &&
      !(p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) &&
      !(p[0] === 192 && p[1] === 168) &&
      !(p[0] === 100 && p[1]! >= 64 && p[1]! <= 127) &&
      !(p[0] === 192 && p[1] === 0) &&
      !(p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51)) &&
      !(p[0] === 203 && p[1] === 0 && p[2] === 113)
    );
  };
  requireCondition(
    ips.length && ips.every((ip) => publicIp(ip.address)),
    400,
    'Адрес документа недоступен',
  );
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      req.destroy();
      fail();
    }, 10000);
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(
        new DomainError(
          400,
          'Документ недоступен. Откройте доступ по ссылке (Читатель) или пришлите файл XLSX, ODS, CSV или DOCX',
        ),
      );
    };
    const req = request(
      {
        hostname,
        path: exportPath,
        method: 'GET',
        timeout: 10000,
        family: 4,
        lookup: (_host, _opts, callback) => callback(null, ips[0]!.address, 4),
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !(
            format === 'txt'
              ? /^text\/plain(?:;|$)/i
              : format === 'xlsx'
                ? /^(?:application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/octet-stream)(?:;|$)/i
                : /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document(?:;|$)/i
          ).test(String(res.headers['content-type'] || ''))
        ) {
          req.destroy();
          return fail();
        }
        const chunks: Buffer[] = [];
        let length = 0;
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > companyImportLimits.bytes) {
            req.destroy();
            fail();
          } else chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('end', () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      fail();
    });
    req.on('error', fail);
    req.end();
  });
}

// Business contacts are allowed only in this structured local import channel.
// Check the same privacy policy on names/roles and all residual text, never send to AI.
const contactDirective =
  /^(?:уточнить|спросить|созвониться|созванивался|запросить|узнать|обратиться|связаться|контакт\s+уточнить)\s/iu;
function safeContactInstructions(value: string, privacy: ImportPrivacyGuard): string[] {
  return value.split(/\r?\n|;/u).flatMap((line) => {
    line = line.trim();
    if (!contactDirective.test(line) || containsEmail(line) || normalizedPhones(line).length)
      return [];
    try {
      privacy(line);
      return [`Контакты — примечание: ${line}`];
    } catch {
      return [];
    }
  });
}
export function parseBusinessContacts(value: string, privacy: ImportPrivacyGuard, city = '') {
  requireCondition(value.length <= 1000, 400, 'Слишком длинное поле контактов');
  const clean = sanitizeImportedCell(value);
  const lines = clean.split(/\r?\n|;(?=\s*[А-ЯЁA-Z])/u).filter((v) => v.trim());
  requireCondition(lines.length <= 10, 400, 'До 10 контактов на компанию');
  const result: ReturnType<typeof contactSchema.parse>[] = [];
  for (const line of lines) {
    const fields = line.split(',').map((v) => v.trim());
    const structured = fields.length === 4;
    let name = structured ? fields[0]! : '',
      role = structured ? fields[1]! : '';
    const emailMatch =
      line.match(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi) || [];
    const email = (structured ? fields[3]! : emailMatch[0] || '').trim().toLowerCase();
    const phones = normalizedPhones(structured ? fields[2]! : line, city);
    if (!phones.length && !email && contactDirective.test(line.trim())) continue;
    if (!structured) {
      const residual = line
        .replace(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, '')
        .replace(/(?:доб(?:авочный)?\.?|ext\.?|#)\s*\d{1,20}/giu, '')
        .replace(/\+?\d[\d\s()./–—-]{5,}\d/g, '')
        .replace(/\b(?:тел(?:ефон)?|e-?mail|почта|фио|контакт)\.?\s*:/giu, '');
      const fragments = residual
        .split(/[,|;]+/)
        .map((v) => v.trim())
        .filter(Boolean);
      const roleIndex = fragments.findIndex((v) =>
        /(?:инженер|энергетик|снабжен|закупк|директор|руководител|начальник|менеджер|технолог|механик|главный|ГИП)/iu.test(
          v,
        ),
      );
      if (roleIndex >= 0) role = fragments.splice(roleIndex, 1)[0]!;
      const roleTail = fragments.filter((v) => /^[а-яё]/u.test(v));
      role = [role, ...roleTail].filter(Boolean).join(', ');
      name = fragments
        .filter((v) => !roleTail.includes(v))
        .join(' ')
        .replace(/^[\s:–—-]+|[\s:–—-]+$/g, '');
    }
    // An explicitly labelled contact may have only a first name. Do not invent a person from a phone-only note.
    if (!name || /[@\d]/.test(name)) continue;
    privacy(name);
    privacy(role);
    if (email) privacy(email.replace('@', ' '));
    const validEmail =
      !email || /^[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+$/i.test(email);
    const candidates = phones.length ? phones : [{ phone: '' }];
    for (const phone of candidates) {
      const checked = contactSchema.safeParse({
        name,
        role,
        phone: phone.phone,
        email: validEmail ? email : '',
        ...(phone.extension ? { extension: phone.extension } : {}),
      });
      if (checked.success) result.push(checked.data);
    }
  }
  requireCondition(result.length <= 30, 400, 'Слишком много телефонов контактов');
  return result;
}

const clientHeaders = [
  'ИНН *',
  'Компания *',
  'Город',
  'Тип клиента *',
  'Выключатели',
  '',
  'ПЧ (УПП)',
  '',
  'КСО (КРУ)',
  'Шкафы АСУ ТП',
  'Услуги',
  'Теплотехника',
  'Итого потенциал',
  'Якорные заказчики',
  'Контакты',
  'Комментарий',
];
const projectHeaders = [
  'Компания *',
  'ИНН *',
  'Проект *',
  'Заказчик проекта',
  'ИНН заказчика',
  'Выключатели',
  '',
  'ПЧ (УПП)',
  '',
  'КСО (КРУ)',
  'Шкафы АСУ ТП',
  'ДГУ (ДЭС)',
  'Шкафы НКУ',
  'Услуги',
  'Теплотехника',
  'Другое',
  'Итого, млн ₽',
  'Стадия *',
  'Решение до',
  'Дата поставки',
  'Комментарий',
];
const columnLetter = (n: number) => String.fromCharCode(65 + n);
function templateSheet(
  part: string,
  shared: string[],
  headers: string[],
  kind: 'clients' | 'projects',
) {
  const sheet = xml(part).worksheet;
  const cells = new Map<string, { value: string; formula?: string }>();
  const physicalRows = arr(sheet?.sheetData?.row);
  requireCondition(physicalRows.length <= 504, 400, 'Шаблон содержит слишком много строк');
  for (const row of physicalRows) {
    if (String(row['@_hidden']) === '1' || String(row['@_hidden']) === 'true') continue;
    for (const c of arr(row.c)) {
      const ref = /^([A-Z]+)([1-9]\d*)$/.exec(c['@_r'] || '');
      requireCondition(ref && Number(ref[2]) <= 504, 400, 'Некорректная ячейка шаблона');
      const col = [...ref[1]!].reduce((n, x) => n * 26 + x.charCodeAt(0) - 64, 0) - 1;
      requireCondition(
        col < headers.length && !cells.has(c['@_r']),
        400,
        'Неизвестная или повторная колонка шаблона',
      );
      const value =
        c['@_t'] === 's'
          ? shared[Number(c.v)]
          : c['@_t'] === 'inlineStr'
            ? textNode(c.is)
            : textNode(c.v);
      requireCondition(
        value !== undefined && value.length <= 1000,
        400,
        'Повреждённый или слишком длинный текст шаблона',
      );
      if (c.f !== undefined) {
        const r = Number(ref![2]),
          total = kind === 'clients' ? 'M' : 'Q',
          range = kind === 'clients' ? `E${r}:L${r}` : `F${r}:O${r}`;
        requireCondition(
          r >= 5 && ref![1] === total && textNode(c.f) === `IF(COUNT(${range})=0,"",SUM(${range}))`,
          400,
          'Неизвестная формула шаблона: вычисления запрещены',
        );
      }
      cells.set(c['@_r'], { value, ...(c.f === undefined ? {} : { formula: textNode(c.f) }) });
    }
  }
  headers.forEach((h, col) =>
    requireCondition(
      cells.get(`${columnLetter(col)}1`)?.value === h,
      400,
      'Шапка шаблона изменена: используйте исходные колонки',
    ),
  );
  const sub = kind === 'clients' ? [4, 5, 6, 7] : [5, 6, 7, 8];
  sub.forEach((col, i) =>
    requireCondition(
      cells.get(`${columnLetter(col)}2`)?.value === (i % 2 ? '6-35 кВ' : '0,4 кВ'),
      400,
      'Проверьте напряжения в шапке шаблона',
    ),
  );
  // Only canonical header merges. A merge in user data may silently lose data.
  const allowedMerges = headers.flatMap((h, i) =>
    h
      ? [
          (kind === 'clients' ? [4, 6] : [5, 7]).includes(i)
            ? `${columnLetter(i)}1:${columnLetter(i + 1)}1`
            : `${columnLetter(i)}1:${columnLetter(i)}2`,
        ]
      : [],
  );
  const merges = arr(sheet?.mergeCells?.mergeCell).map((m) => m['@_ref']);
  requireCondition(
    merges.length === allowedMerges.length &&
      new Set(merges).size === merges.length &&
      merges.every((v) => allowedMerges.includes(v)),
    400,
    'Объединения ячеек шаблона изменены',
  );
  const result: { row: number; values: string[] }[] = [];
  for (let row = 5; row <= 504; row++) {
    const totalCol = kind === 'clients' ? 12 : 16;
    const values = headers.map((_, col) => cells.get(`${columnLetter(col)}${row}`)?.value || '');
    const populated = values.some((v, col) => col !== totalCol && v.trim());
    if (!populated) {
      requireCondition(
        !values[totalCol] || cells.get(`${columnLetter(totalCol)}${row}`)?.formula !== undefined,
        400,
        `Строка ${row}: итог без данных`,
      );
      continue;
    }
    result.push({ row, values });
  }
  requireCondition(result.length <= 100, 400, 'До 100 заполненных строк на лист');
  return result;
}
function parsePicoTemplate(
  parts: Map<string, string>,
  privacy: ImportPrivacyGuard,
): ImportedCompany[] | null {
  const book = xml(parts.get('xl/workbook.xml') || '<workbook/>').workbook;
  const sheetNames = arr(book?.sheets?.sheet).map((s) => s['@_name']);
  if (!sheetNames.includes('Клиенты') || !sheetNames.includes('Проекты')) return null;
  requireCondition(
    JSON.stringify(sheetNames) === JSON.stringify(['Как заполнять', 'Клиенты', 'Проекты']),
    400,
    'Неизвестная структура шаблона Pico',
  );
  const relations = arr(
    xml(parts.get('xl/_rels/workbook.xml.rels') || '<Relationships/>').Relationships?.Relationship,
  );
  const sheets = arr(book.sheets.sheet);
  function sheetPart(index: number) {
    const rel = relations.find((r) => r['@_Id'] === sheets[index]['@_id']);
    const target = String(rel?.['@_Target'] || '')
      .replace(/^\/xl\//, '')
      .replace(/^xl\//, '');
    requireCondition(
      /^worksheets\/sheet\d+\.xml$/.test(target),
      400,
      'Неверная связь листа шаблона',
    );
    const part = parts.get(`xl/${target}`);
    requireCondition(part, 400, 'Лист шаблона отсутствует');
    return part;
  }
  const shared = arr(xml(parts.get('xl/sharedStrings.xml') || '<sst/>').sst?.si).map(textNode);
  const clients = templateSheet(sheetPart(1), shared, clientHeaders, 'clients');
  const projects = templateSheet(sheetPart(2), shared, projectHeaders, 'projects');
  requireCondition(
    clients.length,
    400,
    'Шаблон не заполнен: добавьте свои компании, предзаполненный пример не импортируется',
  );
  const moneyValue = (value: string, _row: number): number | undefined =>
    normalizedMoneyColumn([value], 'млн ₽')[0]?.amount;
  const result = clients.map(({ row, values }) => {
    const v = values.map(sanitizeImportedCell);
    v.forEach((value, col) => {
      if (col !== 14) privacy(value);
    });
    const mapped = parseCompanyTable(
      [
        ['ИНН', 'Название', 'Город', 'Тип', 'Заметки'],
        [v[0]!, v[1]!, v[2]!, v[3]!, v[15]!],
      ],
      'Клиенты',
      privacy,
    )[0]!;
    if (!mapped.data.inn && mapped.data.segment !== 'holding')
      mapped.warnings.push('ИНН не указан или некорректен: импорт без ИНН');
    const amounts = v.slice(4, 12).map((value) => moneyValue(value, row));
    v.slice(4, 12).forEach((value, i) => {
      if (value.trim() && amounts[i] === undefined)
        mapped.warnings.push(`Направление ${i + 1}: некорректная сумма пропущена`);
    });
    const keys = [
      'lv',
      'mv',
      'drives_lv',
      'drives_mv',
      'cells',
      'automation_cabinets',
      'services',
      'heat',
    ] as const;
    mapped.data.divisions = {};
    amounts.forEach((amount, i) => {
      if (amount !== undefined && keys[i]) mapped.data.divisions![keys[i]!] = amount;
    });
    mapped.data.potential = amounts.some((a) => a !== undefined)
      ? amounts.reduce<number>((sum, a) => sum + (a ?? 0), 0)
      : null;
    if (mapped.data.potential !== null && mapped.data.potential > 1e12) {
      mapped.data.potential = null;
      mapped.warnings.push('Общий потенциал пропущен: превышен допустимый размер');
    }
    const notes = [mapped.data.notes || ''];
    if (v[13]) notes.push(`Якорные заказчики: ${v[13]}`);
    mapped.data.notes = notes.filter(Boolean).join('\n');
    mapped.missing = mapped.missing.filter((field) =>
      field === 'Потенциал'
        ? mapped.data.potential == null
        : field === 'Заметки'
          ? !mapped.data.notes
          : true,
    );
    mapped.contacts = parseBusinessContacts(v[14]!, privacy);
    mapped.data.notes = [mapped.data.notes || '', ...safeContactInstructions(v[14] || '', privacy)]
      .filter(Boolean)
      .join('\n');
    mapped.projects = [];
    mapped.source = `Клиенты · строка ${row}`;
    mapped.raw = Object.fromEntries(
      clientHeaders.map((header, col) => [header || `Колонка ${col + 1}`, v[col] || '']),
    );
    mapped.warnings.push(
      'Пример из строки 4 не импортируется. Потенциал пересчитан из направлений, млн ₽ → ₽',
    );
    return mapped;
  });
  for (const { row, values } of projects) {
    const v = values.map(sanitizeImportedCell);
    v.forEach(privacy);
    const parentInn = normalizeImportedInn(v[1]!);
    const parent = result.find((r) => r.data.inn && r.data.inn === parentInn);
    if (!parent || normalize(parent.data.name) !== normalize(normalizedCompanyName(v[0]!))) {
      result.forEach((company) =>
        company.warnings.push(
          `Проекты, строка ${row}: проект пропущен — не найден валидный заказчик по ИНН и названию`,
        ),
      );
      continue;
    }
    const keys = [
      'lv',
      'mv',
      'drives_lv',
      'drives_mv',
      'cells',
      'automation',
      'generator',
      'switchboard',
      'services',
      'heat',
    ] as const;
    const equipment: ReturnType<typeof projectSchema.parse>['equipment'] = [];
    v.slice(5, 15).forEach((value, i) => {
      const amount = moneyValue(value, row);
      if (amount !== undefined)
        equipment.push({ division: keys[i]!, name: divisionLabels[keys[i]!]!, amount });
    });
    if (v[15]) {
      const other = /^(.{1,180}?)\s+-\s+(\d+(?:[.,]\d{1,6})?)$/.exec(v[15]!);
      if (other) {
        const amount = moneyValue(other[2]!, row);
        if (amount !== undefined) equipment.push({ division: 'other', name: other[1]!, amount });
      } else parent.warnings.push(`Проекты, строка ${row}: сумма «Другое» пропущена`);
    }
    const originalStage = v[17]!;
    const notes = [v[20], `Стадия из источника: ${originalStage}`];
    for (const [col, label] of [
      [18, 'Решение до'],
      [19, 'Дата поставки'],
    ] as const) {
      if (v[col]) {
        if (!/^(?:0[1-9]|1[0-2])\.\d{4}$/.test(v[col]!)) {
          parent.warnings.push(`Проекты, строка ${row}: ${label} пропущено — неизвестный формат`);
          continue;
        }
        notes.push(`${label} (месяц): ${v[col]}`);
      }
    }
    if (v[3] || v[4])
      notes.push(`Заказчик из источника: ${v[3] || 'не указан'}; ИНН: ${v[4] || 'не указан'}`);
    if (v[4]) {
      const normalized = normalizeImportedInn(v[4]);
      if (!normalized)
        parent.warnings.push(`Проекты, строка ${row}: некорректный ИНН заказчика пропущен`);
      v[4] = normalized;
    }
    if (v[4] && !validInn(v[4]!)) {
      parent.warnings.push(`Проекты, строка ${row}: некорректный ИНН заказчика пропущен`);
      v[4] = '';
    }
    const customer = result.find((r) => r.data.inn === v[4]);
    if (
      customer &&
      v[3] &&
      normalize(customer.data.name) !== normalize(normalizedCompanyName(v[3]))
    ) {
      parent.warnings.push(
        `Проекты, строка ${row}: ссылка заказчика пропущена — название не совпадает с ИНН`,
      );
      v[4] = '';
    }
    if (parent.projects!.some((p) => normalize(p.data.name) === normalize(v[2]!))) {
      parent.warnings.push(`Проекты, строка ${row}: повтор проекта пропущен`);
      continue;
    }
    const checked = projectSchema.safeParse({
      name: v[2],
      equipment,
      amount: equipment.length ? equipment.reduce((n, e) => n + (e.amount ?? 0), 0) : null,
      stage: 'new',
      notes: notes.filter(Boolean).join('\n'),
    });
    if (!checked.success) {
      parent.warnings.push(`Проекты, строка ${row}: некорректный проект пропущен`);
      continue;
    }
    parent.projects!.push({
      data: checked.data!,
      source: `Проекты · строка ${row}`,
      ...(v[4] ? { customerInn: v[4] } : {}),
    });
    parent.warnings.push(
      `Проект «${v[2]}»: техническая стадия CRM «Новый»; исходная стадия и месяцы дат сохранены в заметках. Итог пересчитан, включая «Другое». Заказчик связывается только с новой компанией из этого импорта; иначе остаётся в заметках`,
    );
  }
  return result;
}

async function parseGoogleDocx(
  bytes: Buffer,
  privacy: ImportPrivacyGuard,
): Promise<ImportedCompany[]> {
  const parts = await unzip(bytes, 'docx');
  const raw = parts.get('word/document.xml');
  requireCondition(raw, 400, 'Google Docs: документ не содержит текста');
  requireCondition(
    !/<(?:\w+:)?(?:altChunk|object|instrText|fldSimple|fldChar|sdt|gridSpan|vMerge|gridBefore|gridAfter|drawing|pict|ins|del|customXml)\b/.test(
      raw,
    ),
    400,
    'Google Docs: вложенные объекты, скрытые контейнеры и объединённые ячейки не поддерживаются',
  );
  // Preserve document order, paragraph text and actual table boundaries.
  xml(raw); // entities/depth/node validation before preserve-order parsing
  const tree = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    processEntities: false,
    parseTagValue: false,
    preserveOrder: true,
  }).parse(raw);
  const text = (nodes: any[]): string =>
    nodes
      .map((n) =>
        n['#text'] !== undefined
          ? entity(String(n['#text']))
          : n.br || n.cr
            ? '\n'
            : n.tab
              ? '\t'
              : Object.entries(n)
                  .filter(([k]) => k !== ':@')
                  .map(([, v]) => (Array.isArray(v) ? text(v) : ''))
                  .join(''),
      )
      .join('');
  function find(nodes: any[], key: string): any[] {
    for (const n of nodes) {
      if (n[key]) return n[key];
      for (const [k, v] of Object.entries(n))
        if (k !== ':@' && Array.isArray(v)) {
          const r = find(v, key);
          if (r.length) return r;
        }
    }
    return [];
  }
  const body = find(tree, 'body');
  const result: ImportedCompany[] = [];
  let paragraphs: string[] = [];
  const flush = async () => {
    const value = paragraphs.join('\n').trim();
    paragraphs = [];
    if (value) result.push(...(await parseCompanyImport(Buffer.from(value), 'txt', privacy)));
  };
  for (const block of body) {
    if (block.p) paragraphs.push(text(block.p));
    else if (block.tbl) {
      requireCondition(
        !find(block.tbl, 'tbl').length,
        400,
        'Google Docs: вложенные таблицы не поддерживаются',
      );
      await flush();
      // Reject unsupported table structure as a whole instead of extending a
      // blacklist for each Word container; never shift sparse cells into a new column.
      const structure = (nodes: any[], allowed: string[]) =>
        requireCondition(
          nodes.every((n) => Object.keys(n).every((k) => k === ':@' || allowed.includes(k))),
          400,
          'Google Docs: неподдерживаемая структура таблицы',
        );
      structure(block.tbl, ['tblPr', 'tblGrid', 'tr']);
      for (const row of block.tbl.filter((n: any) => n.tr)) {
        structure(row.tr, ['trPr', 'tc']);
        for (const cell of row.tr.filter((n: any) => n.tc)) structure(cell.tc, ['tcPr', 'p']);
      }
      const rows = block.tbl
        .filter((n: any) => n.tr)
        .map((n: any) =>
          n.tr
            .filter((v: any) => v.tc)
            .map((v: any) =>
              v.tc
                .filter((p: any) => p.p)
                .map((p: any) => text(p.p))
                .join('\n'),
            ),
        );
      requireCondition(
        rows.length &&
          rows.length <= companyImportLimits.rows + companyImportLimits.preambleRows + 1,
        400,
        'Google Docs: таблица должна содержать заголовок и до 100 компаний',
      );
      requireCondition(
        rows.every((r: string[]) => r.length === rows[0].length),
        400,
        'Google Docs: число ячеек строки должно совпадать с заголовком',
      );
      result.push(...parseCompanyTable(rows, 'Google Docs · таблица', privacy));
    } else
      requireCondition(
        block.sectPr,
        400,
        'Google Docs: неподдерживаемая структура документа; отправьте простую таблицу',
      );
  }
  await flush();
  requireCondition(
    result.length && result.length <= 100,
    400,
    'Google Docs: нужно от 1 до 100 компаний',
  );
  return result;
}
