const bytes = (s: string) => Buffer.from(s);
export function zip(entries: Record<string, string>): Buffer {
  const files: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  function crc(b: Buffer) {
    let n = 0xffffffff;
    for (const c of b) {
      n ^= c;
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    }
    return (n ^ 0xffffffff) >>> 0;
  }
  for (const [name, text] of Object.entries(entries)) {
    const n = bytes(name),
      b = bytes(text),
      h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc(b), 14);
    h.writeUInt32LE(b.length, 18);
    h.writeUInt32LE(b.length, 22);
    h.writeUInt16LE(n.length, 26);
    files.push(h, n, b);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc(b), 16);
    c.writeUInt32LE(b.length, 20);
    c.writeUInt32LE(b.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += h.length + n.length + b.length;
  }
  const end = Buffer.alloc(22),
    cd = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, cd, end]);
}
const clients = [
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
const projects = [
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
export const escapeXml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export const xmlCell = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
export function picoTemplate(
  options: { clients?: string[][]; projects?: string[][]; formula?: string; merge?: string } = {},
) {
  const worksheet = (headers: string[], data: string[][], kind: 'clients' | 'projects') => {
    const letter = (col: number) => String.fromCharCode(65 + col);
    const spans = kind === 'clients' ? [4, 6] : [5, 7];
    const top = headers.map((h, i) => xmlCell(`${letter(i)}1`, h)).join('');
    const sub = spans
      .flatMap((col) => [
        xmlCell(`${letter(col)}2`, '0,4 кВ'),
        xmlCell(`${letter(col + 1)}2`, '6-35 кВ'),
      ])
      .join('');
    // A deliberately populated demo must never become a CRM record.
    const demo = xmlCell('A4', 'Демонстрация') + xmlCell('B4', 'Не импортировать');
    const rows = Array.from({ length: 500 }, (_, i) => {
      const r = i + 5,
        total = kind === 'clients' ? 'M' : 'Q',
        range = kind === 'clients' ? `E${r}:L${r}` : `F${r}:O${r}`;
      const content = (data[i] || [])
        .map((v, col) =>
          col === (kind === 'clients' ? 12 : 16) ? '' : xmlCell(`${letter(col)}${r}`, v),
        )
        .join('');
      const formula =
        options.formula && kind === 'clients' && i === 0
          ? options.formula
          : `IF(COUNT(${range})=0,"",SUM(${range}))`;
      return `<row r="${r}">${content}<c r="${total}${r}"><f>${escapeXml(formula)}</f><v>99999</v></c></row>`;
    }).join('');
    const merges = headers.flatMap((h, i) =>
      h
        ? [spans.includes(i) ? `${letter(i)}1:${letter(i + 1)}1` : `${letter(i)}1:${letter(i)}2`]
        : [],
    );
    if (options.merge) merges.push(options.merge);
    return `<worksheet><sheetData><row r="1">${top}</row><row r="2">${sub}</row><row r="4">${demo}</row>${rows}</sheetData><mergeCells>${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells></worksheet>`;
  };
  return zip({
    'xl/workbook.xml':
      '<workbook xmlns:r="urn:relationships"><sheets><sheet name="Как заполнять" sheetId="1" r:id="r1"/><sheet name="Клиенты" sheetId="2" r:id="r2"/><sheet name="Проекты" sheetId="3" r:id="r3"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/><Relationship Id="r3" Target="worksheets/sheet3.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet/>',
    'xl/worksheets/sheet2.xml': worksheet(clients, options.clients || [], 'clients'),
    'xl/worksheets/sheet3.xml': worksheet(projects, options.projects || [], 'projects'),
  });
}
export const syntheticClient = () => [
  '7707083893',
  'Тестовая компания',
  'Казань',
  'Интегратор',
  '1',
  '2',
  '',
  '',
  '0',
  '3',
  '',
  '',
  '',
  'Якорь',
  'Тестовый Контакт, инженер, +79990000001, business@example.test',
  'Комментарий',
];
export const syntheticProject = () => [
  'Тестовая компания',
  '7707083893',
  'Тестовый проект',
  '',
  '',
  '1',
  '',
  '',
  '',
  '',
  '2',
  '',
  '',
  '',
  '',
  'Трансформатор - 4',
  '',
  'Тендер',
  '11.2026',
  '03.2027',
  'Проектный комментарий',
];
export function docxDocument(body: string) {
  return zip({
    'word/document.xml': `<w:document xmlns:w="urn:word"><w:body>${body}</w:body></w:document>`,
  });
}
export const docParagraph = (value: string) =>
  `<w:p><w:r><w:t>${escapeXml(value)}</w:t></w:r></w:p>`;
export const docTable = (rows: string[][]) =>
  `<w:tbl>${rows.map((r) => `<w:tr>${r.map((v) => `<w:tc>${docParagraph(v)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
