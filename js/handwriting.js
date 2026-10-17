// 手書きパッド（指・Apple Pencil・タッチペン）
// Pointer Events を使い、書いている間はスクロールや拡大をしない。
// ペンを使っているあいだは、手のひら（タッチ）を無視する。

export class HandPad {
  /**
   * @param {HTMLElement} host
   * @param {{dir?:'h'|'v', masu?:boolean, cells?:number|null, onChange?:Function, compact?:boolean}} opt
   */
  constructor(host, opt = {}) {
    this.host = host;
    this.dir = opt.dir || 'h';
    this.masu = opt.masu ?? false;
    this.cells = opt.cells || null;      // マス目の数を決めるとき（やり直し・四字熟語）
    this.fixed = !!opt.cells;
    this.onChange = opt.onChange || (() => {});
    this.strokes = [];
    this.history = [];
    this.mode = 'pen';
    this.active = null;
    this.lastPen = 0;
    this.build();
  }

  build() {
    this.host.innerHTML = `
      <div class="hp-tools">
        <button class="hp-b on" data-a="pen" title="ペン">✏️<span>ペン</span></button>
        <button class="hp-b" data-a="eraser" title="消しゴム">🧽<span>消しゴム</span></button>
        <button class="hp-b" data-a="undo" title="もどす">↩️<span>もどす</span></button>
        <button class="hp-b" data-a="clear" title="全部消す">🗑️<span>全部消す</span></button>
        <span class="hp-sp"></span>
        ${this.fixed ? '' : `<button class="hp-b" data-a="dir">${this.dir === 'v' ? '縦書き' : '横書き'}</button>
        <button class="hp-b ${this.masu ? 'on' : ''}" data-a="masu">マス目</button>`}
      </div>
      <div class="hp-canvas-wrap"><canvas class="hp-bg"></canvas><canvas class="hp-ink"></canvas><div class="hp-ph">ここに書いてね ✍️</div></div>`;
    this.wrap = this.host.querySelector('.hp-canvas-wrap');
    this.bg = this.host.querySelector('.hp-bg');
    this.ink = this.host.querySelector('.hp-ink');
    this.ph = this.host.querySelector('.hp-ph');
    this.ctx = this.ink.getContext('2d');
    this.host.querySelectorAll('.hp-b').forEach((b) => (b.onclick = (e) => { e.preventDefault(); this.action(b.dataset.a, b); }));
    const c = this.ink;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e));
    c.addEventListener('lostpointercapture', (e) => this.up(e));
    // iOS Safari のピンチ拡大・長押しメニューを止める
    for (const ev of ['touchstart', 'touchmove', 'gesturestart', 'contextmenu']) c.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.wrap);
    this.resize();
  }

  destroy() { this.ro && this.ro.disconnect(); }

  action(a, btn) {
    if (a === 'pen' || a === 'eraser') {
      this.mode = a;
      this.host.querySelectorAll('[data-a=pen],[data-a=eraser]').forEach((b) => b.classList.toggle('on', b.dataset.a === a));
    } else if (a === 'undo') this.undo();
    else if (a === 'clear') this.clear();
    else if (a === 'dir') { this.dir = this.dir === 'v' ? 'h' : 'v'; btn.textContent = this.dir === 'v' ? '縦書き' : '横書き'; this.drawGrid(); this.onChange('dir'); }
    else if (a === 'masu') { this.masu = !this.masu; btn.classList.toggle('on', this.masu); this.drawGrid(); this.onChange('masu'); }
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    for (const cv of [this.bg, this.ink]) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    this.drawGrid();
    this.redraw();
  }

  /** マス目のサイズと位置 */
  grid() {
    const { w, h } = this;
    if (this.cells) {
      const n = this.cells;
      const size = this.dir === 'v' ? Math.min(w * 0.8, (h - 16) / n) : Math.min(h * 0.8, (w - 16) / n);
      const total = size * n;
      const x0 = this.dir === 'v' ? (w - size) / 2 : (w - total) / 2;
      const y0 = this.dir === 'v' ? (h - total) / 2 : (h - size) / 2;
      return { size, x0, y0, cols: this.dir === 'v' ? 1 : n, rows: this.dir === 'v' ? n : 1 };
    }
    const size = Math.max(72, Math.min(200, Math.min(w, h) / 2.2)); // 大きく書けるように
    const cols = Math.floor(w / size), rows = Math.floor(h / size);
    return { size, x0: (w - cols * size) / 2, y0: (h - rows * size) / 2, cols, rows };
  }

  drawGrid() {
    const g = this.bg.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (!(this.masu || this.cells)) {
      // 横書き・縦書きのうすい線だけ
      g.strokeStyle = '#f6d7e3'; g.lineWidth = 1; g.setLineDash([6, 6]);
      const step = Math.max(80, Math.min(200, Math.min(this.w, this.h) / 2.2));
      g.beginPath();
      if (this.dir === 'v') for (let x = this.w - step; x > 0; x -= step) { g.moveTo(x, 8); g.lineTo(x, this.h - 8); }
      else for (let y = step; y < this.h; y += step) { g.moveTo(8, y); g.lineTo(this.w - 8, y); }
      g.stroke(); g.setLineDash([]);
      return;
    }
    const { size, x0, y0, cols, rows } = this.grid();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = x0 + c * size, y = y0 + r * size;
      g.fillStyle = '#fffafc'; g.fillRect(x, y, size, size);
      g.strokeStyle = '#ffb3cb'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, size - 2, size - 2);
      g.strokeStyle = '#fbe0ea'; g.lineWidth = 1; g.setLineDash([4, 5]);
      g.beginPath(); g.moveTo(x + size / 2, y + 4); g.lineTo(x + size / 2, y + size - 4); g.moveTo(x + 4, y + size / 2); g.lineTo(x + size - 4, y + size / 2); g.stroke();
      g.setLineDash([]);
    }
  }

  pos(e) {
    const r = this.ink.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: Math.round(e.timeStamp), p: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5 };
  }

  isPalm(e) {
    if (e.pointerType === 'pen') { this.lastPen = Date.now(); return false; }
    if (e.pointerType === 'touch') {
      if (Date.now() - this.lastPen < 2500) return true;            // ペンを使っている最中のタッチは手のひら
      if ((e.width || 0) > 60 || (e.height || 0) > 60) return true; // 大きな接触は手のひら
    }
    return false;
  }

  down(e) {
    if (this.active !== null || this.isPalm(e)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this.ink.setPointerCapture && this.ink.setPointerCapture(e.pointerId);
    this.active = e.pointerId;
    const p = this.pos(e);
    if (this.mode === 'eraser') { this.eraseAt(p); return; }
    this.cur = { points: [p], pen: e.pointerType === 'pen' };
    this.ph.style.display = 'none';
    this.dot(p);
  }

  move(e) {
    if (e.pointerId !== this.active) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const p = this.pos(ev);
      if (this.mode === 'eraser') { this.eraseAt(p); continue; }
      const pts = this.cur.points;
      const last = pts[pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1.2) continue;
      pts.push(p);
      this.segment(pts, pts.length - 1);
    }
  }

  up(e) {
    if (e.pointerId !== this.active) return;
    this.active = null;
    if (this.mode === 'eraser') { if (this.erased && this.erased.length) { this.history.push({ t: 'erase', items: this.erased }); this.onChange('erase'); } this.erased = null; return; }
    if (this.cur) {
      this.strokes.push(this.cur);
      this.history.push({ t: 'add' });
      this.cur = null;
      this.onChange('stroke');
    }
  }

  width(p) { const base = Math.max(3.5, Math.min(this.w, this.h) / 70); return base * (0.55 + p.p * 0.9); }

  dot(p) {
    const c = this.ctx; c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#3d2a44'; c.beginPath(); c.arc(p.x, p.y, this.width(p) / 2, 0, Math.PI * 2); c.fill();
  }

  /** なめらかな線：点と点の真ん中を結ぶ2次ベジェ曲線 */
  segment(pts, i) {
    const c = this.ctx; c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.strokeStyle = '#3d2a44'; c.lineCap = 'round'; c.lineJoin = 'round';
    const p0 = pts[Math.max(0, i - 2)], p1 = pts[i - 1], p2 = pts[i];
    const m1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }, m2 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    c.lineWidth = this.width(p2);
    c.beginPath(); c.moveTo(i < 2 ? p1.x : m1.x, i < 2 ? p1.y : m1.y); c.quadraticCurveTo(p1.x, p1.y, m2.x, m2.y); c.stroke();
  }

  redraw() {
    const c = this.ctx; c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    for (const s of this.strokes) {
      if (s.points.length === 1) { this.dot(s.points[0]); continue; }
      for (let i = 1; i < s.points.length; i++) this.segment(s.points, i);
      const l = s.points[s.points.length - 1], m = s.points[s.points.length - 2];
      c.beginPath(); c.moveTo((l.x + m.x) / 2, (l.y + m.y) / 2); c.lineTo(l.x, l.y); c.stroke();
    }
    this.ph.style.display = this.strokes.length ? 'none' : '';
  }

  eraseAt(p) {
    const r = 16;
    const hit = [];
    this.strokes = this.strokes.filter((s, idx) => {
      const near = s.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < r);
      if (near) hit.push({ s, idx });
      return !near;
    });
    if (hit.length) { (this.erased = this.erased || []).push(...hit); this.redraw(); }
  }

  undo() {
    const h = this.history.pop();
    if (!h) return;
    if (h.t === 'add') this.strokes.pop();
    else if (h.t === 'erase' || h.t === 'clear') {
      for (const it of [...h.items].sort((a, b) => a.idx - b.idx)) this.strokes.splice(Math.min(it.idx, this.strokes.length), 0, it.s);
    }
    this.redraw(); this.onChange('undo');
  }

  clear() {
    if (!this.strokes.length) return;
    this.history.push({ t: 'clear', items: this.strokes.map((s, idx) => ({ s, idx })) });
    this.strokes = []; this.redraw(); this.onChange('clear');
  }

  isEmpty() { return this.strokes.length === 0; }

  /** 書いたところだけを切りとった画像（白い背景・黒い線） */
  toImage({ max = 900, pad = 24 } = {}) {
    if (this.isEmpty()) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of this.strokes) for (const p of s.points) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); }
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
    const bw = x2 - x1, bh = y2 - y1;
    const scale = Math.min(2, max / Math.max(bw, bh));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bw * scale)); cv.height = Math.max(1, Math.round(bh * scale));
    const c = cv.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
    c.setTransform(scale, 0, 0, scale, -x1 * scale, -y1 * scale);
    c.strokeStyle = '#000'; c.fillStyle = '#000'; c.lineCap = 'round'; c.lineJoin = 'round';
    const lw = Math.max(3.5, Math.min(this.w, this.h) / 70);
    for (const s of this.strokes) {
      c.lineWidth = lw;
      c.beginPath(); c.moveTo(s.points[0].x, s.points[0].y);
      for (const p of s.points.slice(1)) c.lineTo(p.x, p.y);
      if (s.points.length === 1) { c.arc(s.points[0].x, s.points[0].y, lw / 2, 0, Math.PI * 2); c.fill(); } else c.stroke();
    }
    const url = cv.toDataURL('image/png');
    return { dataUrl: url, base64: url.split(',')[1], width: cv.width, height: cv.height };
  }

  /** 答えの横に出す小さい画像（この端末の画面に出すだけで保存はしない） */
  thumbnail() { const i = this.toImage({ max: 360, pad: 12 }); return i ? i.dataUrl : null; }
}

/** タブレットらしい端末か（手書きの初期設定に使う） */
export function isTablet() {
  const tp = navigator.maxTouchPoints || 0;
  const s = Math.min(screen.width, screen.height);
  return tp > 1 && s >= 600;
}
