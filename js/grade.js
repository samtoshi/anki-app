// 手書きの答え合わせ：正規化・文字ごとの比較・部分的なやり直し
// （認識エンジンには依存しない純粋な関数だけ）

const KANA_ONLY = /^[\u3041-\u309Fー・\s]+$/; // かっこの中がひらがなだけ＝読み
const PAREN = /[（(]([^）)]*)[）)]/g;
const SEP = /[\s・･／\/、，,。．.「」『』〈〉【】〔〕:：;；!！?？〜~＝=→]/g;
const DASH = /[－―—–‐\-ｰ]/g;

export const isKanji = (ch) => /\p{Script=Han}/u.test(ch) || ch === '々' || ch === '〆';

/** 全角・半角、空白、区切り記号、のばし棒のゆれをそろえる */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(DASH, 'ー')
    .replace(/[．.](?=\d)/g, '#DOT#') // 1.1 などの小数点は残す
    .replace(SEP, '')
    .replace(/#DOT#/g, '.')
    .toLowerCase();
}

/** 答えのかっこの中がひらがなだけなら「読み」 */
export function readingOf(card) {
  if (card.reading) return card.reading;
  const r = [];
  String(card.a || '').replace(PAREN, (_, inner) => { if (KANA_ONLY.test(inner)) r.push(inner); return ''; });
  return r.join('・');
}

/** 手書きで書くべき答え（四字熟語は熟語そのもの） */
export function writeTarget(card) { return card.w || card.a; }

/** 受けつける答えの一覧（正規化ずみ・重複なし） */
export function answerKeys(card) {
  const keys = new Set();
  const add = (s) => { const n = normalize(s); if (n) keys.add(n); };
  const base = writeTarget(card);
  add(base.replace(PAREN, ''));             // かっこの中をのぞいた形（いちばんの答え）
  if (!card.w) {
    let hasNonReading = false;
    base.replace(PAREN, (_, inner) => {
      if (!KANA_ONLY.test(inner)) {
        hasNonReading = true;
      }
      return '';
    });
    if (hasNonReading) add(base.replace(PAREN, (m, inner) => (KANA_ONLY.test(inner) ? '' : inner)));
    // 「A・B」の2つなら順番が逆でもOK
    const main = base.replace(PAREN, '');
    if (!/[／\/]/.test(main)) {
      const parts = main.split(/[・、]/).filter(Boolean);
      if (parts.length === 2) add(parts[1] + parts[0]);
    }
  }
  for (const a of card.alts || []) add(a);
  return [...keys];
}

/** 手書きで自動採点できるカードか（文章の答えは自己採点にする） */
export function isGradable(card) {
  if (card.self) return false;
  if (card.w) return true;
  const main = normalize(String(card.a).replace(PAREN, ''));
  if (!main || main.length > 14) return false;
  if (/[、。]/.test(String(card.a).replace(PAREN, ''))) return false;
  if (/[→＝]/.test(card.a)) return false;
  return true;
}

/**
 * 文字ごとの比較（編集距離＋たどりなおし）
 * ops: {t:'ok'|'sub'|'del'|'ins', e:期待する文字, g:書いた文字, i:期待する文字の位置}
 */
export function diffChars(expected, got) {
  const E = [...expected], G = [...got];
  const n = E.length, m = G.length;
  const D = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (E[i - 1] === G[j - 1] ? 0 : 1));
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (E[i - 1] === G[j - 1] ? 0 : 1)) {
      ops.push({ t: E[i - 1] === G[j - 1] ? 'ok' : 'sub', e: E[i - 1], g: G[j - 1], i: i - 1 }); i--; j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      ops.push({ t: 'del', e: E[i - 1], i: i - 1 }); i--;
    } else {
      ops.push({ t: 'ins', g: G[j - 1], i: i }); j--;
    }
  }
  ops.reverse();
  const wrong = ops.filter((o) => o.t === 'sub' || o.t === 'del').map((o) => o.i);
  const extra = ops.filter((o) => o.t === 'ins').length;
  return { ops, wrong, extra, dist: D[n][m], expected, got };
}

/** いちばん近い答えと比べる */
export function check(card, recognized) {
  const got = normalize(recognized);
  const keys = answerKeys(card);
  let best = null;
  for (const k of keys) {
    const d = diffChars(k, got);
    if (!best || d.dist < best.dist || (d.dist === best.dist && k.length > best.expected.length)) best = d;
  }
  return { ...best, correct: !!best && best.dist === 0 && got.length > 0, keys };
}

/**
 * 部分的なやり直しの計画
 * 間違えた文字が半分以下なら、その文字だけをマス目にして書き直す。
 * それ以上まちがえた／余分な字だけのときは null（ぜんぶ書き直し or 答えを見る）
 */
export function redoPlan(result) {
  const exp = [...result.expected];
  const wrong = [...new Set(result.wrong)].sort((a, b) => a - b);
  if (!wrong.length) return null;
  if (wrong.length > Math.max(1, Math.ceil(exp.length / 2))) return null;
  return {
    chars: exp,
    blanks: wrong,                                 // 書き直す位置
    expected: wrong.map((i) => exp[i]).join(''),   // 書き直す文字（順番どおり）
    kanjiOnly: wrong.every((i) => isKanji(exp[i])),
    tries: 0,
  };
}

/** やり直しの結果を反映。あっていた文字はうめて、まだ違うところだけ残す */
export function applyRedo(plan, recognized) {
  const got = normalize(recognized);
  const d = diffChars(plan.expected, got);
  const stillWrong = new Set(d.wrong);
  const blanks = plan.blanks.filter((_, k) => stillWrong.has(k));
  return {
    ...plan,
    blanks,
    expected: blanks.map((i) => plan.chars[i]).join(''),
    tries: plan.tries + 1,
    done: blanks.length === 0,
    kanjiOnly: blanks.every((i) => isKanji(plan.chars[i])),
  };
}

/** 自動採点 → 復習の4段階 */
export function autoGrade({ correctFirst, fixedByRedo, ms = 0, length = 1 }) {
  if (correctFirst) return ms > 0 && ms < 4000 + 700 * length ? 'easy' : 'good';
  if (fixedByRedo) return 'hard';
  return 'again';
}
