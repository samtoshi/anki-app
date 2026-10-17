// 読み上げ（speechSynthesis）と、声で答える（Web Speech API の音声認識）
// 声の認識は、その端末のブラウザ（Safari・Chrome）の仕組みを使います。

// ---- 読み上げ（TTS マネージャー）----
// iPad（Safari・Chrome どちらも中身は WebKit）では、次のことで読み上げが「ときどき」出なくなる。ここで全部ふせぐ：
//  1) さいしょの読み上げはタップの中でないと始まらない → タップのたびに（まだなら）無音の読み上げで準備。
//     それでも始まらなかった問題は「次のタップ」で読む（🔊 が光る）
//  2) cancel() の直後に speak() すると、その読み上げが消える → 止めたら少し待ってから読む
//  3) 声の一覧（getVoices）があとから来る → voiceschanged を待つ（見つからなくても lang だけで読む）
//  4) 一時停止のまま固まる → speak の前と読んでいるあいだに resume()
//  5) 読み上げの途中で utterance が片づけられて onend が来ない → 今読んでいるものを持っておく
//  6) マイク（音声認識）のすぐあとは音が出ない → 認識が終わってから少し待つ
//  7) 長い文は途中で切れる → 「。」ごとに分けて読む
//  8) 1秒たっても始まらなければ、もう一度だけ読む（2回目は声の指定なし）
const ss = () => (typeof window !== 'undefined' && window.speechSynthesis) || null;
export const canSpeak = () => !!ss() && typeof SpeechSynthesisUtterance !== 'undefined';
/** iPhone・iPad（iPad の Chrome＝CriOS、デスクトップ表示の iPad＝Macintosh＋タッチ もふくむ） */
export function isIOSLike(nav = typeof navigator !== 'undefined' ? navigator : {}) {
  const ua = nav.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || /CriOS|FxiOS|EdgiOS/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
}
const IOS = isIOSLike();
export const TTS_TIMING = { cancelGap: IOS ? 250 : 120, micGap: IOS ? 700 : 250, startMs: 1200 };
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function pickVoice() {
  const S = ss(); if (!S || !S.getVoices) return null;
  const vs = S.getVoices().filter((v) => /^ja(-|_|$)/i.test(v.lang));
  const local = vs.filter((v) => v.localService !== false);
  const pool = local.length ? local : vs;
  return pool.find((v) => /Kyoko|O-ren|Otoya|Nanami|Haruka|Google/i.test(v.name)) || pool[0] || null;
}
let voicesWaited = false;
async function getVoice(maxMs = 1500) {
  const v = pickVoice(); if (v || voicesWaited) return v;
  const S = ss();
  await new Promise((res) => {
    const done = () => { clearTimeout(t); try { S.removeEventListener && S.removeEventListener('voiceschanged', done); } catch {} res(); };
    const t = setTimeout(done, maxMs);
    try { S.addEventListener ? S.addEventListener('voiceschanged', done) : (S.onvoiceschanged = done); } catch { done(); }
  });
  voicesWaited = true; // 待つのは1回だけ（声がない端末で毎回待たない）
  return pickVoice();
}

/** 読み上げる文を整える（かっこの読みがな・記号） */
export function speakText(t) {
  return String(t || '').replace(/（[ぁ-んー・]+）/g, '').replace(/[①-⑳]/g, (c) => `${c.charCodeAt(0) - 0x245f}つ目、`).replace(/[「」『』]/g, '').replace(/\n/g, '。');
}
/** 長い文は「。」などで区切って、1つ max 字まで */
export function chunkText(t, max = 120) {
  const parts = String(t).match(/[^。！？!?]+[。！？!?]*/g) || [];
  const out = [];
  for (let p of parts) {
    while (p.length > max) { let k = p.lastIndexOf('、', max); if (k < max / 2) k = max; out.push(p.slice(0, k + 1)); p = p.slice(k + 1); }
    if (!p.trim()) continue;
    if (out.length && (out[out.length - 1] + p).length <= max) out[out.length - 1] += p; else out.push(p);
  }
  return out;
}

let speakGen = 0;        // 新しく読む・止めるたびにふえる（古い読み上げは捨てる）
let unlocked = false;    // この画面で一度でも読み上げが始まった（iOS の準備ができた）
let lastCancel = 0, micEndAt = 0, micOn = false;
let alive = null;        // 今読んでいる utterance（片づけられないように持っておく）
let pending = null;      // 始められなかった読み上げ（次のタップで読む）
let inflight = null;     // 今読もうとしている（まだ始まっていない）読み上げ：その間にタップがあれば、タップの中で読む
let blockedFn = () => {};
let lastGestureAt = 0;
/** 読み上げが「タップ待ち」になった・なくなったときに呼ぶ（🔊 を光らせる） */
export function onSpeechBlocked(fn) { blockedFn = fn || (() => {}); }
function setPending(p) { pending = p; try { blockedFn(!!p); } catch {} }
/** 音声認識が始まった・終わったことを知らせる（終わってすぐは読まない） */
export function noteMic(on) { micOn = on; if (!on) micEndAt = Date.now(); }

function cancelNow() {
  const S = ss(); if (!S) return;
  if (alive || S.speaking || S.pending) { try { S.cancel(); } catch {} lastCancel = Date.now(); }
  alive = null;
}
function makeU(text, rate, voice) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP'; u.rate = rate;
  if (voice && !IOS) u.voice = voice; // iPad：声を指定すると音が出ないことがあるので、言語だけ指定する
  return u;
}
/** 1つの文を読む。true＝読み終わった、false＝止めた・始まらなかった */
function sayOne(text, rate, voice, gen, attempt = 1) {
  const S = ss();
  return new Promise((resolve) => {
    let started = false, settled = false;
    const u = makeU(text, rate, attempt === 1 ? voice : null);
    alive = u;
    const fin = (v) => { if (settled) return; settled = true; clearTimeout(wd); clearInterval(keep); if (alive === u) alive = null; resolve(v); };
    u.onstart = () => { started = true; unlocked = true; if (inflight && inflight.gen === gen) inflight.started = true; if (pending && pending.gen === gen) setPending(null); };
    u.onend = () => { if (!started) u.onstart(); fin(true); }; // onstart が来ないブラウザもあるので、終わったら始まったことにする
    u.onerror = (e) => {
      const err = e && e.error;
      if (err === 'not-allowed' && gen === speakGen) { setPending({ text, rate, gen }); return fin(false); }
      if (!started && gen === speakGen && attempt === 1 && err !== 'interrupted' && err !== 'canceled') { clearTimeout(wd); settled = true; clearInterval(keep); return retry(); }
      fin(false);
    };
    const retry = async () => {
      try { S.cancel(); } catch {} lastCancel = Date.now();
      await sleep(TTS_TIMING.cancelGap);
      if (gen !== speakGen) return resolve(false);
      resolve(await sayOne(text, rate, voice, gen, 2));
    };
    // 始まらない（iOS の準備ができていない・cancel 直後で消えた）→ もう一度だけ。それでもだめなら次のタップで読む
    const wd = setTimeout(() => {
      if (started || settled || gen !== speakGen) return;
      if (attempt === 1) { settled = true; clearInterval(keep); return retry(); }
      try { S.cancel(); } catch {} lastCancel = Date.now();
      setPending({ text, rate, gen }); fin(false);
    }, TTS_TIMING.startMs);
    // 一時停止のまま固まるのをふせぐ
    const keep = setInterval(() => { try { if (S.paused) S.resume(); } catch {} }, 300);
    try { if (S.paused) S.resume(); } catch {}
    try { S.speak(u); } catch { fin(false); }
  });
}

/** 問題などを読む（前の読み上げは止める）。読み終わるか止めたら終わる */
export async function speak(text, { rate = 1 } = {}) {
  if (!canSpeak()) return;
  const gen = ++speakGen;
  if (pending) setPending(null);
  cancelNow();
  const t = speakText(text).trim(); if (!t) return;
  const voice = await getVoice();
  // cancel の直後・マイクのすぐあとは少し待つ（すぐ読むと消える・音が出ない）
  const wait = Math.max(lastCancel + TTS_TIMING.cancelGap, micEndAt + TTS_TIMING.micGap) - Date.now();
  if (wait > 0) await sleep(wait);
  if (gen !== speakGen) return;
  if (micOn) { setPending({ text: t, rate, gen }); return; } // マイクを使っている間は読まない
  inflight = { text: t, rate, gen, started: false };
  for (const c of chunkText(t)) {
    if (gen !== speakGen) return;
    if (!(await sayOne(c, rate, voice, gen))) {
      // 始められなかったら、のこりもまとめて次のタップで
      if (pending && pending.gen === gen) setPending({ text: t.slice(t.indexOf(c)), rate, gen });
      return;
    }
  }
}
/** タップの中から、すぐに読む（iOS はタップの中なら必ず始められる） */
export function speakFromTap(text, { rate = 1 } = {}) {
  if (!canSpeak()) return;
  lastGestureAt = Date.now();
  const gen = ++speakGen;
  if (pending) setPending(null);
  const S = ss(); const t = speakText(text).trim(); if (!t) return;
  // 本当に読んでいる最中か（始まらずに待っているだけの読み上げは「読んでいる」に入れない）
  const wasBusy = unlocked && !!(S.speaking || S.pending);
  if (S.speaking || S.pending) { try { S.cancel(); } catch {} lastCancel = Date.now(); } // 読んでいないときは cancel しない（cancel 直後の読み上げは消えることがある）
  alive = null;
  const chunks = chunkText(t);
  (async () => {
    const voice = pickVoice();
    for (let i = 0; i < chunks.length; i++) {
      if (gen !== speakGen) return;
      // 読んでいる途中だった（＝もう使える状態）なら、cancel のあと少し待ってから読む。まだ一度も読めていないときは、タップの中ですぐ読む
      if (i === 0 && wasBusy) await sleep(TTS_TIMING.cancelGap);
      if (!(await sayOne(chunks[i], rate, voice, gen))) return;
    }
  })();
}
export function stopSpeak() {
  speakGen++; inflight = null; if (pending) setPending(null);
  if (!canSpeak()) return;
  const S = ss(); try { S.cancel(); } catch {} lastCancel = Date.now(); alive = null; // 止めるときは必ず cancel（次に読むときは少し待つので消えない）
}
export const speechPending = () => !!pending;
export const ttsDebug = () => ({ unlocked, pending: !!pending, gen: speakGen, ios: IOS });

/**
 * タップのたびに：まだ読み上げが使えるようになっていなければ、無音の読み上げで準備する。
 * 始められなかった問題があれば、そのタップの中で読む。（iPad は「はじめる」のあと・ページを開き直したあとなど）
 */
export function armSpeechGestures() {
  if (!canSpeak() || typeof document === 'undefined') return;
  const go = (e) => {
    const now = Date.now(); if (now - lastGestureAt < 400) return; // 1回のタップで何度も呼ばない
    lastGestureAt = now;
    const S = ss();
    const tgt = e && e.target && e.target.closest ? e.target : null;
    const waiting = pending || (inflight && !inflight.started && inflight.gen === speakGen ? inflight : null);
    if (waiting && !(tgt && tgt.closest('#speakBtn,.no-tts-tap,.grade,a'))) {
      const p = waiting; setPending(null); inflight = null;
      if (p.gen === speakGen && !micOn) { speakFromTap(p.text, { rate: p.rate }); return; }
    }
    if (!unlocked && !(S.speaking || S.pending)) {
      try { const u = new SpeechSynthesisUtterance('、'); u.volume = 0; u.lang = 'ja-JP'; u.onstart = () => { unlocked = true; }; S.speak(u); } catch {}
    }
  };
  for (const ev of ['touchend', 'pointerup', 'click']) document.addEventListener(ev, go, true);
  // 画面にもどってきたとき（iPad で別のアプリから）：止まったままにならないように
  document.addEventListener('visibilitychange', () => { const S = ss(); if (document.visibilityState === 'hidden') stopSpeak(); else try { if (S.paused) S.resume(); } catch {} });
}
export const unlockSpeechOnFirstTap = armSpeechGestures;

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
export const canListen = () => !!SR;

/**
 * 声を聞く。onPartial(とちゅうの文字) を呼びながら、終わったら全部の文字を返す。
 * 戻り値 { stop() , done: Promise<string> }
 */
export function listen({ onPartial = () => {}, maxMs = 30000, stopGraceMs = 800 } = {}) {
  if (!SR) throw Object.assign(new Error('この端末では声で答えられません'), { code: 'no-sr' });
  stopSpeak();
  const r = new SR();
  r.lang = 'ja-JP'; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
  let finalText = '', interim = '', stopped = false, settled = false, grace = null;
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const finish = (err) => {
    if (settled) return; settled = true; noteMic(false);
    clearTimeout(timer); clearTimeout(grace);
    r.onresult = r.onerror = r.onend = null;
    if (err) rejectDone(err); else resolveDone((finalText + interim).trim());
  };
  r.onresult = (e) => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t; else interim += t;
    }
    onPartial(finalText + interim);
  };
  r.onerror = (e) => { if (e.error === 'no-speech' || e.error === 'aborted') return; finish(Object.assign(new Error(e.error), { code: 'sr-' + e.error })); };
  r.onend = () => finish();
  try { r.start(); } catch (e) { throw Object.assign(e, { code: 'sr-start' }); }
  noteMic(true);
  const timer = setTimeout(() => stop(), maxMs);
  // 「おわり」を押したら止める。Safari などで onend が来ないことがあるので、少し待っても来なければ
  // abort して、そこまで聞こえた文字で終わりにする（画面が止まったままにならないように）
  function stop() {
    if (stopped) return; stopped = true;
    try { r.stop(); } catch {}
    grace = setTimeout(() => { try { r.abort(); } catch {} finish(); }, stopGraceMs);
  }
  /** すぐにやめる（画面を出るときなど）。聞こえた文字は捨てない */
  function abort() { stopped = true; try { r.abort(); } catch {} finish(); }
  return { stop, abort, done };
}
