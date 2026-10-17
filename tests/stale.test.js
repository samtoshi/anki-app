import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../js/stats.js';
import { schedule, buildQueue } from '../js/srs.js';

test('削除されたカードIDの進み具合が残っていても、エラーにならず数えない', () => {
  const T = 20000;
  const cards = [{ id: 's24-01', q: 'q', a: 'a', tags: ['第24回'] }];
  const decks = [{ id: 'shakai', name: '社会', emoji: '🏯', cards, units: [{ kai: 24, name: 'x', cards, latest: true }] }];
  const src = {
    settings: { nickname: '' },
    states: {
      's24-01': schedule(null, 'good', T - 1),
      'zz-01': schedule(null, 'good', T - 1),          // もう無いカード
      'zz-02': { ...schedule(null, 'easy', T - 40), interval: 30 },
    },
    daily: { [T - 1]: { r: 3, c: 3, n: { shakai: 3 } } },
    lastGrades: { 'zz-01': 'again' },
    charMiss: {},
  };
  const st = computeStats(decks, src, T);
  assert.equal(st.decks[0].total, 1);
  assert.equal(st.decks[0].due, 1);
  assert.deepEqual(st.upcoming, [1, 0, 0, 0, 0, 0, 0]);
  assert.equal(st.units.length, 1);
  assert.equal(st.units[0].weak, 0);
  assert.deepEqual(buildQueue(cards, src.states, T, 10).map((c) => c.id), ['s24-01']);
});
