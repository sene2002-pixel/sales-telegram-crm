import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectTeamMetrics, teamMetrics, TeamStats } from '../shared/team-metrics';

const employee: TeamStats = {
  id: '1',
  name: 'Семён Орлов',
  role: 'manager',
  active: true,
  inactiveCompanies: [],
  companies: 10,
  openTasks: 10,
  overdue: 10,
  completed: 10,
  interactions: 10,
};
const manager = { ...employee, id: '2', name: 'Анна Орлова' };
const supervisor: TeamStats = { ...manager, id: '3', role: 'supervisor' };

test('Team search combines partial name, surname and role words independent of order, case and ё', () => {
  const rows = [manager, employee, supervisor];
  assert.deepEqual(selectTeamMetrics(rows, { q: '  Орло  МЕНЕД сеМен ' }), [employee]);
  assert.deepEqual(selectTeamMetrics(rows, { q: 'Анна', role: 'supervisor' }), [supervisor]);
  assert.deepEqual(selectTeamMetrics(rows, { q: 'руков', role: 'manager' }), []);
  assert.deepEqual(selectTeamMetrics(rows, {}), rows);
});

test('Every metric sorts numerically in both directions with deterministic ties without mutating rows', () => {
  for (const [sort] of teamMetrics) {
    const smaller = { ...employee, [sort]: 2 };
    const rows = [supervisor, smaller, manager];
    assert.deepEqual(selectTeamMetrics(rows, { sort, direction: 'asc' }), [
      smaller,
      manager,
      supervisor,
    ]);
    assert.deepEqual(selectTeamMetrics(rows, { sort, direction: 'desc' }), [
      manager,
      supervisor,
      smaller,
    ]);
    assert.deepEqual(rows, [supervisor, smaller, manager]);
  }
});
