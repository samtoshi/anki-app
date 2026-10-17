// テスト前見直し：苦手なカードを選ぶ
export const WEAK_EF = 2.3;

/** 苦手：わすれたことがある／覚えにくい（EFが低い）／最後の採点が「わからない」「むずかしい」 */
export function isWeak(state, lastGrade) {
  if (lastGrade === 'again' || lastGrade === 'hard') return true;
  if (!state || !state.seen) return false;
  if ((state.lapses || 0) > 0) return true;
  if ((state.ef ?? 2.5) < WEAK_EF) return true;
  if (!lastGrade && (state.lg === 'again' || state.lg === 'hard')) return true;
  return false;
}

/** mode: 'all' | 'weak' */
export function selectReviewCards(cards, states = {}, grades = {}, mode = 'all') {
  if (mode !== 'weak') return cards.slice();
  return cards.filter((c) => isWeak(states[c.id], grades[c.id]));
}
