// 読み上げ（speechSynthesis）と、声で答える（Web Speech API の音声認識）
// 声の認識は、その端末のブラウザ（Safari・Chrome）の仕組みを使います。

let voiceP = null;
function jaVoice() {
  if (!('speechSynthesis' in window)) return Promise.resolve(null);
  if (!voiceP) voiceP = new Promise((res) => {
    const pick = () => { const vs = speechSynthesis.getVoices().filter((v) => /^ja(-|_|$)/i.test(v.lang)); return vs.find((v) => /Kyoko|O-ren|Google|Nanami|Haruka/i.test(v.name)) || vs[0] || null; };
    const v = pick(); if (v) return res(v);
    speechSynthesis.onvoiceschanged = () => res(pick());
    setTimeout(() => res(pick()), 1200);
  });
  return voiceP;
}
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** 読み上げ用に、かっこの読みがなや記号を整える */
export function speakText(t) {
  return String(t || '').replace(/（[ぁ-んー・]+）/g, '').replace(/[①-⑳]/g, (c) => `${c.charCodeAt(0) - 0x245f}つ目、`).replace(/[「」『』]/g, '').replace(/\n/g, '。');
}

export async function speak(text, { rate = 1 } = {}) {
  if (!canSpeak()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(speakText(text));
  u.lang = 'ja-JP'; u.rate = rate;
  const v = await jaVoice(); if (v) u.voice = v;
  return new Promise((res) => { u.onend = u.onerror = () => res(); speechSynthesis.speak(u); });
}
export function stopSpeak() { if (canSpeak()) speechSynthesis.cancel(); }

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
export const canListen = () => !!SR;

/**
 * 声を聞く。onPartial(とちゅうの文字) を呼びながら、終わったら全部の文字を返す。
 * 戻り値 { stop() , done: Promise<string> }
 */
export function listen({ onPartial = () => {}, maxMs = 30000 } = {}) {
  if (!SR) throw Object.assign(new Error('この端末では声で答えられません'), { code: 'no-sr' });
  stopSpeak();
  const r = new SR();
  r.lang = 'ja-JP'; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
  let finalText = '', interim = '', stopped = false;
  const done = new Promise((res, rej) => {
    r.onresult = (e) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      onPartial(finalText + interim);
    };
    r.onerror = (e) => { if (e.error === 'no-speech' || e.error === 'aborted') return; rej(Object.assign(new Error(e.error), { code: 'sr-' + e.error })); };
    r.onend = () => res((finalText + interim).trim());
  });
  try { r.start(); } catch (e) { throw Object.assign(e, { code: 'sr-start' }); }
  const timer = setTimeout(() => stop(), maxMs);
  function stop() { if (stopped) return; stopped = true; clearTimeout(timer); try { r.stop(); } catch {} }
  return { stop, done };
}
