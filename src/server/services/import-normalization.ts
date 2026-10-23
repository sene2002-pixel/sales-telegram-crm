import { validInn } from '../../shared/contracts';

const fullLegalForms: [string, string][] = [
  ['общество\\s+с\\s+ограниченной\\s+ответственностью', 'ООО'],
  ['публичное\\s+акционерное\\s+общество', 'ПАО'],
  ['непубличное\\s+акционерное\\s+общество', 'НАО'],
  ['открытое\\s+акционерное\\s+общество', 'ОАО'],
  ['закрытое\\s+акционерное\\s+общество', 'ЗАО'],
  ['акционерное\\s+общество', 'АО'],
  ['индивидуальный\\s+предприниматель', 'ИП'],
  ['федеральное\\s+государственное\\s+унитарное\\s+предприятие', 'ФГУП'],
  ['государственное\\s+унитарное\\s+предприятие', 'ГУП'],
  ['муниципальное\\s+унитарное\\s+предприятие', 'МУП'],
  ['товарищество\\s+с\\s+ограниченной\\s+ответственностью', 'ТОО'],
  ['федеральное\\s+государственное\\s+бюджетное\\s+учреждение', 'ФГБУ'],
  ['государственное\\s+бюджетное\\s+учреждение', 'ГБУ'],
  ['автономная\\s+некоммерческая\\s+организация', 'АНО'],
  ['некоммерческая\\s+организация', 'НКО'],
];
const shortLegalForms = 'ООО|ПАО|ОАО|ЗАО|НАО|АО|ИП|ФГУП|ГУП|МУП|ФГБУ|ГБУ|АНО|НКО|ТОО';
const formsPattern =
  '(?:' + fullLegalForms.map(([pattern]) => pattern).join('|') + '|' + shortLegalForms + ')';
export function importedLegalForm(name: string): string | undefined {
  const text = name
    .trim()
    .replace(/[«»„“”"'‘’]/g, '')
    .trim();
  for (const [pattern, code] of fullLegalForms) {
    if (new RegExp('^' + pattern + '(?=\\s|$)', 'iu').test(text)) return code;
  }
  const match =
    text.match(new RegExp('^(' + shortLegalForms + ')(?=\\s|$)', 'iu')) ||
    text.match(new RegExp('(?:,\\s*|\\s+)(' + shortLegalForms + ')\\.?$', 'iu'));
  return match?.[1]?.toUpperCase();
}
/** Import-only cleanup; legal-form provenance is captured separately before calling. */
export function normalizedCompanyName(name: string): string {
  const text = name
    .trim()
    .replace(/[«»„“”"'‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleaned = text
    .replace(new RegExp('^' + formsPattern + '(?=\\s|$)\\s*', 'iu'), '')
    .replace(new RegExp('(?:,\\s*|\\s+)' + formsPattern + '\\.?$', 'iu'), '')
    .trim();
  if (importedLegalForm(name) === 'ИП') {
    const words = cleaned.split(/\s+/);
    if (words.length >= 2)
      return `ИП ${words[0]} ${
        words.slice(1).every((w) => /^[А-Яа-яA-Za-z]\./u.test(w))
          ? words.slice(1).join('')
          : words
              .slice(1)
              .map((w) => w[0] + '.')
              .join('')
      }`;
    return `ИП ${cleaned}`;
  }
  return cleaned || text;
}
export function normalizedInn(value: string): string | undefined {
  let text = value.trim();
  const match = text.match(/^(\d+)(?:[.,](\d+))?[eE]([+-]?\d+)$/);
  if (match) {
    const fraction = match[2] || '',
      digits = match[1]! + fraction;
    const exponent = Number(match[3]),
      point = match[1]!.length + exponent;
    if (
      !Number.isInteger(exponent) ||
      Math.abs(exponent) > 20 ||
      point <= 0 ||
      point > 12 ||
      (point < digits.length && !/^0*$/.test(digits.slice(point)))
    )
      return undefined;
    text =
      point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point);
  } else {
    if (!/^[\d\s'’.-]+$/.test(text)) return undefined;
    text = text.replace(/\D/g, '');
  }
  if (text.length === 9 || text.length === 11) text = '0' + text;
  return validInn(text) ? text : undefined;
}
export function normalizedCity(value: string): string {
  const text = value
    .trim()
    .replace(/^(?:город\s+|гор\.\s*|г\.\s*|г\s+)/iu, '')
    .trim();
  if (
    /^(?:[—–-]+|н\s*[/\.]\s*д\.?|неизвестно|не\s*указан(?:о)?|нет|крас|нд|\?|уточнить)$/iu.test(
      text,
    )
  )
    return '';
  const key = text.toLowerCase().replace(/[.\s-]/g, '');
  return (
    (
      {
        спб: 'Санкт-Петербург',
        нновгород: 'Нижний Новгород',
        нурсултан: 'Астана',
        алмата: 'Алматы',
        питер: 'Санкт-Петербург',
        санктпетербург: 'Санкт-Петербург',
        мск: 'Москва',
        екб: 'Екатеринбург',
        ебург: 'Екатеринбург',
        нн: 'Нижний Новгород',
        нск: 'Новосибирск',
      } as Record<string, string>
    )[key] || text
  );
}
export function normalizedSegment(value: string): string | undefined {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
  if (
    /^(производитель нку|производитель ктп\/кру|щитовое производство|завод щитов|автоматизация,? шкафы)$/.test(
      key,
    )
  )
    return 'integrator';
  if (/^(электромонтаж|пнр|пусконаладка|гп|субподряд|смр)$/.test(key)) return 'contractor';
  if (/^(пи|проектировщик|проектная организация|институт|проектное бюро)$/.test(key))
    return 'design_institute';
  if (
    /^(оем|оэм|производитель оборудования|машиностроитель|изготовитель дгу|изготовитель насосов)$/.test(
      key,
    )
  )
    return 'oem';
  if (/^(конечник|конечный заказчик|эксплуатация|владелец объекта|застройщик)$/.test(key))
    return 'end_client';
  if (/^(сети|мрск|рск|сбыт|электросетевая)$/.test(key)) return 'grid_company';
  if (key === 'shchitovik') return 'integrator';
  if (key === 'general contractor') return 'contractor';
  if (/^(щитовик|щитосборщик|сборщик щитов|интегратор|системный интегратор)$/.test(key))
    return 'integrator';
  if (
    /^(монтаж|монтажник|монтажная компания|инжиниринг|инжиниринговая компания|генподряд|генподрядчик|подрядчик)$/.test(
      key,
    )
  )
    return 'contractor';
  if (/^(дистрибьютор|дистрибутор|дилер|поставщик)$/.test(key)) return 'distributor';
  return undefined;
}
const unitPattern =
  '(?:млрд|миллиард(?:а|ов)?|млн|миллион(?:а|ов)?|лям(?:а|ов)?|кк|тыс(?:яч(?:а|и)?)?|т\\.?р\\.?|мл|м|к|руб(?:лей|ля)?|р|₽)';
export function moneyUnit(text: string): number | undefined {
  const match = text
    .trim()
    .toLowerCase()
    .match(new RegExp('(?:^|[^а-яa-z])(' + unitPattern + ')(?=$|[^а-яa-z])', 'iu'));
  if (!match) return undefined;
  const unit = match[1]!;
  return /^(млрд|миллиард)/u.test(unit)
    ? 1e9
    : /^(млн|миллион|лям|кк|мл|м)$/u.test(unit)
      ? 1e6
      : /^(тыс|т|к)/u.test(unit)
        ? 1e3
        : 1;
}
function numeric(text: string): number | undefined {
  let value = text.trim().replace(/[\s\u00a0'’]/g, '');
  if (!/^\d+(?:[.,]\d+)*(?:e[+-]?\d+)?$/i.test(value)) return undefined;
  const exponent = value.match(/e[+-]?\d+$/i)?.[0] || '';
  if (exponent) value = value.slice(0, -exponent.length);
  const last = Math.max(value.lastIndexOf(','), value.lastIndexOf('.'));
  if (last >= 0) value = value.slice(0, last).replace(/[.,]/g, '') + '.' + value.slice(last + 1);
  const number = Number(value + exponent);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
export interface MoneyCell {
  value?: number;
  explicit?: number;
  range?: string;
}
function scalarMoney(text: string): MoneyCell {
  const explicit = moneyUnit(text);
  const withoutUnit = text
    .replace(new RegExp('\\s*' + unitPattern + '\\.?\\s*(?:руб(?:лей|ля)?|₽)?\\.?\\s*$', 'iu'), '')
    .trim();
  return { value: numeric(withoutUnit), explicit };
}
export function parsedMoney(text: string): MoneyCell {
  const original = text.trim();
  // Parse a scalar first: '-' in e-3 is an exponent sign, not a range delimiter.
  const scalar = scalarMoney(original);
  if (scalar.value !== undefined) return scalar;
  const range = original.match(/^(?:от\s+)?(.+?)\s*(?:–|—|-|до)\s*(.+)$/iu);
  if (!range) return {};
  const lower = scalarMoney(range[1]!),
    upper = scalarMoney(range[2]!);
  if (lower.value === undefined || upper.value === undefined) return {};
  const common = upper.explicit ?? lower.explicit;
  if (common !== undefined)
    return {
      value: Math.max(
        lower.value * (lower.explicit ?? common),
        upper.value * (upper.explicit ?? common),
      ),
      explicit: 1,
      range: original,
    };
  return { value: Math.max(lower.value, upper.value), range: original };
}
export function normalizedMoneyColumn(
  values: string[],
  header: string,
): { amount?: number; warning?: string; note?: string }[] {
  const parsed = values.map(parsedMoney);
  const nonzero = parsed
    .filter((v) => v.value !== undefined && v.value > 0)
    .map((v) => v.value!)
    .sort((a, b) => a - b);
  const middle = Math.floor(nonzero.length / 2);
  const median = nonzero.length
    ? nonzero.length % 2
      ? nonzero[middle]!
      : (nonzero[middle - 1]! + nonzero[middle]!) / 2
    : undefined;
  const headerUnit = moneyUnit(header);
  const inferred =
    median === undefined ? undefined : median <= 1000 ? 1e6 : median >= 10000 ? 1 : undefined;
  const converted = parsed.map((v) =>
    v.value === undefined
      ? undefined
      : v.value * (v.explicit ?? headerUnit ?? (v.value === 0 ? 1 : inferred) ?? NaN),
  );
  const known = converted
    .filter((v): v is number => v !== undefined && Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const n = Math.floor(known.length / 2),
    base = known.length
      ? known.length % 2
        ? known[n]!
        : (known[n - 1]! + known[n]!) / 2
      : undefined;
  return parsed.map((v, i) => {
    if (!values[i]!.trim()) return {};
    const amount = converted[i];
    if (
      amount === undefined ||
      !Number.isFinite(amount) ||
      amount > 1e12 ||
      (base && amount > 0 && Math.max(amount / base, base / amount) > 1000)
    )
      return { warning: 'Сумма пропущена: неоднозначное значение или выброс' };
    return { amount, ...(v.range ? { note: `Исходный диапазон: ${v.range}` } : {}) };
  });
}

/** Candidate matching never authorizes a merge. INN, country and legal-form compatibility are checked by the caller. */
export function candidateSimilarity(a: string, b: string): boolean {
  const chars: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'i',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'shch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  };
  const canonical = (v: string) =>
    normalizedCompanyName(v)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split('')
      .map((c) => chars[c] ?? c)
      .join('')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const left = canonical(a),
    right = canonical(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.split(' ').sort().join(' ') === right.split(' ').sort().join(' ')) return true;
  if (
    Math.min(left.length, right.length) >= 5 &&
    (` ${left} `.includes(` ${right} `) || ` ${right} `.includes(` ${left} `))
  )
    return true;
  if (Math.min(left.length, right.length) < 5 || Math.abs(left.length - right.length) > 1)
    return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }
  return edits + (left.length - i) + (right.length - j) <= 1;
}

export interface NormalizedPhone {
  phone: string;
  extension?: string;
  free?: boolean;
}
export function normalizedPhones(value: string, city = ''): NormalizedPhone[] {
  const codes: Record<string, string> = {
    Екатеринбург: '343',
    Курган: '3522',
    Казань: '843',
    Москва: '495',
    'Санкт-Петербург': '812',
  };
  const result: NormalizedPhone[] = [];
  let inherited = '';
  const pieces = value.split(/[;,|/\n]+|\s+и\s+/iu);
  for (const part of pieces) {
    if (/(?:инн|сч[её]т|сч№|договор)/iu.test(part)) continue;
    const extension = part.match(/(?:доб(?:авочный)?\.?|вн\.?|ext\.?|#)\s*(\d{1,20})\s*$/iu)?.[1];
    const body = part.replace(/(?:доб(?:авочный)?\.?|вн\.?|ext\.?|#)\s*\d{1,20}\s*$/iu, '');
    const groups = body.match(/\+?\d[\d\s().-]{4,}\d/g) || [];
    for (const group of groups) {
      let digits = group.replace(/\D/g, '');
      let international = group.trim().startsWith('+') && !digits.startsWith('7');
      if (!international && digits.length > 11) {
        const mobile = digits.match(/[78]9\d{9}/);
        if (!mobile) continue;
        digits = mobile[0];
      }
      if (international) {
        if (digits.length < 8 || digits.length > 15) continue;
      } else {
        if (digits.length === 11 && /^[78]/.test(digits)) digits = digits.slice(1);
        if (digits.length < 10) {
          const code = inherited || codes[normalizedCity(city)];
          if (code && code.length + digits.length === 10) digits = code + digits;
        }
        if (digits.length !== 10 || !/^[3-9]/.test(digits)) continue;
        const explicitCode = group.match(/\((\d{3,5})\)/)?.[1];
        inherited =
          explicitCode ||
          codes[normalizedCity(city)] ||
          (digits.startsWith('3522') ? '3522' : digits.slice(0, 3));
        digits = '7' + digits;
      }
      const phone = '+' + digits;
      if (!result.some((p) => p.phone === phone && p.extension === extension))
        result.push({
          phone,
          ...(extension ? { extension } : {}),
          ...(phone.startsWith('+7800') ? { free: true } : {}),
        });
    }
  }
  return result;
}

/** Dates are month-granular. Relative dates require a known source date, never the server's current clock. */
export function normalizedImportDate(value: string, sourceDate?: string): string | undefined {
  const text = value.trim().toLowerCase().replace(/ё/g, 'е');
  if (!text || /^(?:уточн|реализац|неизвест|нет|[?—–-])/u.test(text)) return undefined;
  const format = (month: number, year: number) =>
    month >= 1 && month <= 12 && year >= 1900 && year <= 2199
      ? `${String(month).padStart(2, '0')}.${year}`
      : undefined;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/i);
  if (iso) {
    const year = Number(iso[1]),
      month = Number(iso[2]),
      day = Number(iso[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day
      ? undefined
      : format(month, year);
  }
  const numericDate = text.match(/^(?:(\d{1,2})[./])?(\d{1,2})[./](\d{2}|\d{4})$/);
  if (numericDate) {
    const year = Number(numericDate[3]) + (numericDate[3]!.length === 2 ? 2000 : 0),
      month = Number(numericDate[2]);
    if (
      numericDate[1] &&
      (Number(numericDate[1]) < 1 || Number(numericDate[1]) > new Date(year, month, 0).getDate())
    )
      return undefined;
    return format(month, year);
  }
  const serial = /^\d{5}(?:\.\d+)?$/.test(text) ? Number(text) : undefined;
  if (serial !== undefined) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.trunc(serial) * 86400000);
    return format(d.getUTCMonth() + 1, d.getUTCFullYear());
  }
  const context =
    sourceDate && /^\d{4}-\d{2}-\d{2}/.test(sourceDate) ? new Date(sourceDate) : undefined;
  const validContext = context && !Number.isNaN(+context) ? context : undefined;
  const yearMatch = text.match(/\b(20\d{2}|19\d{2})\b/),
    year = yearMatch ? Number(yearMatch[1]) : validContext?.getUTCFullYear();
  const quarter = text.match(/(?:\b([1-4])|\b(i{1,3}|iv))\s*кв/u);
  if (quarter && year) {
    const q = quarter[1]
      ? Number(quarter[1])
      : ({ i: 1, ii: 2, iii: 3, iv: 4 } as Record<string, number>)[quarter[2]!];
    return format(q! * 3, year);
  }
  if (/^\d{4}$/.test(text)) return format(12, Number(text));
  const months = [
    'янв',
    'фев',
    'мар',
    'апр',
    'ма[йя]',
    'июн',
    'июл',
    'авг',
    'сен',
    'окт',
    'ноя',
    'дек',
  ];
  const matched = months.findIndex((m) => new RegExp(m, 'u').test(text));
  if (matched >= 0) {
    let y = year;
    const short = text.match(/\b(\d{2})$/);
    if (!yearMatch && short) y = 2000 + Number(short[1]);
    if (!y) return undefined;
    if (!yearMatch && !short && validContext && matched < validContext.getUTCMonth()) y++;
    return format(matched + 1, y);
  }
  const seasons = [...text.matchAll(/весн|лет|осен|зим/gu)];
  if (seasons.length && year) {
    const endings: Record<string, number> = { весн: 5, лет: 8, осен: 11, зим: 2 };
    const months = seasons.map((season) => {
      const prefix = text.slice(Math.max(0, season.index! - 12), season.index);
      return /начал[ое]/u.test(prefix) && season[0] === 'осен' ? 9 : endings[season[0]]!;
    });
    return format(Math.max(...months), year);
  }
  if (validContext) {
    if (/^(?:этот|текущий) месяц$/u.test(text))
      return format(validContext.getUTCMonth() + 1, validContext.getUTCFullYear());
    if (/след\.?\s*недел/u.test(text)) {
      const d = new Date(+validContext + 7 * 86400000);
      return format(d.getUTCMonth() + 1, d.getUTCFullYear());
    }
  }
  return undefined;
}
