import test from 'node:test';
import assert from 'node:assert/strict';

// Safari のように stop() しても onend が来ない音声認識のまね
let aborted = 0;
class StuckSR {
  start() { setTimeout(() => this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'がいこくじんのはんじ' }], { isFinal: false })] }), 10); }
  stop() {}
  abort() { aborted++; }
}
globalThis.window = { webkitSpeechRecognition: StuckSR };
const { listen } = await import('../js/voice.js');

test('「おわり」で止めたら、onend が来なくても聞こえた文字で終わる（固まらない）', async () => {
  const l = listen({ stopGraceMs: 50 });
  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now(); l.stop();
  const said = await l.done;
  assert.equal(said, 'がいこくじんのはんじ');
  assert.ok(Date.now() - t0 < 500);
  assert.equal(aborted, 1);
});

test('abort() はすぐに終わる（画面を出るとき）', async () => {
  const l = listen();
  l.abort();
  assert.equal(await l.done, '');
});

test('読み上げ：声のじゅんび中に止めたら、前の問題は読まない・読むのは最後の1つだけ', async () => {
  const spoken = []; let cancels = 0;
  globalThis.window.speechSynthesis = { getVoices: () => [{ lang: 'ja-JP', name: 'Kyoko' }], cancel: () => { cancels++; }, speak: (u) => { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 1); } };
  globalThis.speechSynthesis = globalThis.window.speechSynthesis;
  globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  const v = await import('../js/voice.js?tts');
  const a = v.speak('問題1'); const b = v.speak('問題2（もんだい）');
  await Promise.all([a, b]);
  assert.deepEqual(spoken, ['問題2']);
  const c = v.speak('問題3'); v.stopSpeak(); await c;
  assert.deepEqual(spoken, ['問題2']);
  assert.ok(cancels >= 3);
});
