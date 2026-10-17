import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGame, streakInfo, stickerBalance, levelOf, monthCells } from '../js/game.js';
import { dayIndex } from '../js/srs.js';

const at = (day, h = 18) => { const d = new Date(2026, 9, 1 + day, h); return d.getTime(); };
const revs = (day, n, g = 'good') => Array.from({ length: n }, (_, i) => ({ c: 'c' + i, d: 'shakai', g, t: at(day) + i * 1000, m: 's' }));

test('れんぞく日数は「10まい以上の日」、7日でシール1まい', () => {
  const today = dayIndex(new Date(at(20)));
  const daily = {};
  for (let i = 0; i < 16; i++) daily[today - 15 + i] = { r: i === 4 ? 3 : 12 }; // 4日目は3まいだけ（れんぞくが切れる）
  const s = streakInfo(daily, today);
  assert.equal(s.streak, 11); assert.equal(s.best, 11); assert.equal(s.earned, 1); assert.equal(s.progress, 4);
  // 今日まだ勉強していなくても、きのうまでのれんぞくは消えない
  delete daily[today];
  assert.equal(streakInfo(daily, today).streak, 10);
});

test('シールの残り：申しこみ中・使った分をひく。ことわられた分はもどる', () => {
  assert.deepEqual(stickerBalance(5, [{ cost: 3, st: 'ok' }, { cost: 1, st: 'req' }, { cost: 2, st: 'no' }]), { earned: 5, used: 4, balance: 1 });
});

test('XP・レベル・コンボ・バッジ', () => {
  const r = [...revs(0, 12), ...revs(1, 3, 'again'), ...revs(1, 9)];
  const g = computeGame(r, { today: dayIndex(new Date(at(1))), goal: 20 });
  assert.equal(g.total, 24);
  assert.ok(g.xp > 0); assert.equal(g.maxCombo, 12);
  assert.ok('first' in g.badges && 'combo10' in g.badges && 'perfect' in g.badges);
  assert.equal(levelOf(99).lv, 1); assert.equal(levelOf(100).lv, 2); assert.equal(levelOf(240).lv, 3);
});

test('カレンダー：日曜はじまりで、勉強した日に印', () => {
  const today = dayIndex(new Date(2026, 9, 17, 12));
  const cells = monthCells(2026, 9, { [today]: { r: 15 }, [today - 1]: { r: 4 } }, today);
  assert.equal(cells.length % 7, 0);
  const c17 = cells.find((c) => c && c.date === 17), c16 = cells.find((c) => c && c.date === 16);
  assert.ok(c17.studied && c17.today); assert.ok(!c16.studied && c16.part);
  assert.equal(cells.findIndex((c) => c && c.date === 1), new Date(2026, 9, 1).getDay());
});
