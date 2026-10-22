type EditableContact = {
  id?: string;
  version?: number;
  name: string;
  role: string;
  phone: string;
  email: string;
};

/** The atomic editor accepts contact changes, not a replacement contact collection. */
export function companyContactChanges(
  draft: EditableContact[],
  existing: { id: string; data: Record<string, any> }[],
) {
  const originals = new Map(existing.map((contact) => [contact.id, contact.data]));
  return draft.flatMap(({ id, version, ...data }) => {
    const original = id ? originals.get(id) : undefined;
    if (
      original &&
      (['name', 'role', 'phone', 'email'] as const).every(
        (field) => data[field] === (original[field] || ''),
      )
    )
      return [];
    return [{ ...(id ? { id, version } : {}), data }];
  });
}
