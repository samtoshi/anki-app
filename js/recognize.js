// 手書き文字の読み取り
// 1) Firebase AI Logic（Gemini Developer API・無料枠）に「書いた字の画像」だけを送って書き起こしてもらう
//    - 送るのは画像と、書く向き・だいたいの字数・漢字かどうか だけ（名前・メール・正解の文字は送らない）
//    - 画像は読み取りのためだけに送り、Firestore などには保存しない
//    - App Check（reCAPTCHA v3）のトークンがないと使えない
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
async function modelFor(name) {
  if (!models.has(name)) {
    const { ai, inst } = await aiInstance();
    models.set(name, ai.getGenerativeModel(inst, {
      model: name,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ai.Schema.object({ properties: { text: ai.Schema.string() } }),
        maxOutputTokens: 120,
        temperature: 0,
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
    }));
  }
  return models.get(name);
}

// その日に上限に達した・使えなかったモデル（この端末だけに覚える）
const SKIP_KEY = 'anki-cards:ai-skip';
const today = () => new Date().toLocaleDateString('sv-SE');
function skipped() { try { const s = JSON.parse(localStorage.getItem(SKIP_KEY) || '{}'); return s.day === today() ? s.models || [] : []; } catch { return []; } }
function skip(name) { const m = new Set(skipped()); m.add(name); localStorage.setItem(SKIP_KEY, JSON.stringify({ day: today(), models: [...m] })); }

/** エラーの種類：quota（今日の上限）・model（そのモデルが使えない）・appcheck・offline・other */
export function aiErrorKind(e) {
  const t = `${e?.code || ''} ${e?.message || ''} ${e?.customErrorData?.status || ''}`;
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(t)) return 'quota';
  if (/\b404\b|NOT_FOUND|not found|not supported|\b400\b.*model|thinking/i.test(t)) return 'model';
  if (/App ?Check|appCheck|\b401\b/i.test(t)) return 'appcheck';
  if (!navigator.onLine || /Failed to fetch|NetworkError|network/i.test(t)) return 'offline';
  return 'other';
}

export const PROMPT = (dir, ctx = {}) => [
  '画像は、小学生が指やペンで手書きした日本語（漢字・ひらがな・カタカナ・数字など）です。',
  `書かれている向きは${dir === 'v' ? '縦書き（右の列から左の列へ、上から下へ）' : '横書き（左から右へ）'}です。`,
  ctx.cells ? `マス目は${ctx.cells}個です（1マスに1字ずつ書いてあります）。` : (ctx.len ? `目安として、${ctx.len}字くらいの答えです（ちがっていてもかまいません）。` : ''),
  ctx.kanji ? '漢字で書く問題です。' : '',
  '書かれている文字を、見えるとおりにそのまま書き起こしてください。',
  '・まちがった字や形のくずれた字も、正しい字に直したり、言葉として自然になるよう補ったりしないでください。',
  '・読めない字は「？」にしてください。空いているマスは書かないでください。',
  '・何も書かれていなければ空文字にしてください。',
  '結果は JSON {"text": "..."} だけで返してください。',
].filter(Boolean).join('\n');

function parseText(t) {
  try { return String(JSON.parse(t).text || '').trim(); } catch { return String(t).replace(/[{}"]/g, '').replace(/^\s*text\s*:/, '').trim(); }
}

async function geminiRead(pad, ctx) {
  const img = pad.toImage({ max: 640 }); // 小さめの画像で送る（料金・通信量を少なく）
  if (!img) return '';
  const list = aiModels.filter((m) => !skipped().includes(m));
  if (!list.length) throw Object.assign(new Error('今日のAI読み取りの上限に達しました'), { code: 'ai-quota' });
  let last = null;
  for (const name of list) {
    try {
      const model = await modelFor(name);
      const res = await withTimeout(model.generateContent([PROMPT(pad.dir, ctx), { inlineData: { data: img.base64, mimeType: 'image/png' } }]), 20000);
      return parseText(res.response.text());
    } catch (e) {
      last = e;
      const k = aiErrorKind(e);
      console.warn('AI読み取り', name, k, e?.message);
      if (k === 'quota' || k === 'model') { skip(name); continue; }
      throw Object.assign(e, { code: k === 'appcheck' ? 'ai-appcheck' : k === 'offline' ? 'ai-offline' : (e.code || 'ai-error') });
    }
  }
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
