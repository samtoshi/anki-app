import { schedule, dayIndex, cardStatus } from './srs.js';
import { createAdapter } from './sync.js';
import { dailyFromReviews, lastGrades, charMisses } from './merge.js';

// ttsAuto：問題の自動読み上げ（はじめは OFF。ttsV=2 で、前に ON だった端末も一度だけ OFF にする）
export const DEFAULT_SETTINGS = { newPerDay: 10, nickname: '', handwriting: 'auto', recognition: 'on', recogV: 2, ttsAuto: false, ttsV: 2 };

const rid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

function emptyData() {
  return { v: 2, states: {}, reviews: [], legacyLog: {}, settings: { ...DEFAULT_SETTINGS }, created: Date.now(),
    device: Math.random().toString(36).slice(2, 10), pending: [], cloud: null,
    sel: {},          // 社会・理科の「はんい」{ deckId: { k: [回...], t } }
    slog: {},         // 勉強の記録（1回すわって勉強した分ごと）{ id: { s, e, ms, d, rg, k, n, ok, rs } }
    slogDirty: [],    // まだクラウドに送っていない slog の id
    inprog: null,     // とちゅうの勉強 { id, k, ids, i, done, again, combo, xp, total, back, rg, t } か { t, none: 1 }
    inprogDirty: false,
    ann: {},          // 見たおしらせ { id: 時刻 }
    annDirty: false };
}

/** v1（日ごとの集計だけ）→ v2（1回ごとの記録） */
export function migrate(d) {
  if (!d) return emptyData();
  if (d.v === 1) {
    const e = emptyData();
    const settings = { ...e.settings, ...(d.settings || {}), ttsAuto: false, ttsV: 2 };
    return { ...e, states: d.states || {}, legacyLog: d.log || {}, settings, created: d.created || e.created };
  }
  if (d.v === 2) {
    const e = emptyData();
    const settings = { ...e.settings, ...(d.settings || {}) };
    // 以前は読み取りが「OFF」が初期値だった → 一度だけ ON にする（あとで OFF にすればそのまま）
    if ((d.settings || {}).recogV !== 2) { settings.recognition = 'on'; settings.recogV = 2; }
    // 自動の読み上げは「いらない」ことになった → 前に ON だった端末も一度だけ OFF にする（あとで ON にすればそのまま）
    if ((d.settings || {}).ttsV !== 2) { settings.ttsAuto = false; settings.ttsV = 2; }
    return { ...e, ...d, settings, sel: d.sel || {}, slog: d.slog || {}, slogDirty: d.slogDirty || [], inprog: d.inprog || null, inprogDirty: !!d.inprogDirty, ann: d.ann || {}, annDirty: !!d.annDirty };
  }
  return emptyData();
}

export class Store {
  constructor(adapter = createAdapter()) {
    this.adapter = adapter;
    this.data = emptyData();
    this.listeners = new Set();
    this._cache = null;
  }
  async init() {
    this.data = migrate(await this.adapter.load());
    if (globalThis.navigator?.storage?.persist) navigator.storage.persist().catch(() => {});
    return this;
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { this._cache = null; this.save(); for (const f of this.listeners) try { f(); } catch (e) { console.warn(e); } }
  save() { return this.adapter.save(this.data); }
  get settings() { return this.data.settings; }
  state(id) { return this.data.states[id] || null; }
  /** おしらせを見た（記録して、クラウドに送る印をつける） */
  markAnnSeen(id, now = Date.now()) {
    if (!id || this.data.ann[id]) return false;
    this.data.ann = { ...this.data.ann, [id]: now }; this.data.annDirty = true; this.save(); return true;
  }

  /** 集計（キャッシュつき） */
  get derived() {
    if (!this._cache) {
      this._cache = {
        daily: dailyFromReviews(this.data.reviews, this.data.legacyLog),
        lastGrades: lastGrades(this.data.reviews),
        charMiss: charMisses(this.data.reviews),
      };
    }
    return this._cache;
  }
  /** 進み具合の計算に使うもの（保護者のリアルタイム表示もこの形で受けとる） */
  statsSource() {
    const d = this.derived;
    return { states: this.data.states, daily: d.daily, lastGrades: d.lastGrades, charMiss: d.charMiss, settings: this.settings };
  }
  newLeft(deckId, today = dayIndex()) {
    const l = this.derived.daily[today];
    const used = (l && l.n && l.n[deckId]) || 0;
    return Math.max(0, this.settings.newPerDay - used);
  }
  /**
   * 採点を記録
   * mode 's' = ふだんの復習（予定が変わる）／'r' = テスト前見直し・ぜんぶ練習（予定は変わらない、記録だけ）
   * miss = 書きまちがえた文字
   */
  grade(card, deckId, grade, { mode = 's', miss = [], auto = false, now = Date.now(), today = dayIndex(new Date(now)) } = {}) {
    const prev = this.state(card.id);
    const wasNew = cardStatus(prev) === 'new';
    let next = prev;
    if (mode === 's') {
      next = { ...schedule(prev, grade, today), ts: now, lg: grade };
      this.data.states[card.id] = next;
    }
    const e = { id: this.data.device + '-' + rid(), c: card.id, d: deckId, k: card.kai ?? null, g: grade, t: now, m: mode };
    if (wasNew && mode === 's') e.n = 1;
    if (miss && miss.length) e.x = miss.slice(0, 20);
    if (auto) e.a = 1;
    this.data.reviews.push(e);
    this.data.pending.push(e.id);
    this.changed();
    return next;
  }
  setSetting(k, v) { this.settings[k] = v; this.changed(); }

  // ---------- はんい（社会・理科） ----------
  setRange(deckId, kais, now = Date.now()) { this.data.sel[deckId] = { k: [...kais], t: now }; this.data.selDirty = true; this.changed(); }

  // ---------- 勉強の記録（時刻つき） ----------
  /** 1枚答えるたびに、いまの「すわって勉強した分」を更新する */
  logCard(sit, { g, cardMs, now = Date.now() }) {
    // 毎回あたらしいオブジェクトにする（同期の途中で変わっても、送りのこしがわかるように）
    const e = { ...(this.data.slog[sit.id] || { s: sit.s, e: sit.s, ms: 0, d: sit.d, rg: sit.rg, k: sit.k, n: 0, ok: 0, ...(sit.rs ? { rs: 1 } : {}) }) };
    this.data.slog[sit.id] = e;
    e.n += 1;
    if (g === 'good' || g === 'easy') e.ok += 1;
    e.e = now;
    e.ms += Math.max(0, Math.min(cardMs || 0, 180000)); // 1枚 3分まで（席をはなれていた時間は入れない）
    if (!this.data.slogDirty.includes(sit.id)) this.data.slogDirty.push(sit.id);
  }

  // ---------- とちゅうの勉強 ----------
  setInprog(obj, now = Date.now()) { this.data.inprog = obj ? { ...obj, t: now } : { t: now, none: 1 }; this.data.inprogDirty = true; this.save(); }
  get resumable() { const p = this.data.inprog; return p && !p.none && Array.isArray(p.ids) && p.i < p.ids.length ? p : null; }
  exportJSON() { return JSON.stringify(this.data); }
  importJSON(text) {
    const d = JSON.parse(text);
    if (!d || !(d.v === 1 || d.v === 2) || typeof d.states !== 'object') throw new Error('形式がちがいます');
    const cloud = this.data.cloud;
    this.data = migrate(d);
    this.data.cloud = cloud;
    this.data.pending = this.data.reviews.map((r) => r.id);
    this.changed();
  }
  reset() { const cloud = this.data.cloud; this.data = emptyData(); this.data.cloud = cloud; this.changed(); }
}

/** 記録のまぜかた（ほかの端末の分とあわせる） */
export function mergeSlog(local = {}, remote = {}) {
  const out = { ...local }; let added = 0;
  for (const [id, r] of Object.entries(remote || {})) {
    const l = out[id];
    if (!l || (r.n || 0) > (l.n || 0) || ((r.n || 0) === (l.n || 0) && (r.e || 0) > (l.e || 0))) { out[id] = r; added++; }
  }
  return { slog: out, added };
}
/** はんい：新しく決めたほう */
export function mergeSel(local = {}, remote = {}) {
  const out = { ...local }; let changed = false;
  for (const [k, r] of Object.entries(remote || {})) if (r && (!out[k] || (r.t || 0) > (out[k].t || 0))) { out[k] = r; changed = true; }
  return { sel: out, changed };
}
/** とちゅうの勉強：新しいほう（すてた＝none も新しければそちら） */
export function pickInprog(local, remote) {
  if (!remote) return { inprog: local, changed: false };
  if (!local || (remote.t || 0) > (local.t || 0)) return { inprog: remote, changed: true };
  return { inprog: local, changed: false };
}
