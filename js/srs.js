// あんきカード — 忘却曲線にもとづく復習スケジュール（SM-2 をベースに少し調整）
// すべて「日」単位で計算します（day = ローカル日付の通し番号）。

export const GRADES = {
  again: { q: 0, label: 'わからない', emoji: '😢' },
  hard:  { q: 3, label: 'むずかしい', emoji: '🤔' },
  good:  { q: 4, label: 'わかった',   emoji: '😊' },
  easy:  { q: 5, label: 'かんたん',   emoji: '🤩' },
};

export const MASTERED_DAYS = 21;   // 間隔が21日以上になったら「覚えた」
export const MIN_EF = 1.3;
export const START_EF = 2.5;
export const TARGET_RETENTION = 0.9; // 復習日に覚えている確率の目安

const DAY_MS = 86400000;

/** ローカル時刻での日付通し番号 */
export function dayIndex(date = new Date()) {
  const d = new Date(date);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / DAY_MS);
}

/** 日付通し番号 → 'YYYY-MM-DD' */
export function dayToISO(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function newCardState() {
  return { ef: START_EF, reps: 0, interval: 0, due: null, lapses: 0, last: null, seen: 0 };
}

/**
 * 1回の自己採点で、カードの次の状態を計算する（元の state は変更しない）
 * @param {object|null} state 現在の状態（新しいカードは null）
 * @param {'again'|'hard'|'good'|'easy'} grade
 * @param {number} today dayIndex
 */
export function schedule(state, grade, today) {
  const g = GRADES[grade];
  if (!g) throw new Error('unknown grade: ' + grade);
  const s = { ...(state || newCardState()) };
  const q = g.q;
  const prevInterval = s.interval || 0;

  // EF（覚えやすさ）の更新（SM-2 の式）
  s.ef = Math.max(MIN_EF, +(s.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))).toFixed(3));

  if (q < 3) {
    // わからない → 最初からやり直し。今日のうちにもう一度出す
    if (s.reps > 0) s.lapses += 1;
    s.reps = 0;
    s.interval = 0;
  } else {
    let next;
    if (s.reps === 0) {
      next = grade === 'easy' ? 3 : 1;
    } else if (s.reps === 1) {
      next = grade === 'hard' ? 3 : grade === 'easy' ? 8 : 6;
    } else {
      const base = Math.max(1, prevInterval);
      if (grade === 'hard') next = Math.max(base + 1, Math.round(base * 1.2));
      else if (grade === 'easy') next = Math.round(base * s.ef * 1.3);
      else next = Math.round(base * s.ef);
      next = Math.max(next, base + 1);
    }
    s.reps += 1;
    s.interval = Math.min(next, 365);
  }
  s.due = today + s.interval;
  s.last = today;
  s.seen = (s.seen || 0) + 1;
  return s;
}

/** ボタンの下に出す「次はいつ？」の表示 */
export function previewLabel(state, grade, today) {
  const n = schedule(state, grade, today).interval;
  if (n === 0) return 'もう一回';
  if (n === 1) return 'あした';
  if (n < 30) return n + '日後';
  if (n < 365) return Math.round(n / 30) + 'か月後';
  return '1年後';
}

/** 'new' | 'learning' | 'mastered' */
export function cardStatus(state) {
  if (!state || !state.seen) return 'new';
  return state.interval >= MASTERED_DAYS ? 'mastered' : 'learning';
}

export function isDue(state, today) {
  return !!state && state.seen > 0 && state.due != null && state.due <= today;
}

/**
 * 忘却曲線 R = exp(-t/S)。復習日（t = interval）にちょうど R = 0.9 になるように S を決める
 * → R(t) = 0.9^(t / interval)
 */
export function retrievability(state, today) {
  if (!state || !state.seen || state.last == null) return null;
  const t = Math.max(0, today - state.last);
  const I = Math.max(1, state.interval);
  return Math.pow(TARGET_RETENTION, t / I);
}

/**
 * 今日の復習キュー
 * @param {Array<{id:string}>} cards 対象カード
 * @param {Record<string,object>} states カードIDごとの状態
 * @param {number} today
 * @param {number} newLeft 今日あと何枚 新しいカードを出してよいか
 */
export function buildQueue(cards, states, today, newLeft) {
  const due = [];
  const fresh = [];
  for (const c of cards) {
    const s = states[c.id];
    if (isDue(s, today)) due.push(c);
    else if (cardStatus(s) === 'new') fresh.push(c);
  }
  // 期限切れが古いものから
  due.sort((a, b) => states[a.id].due - states[b.id].due);
  const news = fresh.slice(0, Math.max(0, newLeft));
  // 復習と新しいカードを交互に混ぜる（あきないように）
  const out = [];
  let i = 0, j = 0;
  while (i < due.length || j < news.length) {
    if (i < due.length) out.push(due[i++]);
    if (i < due.length) out.push(due[i++]);
    if (j < news.length) out.push(news[j++]);
  }
  return out;
}

/** これから n 日間に復習がくる枚数 */
export function upcoming(states, ids, today, days = 7) {
  const arr = new Array(days).fill(0);
  for (const id of ids) {
    const s = states[id];
    if (!s || !s.seen || s.due == null) continue;
    const k = Math.max(0, s.due - today);
    if (k < days) arr[k] += 1;
  }
  return arr;
}

/** 連続学習日数（今日 or きのうまで続いていればカウント） */
export function streak(historyDays, today) {
  const set = new Set(historyDays);
  let d = set.has(today) ? today : today - 1;
  let n = 0;
  while (set.has(d)) { n++; d--; }
  return n;
}
