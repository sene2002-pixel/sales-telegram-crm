import { DomainError } from '../domain/errors';
/** Deterministic layout preprocessing. Never treats shipment history as potential. */
export function normalizeLayout(rows: string[][], sourceRows = rows.map((_, i) => i + 1)) {
  if (
    rows.length > 2000 ||
    rows.some((r) => r.length > 100 || r.some((c) => c.length > 1000)) ||
    sourceRows.length !== rows.length
  )
    throw new DomainError(400, 'Превышены ограничения таблицы');
  let output = rows.map((r) => [...r]);
  let origins = [...sourceRows];
  const warnings: string[] = [];
  let kind: 'companies' | 'invoices' | 'erp' = 'companies';
  const key = (s: string = '') => s.trim().toLowerCase().replace(/ё/g, 'е');
  const companyHeader = (s: string) =>
    /^(компания|клиент|контрагент|покупатель|наименование контрагента)$/.test(key(s));
  const codeFields = rows.flatMap((r) =>
    r.some(companyHeader)
      ? r.flatMap((c, j) => (/^(тип|категория|тип клиента|отрасль)$/.test(key(c)) ? [j] : []))
      : [],
  );
  const usedCodes = new Set(
    rows.flatMap((r) =>
      codeFields.map((j) => r[j]?.trim()).filter((v): v is string => !!v && /^\d{1,3}$/.test(v)),
    ),
  );
  const hasUsedLegend = rows.some((r) => {
    const filled = r.filter((c) => c.trim());
    const candidate = filled.length === 1 && /^\s*(\d{1,3})\s*[-–—=]\s*\S/.exec(filled[0]!);
    return !!candidate && usedCodes.has(candidate[1]!);
  });
  const legend = new Map<string, string>();
  const legendRows = new Set<number>();
  for (let i = 0; i < output.length; i++) {
    const filled = output[i]!.filter((c) => c.trim());
    if (filled.length !== 1) continue;
    const m = /^\s*(\d{1,3})\s*[-–—=]\s*(\S.{1,99})\s*$/.exec(filled[0]!);
    if (!m || !hasUsedLegend) continue;
    const previous = legend.get(m[1]!);
    if (previous && previous !== m[2]!)
      throw new DomainError(400, 'Противоречивая легенда таблицы');
    legend.set(m[1]!, m[2]!);
    legendRows.add(i);
  }
  let typeColumns: number[] = [];
  for (let i = 0; i < output.length; i++) {
    const row = output[i]!;
    if (row.some(companyHeader))
      typeColumns = row.flatMap((c, j) =>
        /^(тип|категория|тип клиента|отрасль)$/.test(key(c)) ? [j] : [],
      );
    else
      for (const j of typeColumns)
        if (legend.has(row[j]?.trim() || '')) row[j] = legend.get(row[j]!.trim())!;
  }
  if (legendRows.size) {
    origins = origins.filter((_, i) => !legendRows.has(i));
    output = output.filter((_, i) => !legendRows.has(i));
    warnings.push('Числовые коды типов раскрыты по явной легенде таблицы');
  }
  // A blank heading may carry adjacent notes, but symbols/numbers carry no known meaning.
  for (let start = 0; start < output.length; start++) {
    const h = output[start]!;
    const nameColumn = h.findIndex(companyHeader);
    if (nameColumn < 0) continue;
    let end = start + 1;
    while (end < output.length && !output[end]!.some(companyHeader)) end++;
    const width = Math.max(h.length, ...output.slice(start + 1, end).map((r) => r.length));
    for (let j = 0; j < width; j++) {
      if (h[j]?.trim()) continue;
      const values = output.slice(start + 1, end).filter((r) => r[j]?.trim());
      if (
        values.length &&
        values.every(
          (r) =>
            r[nameColumn]?.trim() &&
            /[а-яa-z]{2}/i.test(r[j]!) &&
            !/^\s*[\d.,+−–—%₽$]+\s*$/.test(r[j]!),
        )
      ) {
        h[j] = `Заметка из таблицы ${j + 1}`;
      }
    }
    const sections = output
      .slice(start + 1, end)
      .some(
        (r) =>
          r.filter((c) => c.trim()).length === 1 && /^Отрасль\s*:\s*\S/i.test(r[nameColumn] || ''),
      );
    if (sections) {
      let industryColumn = h.findIndex((c) => key(c) === 'отрасль');
      if (industryColumn < 0) {
        industryColumn = width;
        h[industryColumn] = 'Отрасль';
      }
      let industry = '';
      for (let row = start + 1; row < end; row++) {
        const r = output[row]!;
        const m =
          r.filter((c) => c.trim()).length === 1 &&
          /^Отрасль\s*:\s*(.{1,150})$/i.exec(r[nameColumn] || '');
        if (m) {
          industry = m[1]!.trim();
          r[nameColumn] = '';
        } else if (r[nameColumn]?.trim() && !r[industryColumn]?.trim() && industry)
          r[industryColumn] = industry;
      }
    }
    start = end - 1;
  }
  // ERP indentation is meaningful only when the source explicitly contains buying groups.
  const header = output.findIndex((r) => r.some(companyHeader));
  const column = header < 0 ? -1 : output[header]!.findIndex(companyHeader);
  const group = (s: string) => /^(покупают|не покупают|итого|всего)(?:\s|$)/i.test(s.trim());
  if (
    column >= 0 &&
    output.slice(header + 1).some((r) => /^(покупают|не покупают)$/i.test(r[column]?.trim() || ''))
  ) {
    const depths = output
      .slice(header + 1)
      .filter((r) => r[column]?.trim() && !group(r[column]!))
      .map((r) => /^\s*/.exec(r[column]!)![0].replace(/\t/g, '    ').length);
    const deepest = Math.max(0, ...depths);
    if (deepest > 0) {
      const depth = (r: string[]) => /^\s*/.exec(r[column] || '')![0].replace(/\t/g, '    ').length;
      const keep = output.map((r, i) => {
        if (i <= header) return true;
        if (!r[column]?.trim() || group(r[column]!) || depth(r) === 0) return false;
        const next = output.slice(i + 1).find((candidate) => candidate[column]?.trim());
        return !next || depth(next) <= depth(r);
      });
      origins = origins.filter((_, i) => keep[i]);
      output = output
        .filter((_, i) => keep[i])
        .map((r) => r.map((c, j) => (j === column ? c.trim() : c)));
      kind = 'erp';
      warnings.push('Строки групп и руководителей исключены по явной иерархии отступов');
    }
  }
  // A contract row requires an explicit document marker and a real calendar date.
  const contractName = (s: string): string | undefined => {
    const m =
      /^\s*(?:\[\d+\]\s*)?(?:дог(?:овор)?|счет|счёт)\.?\s+\S+\s+от\s+(\d{2})\.(\d{2})\.(\d{4})\s*(?:г\.?)?\s+(.+)$/i.exec(
        s,
      );
    if (!m) return;
    const d = Number(m[1]),
      month = Number(m[2]),
      year = Number(m[3]);
    const date = new Date(Date.UTC(year, month - 1, d));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== d
    )
      return;
    return m[4]!.trim();
  };
  const contractHeader = output.findIndex((r) =>
    r.some((c) => /^(договор|счет|счёт|документ)$/.test(key(c))),
  );
  if (contractHeader >= 0) {
    const h = output[contractHeader]!;
    const doc = h.findIndex((c) => /^(договор|счет|счёт|документ)$/.test(key(c)));
    if (output.slice(contractHeader + 1).some((r) => contractName(r[doc] || ''))) {
      // Invoice imports are company lists only; no account comments or amounts survive.
      const allowed = h.flatMap((c, j) => (/^(инн|город|страна|регион)$/.test(key(c)) ? [j] : []));
      const next: string[][] = [['Компания', ...allowed.map((j) => h[j]!)]];
      const nextOrigins = [origins[contractHeader]!];
      for (let i = contractHeader + 1; i < output.length; i++) {
        const name = contractName(output[i]![doc] || '');
        if (!name) continue;
        next.push([name, ...allowed.map((j) => output[i]![j] || '')]);
        nextOrigins.push(origins[i]!);
      }
      output = next;
      origins = nextOrigins;
      kind = 'invoices';
      warnings.push('Суммы и оперативные заметки счетов и отгрузок пропущены');
    }
  }
  // Explicit historical shipment columns must never become potential, including ERP exports.
  let removed = new Set<number>();
  let shipmentColumns = false;
  output = output.map((r) => {
    if (r.some(companyHeader)) {
      removed = new Set<number>();
      r.forEach((c, j) => {
        if (
          /отгруж|отгрузк|купили.+\b20\d{2}\b/i.test(c) ||
          (kind === 'erp' && /^годовая$/i.test(c.trim()))
        )
          removed.add(j);
      });
    }
    if (removed.size) shipmentColumns = true;
    return r.filter((_, j) => !removed.has(j));
  });
  if (shipmentColumns) warnings.push('Колонки отгрузок пропущены');
  return { rows: output, sourceRows: origins, warnings, kind };
}
