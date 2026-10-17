// ごほうび（XP・レベル・れんぞく日数・今日の目標・スタンプ・バッジ）
// すべて「採点の記録（reviews）」から計算するので、どの端末でも同じになる。
// 保護者の画面用に、まとめ（summary）を記録のドキュメントに入れて送る。
import { dayIndex } from './srs.js';

export const XP = { again: 2, hard: 6, good: 10, easy: 12 };
export const COMBO_BONUS = 2; // 5コンボ以上のとき 1まいごとにプラス

/** レベル：1→2 は 100XP、そのあと 1レベルごとに 40XP ずつふえる */
export function levelOf(xp) {
  let lv = 1, need = 100, acc = 0;
  while (xp >= acc + need) { acc += need; lv++; need = 100 + 40 * (lv - 1); }
  return { lv, cur: xp - acc, need };
}

export const BADGES = [
  { id: 'first', e: '🌱', name: 'はじめの一歩', desc: 'はじめてカードをふりかえった' },
  { id: 'goal1', e: '🎯', name: '目標たっせい', desc: '1日の目標をはじめてクリア' },
  { id: 'combo10', e: '⚡', name: '10コンボ', desc: '10まい続けて「わかった」' },
  { id: 'combo25', e: '🌈', name: '25コンボ', desc: '25まい続けて「わかった」' },
  { id: 'perfect', e: '💯', name: 'パーフェクト', desc: '1日10まい以上、ぜんぶわかった' },
  { id: 'streak3', e: '🔥', name: '3日れんぞく', desc: '3日続けて勉強した（1日10まい以上）' },
  { id: 'streak7', e: '🏅', name: '7日れんぞく', desc: '1週間続けて勉強した' },
  { id: 'streak30', e: '👑', name: '30日れんぞく', desc: '30日続けて勉強した' },
  { id: 'r100', e: '📗', name: '100まい', desc: 'ふりかえり 100回' },
  { id: 'r500', e: '📚', name: '500まい', desc: 'ふりかえり 500回' },
  { id: 'r1000', e: '🏆', name: '1000まい', desc: 'ふりかえり 1000回' },
  { id: 'sticker1', e: '🎁', name: 'はじめてのシール', desc: '7日れんぞくでシールをもらった' },
  { id: 'goal10', e: '🌸', name: 'スタンプ10こ', desc: '目標たっせいの日が10日' },
  { id: 'lv5', e: '⭐', name: 'レベル5', desc: 'レベル5になった' },
  { id: 'lv10', e: '🌟', name: 'レベル10', desc: 'レベル10になった' },
];
export const STICKERS = ['🐰', '🌸', '🍓', '⭐', '🦄', '🍰', '🌷', '🐥', '🍩', '🎀', '🐱', '🌈', '🍒', '🧸'];
export const stickerFor = (day) => STICKERS[((day * 7) % STICKERS.length + STICKERS.length) % STICKERS.length];

/** 「勉強した日」：その日（日本時間の0時区切り）に10まい以上ふりかえった日 */
export const STUDY_MIN = 10;
export const STICKER_DAYS = 7; // 7日れんぞくで シール1まい

/**
 * daily: {day: {r}}（記録から作った日ごとの数。保護者の画面でも同じものがある）
 * → れんぞく日数・いちばん長いれんぞく・シール（もらった数・つぎまで）
 */
export function streakInfo(daily = {}, today = dayIndex()) {
  const studied = new Set(Object.entries(daily).filter(([, l]) => (l && l.r) >= STUDY_MIN).map(([k]) => +k).filter((d) => !isNaN(d)));
  const days = [...studied].sort((a, b) => a - b);
  let run = 0, best = 0, prev = null, earned = 0;
  const flush = () => { earned += Math.floor(run / STICKER_DAYS); };
  for (const d of days) {
    if (prev != null && d === prev + 1) run++; else { flush(); run = 1; }
    prev = d; best = Math.max(best, run);
  }
  flush();
  let streak = 0;
  for (let d = studied.has(today) ? today : today - 1; studied.has(d); d--) streak++;
  return { studied, streak, best, earned, progress: streak % STICKER_DAYS, todayDone: studied.has(today) };
}

/** シールの残り（もらった数 − 使った・申しこみ中の数） */
export function stickerBalance(earned, spends = []) {
  const used = spends.filter((x) => x.st === 'req' || x.st === 'ok').reduce((a, x) => a + (x.cost || 0), 0);
  return { earned, used, balance: Math.max(0, earned - used) };
}

/** 月のカレンダー（日曜はじまり）。cells: [{day, date, n, studied, today}|null] */
export function monthCells(year, month, daily = {}, today = dayIndex()) {
  const first = new Date(year, month, 1), n = new Date(year, month + 1, 0).getDate();
  const cells = Array(first.getDay()).fill(null);
  for (let i = 1; i <= n; i++) {
    const day = dayIndex(new Date(year, month, i, 12));
    const r = daily[day]?.r || 0;
    cells.push({ day, date: i, n: r, studied: r >= STUDY_MIN, part: r > 0 && r < STUDY_MIN, today: day === today, future: day > today });
  }
  while (cells.length % 7) cells.push(null);
  return cells;
}

/**
 * reviews: [{c,d,k,g,t,m}]（時間順でなくてもよい）
 * masteredUnits: ['shakai-25', ...]（回のカードをぜんぶ覚えた）
 */
export function computeGame(reviews = [], { today = dayIndex(), goal = 20, masteredUnits = [], unitNames = {} } = {}) {
  const rs = [...reviews].sort((a, b) => a.t - b.t);
  const byDay = new Map();
  const badges = {};
  const earn = (id, day) => { if (!(id in badges)) badges[id] = day; };
  let xp = 0, combo = 0, maxCombo = 0, total = 0, lastDay = null;
  for (const r of rs) {
    const day = dayIndex(new Date(r.t));
    if (day !== lastDay) { combo = 0; lastDay = day; }
    const o = byDay.get(day) || { n: 0, again: 0 };
    o.n++; if (r.g === 'again') o.again++;
    byDay.set(day, o);
    total++;
    if (r.g === 'again') combo = 0; else combo++;
    maxCombo = Math.max(maxCombo, combo);
    xp += (XP[r.g] || 0) + (combo >= 5 ? COMBO_BONUS : 0);
    if (total === 1) earn('first', day);
    if (combo >= 10) earn('combo10', day);
    if (combo >= 25) earn('combo25', day);
    if (total >= 100) earn('r100', day);
    if (total >= 500) earn('r500', day);
    if (total >= 1000) earn('r1000', day);
    if (o.n === goal) earn('goal1', day);
    const lv = levelOf(xp).lv;
    if (lv >= 5) earn('lv5', day);
    if (lv >= 10) earn('lv10', day);
  }
  // れんぞく日数
  const days = [...byDay.keys()].sort((a, b) => a - b);
  let run = 0, prev = null, goalDays = 0;
  for (const d of days.filter((x) => byDay.get(x).n >= STUDY_MIN)) {
    run = prev != null && d === prev + 1 ? run + 1 : 1; prev = d;
    if (run >= 3) earn('streak3', d);
    if (run >= 7) { earn('streak7', d); earn('sticker1', d); }
    if (run >= 30) earn('streak30', d);
  }
  for (const d of days) {
    const o = byDay.get(d);
    if (o.n >= 10 && o.again === 0) earn('perfect', d);
    if (o.n >= goal) { goalDays++; if (goalDays === 10) earn('goal10', d); }
  }
  const daily = Object.fromEntries([...byDay].map(([d, o]) => [d, { r: o.n }]));
  const si = streakInfo(daily, today);
  const streak = si.streak;
  for (const u of masteredUnits) earn('m-' + u, today);
  const todayN = byDay.get(today)?.n || 0;
  const stamps = [];
  for (let d = today - 27; d <= today; d++) { const n = byDay.get(d)?.n || 0; stamps.push([d, n >= goal ? 2 : n > 0 ? 1 : 0]); }
  return { v: 1, xp, level: levelOf(xp), streak, best: si.best, stickers: si.earned, stickerProgress: si.progress, today: todayN, goal, done: todayN >= goal, maxCombo, total, goalDays, badges, stamps, masteredUnits, unitNames };
}

/** バッジの表示用リスト（回マスターもふくむ） */
export function badgeList(game) {
  const list = BADGES.map((b) => ({ ...b, got: b.id in (game.badges || {}) }));
  for (const u of game.masteredUnits || []) list.push({ id: 'm-' + u, e: '🎓', name: `${(game.unitNames || {})[u] || u} マスター`, desc: 'その回のカードをぜんぶ覚えた', got: true });
  return list;
}

/** ごほうびの見た目（ホーム・進み具合・保護者の画面で共通） */
export function ringSvg(n, goal, size = 92) {
  const r = size / 2 - 8, c = 2 * Math.PI * r, p = Math.min(1, n / Math.max(1, goal));
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-label="今日の目標 ${n}/${goal}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#ffe3ec" stroke-width="10"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${p >= 1 ? '#5ccf8f' : '#ff6f9c'}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="47%" text-anchor="middle" font-size="${size / 4.2}" font-weight="900" fill="#5a4660">${n}</text>
    <text x="50%" y="68%" text-anchor="middle" font-size="${size / 8}" fill="#9a8aa0">/ ${goal}まい</text></svg>`;
}

/** おいわいの紙ふぶき（動きをへらす設定のときは出さない） */
export function confetti(power = 1) {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const cv = document.createElement('canvas');
  cv.className = 'confetti-cv';
  const W = cv.width = innerWidth, H = cv.height = innerHeight;
  document.body.appendChild(cv);
  const g = cv.getContext('2d');
  const colors = ['#ff8fb1', '#ffd54a', '#7cc8ff', '#b99bff', '#5ccf8f', '#ffb85c'];
  const N = Math.round(40 * power);
  const ps = Array.from({ length: N }, () => ({ x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.45, vx: (Math.random() - 0.5) * 9 * power, vy: -Math.random() * 10 * power - 4, r: Math.random() * 6 + 4, c: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * 6, s: Math.random() * 0.3 - 0.15 }));
  const t0 = performance.now();
  const step = (t) => {
    const k = (t - t0) / 1000;
    g.clearRect(0, 0, W, H);
    for (const p of ps) { p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.a += p.s; g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.c; g.globalAlpha = Math.max(0, 1 - k / 1.6); g.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); g.restore(); }
    if (k < 1.6) requestAnimationFrame(step); else cv.remove();
  };
  requestAnimationFrame(step);
}
