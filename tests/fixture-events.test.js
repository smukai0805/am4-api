import test from 'node:test';
import assert from 'node:assert/strict';
import { selectGoalEvents } from '../api/fixtures.js';

test('goal events expose scorers in match order without cards or substitutions', () => {
  const goals = selectGoalEvents([
    { time: { elapsed: 71, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: 9, name: 'B. Saka' }, assist: { name: 'M. Odegaard' }, type: 'Goal', detail: 'Normal Goal' },
    { time: { elapsed: 12, extra: null }, team: { id: 50, name: 'Manchester City' }, player: { id: 10, name: 'E. Haaland' }, assist: { name: null }, type: 'Goal', detail: 'Penalty' },
    { time: { elapsed: 30, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: 8, name: 'D. Rice' }, type: 'Card', detail: 'Yellow Card' },
  ]);

  assert.deepEqual(goals, [
    { minute: "12'", teamId: 50, team: 'Manchester City', scorer: 'E. Haaland', assist: null, detail: 'Penalty', ownGoal: false },
    { minute: "71'", teamId: 42, team: 'Arsenal', scorer: 'B. Saka', assist: 'M. Odegaard', detail: 'Normal Goal', ownGoal: false },
  ]);
});

test('stoppage-time and own goals are labelled clearly', () => {
  const goals = selectGoalEvents([
    { time: { elapsed: 90, extra: 4 }, team: { id: 1, name: 'Home' }, player: { id: 7, name: 'A. Player' }, assist: { name: null }, type: 'Goal', detail: 'Own Goal' },
  ]);

  assert.deepEqual(goals, [
    { minute: "90+4'", teamId: 1, team: 'Home', scorer: 'A. Player', assist: null, detail: 'Own Goal', ownGoal: true },
  ]);
});
