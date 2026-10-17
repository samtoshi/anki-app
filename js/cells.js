// マス目の数と並び方（手書き欄と答えの画面の両方で、この1か所だけを使う）
import { normalize, writeTarget } from './grade.js';

const PAREN_ALL = /[（(][^）)]*[）)]/g;
export const MAX_CELLS = 16; // これより長い答えはマス目にしない（自由に書く）

/** 手書きで書く字（答え合わせと同じ形：かっこ・「・」・空白などをのぞく） */
export function writeChars(card) { return [...normalize(String(writeTarget(card)).replace(PAREN_ALL, ''))]; }

/**
 * n 個のマスを w×h の中に、なるべく大きく・行（縦書きなら列）を少なく並べる
 * 横書き：左→右、上→下。縦書き：上→下、右→左。
 * 戻り値：{ n, dir, per（1行・1列のマス数）, lines（行・列の数）, cols, rows, size, x0, y0 }
 */
export function cellLayout(n, w, h, dir = 'h', { maxSize = 220, margin = 8, comfort = 120 } = {}) {
  n = Math.max(1, n | 0);
  const cands = [];
  for (let lines = 1; lines <= n; lines++) {
    const per = Math.ceil(n / lines);
    if (lines > 1 && Math.ceil(n / (lines - 1)) === per) continue; // 同じ並びはとばす
    const cols = dir === 'v' ? lines : per, rows = dir === 'v' ? per : lines;
    const size = Math.max(1, Math.min(maxSize, (w - 2 * margin) / cols, (h - 2 * margin) / rows));
    cands.push({ n, dir, per, lines, cols, rows, size });
  }
  const best = Math.max(...cands.map((c) => c.size));
  // 書きやすい大きさ（comfort）があれば、行（列）がいちばん少ない並びにする
  const L = cands.find((c) => c.size >= Math.min(best * 0.9, comfort));
  L.x0 = (w - L.cols * L.size) / 2; L.y0 = (h - L.rows * L.size) / 2;
  return L;
}

/** i 番目の字のマス（行・列の番号） */
export function cellPos(i, L) {
  const line = Math.floor(i / L.per), k = i % L.per;
  return L.dir === 'v' ? { col: L.cols - 1 - line, row: k } : { col: k, row: line };
}
export function cellRect(i, L) {
  if (i < 0 || i >= L.n) return null;
  const { col, row } = cellPos(i, L);
  return { x: L.x0 + col * L.size, y: L.y0 + row * L.size, size: L.size };
}
/** 点 (x, y) が何番目のマスか（マスの外なら -1） */
export function cellAt(x, y, L) {
  const col = Math.floor((x - L.x0) / L.size), row = Math.floor((y - L.y0) / L.size);
  if (col < 0 || row < 0 || col >= L.cols || row >= L.rows) return -1;
  const i = L.dir === 'v' ? (L.cols - 1 - col) * L.per + row : row * L.per + col;
  return i < L.n ? i : -1;
}

/**
 * 答え合わせの結果を、答えの字ごとの状態にする（マスにそろえて色をつけるため）
 * 戻り値：[{ e: 正しい字, st: 'ok'|'bad'|'miss', g: 書いた字 }]、extra: 余分に書いた字
 */
export function cellStates(result, chars) {
  const out = chars.map((e) => ({ e, st: result ? 'miss' : 'none', g: '' }));
  const extra = [];
  if (!result || !result.ops) return { cells: out, extra };
  if ([...result.expected].join('') !== chars.join('')) {
    // ほかの答え（alts）でくらべたときは、その答えの字でマスを作る
    return cellStates(result, [...result.expected]);
  }
  for (const o of result.ops) {
    if (o.t === 'ins') { extra.push(o.g); continue; }
    out[o.i] = { e: o.e, st: o.t === 'ok' ? 'ok' : o.t === 'sub' ? 'bad' : 'miss', g: o.g || '' };
  }
  return { cells: out, extra };
}
