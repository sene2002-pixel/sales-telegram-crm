// Presentation only: keep the original legal name for storage, editing and documents.
export function companyDisplayName(name: string | null | undefined): string {
  const original = name?.trim() || '';
  const forms =
    '(?:общество\\s+с\\s+ограниченной\\s+ответственностью|(?:публичное|непубличное|открытое|закрытое)\\s+акционерное\\s+общество|акционерное\\s+общество|ООО|ПАО|ОАО|ЗАО|НАО|АО|ИП)';
  let value = original.replace(new RegExp('^' + forms + '(?:\\s+|(?=[«“"]))', 'iu'), '').trim();
  value = value.replace(new RegExp('(?:,\\s*|\\s+)' + forms + '\\.?$', 'iu'), '').trim();
  if (value !== original) {
    for (const [left, right] of [
      ['«', '»'],
      ['“', '”'],
      ['"', '"'],
    ] as const) {
      if (value.startsWith(left) && value.endsWith(right)) {
        value = value.slice(1, -1).trim();
        break;
      }
    }
  }
  return value || original;
}
