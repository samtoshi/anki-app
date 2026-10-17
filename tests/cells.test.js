import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeChars, cellLayout, cellRect, cellAt, cellStates, MAX_CELLS } from '../js/cells.js';
import { check } from '../js/grade.js';

test('マスの字数＝答え合わせの字（かっこ・「・」・空白をのぞく）', () => {
  assert.equal(writeChars({ a: '河村瑞賢（かわむらずいけん）' }).join(''), '河村瑞賢');
  assert.equal(writeChars({ a: '下田（静岡県）・函館（北海道）' }).join(''), '下田函館');
  assert.equal(writeChars({ a: '鳥羽・伏見の戦い（とば・ふしみのたたかい）' }).length, 7);
  assert.equal(writeChars({ a: '油かす', alts: ['油粕'] }).length, 3);
  assert.equal(writeChars({ a: 'x', w: '一石二鳥' }).join(''), '一石二鳥');
});

test('並び：全部のマスが重ならず、cellAt と cellRect が逆になる', () => {
  for (const [w, h] of [[780, 840], [1140, 517], [366, 452], [366, 300]]) for (const dir of ['h', 'v']) for (let n = 1; n <= MAX_CELLS; n++) {
    const L = cellLayout(n, w, h, dir);
    assert.equal(L.per * L.lines >= n, true);
    assert.equal(Math.ceil(n / L.per), L.lines);
    assert.ok(L.cols * L.size <= w + 0.01 && L.rows * L.size <= h + 0.01);
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const r = cellRect(i, L); const k = `${Math.round(r.x)},${Math.round(r.y)}`;
      assert.ok(!seen.has(k)); seen.add(k);
      assert.equal(cellAt(r.x + r.size / 2, r.y + r.size / 2, L), i);
    }
  }
});

test('縦書きは右の列から、上から下へ', () => {
  const L = cellLayout(6, 400, 300, 'v');
  const a = cellRect(0, L), b = cellRect(1, L), c = cellRect(L.per, L);
  assert.ok(b.y > a.y && Math.abs(b.x - a.x) < 0.01);
  assert.ok(c.x < a.x);
});

test('答え合わせの結果をマスごとの状態に（ずれない）', () => {
  const card = { a: '四国艦隊下関砲撃事件（しこくかんたいしものせきほうげきじけん）' };
  const chars = writeChars(card);
  const r = check(card, '四国艦体下関砲撃件');
  const { cells } = cellStates(r, chars);
  assert.equal(cells.length, chars.length);
  assert.deepEqual(cells.map((c) => c.st), ['ok', 'ok', 'ok', 'bad', 'ok', 'ok', 'ok', 'ok', 'miss', 'ok']);
  assert.equal(cells[3].g, '体');
});
