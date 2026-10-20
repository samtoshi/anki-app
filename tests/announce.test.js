import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingAnnouncements, mergeSeen } from '../js/announce.js';
import { Store, migrate } from '../js/store.js';

const mem = (d = null) => ({ d, load: async function () { return this.d; }, save: async function (x) { this.d = x; } });
const L = [{ id: 'a', text: '平安時代の復習も加えたよ！', from: '2026-10-21' }, { id: 'b', text: 'つぎ', until: '2026-10-25' }, { id: 'c', text: '' }, { text: 'idなし' }];
const T = (s) => Date.parse(s + '+09:00');

test('おしらせ：見ていないものだけ・期間内だけ（日本時間）', () => {
  assert.deepEqual(pendingAnnouncements(L, {}, T('2026-10-21T00:00:00')).map((a) => a.id), ['a', 'b']);
  assert.deepEqual(pendingAnnouncements(L, {}, T('2026-10-20T23:59:00')).map((a) => a.id), ['b']);
  assert.deepEqual(pendingAnnouncements(L, { a: 1 }, T('2026-10-25T23:59:00')).map((a) => a.id), ['b']);
  assert.deepEqual(pendingAnnouncements(L, { a: 1 }, T('2026-10-26T00:00:01')).map((a) => a.id), []);
  assert.deepEqual(pendingAnnouncements(undefined, {}), []);
  assert.deepEqual(pendingAnnouncements(null, null), []);
});

test('おしらせ：見た記録は どちらかで見たら見たことに（時刻は早いほう）', () => {
  const m = mergeSeen({ a: 5 }, { a: 3, b: 9 });
  assert.deepEqual(m.ann, { a: 3, b: 9 }); assert.equal(m.changed, true);
  assert.equal(mergeSeen({ a: 1 }, { a: 2 }).changed, false);
  assert.deepEqual(mergeSeen(undefined, undefined), { ann: {}, changed: false });
});

test('おしらせ：Store に見た印をつけると送る印もつく・2回目は何もしない・前の形のデータにも入れものができる', async () => {
  assert.deepEqual(migrate({ v: 2, states: {}, reviews: [], settings: {} }).ann, {});
  const s = await new Store(mem()).init();
  assert.equal(s.markAnnSeen('a', 100), true);
  assert.deepEqual(s.data.ann, { a: 100 }); assert.equal(s.data.annDirty, true);
  assert.equal(s.markAnnSeen('a', 200), false); assert.equal(s.data.ann.a, 100);
});
