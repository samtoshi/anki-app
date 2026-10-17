// 今日のひとこと（1日1回。日本時間の日づけごと）
// AI（Gemini）に作ってもらい、記録のドキュメントに入れて、どの端末でも同じものを出す。
// AI に送るのは数字だけ（れんぞく日数・きのうの数など）。名前は送らない（「きみ」と書いてもらう）。
import { aiJSON, defineSchema } from './recognize.js';

defineSchema('msg', (ai) => ai.Schema.object({ properties: { text: ai.Schema.string() } }));

const POOL = [
  'きょうも来てくれてうれしいな！1まいずつ、いっしょにがんばろう🐰',
  'すこしずつでも、毎日つづけるのがいちばんのひみつだよ✨',
  'わすれちゃっても大丈夫。思い出すたびに、もっと強く覚えられるんだよ🌱',
  'きのうのきみより、きょうのきみは1歩まえにいるよ👣',
  'むずかしいカードは、のびしろのカード。ゆっくりでいいよ🍀',
  'さいごまでやると、うさぎがとってもよろこぶよ🐰💕',
  'まちがえたところが、いちばん覚えやすいところ。ためしてみよう！',
  'きょうは何まいいけるかな？目標の輪っかをまんまるにしよう⭕',
];
const STREAK = (n) => [`${n}日れんぞく、すごい！🔥 このちょうしでいこう！`, `${n}日もつづいてるね。毎日のつみかさね、かっこいいよ✨`];

/** ローカルのひとこと（AIが使えないとき） */
export function localMessage(day, ctx = {}) {
  if (ctx.streak >= 3 && day % 2 === 0) return STREAK(ctx.streak)[day % 2 === 0 ? 0 : 1];
  if (ctx.yN >= 10 && ctx.yAcc >= 80) return `きのうは${ctx.yN}まいも、しかもよくできてたね！きょうもいっしょにやろう🌸`;
  return POOL[((day % POOL.length) + POOL.length) % POOL.length];
}

export const MSG_PROMPT = (ctx) => [
  '小学5年生の女の子が、毎日使う暗記カードのアプリを開きました。ホーム画面に出す「きょうのひとこと」を1つ作ってください。',
  '・やさしく明るい話しことばで、40〜70字くらい。絵文字は1〜2こ。',
  '・相手は「きみ」とよんでください（名前は使わない）。',
  '・せめたり、くらべたり、プレッシャーをかけたりしないこと。休んだ日があっても「また来てくれてうれしい」のように前向きに。',
  '・下の数字を1つくらい自然に入れて、ほめたり、はげましたりしてください。毎日ちがう言い方で。',
  `【れんぞく日数】${ctx.streak}日`,
  `【きのう】${ctx.yN}まい・正解率 ${ctx.yAcc ?? '－'}%`,
  `【レベル】${ctx.level}`,
  `【いちばん長いれんぞく】${ctx.best}日`,
  `【今日の目標】${ctx.goal}まい`,
  `【季節】${ctx.month}月`,
  'JSON {"text": "..."} で返してください。',
].join('\n');

export async function aiMessage(ctx) {
  const j = await aiJSON('msg', [MSG_PROMPT(ctx)], { timeout: 15000 });
  const t = String(j.text || '').trim();
  if (!t || t.length > 140) throw new Error('ひとことの形がへんです');
  return t;
}
