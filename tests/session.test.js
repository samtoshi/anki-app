import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, migrate, mergeSlog, mergeSel, pickInprog, DEFAULT_SETTINGS } from '../js/store.js';

const mem = (d = null) => ({ d, load: async function () { return this.d; }, save: async function (x) { this.d = x; } });

test('自動の読み上げ：はじめは OFF・前に ON だった端末も一度だけ OFF（そのあと ON にしたら ON のまま）', () => {
  assert.equal(DEFAULT_SETTINGS.ttsAuto, false);
  const old = migrate({ v: 2, states: {}, reviews: [], settings: { ttsAuto: true, recogV: 2 } });
  assert.equal(old.settings.ttsAuto, false); assert.equal(old.settings.ttsV, 2);
  const undef = migrate({ v: 2, states: {}, reviews: [], settings: { recogV: 2 } });
  assert.equal(undef.settings.ttsAuto, false);
  const again = migrate({ v: 2, states: {}, reviews: [], settings: { ttsAuto: true, ttsV: 2, recogV: 2 } });
  assert.equal(again.settings.ttsAuto, true);
  assert.equal(migrate({ v: 1, states: {}, settings: { ttsAuto: true } }).settings.ttsAuto, false);
});

test('前の形のデータにも、記録・はんい・とちゅうの勉強の入れものができる', () => {
  const d = migrate({ v: 2, states: {}, reviews: [], settings: {} });
  assert.deepEqual(d.slog, {}); assert.deepEqual(d.sel, {}); assert.equal(d.inprog, null); assert.deepEqual(d.slogDirty, []);
});

test('勉強の記録：1枚ごとに まい数・正解・時間（1枚3分まで）・終わりの時刻', async () => {
  const s = await new Store(mem()).init();
  const sit = { id: 'a', s: 1000, d: ['shakai'], rg: '社会 第24回', k: 'study' };
  s.logCard(sit, { g: 'good', cardMs: 20000, now: 21000 });
  s.logCard(sit, { g: 'again', cardMs: 30000, now: 51000 });
  s.logCard(sit, { g: 'easy', cardMs: 3600000, now: 4000000 });
  const e = s.data.slog.a;
  assert.equal(e.n, 3); assert.equal(e.ok, 2); assert.equal(e.ms, 20000 + 30000 + 180000);
  assert.equal(e.s, 1000); assert.equal(e.e, 4000000); assert.equal(e.rg, '社会 第24回');
  assert.deepEqual(s.data.slogDirty, ['a']);
});

test('記録のまぜかた：まい数が多い・あとまで続いたほう', () => {
  const l = { a: { n: 2, e: 10 }, b: { n: 5, e: 50 } };
  const r = { a: { n: 3, e: 20 }, b: { n: 5, e: 40 }, c: { n: 1, e: 5 } };
  const m = mergeSlog(l, r);
  assert.equal(m.slog.a.n, 3); assert.equal(m.slog.b.e, 50); assert.ok(m.slog.c); assert.equal(m.added, 2);
  assert.equal(mergeSlog(m.slog, m.slog).added, 0);
});

test('はんい：あとで決めたほう（教科ごと）', () => {
  const m = mergeSel({ shakai: { k: [24], t: 5 }, rika: { k: [25], t: 9 } }, { shakai: { k: [23, 24], t: 7 }, rika: { k: [21], t: 3 } });
  assert.deepEqual(m.sel.shakai.k, [23, 24]); assert.deepEqual(m.sel.rika.k, [25]); assert.equal(m.changed, true);
});

test('とちゅうの勉強：新しいほう・すてた(none)も新しければそちら・つづきが残っているときだけ再開できる', async () => {
  assert.equal(pickInprog({ t: 5, i: 1 }, { t: 9, none: 1 }).inprog.none, 1);
  assert.equal(pickInprog({ t: 9, i: 2 }, { t: 5, i: 1 }).inprog.i, 2);
  assert.equal(pickInprog(null, { t: 1, i: 0 }).changed, true);
  const s = await new Store(mem()).init();
  s.setInprog({ id: 'x', k: 'study', ids: ['a', 'b', 'c'], i: 1 }, 100);
  assert.equal(s.resumable.i, 1); assert.equal(s.data.inprogDirty, true); assert.equal(s.data.inprog.t, 100);
  s.setInprog({ id: 'x', k: 'study', ids: ['a', 'b'], i: 2 }, 200);
  assert.equal(s.resumable, null);
  s.setInprog(null, 300);
  assert.deepEqual(s.data.inprog, { t: 300, none: 1 }); assert.equal(s.resumable, null);
});

test('はんいを決めると、送る印がつく', async () => {
  const s = await new Store(mem()).init();
  s.setRange('shakai', [23, 24], 50);
  assert.deepEqual(s.data.sel.shakai, { k: [23, 24], t: 50 }); assert.equal(s.data.selDirty, true);
});
