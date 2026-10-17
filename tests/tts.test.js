// iPad（WebKit）・Chrome の読み上げのくせをまねして、TTS マネージャーが毎回読めることを確かめる
import test from 'node:test';
import assert from 'node:assert/strict';

let inGesture = false;
function fakeSS({ gesture = false, dropAfterCancel = 0, voicesLate = 0, stuckPaused = false, dur = 20 } = {}) {
  const S = { heard: [], speaking: false, pending: false, paused: false, unlocked: !gesture, lastCancel: -1e9, resumes: 0, listeners: {}, q: [] };
  let voices = voicesLate ? [] : [{ lang: 'ja-JP', name: 'Kyoko', localService: true }];
  if (voicesLate) setTimeout(() => { voices = [{ lang: 'ja-JP', name: 'Kyoko', localService: true }]; (S.listeners.voiceschanged || []).forEach((f) => f()); }, voicesLate);
  S.getVoices = () => voices;
  S.addEventListener = (n, f) => { (S.listeners[n] ||= []).push(f); };
  S.removeEventListener = (n, f) => { S.listeners[n] = (S.listeners[n] || []).filter((x) => x !== f); };
  S.resume = () => { S.resumes++; if (S.paused) { S.paused = false; S._kick && S._kick(); } };
  S.cancel = () => { S.lastCancel = Date.now(); for (const u of S.q) { u._dead = true; } if (S.cur) { S.cur._dead = true; const c = S.cur; S.cur = null; c.onerror && c.onerror({ error: 'interrupted' }); } S.q = []; S.speaking = S.pending = false; };
  const next = () => {
    if (S.cur || !S.q.length) return;
    const u = S.q.shift(); S.cur = u; S.speaking = true;
    const run = () => { u.onstart && u.onstart(); setTimeout(() => { if (u._dead) return; if (u.volume !== 0) S.heard.push(u.text); S.cur = null; S.speaking = false; u.onend && u.onend(); next(); }, dur); };
    if (stuckPaused && !S._stuckOnce) { S._stuckOnce = true; S.paused = true; S._kick = () => { S._kick = null; run(); }; return; }
    run();
  };
  S.speak = (u) => {
    if (!S.unlocked) { if (inGesture) S.unlocked = true; else return; } // iOS：タップの中でないと、何も起きない（onstart も onend も来ない）
    if (Date.now() - S.lastCancel < dropAfterCancel) return;             // cancel 直後の speak は消える
    S.q.push(u); next();
  };
  return S;
}
function setup(opts, ua = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1') {
  const S = fakeSS(opts);
  const handlers = {};
  globalThis.window = { speechSynthesis: S };
  globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.volume = 1; } };
  globalThis.document = { visibilityState: 'visible', addEventListener: (n, f) => { (handlers[n] ||= []).push(f); } };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua, maxTouchPoints: 5 }, configurable: true });
  const tap = (target = { closest: () => null }) => { inGesture = true; try { for (const n of ['touchend', 'pointerup', 'click']) (handlers[n] || []).forEach((f) => f({ target })); } finally { inGesture = false; } };
  return { S, tap };
}
let n = 0;
const load = async () => { const v = await import('../js/voice.js?t' + (++n)); v.TTS_TIMING.startMs = 150; return v; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('iPad Chrome（CriOS）・デスクトップ表示の iPad を iOS として見分ける', async () => {
  setup({}); const v = await load();
  assert.equal(v.isIOSLike({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148' }), true);
  assert.equal(v.isIOSLike({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', maxTouchPoints: 5 }), true);
  assert.equal(v.isIOSLike({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36', maxTouchPoints: 0 }), false);
  assert.equal(v.isIOSLike({ userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 Chrome/130 Safari/537.36', maxTouchPoints: 5 }), false);
  assert.equal(v.ttsDebug().ios, true);
});

test('声の一覧があとから来ても読む（getVoices が空→voiceschanged）', async () => {
  const { S } = setup({ voicesLate: 200 }); const v = await load();
  await v.speak('問題A');
  assert.deepEqual(S.heard, ['問題A']);
});

test('cancel の直後の speak が消えるブラウザでも、次の問題を読む', async () => {
  const { S } = setup({ dropAfterCancel: 100 }); const v = await load();
  v.speak('問題1'); await sleep(5); // 読んでいる途中で次のカードへ
  await v.speak('問題2');
  assert.deepEqual(S.heard, ['問題2']);
});

test('iPad：タップの前は読めない → 🔊 を光らせて、次のタップで読む', async () => {
  const { S, tap } = setup({ gesture: true }); const v = await load();
  const blocked = []; v.onSpeechBlocked((on) => blocked.push(on)); v.armSpeechGestures();
  await v.speak('東廻り航路を整備した人物は？');
  assert.deepEqual(S.heard, []); assert.equal(v.speechPending(), true); assert.equal(blocked.at(-1), true);
  tap(); await sleep(80);
  assert.deepEqual(S.heard, ['東廻り航路を整備した人物は？']); assert.equal(v.speechPending(), false); assert.equal(blocked.at(-1), false);
  // 一度タップで読めたら、あとのカードはタップなしで読める（ハッシュの画面切りかえ・AI を待ったあとでも）
  await v.speak('次の問題'); await sleep(40);
  assert.deepEqual(S.heard.at(-1), '次の問題');
});

test('iPad：さいしょのタップ（「はじめる」）で無音の準備をすれば、1枚目からタップなしで読む', async () => {
  const { S, tap } = setup({ gesture: true }); const v = await load();
  v.armSpeechGestures(); tap();
  await v.speak('1枚目の問題');
  assert.deepEqual(S.heard, ['1枚目の問題']);
});

test('次のカードへ進んだら、タップ待ちの前の問題は読まない', async () => {
  const { S, tap } = setup({ gesture: true }); const v = await load(); v.armSpeechGestures();
  await v.speak('前の問題'); assert.equal(v.speechPending(), true);
  v.stopSpeak(); assert.equal(v.speechPending(), false);
  tap(); await sleep(60); assert.deepEqual(S.heard, []);
});

test('一時停止で固まっても resume() して読む', async () => {
  const { S } = setup({ stuckPaused: true }); const v = await load();
  await v.speak('問題P');
  assert.deepEqual(S.heard, ['問題P']); assert.ok(S.resumes >= 1);
});

test('マイクを使っている間は読まず、終わってから少し待って読む', async () => {
  const { S } = setup({}); const v = await load();
  v.noteMic(true); await v.speak('問題M'); assert.deepEqual(S.heard, []);
  v.noteMic(false); const t0 = Date.now(); await v.speak('問題M');
  assert.deepEqual(S.heard, ['問題M']); assert.ok(Date.now() - t0 >= v.TTS_TIMING.micGap - 20);
});

test('長い文は分けて読み、全部読む', async () => {
  const { S } = setup({}); const v = await load();
  const long = 'あ'.repeat(100) + '。' + 'い'.repeat(100) + '。';
  await v.speak(long);
  assert.equal(S.heard.length, 2); assert.equal(S.heard.join(''), long);
});

test('🔊（タップの中）はすぐに読む・読んでいる途中でも読み直す', async () => {
  const { S } = setup({ gesture: true, dropAfterCancel: 100 }); const v = await load();
  inGesture = true; v.speakFromTap('問題T'); inGesture = false; await sleep(60);
  assert.deepEqual(S.heard, ['問題T']);
  v.speak('問題U'); await sleep(5); // 読み途中
  inGesture = true; v.speakFromTap('問題U'); inGesture = false; await sleep(500);
  assert.deepEqual(S.heard, ['問題T', '問題U']);
});

test('読み上げを2回続けて呼んでも、読むのは最後の1つだけ（2回読まない）', async () => {
  const { S } = setup({}); const v = await load();
  const a = v.speak('問題1'); const b = v.speak('問題2（もんだい）'); await Promise.all([a, b]);
  assert.deepEqual(S.heard, ['問題2']);
});
