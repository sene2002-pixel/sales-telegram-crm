import { fromBuffer, Entry, ZipFile } from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import {
  CompanyData,
  companySchema,
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
export function assertImportPrivacy(text: string) {
  requireCondition(
    !/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+\d[\d ()-]{8,}\d|(?:пароль|password|api[_ -]?key|secret|токен)\s*[:=]|\bsk-[a-z0-9_-]{10,}|Bearer\s+\S+|(?:диагноз|паспорт|домашн(?:ий|его)\s+адрес|дата\s+рождения|состояние\s+здоровья)/i.test(
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
const fields: Field[] = [...baseFields, ...divisions.map((d) => `division:${d}` as const)];
const aliases: Record<string, Field> = {
  stage: 'stage',
  стадия: 'stage',
  этап: 'stage',
  revenue: 'revenue',
  выручка: 'revenue',
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
};
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
  for (const tag of text.matchAll(/<\/?[A-Za-z][^>]*>/g)) {
    requireCondition(++nodes <= 25000, 400, 'Слишком сложный XML в таблице');
    if (tag[0].startsWith('</')) depth--;
    else if (!tag[0].endsWith('/>')) depth++;
    requireCondition(depth >= 0 && depth <= 32, 400, 'Слишком вложенный XML в таблице');
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
    if (!row.some((v) => v.trim())) continue;
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
      warnings: unknown.length ? [`Не импортированы колонки: ${unknown.length}`] : [],
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
async function unzip(bytes: Buffer): Promise<Map<string, string>> {
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
                    requireCondition(
                      !/TargetMode\s*=\s*["']External/i.test(content),
                      400,
                      'Внешние ссылки в XLSX запрещены',
                    );
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
  format: 'xlsx' | 'csv' | 'txt',
  privacy: ImportPrivacyGuard,
): Promise<ImportedCompany[]> {
  requireCondition(
    bytes.length > 0 && bytes.length <= companyImportLimits.bytes,
    413,
    'Файл должен быть не больше 2 МБ',
  );
  if (format !== 'xlsx') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new DomainError(400, 'Отправьте текст в кодировке UTF-8');
    }
    privacy(text);
    if (format === 'csv' || /^(?:название|компания|name|company)[\t;,]/i.test(text.trim()))
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
    const blocks = text.trim().split(/\r?\n\s*\r?\n/),
      rows: string[][] = [...[]];
    rows.push([...fields]);
    for (const block of blocks) {
      const data: Record<string, string> = {};
      for (const line of block.split(/\r?\n/)) {
        const match = /^([^:]{1,80}):\s*(.*)$/.exec(line);
        requireCondition(
          match,
          400,
          'Google Docs: используйте строки «Название: …», «ИНН: …» и пустую строку между компаниями',
        );
        const field = aliases[normalize(match[1]!)];
        if (field) {
          requireCondition(!data[field], 400, 'Повторяющееся поле компании');
          data[field] = match[2]!;
        }
      }
      rows.push(fields.map((f) => data[f] || ''));
    }
    return parseCompanyTable(rows, 'Документ', privacy);
  }
  const parts = await unzip(Buffer.from(bytes));
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
export async function fetchPublicGoogleDocument(raw: string): Promise<Uint8Array> {
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
        path: `/document/d/${match[1]}/export?format=txt`,
        method: 'GET',
        timeout: 10000,
        family: 4,
        lookup: (_host, _opts, callback) => callback(null, ips[0]!.address, 4),
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !/^text\/plain(?:;|$)/i.test(String(res.headers['content-type'] || ''))
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
