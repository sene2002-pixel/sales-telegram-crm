import { Actor, isLeader } from '../shared/contracts';
import { Field } from './forms';

export function InvitationTeamSelect({
  user,
  users,
  value,
  onChange,
  disabled,
}: {
  user: Actor;
  users: Actor[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  if (user.role !== 'admin') return null;
  return (
    <Field label="Команда руководителя">
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value={user.id}>Моя команда</option>
        {users
          .filter((person) => person.id !== user.id && person.active && isLeader(person))
          .map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
      </select>
    </Field>
  );
}
