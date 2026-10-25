// 目標日モード：「○曜までに、えらんだ回をぜんぶ覚える」ための、1日の問題数を記録から決める
// - 設定（いつまで・どの教科のどの回）は content/manifest の goal に書く（カードの中身と同じ所。学習の記録には書かない）
// - 期限の日がすぎたら、なにもしない（ふだんの学習にもどる）
// - ここは計算だけ（記録を変えない）
import { dayIndex, cardStatus, isDue, MASTERED_DAYS } from './srs.js';

export const GAP_MS = 60 * 60e3;       // 「時間をあけて」＝1時間以上あけて、もう一度正解したら「覚えた」
export const SIT_MAX = 30;             // 1回にすわって出す数（多すぎるとつかれるので）
export const HEAVY_MIN = 60;           // 1日これより多い（分）ときは「多いよ」の表示
const OK = (g) => g === 'good' || g === 'easy';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const DEF = { acc: 0.8, sec: 25 };

/** 'YYYY-MM-DD'（その日のローカル時刻）→ dayIndex */
export function isoToDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return dayIndex(new Date(+m[1], +m[2] - 1, +m[3], 12));
}
/** その日のはじまり（ローカル 0:00）の時刻 */
export function dayStartMs(day) {
  const d = new Date(day * 86400000);
  // dayIndex の逆：ローカルの 0:00
  const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  return local.getTime();
}

/**
 * manifest.goal を読む。期限の日（その日の夜まで）をすぎた・まだ始まっていない・形がへん → null
 * goal: { until:'YYYY-MM-DD', from?:'YYYY-MM-DD', label?:'火曜', title?:'テスト', decks:{ deckId: [回...] | null(ぜんぶ) } }
 */
export function activeGoal(raw, today = dayIndex()) {
  if (!raw || typeof raw !== 'object' || !raw.decks || typeof raw.decks !== 'object') return null;
  const untilDay = isoToDay(raw.until);
  if (untilDay == null || today > untilDay) return null;
  const fromDay = raw.from ? isoToDay(raw.from) : null;
  if (fromDay != null && today < fromDay) return null;
  const [y, m, d] = raw.until.split('-').map(Number);
  const label = raw.label || (WEEK[new Date(y, m - 1, d).getDay()] + '曜');
  return { id: typeof raw.id === 'string' ? raw.id : '', until: raw.until, untilDay, label, title: raw.title || '', decks: raw.decks, daysLeft: untilDay - today + 1 };
}

/**
 * manifest から、いま有効な目標をぜんぶ（期限の早いじゅん）。goals:[...] があればそれ、なければ goal（前の形）
 * 目標ごとに期限がちがってよい（例：社会・漢字は火曜、理科は木曜）。id がないときは 'g0','g1'…
 */
export function activeGoals(manifest, today = dayIndex()) {
  if (!manifest || typeof manifest !== 'object') return [];
  const raws = Array.isArray(manifest.goals) && manifest.goals.length ? manifest.goals : manifest.goal ? [manifest.goal] : [];
  const out = [], seen = new Set();
  raws.forEach((r, i) => {
    const g = activeGoal(r, today);
    if (!g) return;
    if (!g.id || seen.has(g.id)) g.id = 'g' + i;
    seen.add(g.id);
    out.push(g);
  });
  return out.sort((a, b) => a.untilDay - b.untilDay);
}

/** 目標のカード [{card, deck, unit}]（decks はアプリのデッキ一覧） */
export function goalItems(decks, goal) {
  const out = [];
  if (!goal) return out;
  for (const d of decks) {
    if (!(d.id in goal.decks)) continue;
    const ks = goal.decks[d.id];
    for (const u of d.units || []) {
      if (Array.isArray(ks) && !ks.includes(u.kai)) continue;
      for (const c of u.cards || []) out.push({ card: c, deck: d, unit: u });
    }
  }
  return out;
}

/** カードごとの採点（時間順） */
export function reviewsByCard(reviews = []) {
  const m = new Map();
  for (const r of reviews) { if (!r || !r.c) continue; if (!m.has(r.c)) m.set(r.c, []); m.get(r.c).push(r); }
  for (const a of m.values()) a.sort((x, y) => x.t - y.t);
  return m;
}

/** いちばん後ろから、つづけて正解している分 */
function okTail(revs) {
  let i = revs.length;
  while (i > 0 && OK(revs[i - 1].g)) i--;
  return revs.slice(i);
}
/** 時間をあけて2回つづけて正解（1時間以上あいている） */
function spacedOk(tail) { return tail.length >= 2 && tail[tail.length - 1].t - tail[0].t >= GAP_MS; }

/**
 * 目標に向けたカードの様子
 * 'new'（まだやっていない）| 'learning'（まだ覚えていない）| 'ready'（覚えた）
 * 覚えた＝ 長く覚えている（SM-2 で21日以上）／ 時間をあけて2回つづけて正解（最後がまちがいならダメ）
 * before を入れると、その時刻より前の記録だけで考える（今日のはじめの様子）
 */
export function goalStatus(state, revs = [], before = Infinity) {
  const rs = before === Infinity ? revs : revs.filter((r) => r.t < before);
  const st = before === Infinity || !state || state.last == null || state.last < dayIndex(new Date(before)) ? state : null; // 今日かわった状態は使わない
  const last = rs[rs.length - 1];
  const tail = okTail(rs);
  const info = { tail: tail.length, lastT: last ? last.t : null, lastG: last ? last.g : (st && st.lg) || null, firstOkT: tail.length ? tail[0].t : null };
  if (!rs.length && cardStatus(st) === 'new') return { s: 'new', ...info };
  if (last && !OK(last.g)) return { s: 'learning', ...info };
  if (st && st.seen && st.interval >= MASTERED_DAYS) return { s: 'ready', ...info };
  if (spacedOk(tail)) return { s: 'ready', ...info };
  // 前の形の記録（採点の記録がない）：SM-2 で2回つづけて正解していれば覚えた
  if (!rs.length && st && st.reps >= 2) return { s: 'ready', ...info };
  if (!rs.length && st && st.reps >= 1) return { s: 'learning', ...info, tail: 1, lastT: null, firstOkT: null };
  return { s: 'learning', ...info };
}

/**
 * これまでの記録から：正解率・新しいカードを覚えるまでの回数・1まいの時間・1日にやったまい数
 */
export function pastStats({ reviews = [], slog = {}, daily = {} } = {}, today = dayIndex()) {
  const since = dayStartMs(today - 29);
  let n = 0, ok = 0;
  for (const r of reviews) if (r.t >= since) { n++; if (OK(r.g)) ok++; }
  // 覚えるまでの回数：はじめて出てから「時間をあけて2回つづけて正解」になるまでの回数
  const tries = [];
  for (const revs of reviewsByCard(reviews).values()) {
    for (let i = 0; i < revs.length; i++) {
      if (spacedOk(okTail(revs.slice(0, i + 1)))) { tries.push(i + 1); break; }
    }
  }
  let ms = 0, cn = 0;
  for (const e of Object.values(slog || {})) if (e && e.n > 0 && e.ms > 0) { ms += e.ms; cn += e.n; }
  const days = [];
  for (let k = 1; k <= 14; k++) { const l = daily[today - k]; if (l && l.r > 0) days.push(l.r); }
  const acc = n >= 20 ? ok / n : null;
  const p = Math.min(0.97, Math.max(0.4, acc ?? DEF.acc));
  const attempts = tries.length >= 5 ? tries.reduce((a, b) => a + b, 0) / tries.length : null;
  return {
    acc, accN: n,
    attempts, attemptsN: tries.length,
    sec: cn >= 10 ? ms / cn / 1000 : null, secN: cn,
    perDay: days.length ? days.reduce((a, b) => a + b, 0) / days.length : null, perDayN: days.length,
    // 計算に使う値（記録が少ないときは、ふつうの値）
    use: { p, attempts: Math.min(6, Math.max(2, attempts ?? 2 / p)), sec: cn >= 10 ? ms / cn / 1000 : DEF.sec },
  };
}

/** あと何回答えれば「覚えた」になりそうか（1まい） */
export function workOf(gs, use) {
  if (gs.s === 'ready') return 0;
  if (gs.s === 'new') return use.attempts;
  if (gs.tail >= 1) return 1 / use.p;        // 1回正解ずみ → 時間をあけてもう1回
  return Math.min(use.attempts, 2 / use.p);  // まちがえた → 2回つづけて正解が必要
}

/**
 * 目標の計画：教科ごと・回ごとの まだ／覚えた、今日の問題数、のこりの問題数
 * src: { states, reviews, slog, daily }
 */
export function goalPlan(decks, goal, src, now = Date.now()) {
  if (!goal) return null;
  const today = dayIndex(new Date(now));
  const t0 = dayStartMs(today);
  const states = src.states || {};
  const byCard = reviewsByCard(src.reviews || []);
  const ps = pastStats(src, today);
  const use = ps.use;
  const daysLeft = Math.max(1, goal.untilDay - today + 1);
  const items = goalItems(decks, goal);
  const deckMap = new Map();
  for (const it of items) {
    const id = it.deck.id;
    if (!deckMap.has(id)) deckMap.set(id, { id, name: it.deck.name, emoji: it.deck.emoji, total: 0, new: 0, learning: 0, ready: 0, work: 0, work0: 0, done: 0, units: new Map() });
    const D = deckMap.get(id);
    const revs = byCard.get(it.card.id) || [];
    const gs = goalStatus(states[it.card.id], revs);
    const gs0 = goalStatus(states[it.card.id], revs, t0);
    const key = it.unit.kai;
    if (!D.units.has(key)) D.units.set(key, { kai: key, name: it.unit.name, total: 0, new: 0, learning: 0, ready: 0 });
    const U = D.units.get(key);
    D.total++; U.total++; D[gs.s]++; U[gs.s]++;
    D.work += workOf(gs, use); D.work0 += workOf(gs0, use);
    D.done += revs.filter((r) => r.t >= t0 && r.t <= now).length;
  }
  const out = [...deckMap.values()].map((D) => {
    const target = Math.ceil(D.work0 / daysLeft - 1e-9);
    const left = Math.min(Math.max(0, target - D.done), Math.ceil(D.work - 1e-9));
    const later = Math.max(0, D.work0 - target);
    const perLater = daysLeft > 1 ? Math.ceil(later / (daysLeft - 1) - 1e-9) : 0;
    return { ...D, units: [...D.units.values()].sort((a, b) => (a.kai ?? 0) - (b.kai ?? 0)), work: Math.round(D.work), work0: Math.round(D.work0), target, left, perLater };
  });
  const sum = (k) => out.reduce((a, d) => a + d[k], 0);
  const todayTarget = sum('target'), todayLeft = sum('left'), perLater = sum('perLater');
  const days = [];
  for (let k = 0; k < daysLeft; k++) {
    const day = today + k;
    const q = k === 0 ? todayTarget : perLater;
    days.push({ day, w: WEEK[new Date(dayStartMs(day) + 12 * 3600e3).getDay()], q, min: Math.round((q * use.sec) / 60) });
  }
  const maxMin = Math.max(0, ...days.map((d) => d.min));
  return {
    goal, today, daysLeft, decks: out, stats: ps,
    total: sum('total'), new: sum('new'), learning: sum('learning'), ready: sum('ready'),
    remaining: sum('work'), todayTarget, todayDone: sum('done'), todayLeft, days,
    heavy: maxMin > HEAVY_MIN, maxMin,
  };
}

/**
 * 目標の勉強で出すカード（覚えたカードは出さない）
 * じゅんばん：まちがえたカード → 1回正解して1時間たったカード → まだやっていないカード（回を順番に）
 * 1時間たっていない正解ずみのカードは、ほかがないときだけ
 * 教科は、今日のこりの数にあわせてまぜる
 */
export function goalQueue(decks, goal, src, { now = Date.now(), limit = SIT_MAX, plan = goalPlan(decks, goal, src, now) } = {}) {
  if (!plan) return [];
  const states = src.states || {};
  const byCard = reviewsByCard(src.reviews || []);
  const per = new Map();
  for (const it of goalItems(decks, goal)) {
    const revs = byCard.get(it.card.id) || [];
    const gs = goalStatus(states[it.card.id], revs);
    if (gs.s === 'ready') continue;
    let pri;
    if (gs.s === 'new') pri = 2;
    else if (gs.tail === 0) pri = 0;
    else pri = now - (gs.lastT || 0) >= GAP_MS ? 1 : 3;
    if (!per.has(it.deck.id)) per.set(it.deck.id, []);
    per.get(it.deck.id).push({ ...it, pri, lastT: gs.lastT || 0 });
  }
  const lists = [];
  for (const [id, arr] of per) {
    const old = arr.filter((x) => x.pri !== 2 && x.pri !== 3).sort((a, b) => a.pri - b.pri || a.lastT - b.lastT);
    // まだやっていないカード：回ごとに1まいずつ（どの回もまんべんなく）
    const byU = new Map();
    for (const x of arr.filter((x) => x.pri === 2)) { const k = x.unit.kai; if (!byU.has(k)) byU.set(k, []); byU.get(k).push(x); }
    const us = [...byU.keys()].sort((a, b) => (a ?? 0) - (b ?? 0)).map((k) => byU.get(k));
    const fresh = [];
    for (let i = 0; us.some((u) => i < u.length); i++) for (const u of us) if (i < u.length) fresh.push(u[i]);
    const cool = arr.filter((x) => x.pri === 3).sort((a, b) => a.lastT - b.lastT);
    const d = plan.decks.find((x) => x.id === id);
    lists.push({ id, q: [...old, ...fresh], cool, want: d ? d.left : 0 });
  }
  const anyLeft = lists.some((l) => l.want > 0);
  // 今日の分がおわっていても「もっとやる」ときは、のこりの多い教科から
  for (const l of lists) if (!anyLeft) l.want = l.q.length;
  const total = Math.min(limit, lists.reduce((a, l) => a + Math.min(l.want, l.q.length), 0));
  const out = [];
  const share = lists.map((l) => ({ l, n: 0, cap: Math.min(l.want, l.q.length) }));
  while (out.length < total) {
    // 予定に対して進みがいちばん少ない教科から1まい
    const c = share.filter((x) => x.n < x.cap).sort((a, b) => a.n / a.cap - b.n / b.cap)[0];
    if (!c) break;
    out.push(c.l.q[c.n++]);
  }
  if (!out.length) for (const l of lists) for (const x of l.cool) if (out.length < limit) out.push(x);
  return out.map(({ card, deck }) => ({ card, deck }));
}

/** 目標の勉強での記録のしかた：新しい・復習の日のカードはふだんどおり（予定が変わる）、それ以外は記録だけ */
export function goalMode(state, today = dayIndex()) {
  return cardStatus(state) === 'new' || isDue(state, today) ? 's' : 'r';
}
