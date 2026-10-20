// おしらせ（うさぎからのメッセージ）
// 中身は content/manifest の announcements: [{ id, text, from?, until? }]（anki-cards-content の announcements.json）
// 見たかどうかは learners/main/data/state の ann: { id: 見た時刻 }（まなの記録として全部の端末で共有）

const day = (s) => (s ? Date.parse(String(s) + 'T00:00:00+09:00') : NaN);

/** まだ見ていない・期間内のおしらせ（ならび順のまま） */
export function pendingAnnouncements(list, seen = {}, now = Date.now()) {
  return (Array.isArray(list) ? list : []).filter((a) => {
    if (!a || !a.id || !a.text || (seen || {})[a.id]) return false;
    const f = day(a.from), u = day(a.until);
    if (!Number.isNaN(f) && now < f) return false;
    if (!Number.isNaN(u) && now >= u + 864e5) return false; // until の日の終わりまで
    return true;
  });
}

/** 見た記録をあわせる（どちらかで見たら見たことにする。時刻は早いほう） */
export function mergeSeen(local = {}, remote = {}) {
  const out = { ...(local || {}) }; let changed = false;
  for (const [id, t] of Object.entries(remote || {})) {
    if (!t) continue;
    if (!out[id]) { out[id] = t; changed = true; }
    else if (t < out[id]) out[id] = t;
  }
  return { ann: out, changed };
}
