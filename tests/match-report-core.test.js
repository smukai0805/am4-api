import test from 'node:test';
import assert from 'node:assert/strict';
import { requirePlayerOfMatch } from '../lib/match-report-core.js';

test('a match report cannot be generated without one Player of the Match', () => {
  assert.throws(
    () => requirePlayerOfMatch({ ratings: [], mom: null }),
    /Player of the Matchを確定できない/,
  );
});

test('the computed mom is the report Player of the Match', () => {
  const mom = { playerId: 1100, name: 'Erling Haaland', rating: 9.1 };
  assert.equal(requirePlayerOfMatch({ ratings: [mom], mom }), mom);
});
