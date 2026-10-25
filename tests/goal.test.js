import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeGoal, isoToDay, dayStartMs, goalStatus, pastStats, goalPlan, goalQueue, goalMode, workOf, GAP_MS } from '../js/goal.js';
import { dayIndex, schedule } from '../js/srs.js';

const H = 3600e3;
const NOW = new Date(2026, 9, 25, 15, 0).getTime(); // 日曜 15:00（ローカル）
const TODAY = dayIndex(new Date(NOW));
const RAW = { until: '2026-10-27', decks: { s: [1, 2], k: null } };
const mk = (p, n) => Array.from({ length: n }, (_, i) => ({ id: `${p}-${i + 1}`, q: 'q', a: 'a' }));
const DECKS = [
  { id: 's', name: '社会', emoji: '🗾', units: [{ kai: 1, name: '1回', cards: mk('s1', 4) }, { kai: 2, name: '2回', cards: mk('s2', 4) }, { kai: 3, name: '3回', cards: mk('s3', 5) }] },
  { id: 'k', name: '漢字', emoji: '✏️', units: [{ kai: 1, name: '1回', cards: mk('k1', 6) }] },
  { id: 'r', name: '理科', emoji: '🔬', units: [{ kai: 1, name: '1回', cards: mk('r1', 9) }] },
];
const rv = (c, g, t) => ({ id: `${c}@${t}`, c, g, t, d: 's', m: 's' });

test('activeGoal: 期限の日の夜まで有効、次の日からは null', () => {
  assert.equal(isoToDay('2026-10-27'), TODAY + 2);
  const g = activeGoal(RAW, TODAY);
  assert.equal(g.label, '火曜');
  assert.equal(g.daysLeft, 3);
  assert.equal(activeGoal(RAW, TODAY + 2).daysLeft, 1);
  assert.equal(activeGoal(RAW, TODAY + 3), null);
  assert.equal(activeGoal({ ...RAW, from: '2026-10-26' }, TODAY), null);
  assert.equal(activeGoal(null, TODAY), null);
  assert.equal(activeGoal({ until: 'x', decks: {} }, TODAY), null);
  assert.equal(activeGoal({ until: '2026-10-27' }, TODAY), null);
});

test('dayStartMs はローカルの 0:00', () => {
  const t = dayStartMs(TODAY);
  assert.equal(new Date(t).getHours(), 0);
  assert.equal(dayIndex(new Date(t)), TODAY);
  assert.equal(dayIndex(new Date(t - 1)), TODAY - 1);
});

test('goalStatus: 時間をあけて2回つづけて正解で「覚えた」、最後がまちがいならダメ', () => {
  assert.equal(goalStatus(null, []).s, 'new');
  assert.equal(goalStatus(null, [rv('a', 'good', NOW - 3 * H)]).s, 'learning');
  assert.equal(goalStatus(null, [rv('a', 'good', NOW - 3 * H), rv('a', 'good', NOW - 2.5 * H)]).s, 'learning'); // 30分しかあいていない
  assert.equal(goalStatus(null, [rv('a', 'good', NOW - 3 * H), rv('a', 'easy', NOW - 1 * H)]).s, 'ready');
  assert.equal(goalStatus(null, [rv('a', 'good', NOW - 3 * H), rv('a', 'good', NOW - 1 * H), rv('a', 'again', NOW)]).s, 'learning');
  assert.equal(goalStatus(null, [rv('a', 'again', NOW - 5 * H), rv('a', 'good', NOW - 3 * H), rv('a', 'good', NOW - 1 * H)]).s, 'ready');
  // 長く覚えているカード
  assert.equal(goalStatus({ seen: 1, reps: 5, interval: 30, due: TODAY + 20, last: TODAY - 10 }, []).s, 'ready');
  // 前の記録（採点の記録なし）：2回正解ずみなら覚えた
  let st = schedule(schedule(null, 'good', TODAY - 8), 'good', TODAY - 2);
  assert.equal(goalStatus(st, []).s, 'ready');
  assert.equal(goalStatus(schedule(null, 'good', TODAY - 1), []).s, 'learning');
  // before：今日のはじめの様子
  const revs = [rv('a', 'good', dayStartMs(TODAY) - 5 * H), rv('a', 'good', NOW - 2 * H)];
  assert.equal(goalStatus(null, revs).s, 'ready');
  assert.equal(goalStatus(null, revs, dayStartMs(TODAY)).s, 'learning');
});

test('pastStats: 記録が少ないときはふつうの値、多いときは記録から', () => {
  const s0 = pastStats({}, TODAY);
  assert.equal(s0.acc, null);
  assert.equal(s0.use.p, 0.8);
  assert.equal(s0.use.attempts, 2.5);
  assert.equal(s0.use.sec, 25);
  const reviews = [];
  for (let i = 0; i < 10; i++) { // 10まい：again → good → (2時間後) good で覚えた＝3回
    const c = 'x' + i, t = NOW - 30 * H;
    reviews.push(rv(c, 'again', t), rv(c, 'good', t + 60e3), rv(c, 'good', t + 3 * H));
  }
  const slog = { a: { ms: 600e3, n: 30 } };
  const daily = { [TODAY - 1]: { r: 40 }, [TODAY - 2]: { r: 20 }, [TODAY - 20]: { r: 999 } };
  const s = pastStats({ reviews, slog, daily }, TODAY);
  assert.equal(s.accN, 30);
  assert.ok(Math.abs(s.acc - 20 / 30) < 1e-9);
  assert.equal(s.attempts, 3);
  assert.equal(s.attemptsN, 10);
  assert.equal(s.sec, 20);
  assert.equal(s.perDay, 30);
  assert.equal(s.use.attempts, 3);
});

test('workOf', () => {
  const use = { p: 0.8, attempts: 3 };
  assert.equal(workOf({ s: 'ready' }, use), 0);
  assert.equal(workOf({ s: 'new' }, use), 3);
  assert.equal(workOf({ s: 'learning', tail: 1 }, use), 1.25);
  assert.equal(workOf({ s: 'learning', tail: 0 }, use), 2.5);
});

test('goalPlan: えらんだ回だけ、のこり日数でわる、今日やった分を引く', () => {
  const g = activeGoal(RAW, TODAY);
  const reviews = [rv('s1-1', 'good', NOW - 40 * H), rv('s1-1', 'good', NOW - 30 * H)]; // 覚えた（きのうまで）
  const p0 = goalPlan(DECKS, g, { reviews }, NOW);
  const s = p0.decks.find((d) => d.id === 's');
  assert.equal(p0.decks.length, 2); // 理科は入らない
  assert.equal(s.total, 8); // 3回は入らない
  assert.deepEqual([s.new, s.learning, s.ready], [7, 0, 1]);
  assert.deepEqual(s.units.map((u) => [u.kai, u.total, u.ready]), [[1, 4, 1], [2, 4, 0]]);
  const k = p0.decks.find((d) => d.id === 'k');
  assert.equal(k.total, 6);
  // 記録が少ない → attempts 2.5：社会 7×2.5=17.5 → 3日で 6/日、漢字 15 → 5/日
  assert.equal(s.target, 6);
  assert.equal(k.target, 5);
  assert.equal(p0.todayTarget, 11);
  assert.equal(p0.todayLeft, 11);
  assert.equal(p0.days.length, 3);
  assert.deepEqual(p0.days.map((d) => d.w), ['日', '月', '火']);
  assert.equal(p0.total, 14);
  assert.equal(p0.ready, 1);
  // 今日3問やった
  const more = [...reviews, rv('s1-2', 'good', NOW - 2 * H), rv('s1-3', 'again', NOW - H), rv('k1-1', 'good', NOW - H)];
  const p1 = goalPlan(DECKS, g, { reviews: more }, NOW);
  assert.equal(p1.decks.find((d) => d.id === 's').left, 4);
  assert.equal(p1.decks.find((d) => d.id === 'k').left, 4);
  assert.equal(p1.todayDone, 3);
  assert.equal(p1.todayTarget, 11); // 今日のはじめで決まる
  // 期限の日：のこり全部
  const pz = goalPlan(DECKS, activeGoal(RAW, TODAY + 2), { reviews }, NOW + 48 * H);
  assert.equal(pz.daysLeft, 1);
  assert.equal(pz.todayTarget, 18 + 15);
});

test('goalQueue: 覚えたカードは出さない・まちがい→時間がたった正解→新しい（回をまぜる）・教科をまぜる', () => {
  const g = activeGoal(RAW, TODAY);
  const reviews = [
    rv('s1-1', 'good', NOW - 40 * H), rv('s1-1', 'good', NOW - 30 * H), // 覚えた
    rv('s1-2', 'good', NOW - 3 * H),  // 1回正解、3時間前
    rv('s1-3', 'again', NOW - 5 * H), // まちがい
    rv('s1-4', 'good', NOW - 10 * 60e3), // 10分前に正解（まだ出さない）
  ];
  const q = goalQueue(DECKS, g, { reviews }, { now: NOW, limit: 30 });
  const ids = q.map((x) => x.card.id);
  assert.ok(!ids.includes('s1-1'));
  assert.ok(!ids.includes('s1-4'));
  const sIds = ids.filter((x) => x.startsWith('s'));
  assert.deepEqual(sIds.slice(0, 4), ['s1-3', 's1-2', 's2-1', 's2-2'].slice(0, 2).concat(sIds.slice(2, 4)));
  assert.equal(sIds[0], 's1-3');
  assert.equal(sIds[1], 's1-2');
  // 新しいカードは回をまぜる（1回はもう新しいのがないので2回だけ）
  assert.ok(sIds.slice(2).every((x) => x.startsWith('s2')));
  assert.ok(ids.some((x) => x.startsWith('k')));
  assert.ok(!ids.some((x) => x.startsWith('r') || x.startsWith('s3')));
  // 今日の分の数まで
  const plan = goalPlan(DECKS, g, { reviews }, NOW);
  assert.equal(q.length, Math.min(30, plan.todayLeft));
  // 教科がまざっている（はじめの4まいに両方）
  const first4 = ids.slice(0, 4);
  assert.ok(first4.some((x) => x.startsWith('s')) && first4.some((x) => x.startsWith('k')));
  // limit
  assert.equal(goalQueue(DECKS, g, { reviews }, { now: NOW, limit: 3 }).length, 3);
});

test('goalQueue: 今日の分がおわっても、のこりがあれば出す／ぜんぶ覚えたら空', () => {
  const g = activeGoal({ until: '2026-10-27', decks: { k: null } }, TODAY);
  const reviews = [];
  for (let i = 1; i <= 6; i++) reviews.push(rv('k1-' + i, 'good', dayStartMs(TODAY) - 30 * H), rv('k1-' + i, 'good', dayStartMs(TODAY) - 20 * H));
  assert.equal(goalQueue(DECKS, g, { reviews }, { now: NOW }).length, 0);
  const plan = goalPlan(DECKS, g, { reviews }, NOW);
  assert.equal(plan.remaining, 0);
  assert.equal(plan.ready, 6);
  // 新しいカード6まい・今日の分（5）をやった後でも「もっと」で出る
  const r2 = [];
  for (let i = 1; i <= 5; i++) r2.push(rv('k1-' + i, 'again', NOW - H));
  const p2 = goalPlan(DECKS, g, { reviews: r2 }, NOW);
  assert.equal(p2.todayLeft, 0);
  assert.ok(goalQueue(DECKS, g, { reviews: r2 }, { now: NOW }).length > 0);
});

test('goalMode: 新しい・復習の日のカードはふつうの記録、それ以外は記録だけ', () => {
  assert.equal(goalMode(null, TODAY), 's');
  assert.equal(goalMode(schedule(null, 'good', TODAY - 3), TODAY), 's');
  assert.equal(goalMode(schedule(null, 'good', TODAY), TODAY), 'r');
  void GAP_MS;
});
