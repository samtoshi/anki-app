// 手書き文字の読み取り
// 1) ブラウザに手書き認識API（Handwriting Recognition API）があれば端末の中で読む
// 2) なければ Firebase AI Logic（Gemini Developer API）に画像を送って書き起こしてもらう
//    （画像は読み取りのためだけに送り、Firestore などには保存しない）
// 3) どちらも使えなければ null（自己採点にもどる）
import { aiModel } from './firebase-config.js';
import { loadFirebase, SDK_VERSION } from './cloud.js';
import { appCheckSiteKey } from './firebase-config.js';

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

let aiModelP = null;
async function geminiModel() {
  if (!aiModelP) aiModelP = (async () => {
    const fb = await loadFirebase();
    const ai = await import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-ai.js`);
    const inst = ai.getAI(fb.app, { backend: new ai.GoogleAIBackend() });
    return getModel(ai, inst);
  })().catch((e) => { aiModelP = null; throw e; });
  return aiModelP;
}
function getModel(ai, inst) {
  return ai.getGenerativeModel(inst, {
    model: aiModel,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ai.Schema.object({ properties: { text: ai.Schema.string() } }),
      maxOutputTokens: 200,
    },
  });
}

export const PROMPT = (dir) => [
  '画像は、小学生が指やペンで手書きした日本語（漢字・ひらがな・カタカナ・数字など）です。',
  `書かれている向きは${dir === 'v' ? '縦書き（右の列から左の列へ、上から下へ）' : '横書き（左から右へ）'}です。`,
  '書かれている文字を、見えるとおりにそのまま書き起こしてください。',
  '・まちがった字や形のくずれた字も、正しい字に直したり、言葉として自然になるよう補ったりしないでください。',
  '・読めない字は「？」にしてください。',
  '・何も書かれていなければ空文字にしてください。',
  '結果は JSON {"text": "..."} だけで返してください。',
].join('\n');

/**
 * どのエンジンが使えるか
 * settings.recognition: 'off' | 'on'
 */
function fakeQueue() {
  try {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) return null;
    return JSON.parse(localStorage.getItem('anki-cards:fake-recog') || 'null');
  } catch { return null; }
}

export async function availableEngine(settings) {
  if (settings.recognition !== 'on') return null;
  if (fakeQueue()) return 'fake'; // テスト用（localhost だけ）
  if (await deviceRecognizer()) return 'device';
  if (appCheckSiteKey) return 'gemini'; // AI Logic は App Check が必須（docs/SETUP.md）
  return null;
}

/** pad: HandPad。戻り値は文字列（失敗したら例外） */
export async function recognize(engine, pad) {
  if (engine === 'fake') {
    const q = fakeQueue() || [];
    const t = q.shift();
    localStorage.setItem('anki-cards:fake-recog', JSON.stringify(q.length ? q : ['']));
    if (t === '!error') throw new Error('fake error');
    return t ?? '';
  }
  if (engine === 'device') {
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
  if (engine === 'gemini') {
    const img = pad.toImage({ max: 900 });
    if (!img) return '';
    const model = await geminiModel();
    const res = await withTimeout(model.generateContent([PROMPT(pad.dir), { inlineData: { data: img.base64, mimeType: 'image/png' } }]), 20000);
    const t = res.response.text();
    try { return String(JSON.parse(t).text || ''); } catch { return t.replace(/[{}"]/g, '').replace(/^text:/, '').trim(); }
  }
  throw new Error('読み取りが使えません');
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('時間切れ')), ms))]);
}
