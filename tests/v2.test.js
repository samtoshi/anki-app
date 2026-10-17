import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates, mergeReviews, dailyFromReviews, lastGrades, charMisses } from '../js/merge.js';
import { isWeak, selectReviewCards } from '../js/review.js';
import { normalize, answerKeys, check, redoPlan, applyRedo, autoGrade, isGradable, readingOf, diffChars } from '../js/grade.js';
import { Store, migrate } from '../js/store.js';
import { schedule, dayIndex } from '../js/srs.js';

// ---- まぜる ----
test('mergeStates：カードごとに新しい方（ts）が勝つ', () => {
  const local = { a: { ts: 10, v: 'L' }, b: { ts: 50, v: 'L' }, c: { ts: 5, v: 'L' } };
  const remote = { a: { ts: 20, v: 'R' }, b: { ts: 40, v: 'R' }, d: { ts: 1, v: 'R' }, c: { ts: 5, v: 'R' } };
  const m = mergeStates(local, remote);
  assert.equal(m.states.a.v, 'R'); assert.equal(m.states.b.v, 'L'); assert.equal(m.states.d.v, 'R'); assert.equal(m.states.c.v, 'L');
  assert.deepEqual(m.pulled.sort(), ['a', 'd']);
  assert.deepEqual(m.push.sort(), ['b']);
  assert.deepEqual(mergeStates({ x: { ts: 1 } }, {}).push, ['x']);
});

test('mergeReviews：IDで重複をのぞき、時間順', () => {
  const l = [{ id: '1', t: 3 }, { id: '2', t: 1 }];
  const r = [{ id: '2', t: 1 }, { id: '3', t: 2 }];
  const m = mergeReviews(l, r);
  assert.deepEqual(m.reviews.map((x) => x.id), ['2', '3', '1']);
  assert.equal(m.added, 1);
  assert.equal(mergeReviews(m.reviews, r).added, 0);
});

test('dailyFromReviews / lastGrades / charMisses', () => {
  const t = new Date(2026, 9, 17, 10).getTime();
  const rv = [
    { id: '1', c: 'a', d: 'shakai', g: 'again', t, m: 's', n: 1, x: ['権', 'の'] },
    { id: '2', c: 'a', d: 'shakai', g: 'good', t: t + 1000, m: 'r', x: ['権'] },
    { id: '3', c: 'b', d: 'rika', g: 'hard', t: t + 2000, m: 's', n: 1 },
  ];
  const day = dayIndex(new Date(t));
  const d = dailyFromReviews(rv, { [day - 1]: { r: 2, c: 1, n: { yoji: 2 } } });
  assert.deepEqual(d[day], { r: 3, c: 2, n: { shakai: 1, rika: 1 } });
  assert.deepEqual(d[day - 1], { r: 2, c: 1, n: { yoji: 2 } });
  assert.deepEqual(lastGrades(rv), { a: 'good', b: 'hard' });
  const cm = charMisses(rv);
  assert.equal(cm['権'].n, 2); assert.ok(!cm['の']); // ひらがなは「苦手な漢字」に入れない
});

// ---- 苦手 ----
test('isWeak / selectReviewCards', () => {
  const T = 20000;
  const fine = schedule(schedule(null, 'good', T), 'good', T + 1);
  const lapsed = schedule(schedule(fine, 'again', T + 7), 'good', T + 7);
  const hardEF = schedule(schedule(schedule(null, 'hard', T), 'hard', T + 1), 'good', T + 4);
  assert.equal(isWeak(fine, 'good'), false);
  assert.equal(isWeak(null, undefined), false);       // まだ見ていないカードは苦手ではない
  assert.equal(isWeak(lapsed, 'good'), true);           // わすれたことがある
  assert.equal(isWeak(hardEF, 'good'), true);           // EF が低い
  assert.equal(isWeak(fine, 'hard'), true);             // 最後が「むずかしい」（見直しモードも含む）
  assert.equal(isWeak(null, 'again'), true);            // 見直しで「わからない」
  const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const states = { a: fine, b: lapsed, c: hardEF };
  assert.deepEqual(selectReviewCards(cards, states, { a: 'good', d: 'again' }, 'weak').map((c) => c.id), ['b', 'c', 'd']);
  assert.equal(selectReviewCards(cards, states, {}, 'all').length, 4);
});

// ---- 答え合わせ ----
test('normalize：全角半角・空白・区切り・のばし棒', () => {
  assert.equal(normalize('ＡＢＣ　１２３'), 'abc123');
  assert.equal(normalize('約１．１パーセント'), '約1.1パーセント');
  assert.equal(normalize('岩倉具視・大久保利通'), '岩倉具視大久保利通');
  assert.equal(normalize('ﾃﾞｰﾀ'), 'データ');
  assert.equal(normalize('コ－ヒ―'), 'コーヒー');
  assert.equal(normalize('30cm³'), '30cm3');
});

test('answerKeys：読みのかっこはのぞく・別解・順番の入れかえ', () => {
  assert.deepEqual(answerKeys({ a: '征韓論（せいかんろん）' }), ['征韓論']);
  assert.ok(answerKeys({ a: '岩倉具視・大久保利通' }).includes('大久保利通岩倉具視'));
  assert.ok(answerKeys({ a: 'プロイセン（ドイツ）の憲法', alts: ['ドイツの憲法'] }).includes('ドイツの憲法'));
  assert.ok(answerKeys({ a: '大理石（結晶質石灰岩）' }).includes('大理石'));
  assert.equal(readingOf({ a: '尚泰（しょうたい）' }), 'しょうたい');
  assert.equal(readingOf({ a: 'プロイセン（ドイツ）' }), '');
  assert.equal(isGradable({ a: '武力による反乱はなくなり、言論で主張する世の中になった' }), false);
  assert.equal(isGradable({ a: '廃刀令' }), true);
  assert.equal(isGradable({ a: '整合', self: true }), false);
  assert.equal(isGradable({ a: '意味', w: '一石二鳥' }), true);
});

test('check / diffChars：まちがえた文字の位置', () => {
  const r = check({ a: '自由民権運動' }, '自 由 民様運動');
  assert.equal(r.correct, false);
  assert.deepEqual(r.wrong, [3]);
  assert.equal(r.ops[3].t, 'sub'); assert.equal(r.ops[3].g, '様');
  assert.equal(check({ a: '征韓論（せいかんろん）' }, '征韓論').correct, true);
  assert.equal(check({ a: '廃刀令' }, '').correct, false);
  const d = diffChars('西南戦争', '西戦争');
  assert.deepEqual(d.wrong, [1]); assert.equal(d.ops[1].t, 'del');
});

test('redoPlan：漢字だけまちがえたら、その漢字だけマスにする', () => {
  const r = check({ w: '一石二鳥', a: '意味' }, '一右二烏');
  const p = redoPlan(r);
  assert.deepEqual(p.blanks, [1, 3]);
  assert.equal(p.expected, '石鳥');
  assert.equal(p.kanjiOnly, true);
  // 1回目：「石」だけ直った
  const p1 = applyRedo(p, '石島');
  assert.deepEqual(p1.blanks, [3]); assert.equal(p1.expected, '鳥'); assert.equal(p1.done, false); assert.equal(p1.tries, 1);
  // 2回目：ぜんぶ直った
  const p2 = applyRedo(p1, '鳥');
  assert.equal(p2.done, true); assert.equal(p2.tries, 2);
  // ひらがなのまちがいは kanjiOnly ではない
  const q = redoPlan(check({ a: '明治六年の政変' }, '明治六年が政変'));
  assert.deepEqual(q.blanks, [4]); assert.equal(q.kanjiOnly, false);
  // 半分より多くまちがえたら部分やり直しはしない
  assert.equal(redoPlan(check({ a: '五日市憲法' }, '三月一日')), null);
  // 正解ならやり直しなし
  assert.equal(redoPlan(check({ a: '天皇' }, '天皇')), null);
});

test('autoGrade：1回で正解＝わかった（速ければかんたん）／直せた＝むずかしい／だめ＝わからない', () => {
  assert.equal(autoGrade({ correctFirst: true, ms: 20000, length: 3 }), 'good');
  assert.equal(autoGrade({ correctFirst: true, ms: 3000, length: 3 }), 'easy');
  assert.equal(autoGrade({ correctFirst: false, fixedByRedo: true }), 'hard');
  assert.equal(autoGrade({ correctFirst: false, fixedByRedo: false }), 'again');
});

// ---- 記録 ----
class Mem { constructor() { this.v = null; this.name = 'mem'; } async load() { return this.v; } async save(d) { this.v = JSON.parse(JSON.stringify(d)); } }

test('Store：ふだんは予定が変わる・見直しは記録だけ・新しいカードの数・まちがえた字', async () => {
  const st = await new Store(new Mem()).init();
  const card = { id: 's24-01', kai: 24 };
  const now = new Date(2026, 9, 17, 12).getTime();
  st.grade(card, 'shakai', 'good', { now });
  const s1 = st.state('s24-01');
  assert.equal(s1.interval, 1); assert.equal(s1.lg, 'good'); assert.equal(s1.ts, now);
  st.grade(card, 'shakai', 'again', { mode: 'r', miss: ['征'], now: now + 1000 });
  assert.deepEqual(st.state('s24-01'), s1);                    // 見直しでは予定は変わらない
  assert.equal(st.data.reviews.length, 2);
  assert.equal(st.data.reviews[1].m, 'r');
  assert.deepEqual(st.data.reviews[1].x, ['征']);
  assert.equal(st.data.reviews[0].k, 24);
  assert.equal(st.data.pending.length, 2);
  assert.equal(st.newLeft('shakai', dayIndex(new Date(now))), 9);
  assert.equal(st.derived.lastGrades['s24-01'], 'again');
  assert.equal(st.derived.charMiss['征'].n, 1);
});

test('migrate：v1 の記録は legacyLog として残る', () => {
  const d = migrate({ v: 1, states: { a: { seen: 1 } }, log: { 100: { r: 2, c: 1, n: {} } }, settings: { newPerDay: 15 } });
  assert.equal(d.v, 2); assert.equal(d.settings.newPerDay, 15); assert.equal(d.settings.handwriting, 'auto');
  assert.deepEqual(d.legacyLog, { 100: { r: 2, c: 1, n: {} } }); assert.deepEqual(d.reviews, []);
});

test('四字熟語（意味→漢字4字）：答え合わせと、まちがえた漢字だけのやり直し', async () => {
  const { check, redoPlan, applyRedo, isGradable, answerKeys } = await import('../js/grade.js');
  const card = { q: 'ひとつのことをして、ふたつの得をすること', a: '一石二鳥', w: '一石二鳥', reading: 'いっせきにちょう', input: 'write' };
  assert.equal(isGradable(card), true);
  assert.deepEqual(answerKeys(card), ['一石二鳥']);
  assert.equal(check(card, '一石二鳥').correct, true);
  const r = check(card, '一石二島');
  assert.equal(r.correct, false);
  const plan = redoPlan(r);
  assert.ok(plan && plan.kanjiOnly);
  assert.deepEqual(plan.blanks, [3]);
  assert.equal(plan.expected, '鳥');
  assert.equal(applyRedo(plan, '島').done, false);
  assert.equal(applyRedo(plan, '鳥').done, true);
  // 「々」の書き方のちがいも正解
  assert.equal(check({ a: '正々堂々', w: '正々堂々', alts: ['正正堂堂'] }, '正正堂堂').correct, true);
});
