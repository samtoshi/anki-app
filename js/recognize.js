// 手書き文字の読み取り
// 1) Firebase AI Logic（Gemini Developer API・無料枠）に「書いた字の画像」だけを送って書き起こしてもらう
//    - 送るのは画像と、書く向き・だいたいの字数・漢字かどうか だけ（名前・メール・正解の文字は送らない）
//    - 画像は読み取りのためだけに送り、Firestore などには保存しない
//    - App Check（reCAPTCHA Enterprise）のトークンがないと使えない
// 2) Gemini が使えない（上限・電波なし・エラー）とき、Chrome の端末内の手書き認識があればそれを使う
// 3) どちらも使えなければ例外（自分で答え合わせにもどる）
import { aiModels, appCheckSiteKey } from './firebase-config.js';
import { loadFirebase, SDK_VERSION } from './cloud.js';

let onDevice = null;
async function deviceRecognizer() {
  if (onDevice !== null) return onDevice;
  onDevice = false;
  try {
    if (navigator.queryHandwritingRecognizer && navigator.createHandwritingRecognizer) {
      const q = await navigator.queryHandwritingRecognizer({ languages: ['ja'] });
      if (q) onDevice = await navigator.createHandwritingRecognizer({ languages: ['ja'] });
    }
  } catch { onDevice = false; }
  return onDevice;
}

// ---- Gemini ----
let aiP = null;
async function aiInstance() {
  if (!aiP) aiP = (async () => {
    const fb = await loadFirebase();
    const ai = await import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-ai.js`);
    return { ai, inst: ai.getAI(fb.app, { backend: new ai.GoogleAIBackend() }) };
  })().catch((e) => { aiP = null; throw e; });
  return aiP;
}
const models = new Map();
// 読み取りは「考える量 64 トークンまで」・画像は長い辺 384px（本番で計測 2026-10-18：
//   640px・128 より、まちがった字を正しい字に直してしまうことがなく（35/35）、速さは同じくらい。
//   画像の解像度を下げる設定（mediaResolution LOW/MEDIUM）は速く安いが、まちがった字を直してしまうので使わない。
//   1マスずつ切って送るやり方は、遅く・トークンが多く・直してしまうこともあったので使わない）
async function modelFor(name, kind = 'read') {
  const key = name + ':' + kind;
  if (!models.has(key)) {
    const { ai, inst } = await aiInstance();
    const schema = kind === 'read' ? ai.Schema.object({ properties: { text: ai.Schema.string() } }) : SCHEMAS[kind](ai);
    models.set(key, ai.getGenerativeModel(inst, {
      model: name,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 1500, // 考える分（thinking）もふくむ。少ないと答えが途中で切れる
        temperature: kind === 'read' ? 0 : kind === 'msg' ? 0.9 : 0.4,
        thinkingConfig: { thinkingBudget: kind === 'read' ? 64 : 256 },
      },
    }));
  }
  return models.get(key);
}
const SCHEMAS = {};
/** ほかの機能（声の答えの判定など）からも使う：JSON で答えてもらう */
export function defineSchema(kind, fn) { SCHEMAS[kind] = fn; }
export async function aiJSON(kind, parts, { timeout = 20000 } = {}) {
  const list = aiModels.filter((m) => !skipped().includes(m));
  let last = null;
  for (const name of list) {
    try {
      const model = await modelFor(name, kind);
      const res = await withTimeout(model.generateContent(parts), timeout);
      const fin = res.response.candidates?.[0]?.finishReason;
      if (fin && fin !== 'STOP') throw Object.assign(new Error('答えが途中で切れました'), { code: 'ai-truncated' });
      return JSON.parse(res.response.text());
    } catch (e) {
      last = e;
      const k = aiErrorKind(e);
      if (e.code === 'ai-truncated' || e instanceof SyntaxError) continue;
      if (k === 'quota' || k === 'model') { skip(name); continue; }
      throw Object.assign(e, { code: k === 'billing' ? 'ai-quota' : k === 'appcheck' ? 'ai-appcheck' : k === 'offline' ? 'ai-offline' : (e.code || 'ai-error') });
    }
  }
  throw Object.assign(new Error('AIが使えませんでした'), { code: last?.code === 'ai-truncated' ? 'ai-truncated' : 'ai-quota', cause: last });
}

/** 勉強をはじめるときに、App Check のトークンと AI の準備を先にしておく（1回目を速くする） */
export async function warmAI() {
  try {
    const fb = await loadFirebase();
    if (fb.appCheck) { const ac = await import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app-check.js`); await ac.getToken(fb.appCheck); }
    await modelFor(aiModels[0]);
  } catch (e) { console.warn('warmAI', e?.message); }
}

// その日に上限に達した・使えなかったモデル（この端末だけに覚える）
const SKIP_KEY = 'anki-cards:ai-skip';
const today = () => new Date().toLocaleDateString('sv-SE');
function skipped() { try { const s = JSON.parse(localStorage.getItem(SKIP_KEY) || '{}'); return s.day === today() ? s.models || [] : []; } catch { return []; } }
function skip(name) { const m = new Set(skipped()); m.add(name); localStorage.setItem(SKIP_KEY, JSON.stringify({ day: today(), models: [...m] })); }

/** エラーの種類：quota（今日の上限）・model（そのモデルが使えない）・appcheck・offline・other */
export function aiErrorKind(e) {
  const t = `${e?.code || ''} ${e?.message || ''} ${e?.customErrorData?.status || ''}`;
  if (/prepayment|credits are depleted|billing/i.test(t)) return 'billing'; // 支払い（前払いクレジット）の問題：どのモデルも同じ
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(t)) return 'quota';
  if (/\b404\b|NOT_FOUND|not found|not supported/i.test(t)) return 'model';
  if (/App ?Check|appCheck|\b401\b/i.test(t)) return 'appcheck';
  if (!navigator.onLine || /Failed to fetch|NetworkError|network/i.test(t)) return 'offline';
  return 'other';
}

export const PROMPT = (dir, ctx = {}) => [
  '画像は、小学生が指やペンで手書きした日本語（漢字・ひらがな・カタカナ・数字など）です。',
  `書かれている向きは${dir === 'v' ? '縦書き（右の列から左の列へ、上から下へ）' : '横書き（左から右へ）'}です。`,
  ctx.cells ? `マス目は${ctx.cells}個です（1マスに1字ずつ書いてあります${ctx.layout && ctx.layout.lines > 1 ? `。${ctx.layout.dir === 'v' ? `1列に${ctx.layout.per}マスずつ、右の列から順に読みます` : `1行に${ctx.layout.per}マスずつ、上の行から順に読みます`}` : ''}）。` : (ctx.len ? `目安として、${ctx.len}字くらいの答えです（ちがっていてもかまいません）。` : ''),
  ctx.kanji ? '漢字で書く問題です。' : '',
  '書かれている文字を、見えるとおりにそのまま書き起こしてください。',
  '・まちがった字や形のくずれた字も、正しい字に直したり、言葉として自然になるよう補ったりしないでください。',
  '・読めない字は「？」にしてください。空いているマスは書かないでください。',
  '・何も書かれていなければ空文字にしてください。',
  '結果は JSON {"text": "..."} だけで返してください。',
].filter(Boolean).join('\n');

function parseText(res) {
  // 途中で切れた答え（MAX_TOKENS など）は使わない：一部だけの字で「まちがい」にしないため
  const fin = res.candidates?.[0]?.finishReason;
  if (fin && fin !== 'STOP') throw Object.assign(new Error('読み取りの答えが途中で切れました: ' + fin), { code: 'ai-truncated' });
  const t = res.text();
  try { return String(JSON.parse(t).text || '').trim(); }
  catch { throw Object.assign(new Error('読み取りの答えの形がへんです'), { code: 'ai-truncated' }); }
}

export const READ_IMG_MAX = 384;
// たまに返事がとても遅いことがある（本番で 8〜20 秒）。4 秒たっても返事がなければ、同じ問い合わせをもう1つ送って、早いほうを使う
// （ふだんは1回だけ。2回目を送るのは1割くらい）
const HEDGE_MS = 4000;
export function hedged(call, ms) {
  return new Promise((resolve, reject) => {
    let fails = 0, n = 1, done = false;
    const fin = (ok, v) => { if (done) return; if (ok) { done = true; clearTimeout(t); resolve(v); } else if (++fails >= n) { done = true; clearTimeout(t); reject(v); } };
    const run = () => { try { call().then((v) => fin(true, v), (e) => fin(false, e)); } catch (e) { fin(false, e); } };
    const t = setTimeout(() => { if (!done) { n = 2; run(); } }, ms);
    run();
  });
}

async function geminiRead(pad, ctx) {
  const img = pad.toImage({ max: READ_IMG_MAX }); // 小さめの画像で送る（速さ・まちがい字をそのまま読む・料金）
  if (!img) return '';
  const list = aiModels.filter((m) => !skipped().includes(m));
  if (!list.length) throw Object.assign(new Error('今日のAI読み取りの上限に達しました'), { code: 'ai-quota' });
  let last = null;
  for (const name of list) {
    try {
      const model = await modelFor(name);
      const parts = [PROMPT(pad.dir, ctx), { inlineData: { data: img.base64, mimeType: 'image/png' } }];
      const res = await withTimeout(hedged(() => model.generateContent(parts), HEDGE_MS), 20000);
      return parseText(res.response);
    } catch (e) {
      last = e;
      const k = aiErrorKind(e);
      console.warn('AI読み取り', name, k, e?.message);
      if (e && e.code === 'ai-truncated') continue; // 次のモデルでもう一度
      if (k === 'quota' || k === 'model') { skip(name); continue; }
      if (k === 'billing') throw Object.assign(e, { code: 'ai-quota' });
      throw Object.assign(e, { code: k === 'appcheck' ? 'ai-appcheck' : k === 'offline' ? 'ai-offline' : (e.code || 'ai-error') });
    }
  }
  if (last && last.code === 'ai-truncated') throw last; // 読み取れなかっただけ（上限ではない）
  throw Object.assign(new Error('今日のAI読み取りの上限に達しました'), { code: 'ai-quota', cause: last });
}

async function deviceRead(pad) {
  const rec = await deviceRecognizer();
  const drawing = rec.startDrawing({ recognitionType: 'text', alternatives: 1 });
  for (const s of pad.strokes) {
    const st = new globalThis.HandwritingStroke();
    for (const p of s.points) st.addPoint({ x: p.x, y: p.y, t: p.t });
    drawing.addStroke(st);
  }
  const preds = await drawing.getPrediction();
  drawing.clear && drawing.clear();
  return (preds && preds[0] && preds[0].text) || '';
}

function fakeQueue() {
  try {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) return null;
    return JSON.parse(localStorage.getItem('anki-cards:fake-recog') || 'null');
  } catch { return null; }
}

/**
 * どのエンジンが使えるか（settings.recognition: 'on' | 'off'）
 * 'gemini'（だめなら端末内）・'device'・null（自分で答え合わせ）
 */
export async function availableEngine(settings) {
  if (settings.recognition === 'off') return null;
  if (fakeQueue()) return 'fake'; // テスト用（localhost だけ）
  if (appCheckSiteKey && !(['localhost', '127.0.0.1'].includes(location.hostname))) return 'gemini';
  if (await deviceRecognizer()) return 'device';
  return null;
}

/** pad: HandPad, ctx: { cells, len, kanji }。戻り値は文字列（失敗したら例外。e.code で理由） */
export async function recognize(engine, pad, ctx = {}) {
  if (engine === 'fake') {
    const q = fakeQueue() || [];
    const t = q.shift();
    localStorage.setItem('anki-cards:fake-recog', JSON.stringify(q.length ? q : ['']));
    const m = /^~(\d+):([\s\S]*)$/.exec(t || ''); // 「~2500:答え」= 2.5秒まって答える（AIの待ち時間のまね）
    if (m) { await new Promise((r) => setTimeout(r, +m[1])); return m[2]; }
    if (t === '!error') throw new Error('fake error');
    if (t === '!quota') throw Object.assign(new Error('quota'), { code: 'ai-quota' });
    return t ?? '';
  }
  if (engine === 'device') return deviceRead(pad);
  if (engine === 'gemini') {
    try { return await geminiRead(pad, ctx); }
    catch (e) {
      if (await deviceRecognizer()) { try { return await deviceRead(pad); } catch {} }
      throw e;
    }
  }
  throw new Error('読み取りが使えません');
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('時間切れ'), { code: 'ai-timeout' })), ms))]);
}
