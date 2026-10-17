import test from 'node:test';
import assert from 'node:assert/strict';
import { hedged } from '../js/recognize.js';
const later = (ms, v, fail) => new Promise((ok, ng) => setTimeout(() => (fail ? ng(new Error(v)) : ok(v)), ms));

test('はやく返ってきたら1回だけ', async () => {
  let n = 0; const v = await hedged(() => { n++; return later(10, 'a'); }, 50);
  assert.equal(v, 'a'); await later(80); assert.equal(n, 1);
});
test('おそいときは2回目を送って早いほうを使う', async () => {
  let n = 0; const t0 = Date.now();
  const v = await hedged(() => (++n === 1 ? later(500, 'slow') : later(10, 'fast')), 50);
  assert.equal(v, 'fast'); assert.equal(n, 2); assert.ok(Date.now() - t0 < 300);
});
test('2回目より前に1回目が失敗したらエラー', async () => {
  await assert.rejects(hedged(() => later(10, 'x', true), 50), /x/);
});
test('両方失敗したらエラー・片方成功なら成功', async () => {
  let n = 0;
  assert.equal(await hedged(() => (++n === 1 ? later(100, 'ok') : later(5, 'e', true)), 20), 'ok');
  n = 0; await assert.rejects(hedged(() => (++n === 1 ? later(100, 'e1', true) : later(5, 'e2', true)), 20));
});
