import { Company, CrmRecord } from '../shared/contracts';
import { CommittedRecord, useUndoActions } from './TaskActions';
import { api, ApiError, token } from './api';

export type EquipmentKey = keyof Company['divisions'];

const archiveKey = (id: string) => `company-archive:${id}`;
const restoreKey = (id: string) => `company-restore:${id}`;
const equipmentKey = (id: string, division: EquipmentKey) => `equipment-delete:${id}:${division}`;
export const contactDeleteKey = (id: string) => `contact-delete:${id}`;

export function companyTransitionPending(company: Company, pending: ReadonlySet<string>) {
  return pending.has(archiveKey(company.id)) || pending.has(restoreKey(company.id));
}

export function equipmentRemoval(comp: Company, division: EquipmentKey) {
  const divisions = { ...comp.divisions };
  delete divisions[division];
  return {
    divisions,
    potential: Object.values(divisions).reduce((sum, amount) => sum + amount, 0),
  };
}

export function pendingEquipment(company: Company, pending: ReadonlySet<string>) {
  return (Object.keys(company.divisions) as EquipmentKey[]).find((division) =>
    pending.has(equipmentKey(company.id, division)),
  );
}

export function projectClientUndo(company: Company, pending: ReadonlySet<string>): Company {
  const equipment = pendingEquipment(company, pending);
  const archived = pending.has(archiveKey(company.id))
    ? true
    : pending.has(restoreKey(company.id))
      ? false
      : company.archived;
  if (!equipment && archived === company.archived) return company;
  return { ...company, ...(equipment && equipmentRemoval(company, equipment)), archived };
}

export function applyCommittedRecord<T extends { company: Company; records: CrmRecord[] }>(
  detail: T,
  update: CommittedRecord | null,
): T {
  if (!update || update.companyId !== detail.company.id) return detail;
  const current = detail.records.find((record) => record.id === update.id);
  if (!current || (update.record && current.version >= update.record.version)) return detail;
  const saved = update.record;
  return {
    ...detail,
    records: saved
      ? detail.records.map((record) => (record.id === saved.id ? { ...record, ...saved } : record))
      : detail.records.filter((record) => record.id !== update.id),
  };
}

export function useClientUndo() {
  const { pending, schedule, committedRecord } = useUndoActions();
  const session = token;
  async function commitWithConflictRefresh<T>(
    commit: () => Promise<T>,
    refresh: () => Promise<void>,
  ) {
    try {
      return await commit();
    } catch (error) {
      if (session === token && error instanceof ApiError && error.status === 409)
        await refresh().catch(() => undefined);
      throw error;
    }
  }
  return {
    pending,
    committedRecord,
    setArchived(company: Company, onCommitted?: () => Promise<void>) {
      if (companyTransitionPending(company, pending) || pendingEquipment(company, pending)) return;
      const archived = !company.archived;
      schedule({
        key: archived ? archiveKey(company.id) : restoreKey(company.id),
        label: archived ? 'Клиент удалён' : 'Клиент снова в работе',
        kind: archived ? 'deleted' : 'restore',
        commit: () =>
          commitWithConflictRefresh(
            async () => {
              await api(`/companies/${company.id}/archive`, 'POST', {
                archived,
                version: company.version,
              });
            },
            onCommitted ?? (() => Promise.resolve()),
          ),
        onCommitted,
      });
    },
    deleteEquipment(
      company: Company,
      division: EquipmentKey,
      commit: () => Promise<void>,
      onCommitted: () => Promise<void>,
    ) {
      if (pendingEquipment(company, pending) || companyTransitionPending(company, pending)) return;
      schedule({
        key: equipmentKey(company.id, division),
        label: 'Оборудование удалено',
        kind: 'deleted',
        commit,
        onCommitted,
      });
    },
    deleteContact(contact: CrmRecord, onCommitted: () => Promise<void>) {
      schedule({
        key: contactDeleteKey(contact.id),
        label: 'Контакт удалён',
        kind: 'deleted',
        commit: () =>
          commitWithConflictRefresh(async () => {
            await api(`/contacts/${contact.id}?version=${contact.version}`, 'DELETE');
            return { companyId: contact.companyId, id: contact.id };
          }, onCommitted),
        onCommitted,
      });
    },
  };
}
