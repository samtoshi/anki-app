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
