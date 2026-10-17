import { schedule, dayIndex, cardStatus } from './srs.js';
import { createAdapter } from './sync.js';
import { dailyFromReviews, lastGrades, charMisses } from './merge.js';

export const DEFAULT_SETTINGS = { newPerDay: 10, nickname: '', handwriting: 'auto', recognition: 'on', recogV: 2 };

const rid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

function emptyData() {
  return { v: 2, states: {}, reviews: [], legacyLog: {}, settings: { ...DEFAULT_SETTINGS }, created: Date.now(),
    device: Math.random().toString(36).slice(2, 10), pending: [], cloud: null };
}

/** v1（日ごとの集計だけ）→ v2（1回ごとの記録） */
export function migrate(d) {
  if (!d) return emptyData();
  if (d.v === 1) {
    const e = emptyData();
    return { ...e, states: d.states || {}, legacyLog: d.log || {}, settings: { ...e.settings, ...(d.settings || {}) }, created: d.created || e.created };
  }
  if (d.v === 2) {
    const e = emptyData();
    const settings = { ...e.settings, ...(d.settings || {}) };
    // 以前は読み取りが「OFF」が初期値だった → 一度だけ ON にする（あとで OFF にすればそのまま）
    if ((d.settings || {}).recogV !== 2) { settings.recognition = 'on'; settings.recogV = 2; }
    return { ...e, ...d, settings };
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
