/** Render the canonical Russian import format while preserving other dial strings. */
export function contactPhone(phone?: string, extension?: string): string {
  if (!phone) return '';
  const formatted = phone.replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/, '+7 $1 $2-$3-$4');
  return extension ? `${formatted} доб. ${extension}` : formatted;
}
