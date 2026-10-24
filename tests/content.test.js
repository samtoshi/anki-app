import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchContent } from '../js/cloud.js';

const KEY = 'anki-cards:content';
function mem(init = {}, { quota = Infinity } = {}) {
  const m = new Map(Object.entries(init));
  const size = () => [...m.values()].reduce((a, v) => a + v.length, 0);
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { const old = m.get(k); m.delete(k); if (size() + v.length > quota) { if (old != null) m.set(k, old); throw new Error('QuotaExceededError'); } m.set(k, v); },
    removeItem: (k) => m.delete(k),
  };
}
const MAN = {
  decks: [
    { id: 'shakai', latest: [25], units: [{ kai: 25, doc: 'u_shakai_25' }] },
    { id: 'kanji', latest: [25], units: [{ kai: 25, doc: 'u_kanji_25' }] },
  ],
};
const UNITS = { u_shakai_25: { cards: Array.from({ length: 87 }, (_, i) => ({ id: 's25-' + i })) }, u_kanji_25: { cards: [{ id: 'k25-01' }] } };
// 10/17 より前の古い分（漢字なし・社会25は50まい）
const OLD = { uid: 'u1', at: 1, manifest: { decks: [{ id: 'shakai', latest: [25], units: [{ kai: 25, doc: 'u_shakai_25' }] }] }, units: { u_shakai_25: { cards: Array.from({ length: 50 }, (_, i) => ({ id: 's25-' + i })) } } };
const ok = { getManifest: async () => MAN, getUnit: async (id) => UNITS[id] };
const net = () => Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });

test('ネットで読めたら新しいカード（漢字・社会25の87まい）で、前の分を上書きする', async () => {
  const st = mem({ [KEY]: JSON.stringify(OLD) });
  const c = await fetchContent({ uid: 'u1', ...ok, storage: st, waitMs: 0 });
  assert.equal(c.offline, undefined);
  assert.equal(c.units.u_kanji_25.cards.length, 1);
  assert.equal(c.units.u_shakai_25.cards.length, 87);
  assert.equal(JSON.parse(st.getItem(KEY)).units.u_shakai_25.cards.length, 87);
});

test('1回目だけ失敗したら、もう一度読んで新しい分を使う（古い分にしない）', async () => {
  let n = 0;
  const c = await fetchContent({ uid: 'u1', ...ok, getManifest: async () => { if (!n++) throw net(); return MAN; }, storage: mem({ [KEY]: JSON.stringify(OLD) }), waitMs: 0 });
  assert.equal(c.offline, undefined);
  assert.ok(c.units.u_kanji_25);
});

test('ずっと読めないときだけ前の分を使い、offline と いつの分か を返す', async () => {
  const c = await fetchContent({ uid: 'u1', getManifest: async () => { throw net(); }, getUnit: async () => null, storage: mem({ [KEY]: JSON.stringify(OLD) }), waitMs: 0 });
  assert.equal(c.offline, true);
  assert.equal(c.cachedAt, 1);
});

test('1つの回だけ読めないときは、その回だけ前の分（ほかの科目は消えない）', async () => {
  const c = await fetchContent({ uid: 'u1', getManifest: async () => MAN, getUnit: async (id) => { if (id === 'u_shakai_25') throw net(); return UNITS[id]; }, storage: mem({ [KEY]: JSON.stringify(OLD) }), waitMs: 0 });
  assert.equal(c.offline, true);
  assert.ok(c.units.u_kanji_25, '漢字は新しい分');
  assert.equal(c.manifest.decks.length, 2);
});

test('端末の保存がいっぱいでも、古い分を消して入れなおす（古いまま固まらない）', async () => {
  const oldRaw = JSON.stringify(OLD);
  const st = mem({ other: 'x'.repeat(1000), [KEY]: oldRaw }, { quota: 1000 + JSON.stringify({ uid: 'u1', at: 0, manifest: MAN, units: UNITS }).length + 50 });
  await fetchContent({ uid: 'u1', ...ok, storage: st, waitMs: 0, now: () => 5 });
  assert.equal(JSON.parse(st.getItem(KEY)).at, 5);
});

test('どうしても保存できないときは、古い分を残さない', async () => {
  const st = mem({ other: 'x'.repeat(1000), [KEY]: JSON.stringify(OLD) }, { quota: 1100 });
  const c = await fetchContent({ uid: 'u1', ...ok, storage: st, waitMs: 0 });
  assert.ok(c.units.u_kanji_25);
  assert.equal(st.getItem(KEY), null);
});

test('ほかの人の前の分は使わない・権限エラーはそのまま', async () => {
  await assert.rejects(fetchContent({ uid: 'u2', getManifest: async () => { throw net(); }, getUnit: async () => null, storage: mem({ [KEY]: JSON.stringify(OLD) }), waitMs: 0 }));
  await assert.rejects(fetchContent({ uid: 'u1', getManifest: async () => { throw Object.assign(new Error('x'), { code: 'permission-denied' }); }, getUnit: async () => null, storage: mem({ [KEY]: JSON.stringify(OLD) }), waitMs: 0 }), { code: 'permission-denied' });
});
