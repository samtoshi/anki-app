// 毎日かわる小さなイラスト（絵文字を組み合わせた「きょうの絵」）。画像生成は使わない。
// m: その季節の月（なければ1年じゅう）
export const SCENES = [
  { e: '🐰', s: ['🌸', '🌸', '🍡'], bg: ['#ffe3ec', '#fff7fa'], cap: 'うさぎさんとお花見', m: [3, 4] },
  { e: '🐣', s: ['🌷', '🌼', '🦋'], bg: ['#fff4c2', '#f3ffe0'], cap: 'ひよこのお散歩', m: [3, 4, 5] },
  { e: '🐸', s: ['☔', '🌈', '💧'], bg: ['#dff4ff', '#eafff1'], cap: 'かえるくんと雨の日', m: [6] },
  { e: '🐌', s: ['🍃', '💧', '🌱'], bg: ['#e8fbe4', '#f6fff2'], cap: 'かたつむりのゆっくり旅', m: [6, 7] },
  { e: '🐬', s: ['🌊', '🐚', '☀️'], bg: ['#d8f1ff', '#fffbe0'], cap: 'イルカと夏の海', m: [7, 8] },
  { e: '🍉', s: ['🌻', '🎐', '☀️'], bg: ['#fff3d6', '#e7ffe9'], cap: 'すいかで夏やすみ', m: [7, 8] },
  { e: '🎆', s: ['🏮', '🍧', '✨'], bg: ['#2d2a5a', '#5b4a9a'], cap: '夏祭りの花火', m: [7, 8], dark: true },
  { e: '🦊', s: ['🍁', '🍂', '🌰'], bg: ['#ffe7d1', '#fff6e8'], cap: 'きつねと紅葉', m: [10, 11] },
  { e: '🐿️', s: ['🌰', '🍂', '🍄'], bg: ['#fbe8d4', '#fff8ee'], cap: 'りすのどんぐり集め', m: [9, 10, 11] },
  { e: '🎃', s: ['👻', '🍬', '🦇'], bg: ['#ffe0c2', '#f1e6ff'], cap: 'ハロウィンのおばけ', m: [10] },
  { e: '🌕', s: ['🐇', '🍡', '🌾'], bg: ['#2f3a66', '#59628f'], cap: 'お月見うさぎ', m: [9], dark: true },
  { e: '🍠', s: ['🔥', '🍂', '🐻'], bg: ['#ffe8d6', '#fff4ea'], cap: 'やきいもほかほか', m: [11, 12] },
  { e: '⛄', s: ['❄️', '🧣', '✨'], bg: ['#e6f3ff', '#ffffff'], cap: 'ゆきだるまくん', m: [12, 1, 2] },
  { e: '🐧', s: ['❄️', '🧊', '⭐'], bg: ['#dcefff', '#f5fbff'], cap: 'ペンギンのすべり台', m: [12, 1, 2] },
  { e: '🎄', s: ['🎁', '⭐', '🔔'], bg: ['#e4f7e8', '#fff1f1'], cap: 'クリスマスツリー', m: [12] },
  { e: '🎍', s: ['🌅', '🐉', '🍊'], bg: ['#fff1e0', '#ffe9ec'], cap: 'あけましておめでとう', m: [1] },
  { e: '👹', s: ['🫘', '🏠', '😊'], bg: ['#ffe8e0', '#fff7e6'], cap: '節分の豆まき', m: [2] },
  { e: '🍫', s: ['💝', '🌷', '✨'], bg: ['#ffe3ec', '#fff2e6'], cap: 'チョコレートの日', m: [2] },
  { e: '🎎', s: ['🌸', '🍡', '🍑'], bg: ['#ffe9f2', '#fff8fb'], cap: 'ひなまつり', m: [3] },
  { e: '🐱', s: ['🧶', '🐟', '💤'], bg: ['#fff0e6', '#fffaf5'], cap: 'ねこのおひるね' },
  { e: '🐶', s: ['🦴', '🎾', '💕'], bg: ['#fff3e0', '#fffaf2'], cap: 'こいぬとボールあそび' },
  { e: '🐼', s: ['🎋', '🍙', '💤'], bg: ['#eefae8', '#ffffff'], cap: 'パンダのもぐもぐタイム' },
  { e: '🦄', s: ['🌈', '✨', '⭐'], bg: ['#f1e6ff', '#ffe9f4'], cap: 'ゆめのユニコーン' },
  { e: '🐨', s: ['🌿', '🌙', '💤'], bg: ['#e9f6ef', '#f8fff9'], cap: 'コアラのおやすみ' },
  { e: '🐹', s: ['🌻', '🥜', '🏠'], bg: ['#fff4d6', '#fffbee'], cap: 'ハムスターのおうち' },
  { e: '🐻', s: ['🍯', '🐝', '🌼'], bg: ['#fff1d2', '#fff9ec'], cap: 'くまさんとはちみつ' },
  { e: '🐢', s: ['🏝️', '🌴', '🌊'], bg: ['#dff6ff', '#f4fff0'], cap: 'かめさんの島めぐり' },
  { e: '🦒', s: ['🌳', '☁️', '🌞'], bg: ['#fff4dc', '#eefaff'], cap: 'きりんのせのび' },
  { e: '🐙', s: ['🫧', '🐠', '🐚'], bg: ['#dcefff', '#eafaff'], cap: 'たこさんの海のそこ' },
  { e: '🦉', s: ['🌙', '📚', '⭐'], bg: ['#2f3561', '#555d93'], cap: 'ふくろう先生の夜の勉強', dark: true },
  { e: '🚀', s: ['🪐', '⭐', '🌍'], bg: ['#1f2450', '#3f4a8a'], cap: '宇宙へ出発！', dark: true },
  { e: '🏯', s: ['🌸', '🗻', '☁️'], bg: ['#eaf3ff', '#fff4f7'], cap: 'お城と富士山' },
  { e: '🚂', s: ['🌄', '💨', '🌲'], bg: ['#fff1e0', '#eef8ff'], cap: '汽車で旅に出よう' },
  { e: '🧁', s: ['🍓', '🍰', '🎀'], bg: ['#ffe8f0', '#fff8fb'], cap: 'おやつのカップケーキ' },
  { e: '🌈', s: ['☁️', '🐤', '✨'], bg: ['#eaf6ff', '#fff6fb'], cap: '雨上がりのにじ' },
  { e: '🐝', s: ['🌼', '🌸', '🍯'], bg: ['#fff8d4', '#f2ffe6'], cap: 'みつばちのお仕事' },
  { e: '🦔', s: ['🍄', '🍎', '🍂'], bg: ['#f8ecdf', '#fffaf3'], cap: 'はりねずみのお散歩' },
  { e: '🐳', s: ['💦', '🌊', '⛵'], bg: ['#d9efff', '#effaff'], cap: 'くじらの潮ふき' },
];

/** 今日の絵：季節に合うものを優先して、日ごとに順番にかわる */
export function sceneFor(day, month) {
  const pool = SCENES.filter((x) => !x.m || x.m.includes(month));
  const k = ((day * 13) % pool.length + pool.length) % pool.length;
  return pool[k];
}

export function sceneHtml(sc, msg = '') {
  return `<section class="daily-art ${sc.dark ? 'dark' : ''}" style="background:linear-gradient(160deg, ${sc.bg[0]}, ${sc.bg[1]})">
    <div class="da-pic"><span class="da-s s1">${sc.s[0]}</span><span class="da-main">${sc.e}</span><span class="da-s s2">${sc.s[1]}</span><span class="da-s s3">${sc.s[2]}</span></div>
    <div class="da-body"><div class="da-cap">きょうの絵：${sc.cap}</div>${msg ? `<div class="da-msg">💌 ${msg}</div>` : ''}</div></section>`;
}
