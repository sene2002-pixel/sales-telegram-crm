// Compare page identity, not raw URL spelling. Do not equate different paths,
// meaningful query parameters, subdomains or protocols: those can identify other entities.
export function sourceKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // Search providers append tracking markers while the model commonly returns the canonical URL.
    // They do not identify the document and must not make an otherwise identical source fail validation.
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
    // Preserve hash-router routes; only document fragments/text highlights are ignored.
    if (!/^#(?:!|\/)/.test(url.hash)) url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function observedSources(output: any[]): Map<string, string> {
  const observed = new Map<string, string>();
  const add = (raw: unknown) => {
    const key = sourceKey(raw);
    if (key && typeof raw === 'string') observed.set(key, raw);
  };
  for (const item of output) {
    if (item.type === 'web_search_call' && (!item.status || item.status === 'completed')) {
      for (const source of item.action?.sources || []) add(source.url);
      if (item.status === 'completed' && ['open_page', 'find_in_page'].includes(item.action?.type))
        add(item.action.url);
    }
    for (const part of item.content || [])
      for (const citation of part.annotations || [])
        if (citation.type === 'url_citation') add(citation.url);
  }
  return observed;
}
