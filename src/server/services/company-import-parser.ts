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
  divisionLabels,
} from '../../shared/contracts';
import { requireCondition, DomainError } from '../domain/errors';

export const companyImportLimits = {
  bytes: 2 * 1024 * 1024,
  expanded: 8 * 1024 * 1024,
  entries: 100,
  rows: 100,
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
  source: string;
  data: Partial<CompanyData> & { name: string };
  missing: string[];
  warnings: string[];
  contacts?: ReturnType<typeof contactSchema.parse>[];
  projects?: {
    data: ReturnType<typeof projectSchema.parse>;
    source: string;
    customerInn?: string;
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
] as const;
type Field = (typeof baseFields)[number] | `division:${(typeof divisions)[number]}`;
const aliases: Record<string, Field> = Object.assign(Object.create(null), {
  stage: 'stage',
  стадия: 'stage',
  этап: 'stage',
  revenue: 'revenue',
  выручка: 'revenue',
  'выручка руб': 'revenue',
  'выручка млн руб': 'revenue',
  'выручка млн': 'revenue',
  notes: 'notes',
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
    .replace(/[()₽.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
for (const d of divisions)
  for (const alias of [d, labels[d], divisionLabels[d]])
    if (alias) {
      for (const suffix of ['', ' руб', ' млн руб', ' млн ₽'])
        aliases[normalize(alias + suffix)] = `division:${d}`;
    }
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
export function parseCompanyTable(
  rows: string[][],
  source: string,
  privacy: ImportPrivacyGuard,
): ImportedCompany[] {
  requireCondition(
    rows.length > 1 && rows.length <= companyImportLimits.rows + 1,
    400,
    'Таблица должна содержать заголовок и до 100 компаний',
  );
  const contactColumn = rows[0]!.findIndex((h) => normalize(h) === 'контакты');
  const contactRows = rows
    .slice(1)
    .map((r) => (contactColumn < 0 ? [] : parseBusinessContacts(r[contactColumn] || '', privacy)));
  const safeRows = rows.map((r) => r.map((v, i) => (i === contactColumn ? '' : v)));
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
  const result: ImportedCompany[] = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]!;
    if (!row.some((v) => v.trim()) && !contactRows[index - 1]?.length) continue;
    const data: any = {};
    mapped.forEach((field, col) => {
      const value = (row[col] || '').trim();
      if (!field || !value) return;
      if (field === 'segment') {
        const key = segments.find(
          (s) => s === value || normalize(labels[s] || s) === normalize(value),
        );
        requireCondition(key, 400, `Строка ${index + 1}: неизвестный тип клиента`);
        data.segment = key;
      } else if (field === 'stage') {
        const key = stages.find(
          (s) => s === value || normalize(labels[s] || s) === normalize(value),
        );
        requireCondition(key, 400, `Строка ${index + 1}: неизвестная стадия`);
        data.stage = key;
      } else if (field === 'potential' || field === 'revenue' || field.startsWith('division:')) {
        const valueNumber = Number(value.replace(/[\s\u00a0]/g, '').replace(',', '.'));
        requireCondition(
          Number.isFinite(valueNumber) && valueNumber >= 0,
          400,
          `Строка ${index + 1}: некорректный потенциал`,
        );
        const amount = valueNumber * (header[col]!.includes('млн') ? 1_000_000 : 1);
        if (field.startsWith('division:')) {
          data.divisions ??= {};
          data.divisions[field.slice(9)] = amount;
        } else data[field] = amount;
      } else data[field] = value;
    });
    requireCondition(
      typeof data.name === 'string' && data.name.trim(),
      400,
      `Строка ${index + 1}: нет названия компании`,
    );
    const checked = companySchema.safeParse(data);
    requireCondition(
      checked.success,
      400,
      `Строка ${index + 1}: проверьте ИНН, размеры и значения полей`,
    );
    result.push({
      source: `${source} · строка ${index + 1}`,
      data,
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
            })[f],
        ),
      warnings: unknown.length
        ? [`Не импортированы колонки: ${unknown.length} (${unknown.join(', ').slice(0, 400)})`]
        : [],
      ...(contactRows[index - 1]?.length ? { contacts: contactRows[index - 1] } : {}),
    });
  }
  requireCondition(result.length, 400, 'В таблице нет компаний');
  return result;
}
function csv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] || '',
    delimiter = first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',';
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
        rows.length <= 101 && row.length <= 30,
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
  policy: 'xlsx' | 'docx' = 'xlsx',
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
  format: 'xlsx' | 'csv' | 'txt' | 'docx',
  privacy: ImportPrivacyGuard,
): Promise<ImportedCompany[]> {
  requireCondition(
    bytes.length > 0 && bytes.length <= companyImportLimits.bytes,
    413,
    'Файл должен быть не больше 2 МБ',
  );
  if (format === 'docx') return parseGoogleDocx(Buffer.from(bytes), privacy);
  if (format !== 'xlsx') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new DomainError(400, 'Отправьте текст в кодировке UTF-8');
    }
    if (
      format === 'csv' ||
      /^(?:название(?: компании)?|наименование|компания|name|company)[\t;,]/i.test(text.trim())
    )
      return parseCompanyTable(csv(text), 'Таблица', privacy);
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
  const shared = arr(xml(parts.get('xl/sharedStrings.xml') || '<sst/>').sst?.si).map(textNode);
  const sheets = [...parts.keys()].filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort();
  requireCondition(sheets.length === 1, 400, 'Импортируйте файл с одним листом компаний');
  requireCondition(parts.has('xl/workbook.xml'), 400, 'Это не XLSX-книга');
  const worksheet = xml(parts.get(sheets[0]!)!).worksheet;
  requireCondition(!worksheet?.mergeCells, 400, 'Объединённые ячейки не поддерживаются');
  const rows: string[][] = [];
  for (const row of arr(worksheet?.sheetData?.row)) {
    const cells: string[] = [];
    for (const cell of arr(row.c)) {
      requireCondition(cell.f === undefined, 400, 'Формулы в XLSX запрещены');
      const ref = /^([A-Z]+)\d+$/.exec(cell['@_r'] || '');
      requireCondition(ref, 400, 'Некорректная ячейка XLSX');
      const col = [...ref[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
      requireCondition(col < 30, 400, 'В таблице слишком много колонок');
      const value =
        cell['@_t'] === 's'
          ? shared[Number(cell.v)]
          : cell['@_t'] === 'inlineStr'
            ? textNode(cell.is)
            : textNode(cell.v);
      requireCondition(value !== undefined, 400, 'Повреждённая ссылка на текст в XLSX');
      requireCondition(cells[col] === undefined, 400, 'Повторяющаяся ячейка XLSX');
      cells[col] = value;
    }
    rows.push(Array.from({ length: cells.length }, (_, i) => cells[i] || ''));
  }
  return parseCompanyTable(rows, 'XLSX', privacy);
}
export async function fetchPublicGoogleDocument(
  raw: string,
  format: 'txt' | 'docx' = 'txt',
): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError(400, 'Нужна публичная ссылка Google Docs');
  }
  requireCondition(
    url.protocol === 'https:' &&
      url.hostname === 'docs.google.com' &&
      !url.username &&
      !url.password &&
      !url.port,
    400,
    'Поддерживаются только публичные Google Docs',
  );
  const match = /^\/document\/d\/([A-Za-z0-9_-]{10,200})(?:\/edit|\/export|\/view)?\/?$/.exec(
    url.pathname,
  );
  requireCondition(match, 400, 'Экспортируйте Google Docs в TXT или CSV и отправьте файл');
  requireCondition(
    [...url.searchParams.keys()].every((k) => k === 'usp' || k === 'format'),
    400,
    'Используйте обычную публичную ссылку Google Docs без параметров доступа',
  );
  const ips = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DomainError(400, 'Адрес документа недоступен')),
      5000,
    );
    lookup('docs.google.com', { all: true, family: 4 }).then(
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
      reject(new DomainError(400, 'Документ недоступен. Отправьте экспорт TXT, CSV или XLSX'));
    };
    const req = request(
      {
        hostname: 'docs.google.com',
        path: `/document/d/${match[1]}/export?format=${format}`,
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
export function parseBusinessContacts(value: string, privacy: ImportPrivacyGuard) {
  requireCondition(value.length <= 1000, 400, 'Слишком длинное поле контактов');
  const lines = value.split(/\r?\n/).filter((v) => v.trim());
  requireCondition(lines.length <= 10, 400, 'До 10 контактов на компанию');
  return lines.map((line) => {
    const fields = line.split(',').map((v) => v.trim());
    requireCondition(
      fields.length === 4,
      400,
      'Контакты: одна строка «ФИО, должность, телефон, email»; для пропуска поля оставьте пустое место между запятыми',
    );
    const [name, role, phone, email] = fields as [string, string, string, string];
    privacy(name);
    privacy(role);
    requireCondition(
      !phone || /^\+?[\d ()-]{5,30}$/.test(phone),
      400,
      'Проверьте телефон контакта',
    );
    const checked = contactSchema.safeParse({ name, role, phone, email });
    requireCondition(checked.success, 400, 'Проверьте имя и email контакта');
    // Strip only the validated business address. Forbidden categories/secrets in its
    // local/domain parts must still be checked by the caller's policy.
    privacy(email.replace('@', ' '));
    return checked.data!;
  });
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
    'Шаблон не заполнен: добавьте клиентов начиная со строки 5. Строка 4 — пример',
  );
  const moneyValue = (value: string, row: number): number | undefined => {
    if (!value.trim()) return undefined;
    requireCondition(
      /^\d+(?:[.,]\d{1,6})?$/.test(value.trim()),
      400,
      `Строка ${row}: сумма должна быть числом в млн ₽`,
    );
    const n = Number(value.replace(',', '.')) * 1_000_000;
    requireCondition(Number.isFinite(n) && n <= 1e12, 400, `Строка ${row}: слишком большая сумма`);
    return n;
  };
  const result = clients.map(({ row, values: v }) => {
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
    requireCondition(
      mapped.data.inn && mapped.data.segment,
      400,
      `Клиенты, строка ${row}: заполните ИНН и тип`,
    );
    const amounts = v.slice(4, 12).map((value) => moneyValue(value, row));
    const keys = ['lv', 'mv', 'drives_lv', 'drives_mv', 'cells', null, 'services', 'heat'] as const;
    mapped.data.divisions = {};
    amounts.forEach((amount, i) => {
      if (amount !== undefined && keys[i]) mapped.data.divisions![keys[i]!] = amount;
    });
    mapped.data.potential = amounts.some((a) => a !== undefined)
      ? amounts.reduce<number>((sum, a) => sum + (a ?? 0), 0)
      : null;
    requireCondition(
      mapped.data.potential === null || mapped.data.potential <= 1e12,
      400,
      `Клиенты, строка ${row}: слишком большой итог`,
    );
    const notes = [mapped.data.notes || ''];
    if (amounts[5] !== undefined) {
      notes.push(`АСУ ТП: ${amounts[5]} ₽/год`);
      mapped.warnings.push(
        'АСУ ТП сохранено в заметках и общем потенциале; отдельной категории потенциала компании в CRM нет',
      );
    }
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
    mapped.projects = [];
    mapped.source = `Клиенты · строка ${row}`;
    mapped.warnings.push(
      'Пример из строки 4 не импортируется. Потенциал пересчитан из направлений, млн ₽ → ₽',
    );
    return mapped;
  });
  requireCondition(
    new Set(result.map((r) => r.data.inn)).size === result.length,
    400,
    'В листе «Клиенты» повторяется ИНН: объедините данные одной компании',
  );
  for (const { row, values: v } of projects) {
    v.forEach(privacy);
    const parent = result.find((r) => r.data.inn === v[1]);
    requireCondition(
      parent && normalize(parent.data.name) === normalize(v[0]!),
      400,
      `Проекты, строка ${row}: укажите компанию с тем же ИНН и названием в листе «Клиенты»`,
    );
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
      requireCondition(
        other,
        400,
        `Проекты, строка ${row}: «Другое» в формате «Оборудование - сумма в млн ₽»`,
      );
      equipment.push({ division: 'other', name: other[1]!, amount: moneyValue(other[2]!, row)! });
    }
    const originalStage = v[17]!;
    requireCondition(
      ['Есть проект', 'Тендер', 'Выбор вендора', 'Заказ получен'].includes(originalStage),
      400,
      `Проекты, строка ${row}: неизвестная стадия`,
    );
    const notes = [v[20], `Стадия из источника: ${originalStage}`];
    for (const [col, label] of [
      [18, 'Решение до'],
      [19, 'Дата поставки'],
    ] as const) {
      if (v[col]) {
        requireCondition(
          /^(?:0[1-9]|1[0-2])\.\d{4}$/.test(v[col]!),
          400,
          `Проекты, строка ${row}: ${label} в формате ММ.ГГГГ`,
        );
        notes.push(`${label} (месяц): ${v[col]}`);
      }
    }
    if (v[3] || v[4])
      notes.push(`Заказчик из источника: ${v[3] || 'не указан'}; ИНН: ${v[4] || 'не указан'}`);
    if (v[4])
      requireCondition(validInn(v[4]!), 400, `Проекты, строка ${row}: проверьте ИНН заказчика`);
    const customer = result.find((r) => r.data.inn === v[4]);
    requireCondition(
      !customer || !v[3] || normalize(customer.data.name) === normalize(v[3]),
      400,
      `Проекты, строка ${row}: название заказчика не совпадает с ИНН в листе «Клиенты»`,
    );
    requireCondition(
      !parent.projects!.some((p) => normalize(p.data.name) === normalize(v[2]!)),
      400,
      `Проекты, строка ${row}: проект этой компании повторяется`,
    );
    const checked = projectSchema.safeParse({
      name: v[2],
      equipment,
      amount: equipment.length ? equipment.reduce((n, e) => n + (e.amount ?? 0), 0) : null,
      stage: 'new',
      notes: notes.filter(Boolean).join('\n'),
    });
    requireCondition(
      checked.success,
      400,
      `Проекты, строка ${row}: проверьте название, суммы и комментарий`,
    );
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
        rows.length && rows.length <= 101,
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
