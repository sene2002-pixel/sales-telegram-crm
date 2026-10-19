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
];
const shortLegalForms = 'ООО|ПАО|ОАО|ЗАО|НАО|АО|ИП|ФГУП|ГУП|МУП|ТОО';
const formsPattern =
  '(?:' + fullLegalForms.map(([pattern]) => pattern).join('|') + '|' + shortLegalForms + ')';
export function importedLegalForm(name: string): string | undefined {
  const text = name
    .trim()
    .replace(/[«»“”"'‘’]/g, '')
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
    .replace(/[«»“”"'‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleaned = text
    .replace(new RegExp('^' + formsPattern + '(?=\\s|$)\\s*', 'iu'), '')
    .replace(new RegExp('(?:,\\s*|\\s+)' + formsPattern + '\\.?$', 'iu'), '')
    .trim();
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
    .replace(/^(?:город\s+|г\.\s*|г\s+)/iu, '')
    .trim();
  if (/^(?:[—–-]+|н\s*[/\.]\s*д\.?|неизвестно|не\s*указан(?:о)?|нет|крас)$/iu.test(text)) return '';
  const key = text.toLowerCase().replace(/[.\s-]/g, '');
  return (
    (
      {
        спб: 'Санкт-Петербург',
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
