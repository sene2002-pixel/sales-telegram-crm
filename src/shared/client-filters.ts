import { Company } from './contracts';
import { ClientScore, displayedClientPotential } from './analytics';
import { companyDisplayName } from './company-display-name';
export const clientSortLabels = {
  name: 'По алфавиту А–Я',
  potential: 'По потенциалу ↓',
  potentialAsc: 'По потенциалу ↑',
  updated: 'По обновлению ↓',
  updatedAsc: 'По обновлению ↑',
  processed: 'По проработке ↓',
  processedAsc: 'По проработке ↑',
} as const;
export type ClientSort = keyof typeof clientSortLabels;
export function matchesClientFilters(
  company: Company,
  city: string,
  segments: readonly string[],
  divisions: readonly string[],
) {
  return (
    (!city || company.city === city) &&
    (!segments.length || segments.includes(company.segment)) &&
    (!divisions.length ||
      divisions.some((key) => company.divisions[key as keyof typeof company.divisions] != null))
  );
}
const levelOrder = ['new', 'acquaintance', 'development', 'partner', 'ours'];
export function compareClients(
  a: Company,
  b: Company,
  sort: ClientSort,
  scores: Record<string, ClientScore>,
  companies: readonly Company[],
) {
  const name = () =>
    companyDisplayName(a.name).localeCompare(companyDisplayName(b.name), 'ru') ||
    a.id.localeCompare(b.id);
  const potential = (company: Company) =>
    displayedClientPotential(
      company,
      companies.filter((child) => child.holdingId === company.id && !child.archived),
    );
  if (sort === 'potential' || sort === 'potentialAsc') {
    const av = potential(a),
      bv = potential(b);
    if (av === null || bv === null) return av === bv ? name() : av === null ? 1 : -1;
    return (sort === 'potential' ? bv - av : av - bv) || name();
  }
  if (sort === 'updated' || sort === 'updatedAsc')
    return (
      (sort === 'updated'
        ? b.updatedAt.localeCompare(a.updatedAt)
        : a.updatedAt.localeCompare(b.updatedAt)) || name()
    );
  if (sort === 'processed' || sort === 'processedAsc') {
    const av = scores[a.id],
      bv = scores[b.id];
    if (!av || !bv) return av === bv ? name() : !av ? 1 : -1;
    const rank = levelOrder.indexOf(av.level) - levelOrder.indexOf(bv.level);
    return (
      (sort === 'processed' ? -(rank || av.score - bv.score) : rank || av.score - bv.score) ||
      name()
    );
  }
  return name();
}
