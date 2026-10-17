import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, cardStatus, isDue, buildQueue, retrievability, upcoming, streak, previewLabel, MASTERED_DAYS } from '../js/srs.js';

const T = 20000;

test('新しいカード：わかった → あした、その次 6日後、その次は EF 倍', () => {
  let s = schedule(null, 'good', T);
  assert.equal(s.interval, 1); assert.equal(s.due, T + 1); assert.equal(s.reps, 1);
  s = schedule(s, 'good', T + 1);
  assert.equal(s.interval, 6); assert.equal(s.due, T + 7);
  s = schedule(s, 'good', T + 7);
  assert.equal(s.interval, Math.round(6 * s.ef)); // 6 * 2.5 = 15
  assert.equal(s.interval, 15);
});

test('わからない → 間隔0（今日もう一度）、EFが下がる、lapse が増える', () => {
  let s = schedule(null, 'good', T);
  s = schedule(s, 'good', T + 1);
  const before = s.ef;
  s = schedule(s, 'again', T + 7);
  assert.equal(s.interval, 0); assert.equal(s.reps, 0); assert.equal(s.lapses, 1);
  assert.ok(s.ef < before);
  assert.ok(isDue(s, T + 7));
  // もう一度わかった → あした
  s = schedule(s, 'good', T + 7);
  assert.equal(s.interval, 1);
});

test('EF は 1.3 より下がらない', () => {
  let s = null;
  for (let i = 0; i < 20; i++) s = schedule(s, 'again', T + i);
  assert.equal(s.ef, 1.3);
});

test('むずかしい < わかった < かんたん の順に間隔がのびる', () => {
  let base = schedule(schedule(schedule(null, 'good', T), 'good', T + 1), 'good', T + 7);
  const h = schedule(base, 'hard', T + 22).interval;
  const g = schedule(base, 'good', T + 22).interval;
  const e = schedule(base, 'easy', T + 22).interval;
  assert.ok(h < g && g < e, `${h} ${g} ${e}`);
  assert.ok(h > base.interval);
});

test('間隔が21日以上で「覚えた」', () => {
  let s = null, day = T;
  assert.equal(cardStatus(s), 'new');
  s = schedule(s, 'good', day); assert.equal(cardStatus(s), 'learning');
  while (s.interval < MASTERED_DAYS) { day = s.due; s = schedule(s, 'good', day); }
  assert.equal(cardStatus(s), 'mastered');
});

test('間隔の上限は365日', () => {
  let s = null, day = T;
  for (let i = 0; i < 15; i++) { s = schedule(s, 'easy', day); day = s.due; }
  assert.equal(s.interval, 365);
});

test('元の state を変更しない', () => {
  const s = schedule(null, 'good', T);
  const copy = JSON.stringify(s);
  schedule(s, 'easy', T + 1);
  assert.equal(JSON.stringify(s), copy);
});

test('今日のキュー：期限の来たカード＋新しいカード（上限つき）', () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ id: 'c' + i }));
  const states = {};
  states.c0 = { ...schedule(null, 'good', T - 5), due: T - 3 }; // 期限切れ
  states.c1 = schedule(null, 'good', T - 1);                     // due = T
  states.c2 = schedule(null, 'good', T);                         // due = T+1（まだ）
  const q = buildQueue(cards, states, T, 5);
  const ids = q.map((c) => c.id);
  assert.ok(ids.includes('c0') && ids.includes('c1'));
  assert.ok(!ids.includes('c2'));
  assert.equal(ids.length, 2 + 5);
  assert.equal(ids[0], 'c0'); // 古い期限が先
  assert.equal(buildQueue(cards, states, T, 0).length, 2);
});

test('忘却曲線：復習日にちょうど90%、時間がたつほど下がる', () => {
  const s = schedule(schedule(null, 'good', T), 'good', T + 1); // interval 6, last T+1
  assert.equal(retrievability(s, T + 1), 1);
  assert.ok(Math.abs(retrievability(s, T + 7) - 0.9) < 1e-9);
  assert.ok(retrievability(s, T + 20) < 0.9);
  assert.equal(retrievability(null, T), null);
});

test('これからの復習枚数・連続日数', () => {
  const states = { a: schedule(null, 'good', T), b: schedule(null, 'easy', T) };
  assert.deepEqual(upcoming(states, ['a', 'b', 'x'], T, 7), [0, 1, 0, 1, 0, 0, 0]);
  assert.equal(streak([T, T - 1, T - 2, T - 4], T), 3);
  assert.equal(streak([T - 1, T - 2], T), 2); // 今日まだでも、きのうまで続いていればOK
  assert.equal(streak([T - 2], T), 0);
});

test('ボタンの表示', () => {
  assert.equal(previewLabel(null, 'again', T), 'もう一回');
  assert.equal(previewLabel(null, 'good', T), 'あした');
  assert.equal(previewLabel(null, 'easy', T), '3日後');
});
