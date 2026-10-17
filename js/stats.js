import { cardStatus, isDue, retrievability, upcoming, streak, dayIndex } from './srs.js';
import { isWeak } from './review.js';

/**
 * 進み具合のまとめ（子どもの画面・保護者の共有リンク・保護者のリアルタイム表示で共通）
 * decks: [{id,name,emoji,cards(いまの回), units:[{kai,name,cards,latest}]}]
 * src: {states, daily, lastGrades, charMiss, settings}
 * 今のデッキにないカードIDの記録は数えない。
 */
export function computeStats(decks, src, today = dayIndex()) {
  const states = src.states || {};
  const grades = src.lastGrades || {};
  const deckStats = decks.map((d) => {
    const c = { id: d.id, name: d.name, emoji: d.emoji, total: d.cards.length, new: 0, learning: 0, mastered: 0, due: 0 };
    for (const card of d.cards) {
      const s = states[card.id];
      c[cardStatus(s)] += 1;
      if (isDue(s, today)) c.due += 1;
    }
    return c;
  });
  const units = [];
  for (const d of decks) for (const u of d.units || []) {
    if (u.kai == null) continue;
    const c = { deck: d.id, deckName: d.name, emoji: d.emoji, kai: u.kai, name: u.name, latest: !!u.latest, total: u.cards.length, new: 0, learning: 0, mastered: 0, weak: 0 };
    for (const card of u.cards) {
      c[cardStatus(states[card.id])] += 1;
      if (isWeak(states[card.id], grades[card.id])) c.weak += 1;
    }
    units.push(c);
  }
  const allIds = decks.flatMap((d) => (d.units ? d.units.flatMap((u) => u.cards) : d.cards).map((c) => c.id));
  const curIds = decks.flatMap((d) => d.cards.map((c) => c.id));
  let rSum = 0, rN = 0;
  for (const id of allIds) {
    const r = retrievability(states[id], today);
    if (r != null) { rSum += r; rN += 1; }
  }
  const daily = src.daily || {};
  const hist = [];
  for (let k = 13; k >= 0; k--) { const l = daily[today - k]; hist.push([l ? l.r : 0, l ? l.c : 0]); }
  let r30 = 0, c30 = 0, total = 0;
  const days = [];
  for (const [k, l] of Object.entries(daily)) {
    const day = +k;
    total += l.r;
    if (l.r > 0) days.push(day);
    if (today - day < 30 && today >= day) { r30 += l.r; c30 += l.c; }
  }
  const weakChars = Object.entries(src.charMiss || {}).sort((a, b) => b[1].n - a[1].n || b[1].t - a[1].t).slice(0, 16).map(([ch, o]) => [ch, o.n]);
  return {
    v: 1, at: Date.now(), today,
    nickname: (src.settings && src.settings.nickname) || '',
    decks: deckStats, units, weakChars,
    streak: streak(days, today), studyDays: days.length, hist,
    retention: rN ? Math.round((rSum / rN) * 100) : null,
    accuracy30: r30 ? Math.round((c30 / r30) * 100) : null,
    upcoming: upcoming(states, curIds, today, 7),
    totalReviews: total,
  };
}
