// 端末どうしの記録をまぜる（オフラインで別々に勉強しても大丈夫なように）
import { dayIndex } from './srs.js';
import { isKanji } from './grade.js';

/** カードごとに「最後に採点した方」を残す */
export function mergeStates(local = {}, remote = {}) {
  const states = { ...local };
  const pulled = [], push = [];
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const id of ids) {
    const a = local[id], b = remote[id];
    if (a && !b) { push.push(id); continue; }
    if (!a && b) { states[id] = b; pulled.push(id); continue; }
    const ta = a.ts || 0, tb = b.ts || 0;
    if (tb > ta) { states[id] = b; pulled.push(id); }
    else if (ta > tb) push.push(id);
  }
  return { states, pulled, push };
}

/** 採点の記録は ID で重複をのぞいて合わせる */
export function mergeReviews(local = [], remote = []) {
  const map = new Map();
  for (const r of local) map.set(r.id, r);
  let added = 0;
  for (const r of remote) if (r && r.id && !map.has(r.id)) { map.set(r.id, r); added++; }
  const reviews = [...map.values()].sort((x, y) => x.t - y.t);
  return { reviews, added };
}

/** 日ごとの集計 {day: {r, c, n:{deck:count}}}（古い形式の記録 legacy もたす） */
export function dailyFromReviews(reviews = [], legacy = {}) {
  const out = {};
  for (const [k, l] of Object.entries(legacy || {})) out[k] = { r: l.r || 0, c: l.c || 0, n: { ...(l.n || {}) } };
  for (const e of reviews) {
    const k = String(dayIndex(new Date(e.t)));
    const l = out[k] || (out[k] = { r: 0, c: 0, n: {} });
    l.r++;
    if (e.g !== 'again') l.c++;
    if (e.n && e.m === 's') l.n[e.d] = (l.n[e.d] || 0) + 1;
  }
  return out;
}

/** カードごとの最後の自己採点（勉強・見直しの両方） */
export function lastGrades(reviews = []) {
  const out = {};
  for (const e of reviews) out[e.c] = e.g; // reviews は時間順
  return out;
}

/** まちがえた漢字の集計 {字: {n, t}} */
export function charMisses(reviews = []) {
  const out = {};
  for (const e of reviews) for (const ch of e.x || []) {
    if (!isKanji(ch)) continue;
    const o = out[ch] || (out[ch] = { n: 0, t: 0 });
    o.n++; o.t = Math.max(o.t, e.t);
  }
  return out;
}
