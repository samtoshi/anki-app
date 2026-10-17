// 声で答えたときの、やさしい先生（Firebase AI Logic / Gemini）
// 送るもの：問題・お手本の答え・メモ・まなが言ったことば（音声認識の文字）だけ。名前やメールは送らない。
import { aiJSON, defineSchema } from './recognize.js';
import { isKanji } from './grade.js';

defineSchema('oral', (ai) => ai.Schema.object({ properties: {
  result: ai.Schema.enumString({ enum: ['good', 'partial', 'miss'] }),
  praise: ai.Schema.string(),
  missing: ai.Schema.string(),
  comment: ai.Schema.string(),
  term: ai.Schema.string(),
} }));

export const ORAL_PROMPT = (card, said) => [
  'あなたは、小学5年生の女の子に社会を教える、やさしくて明るい先生です。',
  'カードの問題に、子どもが声で答えました。答えの文字は音声認識なので、同じ読みの別の漢字・ひらがな・言い間違いのような変換ミスがあります。意味で判断してください。',
  `【問題】${card.q}`,
  `【お手本の答え】${card.a}`,
  card.note ? `【メモ】${card.note}` : '',
  `【子どもの答え（音声認識）】${said || '（何も聞き取れなかった）'}`,
  '次の JSON で答えてください。',
  '- result: お手本の大事なところが言えていれば "good"、一部だけなら "partial"、ちがう・答えていないなら "miss"',
  '- praise: よく言えたところ（20字くらい、なければ空）',
  '- missing: 足りないところ・ちがうところ（30字くらい、なければ空）',
  '- comment: 子どもへのひとこと（ていねいすぎない、やさしい話しことば。60字以内。答えをそのままくり返しすぎない）',
  '- term: お手本の答えの中にある、漢字で書けるようにしたい大事な用語（1つ。人名・用語・出来事など。お手本にそのまま出てくる字だけ。なければ空）',
].filter(Boolean).join('\n');

/** 判定。term は「お手本の答えの中にある、漢字を含む言葉」だけ残す */
function fakeJudge() {
  try { if (!['localhost', '127.0.0.1'].includes(location.hostname)) return null; return JSON.parse(localStorage.getItem('anki-cards:fake-judge') || 'null'); } catch { return null; }
}
export async function judgeOral(card, said) {
  const j = fakeJudge() || await aiJSON('oral', [ORAL_PROMPT(card, said)], { timeout: 20000 }); // テスト用（localhost だけ）
  const plain = String(card.a).replace(/（[^）]*）|\([^)]*\)/g, '');
  let term = String(j.term || '').replace(/[（(].*$/, '').trim();
  if (!term || term.length > 12 || !plain.includes(term) || ![...term].some(isKanji)) term = '';
  return { result: ['good', 'partial', 'miss'].includes(j.result) ? j.result : 'partial', praise: String(j.praise || ''), missing: String(j.missing || ''), comment: String(j.comment || '').slice(0, 120), term };
}

/** 判定 → おすすめの評価 */
export const oralGrade = (r) => (r === 'good' ? 'good' : r === 'partial' ? 'hard' : 'again');
