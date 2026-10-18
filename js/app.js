import { GRADES, dayIndex, dayToISO, previewLabel, buildQueue, cardStatus, isDue } from './srs.js';
import { Store } from './store.js';
import { computeStats } from './stats.js';
import { selectReviewCards, isWeak } from './review.js';
import { check, redoPlan, applyRedo, autoGrade, isGradable, readingOf, isKanji, writeTarget, normalize } from './grade.js';
import { HandPad, isTablet } from './handwriting.js';
import { availableEngine, recognize, warmAI } from './recognize.js';
import { computeGame, streakInfo, stickerBalance, monthCells, badgeList, ringSvg, confetti, stickerFor, XP, COMBO_BONUS, STUDY_MIN, STICKER_DAYS } from './game.js';
import { speak, speakFromTap, stopSpeak, canSpeak, canListen, listen, armSpeechGestures, onSpeechBlocked, speechPending } from './voice.js';
import { judgeOral, oralGrade } from './tutor.js';
import { sceneFor, sceneHtml } from './art.js';
import { writeChars, cellLayout, cellStates, MAX_CELLS } from './cells.js';
import { localMessage, aiMessage } from './dailymsg.js';
import { CloudSync, loadFirebase, signInGoogle, signOut, loadContent, roleOf } from './cloud.js';
import { appCheckSiteKey } from './firebase-config.js';

const $app = document.getElementById('app');
const store = new Store();
const cloud = new CloudSync(store);
let DECKS = [];
let session = null;
let unwatch = null;
let reviewSel = null;
let USER = null;      // ログインしている人
let ROLE = null;      // 'learner'（まなとして勉強）| 'parent'（見るだけ）
let CONTENT = null;   // Firestore から読んだカード
// 読み上げの速さは「ふつう(1)」「はやい(1.2)」の2つだけ（前の「ゆっくり(0.8)」などは「ふつう」にする）
// 声で回答する（設定。はじめは ON）。OFF なら声を聞かず、自分で答え合わせにする
const voiceOn = () => store.settings.voiceAnswer !== false;
const ttsRate = () => (Number(store.settings.ttsRate) === 1.2 ? 1.2 : 1);
const isParentRole = () => ROLE === 'parent';
// 確認モード：記録しない（父・ママがカードを試すとき）。ママ（見るだけ）はいつも確認モード
const isAdult = () => isParentRole() || ((CONTENT?.manifest?.adults) || []).map((e) => String(e).toLowerCase()).includes(String(USER?.email || '').toLowerCase());
const confirmMode = () => isParentRole() || !!store.settings.confirm;
const confirmBanner = () => confirmMode() ? `<div class="confirm-banner">🔍 確認モード（記録しないよ）${isParentRole() ? '' : '<button class="btn soft mini" id="confirmOff">やめる</button>'}</div>` : '';
function bindConfirmOff() { const b = document.getElementById('confirmOff'); if (b) b.onclick = () => { store.setSetting('confirm', false); toast('確認モードをやめたよ。ここからは記録するね'); route(); }; }
const goal = () => store.settings.goal || 20;
let GAME_CACHE = null;
function game() {
  const key = store.data.reviews.length + ':' + dayIndex() + ':' + goal();
  if (GAME_CACHE && GAME_CACHE.key === key) return GAME_CACHE.g;
  const st = DECKS.length ? stats() : { units: [] };
  const mu = (st.units || []).filter((u) => u.total && u.mastered === u.total);
  const g = computeGame(store.data.reviews, { goal: goal(), masteredUnits: mu.map((u) => `${u.deck}-${u.kai}`), unitNames: Object.fromEntries(mu.map((u) => [`${u.deck}-${u.kai}`, `${u.deckName} 第${u.kai}回`])) });
  GAME_CACHE = { key, g };
  return g;
}
let REWARDS = { items: {}, spends: [], err: null, ready: false };
let unwatchRewards = null;
function startRewardsWatch() {
  if (unwatchRewards) return;
  cloud.watchRewards((r) => { REWARDS = { ...r, err: null, ready: true }; if (/^#\/(rewards|$)|^#?$/.test(location.hash || '#/') || location.hash === '#/rewards') refreshRewardsView(); },
    (e) => { REWARDS = { ...REWARDS, err: e, ready: true }; refreshRewardsView(); })
    .then((u) => { unwatchRewards = u; }).catch((e) => { REWARDS = { ...REWARDS, err: e, ready: true }; });
}
function refreshRewardsView() { const box = document.getElementById('rewardsBox'); if (box) box.innerHTML = rewardsHtml(); bindRewards(); }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const $ = (sel) => $app.querySelector(sel);

// ---------- データ ----------

// 科目の見た目のきほん（デッキ一覧に emoji/color/name が無いときに使う。新しい科目もそのまま出せる）
const DECK_DEFAULTS = {
  shakai: { name: '社会', emoji: '🗾', color: '#ffb86b' }, rika: { name: '理科', emoji: '🔬', color: '#7cc8ff' },
  yoji: { name: '四字熟語', emoji: '🀄', color: '#c9a0ff' },
  'kokugo-chishiki': { name: '国語知識', emoji: '📖', color: '#ff9fc4' }, kanji: { name: '漢字', emoji: '✏️', color: '#8fd99b' },
};
async function loadDecks() {
  CONTENT = await loadContent();
  const m = CONTENT.manifest;
  DECKS = m.decks.map((d0) => {
    const d = { emoji: '📚', color: '#9fb7ff', name: d0.id, ...(DECK_DEFAULTS[d0.id] || {}), ...d0, units: d0.units || [] };
    const units = d.units.map((u) => ({ ...u, cards: (CONTENT.units[u.doc] || {}).cards || [], latest: !d.latest || d.latest.includes(u.kai) }));
    const cur = units.filter((u) => u.latest);
    return { ...d, units, cards: cur.flatMap((u) => u.cards), allCards: units.flatMap((u) => u.cards) };
  });
  applyRanges();
}
// ---------- はんい（社会・理科：どの回をやるか。いくつでも。教科ごとに覚えて、ほかの端末ともそろえる） ----------
const RANGE_DECKS = ['shakai', 'rika'];
const hasRange = (d) => RANGE_DECKS.includes(d.id) && d.units.filter((u) => u.kai != null).length > 1;
/** えらんだ回（なければ、いままでどおり「さいしん」の回） */
function rangeKais(d) {
  const valid = d.units.map((u) => u.kai);
  const saved = ((store.data.sel || {})[d.id]?.k || []).filter((k) => valid.includes(k));
  return saved.length ? saved : d.units.filter((u) => u.latest).map((u) => u.kai);
}
function applyRanges() {
  for (const d of DECKS) {
    if (!hasRange(d)) { d.units.forEach((u) => { u.sel = u.latest; }); continue; }
    const ks = rangeKais(d);
    d.units.forEach((u) => { u.sel = ks.includes(u.kai); });
    d.cards = d.units.filter((u) => u.sel).flatMap((u) => u.cards);
  }
  GAME_CACHE = null;
}
/** 「第24回 自由民権運動」「第23・24回」 */
function rangeText(d) {
  const us = d.units.filter((u) => u.sel && u.kai != null).sort((a, b) => a.kai - b.kai);
  if (!us.length) return '';
  if (us.length === 1) return `第${us[0].kai}回 ${us[0].name || ''}`.trim();
  return `第${us.map((u) => u.kai).join('・')}回`;
}
/** 記録に残す「はんい」の言葉：カードの回から作る（例：社会 第24回・理科 第23・25回） */
function itemsRangeLabel(items) {
  const by = new Map();
  for (const { card, deck } of items) { if (!by.has(deck.id)) by.set(deck.id, { deck, k: new Set() }); if (card.kai != null) by.get(deck.id).k.add(card.kai); }
  return [...by.values()].map(({ deck, k }) => `${deck.name}${k.size ? ' 第' + [...k].sort((a, b) => a - b).join('・') + '回' : ''}`).join('・');
}
const deckById = (id) => DECKS.find((d) => d.id === id);
function tagsOf(deck) {
  const out = [];
  for (const c of deck.cards) for (const t of c.tags || []) if (/^第\d+回$/.test(t) && !out.includes(t)) out.push(t);
  return out;
}
const unitOf = (deck, tag) => { const c = deck.cards.find((c) => c.tags.includes(tag)); return c ? c.tags.find((t) => t !== tag) || '' : ''; };
const filterCards = (deck, tag) => (tag ? deck.cards.filter((c) => c.tags.includes(tag)) : deck.cards);
const stats = () => computeStats(DECKS, store.statsSource());

function counts(cards, today) {
  let due = 0, fresh = 0, mastered = 0;
  for (const c of cards) {
    const s = store.state(c.id);
    if (isDue(s, today)) due++;
    const st = cardStatus(s);
    if (st === 'new') fresh++;
    if (st === 'mastered') mastered++;
  }
  return { due, fresh, mastered, total: cards.length };
}

/** 漢字で書く答えのカード（手書きを OFF にしていなければ、スマホでも手書きにする） */
const writeDefault = (card) => !!card.w || (card.input === 'write') || (isGradable(card) && [...normalize(String(writeTarget(card)).replace(/[（(][^）)]*[）)]/g, ''))].some(isKanji));
const hwOn = () => store.settings.handwriting === 'on' || (store.settings.handwriting === 'auto' && isTablet());

function greeting() {
  const h = new Date().getHours();
  const name = store.settings.nickname ? esc(store.settings.nickname) + '、' : '';
  if (h < 10) return `おはよう、${name}きょうもがんばろう！`;
  if (h < 17) return `こんにちは、${name}すこしずつ覚えよう♪`;
  return `こんばんは、${name}ねる前の復習はきくよ！`;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- ホーム・デッキ ----------

function viewHome() {
  const today = dayIndex();
  const st = stats();
  let totalDue = 0, totalNew = 0;
  const deckHtml = DECKS.map((d) => {
    const c = counts(d.cards, today);
    const nNew = Math.min(c.fresh, store.newLeft(d.id, today));
    totalDue += c.due; totalNew += nNew;
    const pct = Math.round((c.mastered / Math.max(1, c.total)) * 100);
    const cur = hasRange(d) ? esc(rangeText(d)) : d.units.filter((u) => u.latest && u.kai != null).map((u) => `第${u.kai}回 ${esc(u.name)}`).join('・');
    return `<a class="deck" href="#/deck/${d.id}" style="--c:${d.color}">
      <div class="deck-emoji">${d.emoji}</div>
      <div class="deck-body">
        <div class="deck-name">${esc(d.name)} <small>${cur || ''} ${c.total}まい</small></div>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div class="deck-meta">今日の学習 <b>${c.due}</b>・新しい <b>${nNew}</b>・覚えた ${c.mastered}</div>
      </div><div class="chev">›</div></a>`;
  }).join('');
  const todo = totalDue + totalNew;
  $app.innerHTML = `
    ${confirmBanner()}
    <header class="hero">
      <div class="mascot">🐰</div>
      <p class="greet">${greeting()}</p>
    </header>
    <div id="dailyArt">${dailyArtHtml()}</div>
    ${gameHeaderHtml(game(), store.derived.daily)}
    ${resumeHtml()}
    <div class="home-grid">
    <section class="today">
      <div class="today-num">${todo}<small>まい</small></div>
      <div class="today-label">今日の学習</div>
      ${todo ? `<a class="btn big primary" href="#/study/all">🌸 今日の学習をはじめる</a>`
             : `<p class="done-msg">今日の分はおわり！えらい！✨</p>`}
      <a class="btn big soft" href="#/review">📝 テスト前見直し</a>
      ${(() => { const n = mistakeCards().length; return n ? `<a class="btn big soft" href="#/mistakes" id="homeMistakes">🔁 まちがい復習（${n}まい）</a>` : ''; })()}
      ${confirmMode() ? '' : '<button class="btn soft mini" id="confirmOn">🔍 確認モード（記録しないで試す・パパ／ママ用）</button>'}
    </section>
    <section>
    <h2 class="sec">デッキ</h2>
    <div class="decks">${deckHtml}</div>
    </section></div>
    ${nav('home')}`;
  bindConfirmOff();
  bindResume();
  ensureDailyMsg();
  const on = document.getElementById('confirmOn');
  if (on) on.onclick = () => { if (confirm('確認モードにしますか？\n（まなが勉強するときは、かならず「やめる」を押してね）')) { store.setSetting('confirm', true); route(); } };
}

// ---------- 今日の絵・ひとこと ----------
function msgCtx() {
  const today = dayIndex(), daily = store.derived.daily, y = daily[today - 1];
  const g = game(), si = streakInfo(daily, today);
  return { streak: si.streak, best: si.best, yN: y ? y.r : 0, yAcc: y && y.r ? Math.round((y.c / y.r) * 100) : null, level: g.level.lv, goal: g.goal, month: new Date().getMonth() + 1 };
}
function dailyArtHtml(text) {
  const today = dayIndex();
  const dm = store.data.dmsg && store.data.dmsg.day === today ? store.data.dmsg.text : null;
  const nick = esc(store.settings.nickname || '');
  const msg = esc(text || dm || localMessage(today, msgCtx())).replace(/きみ/g, nick || 'きみ');
  return sceneHtml(sceneFor(today, new Date().getMonth() + 1), msg);
}
let dmsgBusy = false;
async function ensureDailyMsg() {
  const today = dayIndex();
  if (dmsgBusy || isParentRole() || confirmMode() || (store.data.dmsg && store.data.dmsg.day === today)) return;
  dmsgBusy = true;
  try {
    await new Promise((r) => setTimeout(r, 3500)); // 先にクラウドを読む（ほかの端末が作っていればそれを使う）
    if (store.data.dmsg && store.data.dmsg.day === today) return;
    const eng = await availableEngine(store.settings);
    if (eng !== 'gemini') return;
    const text = await aiMessage(msgCtx());
    if (store.data.dmsg && store.data.dmsg.day === today) return;
    store.data.dmsg = { day: today, text, at: Date.now() };
    store.save(); cloud.schedule(300);
  } catch (e) { console.warn('dailymsg', e?.message); }
  finally {
    dmsgBusy = false;
    const box = document.getElementById('dailyArt'); if (box) box.innerHTML = dailyArtHtml();
  }
}

/** ホームの上：レベル・今日の目標・れんぞく・シール */
function gameHeaderHtml(g, daily) {
  const si = streakInfo(daily || {}, dayIndex());
  const lvPct = Math.round((g.level.cur / g.level.need) * 100);
  return `<section class="gamebar">
    <div class="gb-ring">${ringSvg(g.today, g.goal)}<span>今日の目標</span></div>
    <div class="gb-main">
      <div class="gb-lv"><b>Lv.${g.level.lv}</b> <small>${g.level.cur}/${g.level.need} XP</small></div>
      <div class="bar xp"><span style="width:${lvPct}%"></span></div>
      <div class="gb-row">
        <a href="#/rewards" class="gb-chip">🔥 <b>${si.streak}</b>日れんぞく</a>
        <a href="#/rewards" class="gb-chip">🎁 シール <b>${si.progress}</b>/${STICKER_DAYS}日</a>
      </div>
    </div></section>`;
}

function viewDeck(id, tag = '') {
  const d = deckById(id);
  if (!d) return go('#/');
  const today = dayIndex();
  const tags = tagsOf(d);
  const cards = filterCards(d, tag);
  const c = counts(cards, today);
  const nNew = Math.min(c.fresh, store.newLeft(d.id, today));
  const chips = hasRange(d) && !isParentRole() ? rangePickerHtml(d, today) : tags.length > 1 ? `<div class="chips">
      <a class="chip ${tag ? '' : 'on'}" href="#/deck/${d.id}">ぜんぶ</a>
      ${tags.map((t) => `<a class="chip ${t === tag ? 'on' : ''}" href="#/deck/${d.id}/${encodeURIComponent(t)}">${esc(t)} ${esc(unitOf(d, t))}</a>`).join('')}
    </div>` : (tags.length ? `<p class="small">${esc(tags[0])} ${esc(unitOf(d, tags[0]))}（前の回は「テスト前見直し」で）</p>` : '');
  const grades = store.derived.lastGrades;
  const list = cards.map((card) => {
    const s = cardStatus(store.state(card.id));
    const mark = { new: '⚪', learning: '🟡', mastered: '🌟' }[s];
    const weak = isWeak(store.state(card.id), grades[card.id]) ? ' <span class="weak-badge">苦手</span>' : '';
    return `<details class="item"><summary>${mark} ${esc(card.q)}${weak}</summary><div class="ans"><b>${nl(card.a)}</b>${card.reading ? `<div class="reading">${esc(card.reading)}</div>` : ''}${card.note ? `<div class="note">💡 ${nl(card.note)}</div>` : ''}</div></details>`;
  }).join('');
  $app.innerHTML = `
    ${confirmBanner()}
    <header class="bar-top" style="--c:${d.color}"><a href="${isParentRole() ? '#/cards' : '#/'}" class="back">‹</a><h1>${d.emoji} ${esc(d.name)}</h1></header>
    ${(store.resumable?.d || []).includes(d.id) ? resumeHtml() : ''}
    ${chips}
    <section class="stat-row">
      <div><b>${c.due}</b><span>今日の学習</span></div>
      <div><b>${nNew}</b><span>今日の新しい</span></div>
      <div><b>${c.mastered}</b><span>覚えた</span></div>
      <div><b>${c.total}</b><span>ぜんぶ</span></div>
    </section>
    <div class="actions">
      ${c.due + nNew ? `<a class="btn big primary" href="#/study/${d.id}${tag ? '/' + encodeURIComponent(tag) : ''}">🌸 今日の学習（${c.due + nNew}まい）</a>`
                    : `<p class="done-msg">このデッキの今日の分はおわり！🎉</p>`}
      <a class="btn big soft" href="#/cram/${d.id}${tag ? '/' + encodeURIComponent(tag) : ''}">🔁 ぜんぶ練習</a>
      <p class="small">「ぜんぶ練習」と「テスト前見直し」は、復習の予定を変えずに記録だけ残します。</p>
    </div>
    <h2 class="sec">カード一覧 <small>⚪新しい 🟡学習中 🌟覚えた</small></h2>
    <div class="list">${list}</div>
    <p class="small src">${esc(d.source || '')}</p>
    ${nav(isParentRole() ? 'cards' : 'home')}`;
  bindConfirmOff();
  bindResume();
  bindRangePicker(d, tag);
}
function rangePickerHtml(d, today) {
  const units = d.units.filter((u) => u.kai != null).slice().sort((a, b) => b.kai - a.kai);
  const rows = units.map((u) => {
    const c = counts(u.cards, today);
    return `<button class="unit ${u.sel ? 'on' : ''}" data-rk="${u.kai}">
      <span class="check">${u.sel ? '✅' : '⬜'}</span>
      <span class="u-name">第${u.kai}回 ${esc(u.name)} ${u.latest ? '<span class="new-badge">さいしん</span>' : ''}</span>
      <span class="u-meta">${u.cards.length}まい・今日の学習 <b>${c.due}</b>・新しい ${c.fresh}</span></button>`;
  }).join('');
  return `<section class="rangebox"><h2 class="sec">📚 やる回をえらぶ <small>（いくつでも・今日の学習もここから）</small></h2>
    <div class="quick"><button class="btn soft mini" data-rq="latest">さいしんだけ</button><button class="btn soft mini" data-rq="all">ぜんぶの回</button></div>
    <div class="units" id="rangeUnits">${rows}</div>
    <p class="small">えらんだ回：<b id="rangeNow">${esc(rangeText(d))}</b>（つぎからも、この回で始まるよ）</p></section>`;
}
function bindRangePicker(d, tag) {
  if (!hasRange(d) || isParentRole()) return;
  const setK = (ks) => {
    if (!ks.length) { toast('1つはえらんでね'); return; }
    store.setRange(d.id, ks); applyRanges(); viewDeck(d.id, '');
  };
  $app.querySelectorAll('[data-rk]').forEach((b) => (b.onclick = () => {
    const k = +b.dataset.rk, cur = rangeKais(d);
    setK(cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]);
  }));
  $app.querySelectorAll('[data-rq]').forEach((b) => (b.onclick = () => setK(b.dataset.rq === 'all' ? d.units.filter((u) => u.kai != null).map((u) => u.kai) : d.units.filter((u) => u.latest).map((u) => u.kai))));
}

// ---------- テスト前見直し ----------

function viewReviewPicker() {
  const decks = DECKS;
  const sel = reviewSel || (reviewSel = { deck: decks[0].id, by: {}, mode: 'all' });
  if (!sel.by) sel.by = {};
  const d = deckById(sel.deck) || decks[0];
  const units = d.units.slice().sort((a, b) => (a.kai ?? 1e9) - (b.kai ?? 1e9));
  if (!sel.by[d.id]) sel.by[d.id] = units.filter((u) => u.latest).map((u) => u.kai);
  const grades = store.derived.lastGrades;
  // えらんだ回（教科をまたいで、いくつでも）
  const picked = decks.flatMap((x) => x.units.filter((u) => (sel.by[x.id] || []).includes(u.kai)).map((u) => ({ u, deck: x })));
  const cards = picked.flatMap(({ u, deck }) => u.cards.map((c) => ({ card: c, deck })));
  const weakN = cards.filter((x) => isWeak(store.state(x.card.id), grades[x.card.id])).length;
  const n = sel.mode === 'weak' ? weakN : cards.length;
  const cur = sel.by[d.id];
  const unitRows = units.map((u) => {
    const m = u.cards.filter((c) => cardStatus(store.state(c.id)) === 'mastered').length;
    const w = selectReviewCards(u.cards, store.data.states, grades, 'weak').length;
    const on = cur.includes(u.kai);
    return `<button class="unit ${on ? 'on' : ''}" data-kai="${u.kai}">
      <span class="check">${on ? '✅' : '⬜'}</span>
      <span class="u-name">${u.kai != null ? `第${u.kai}回 ` : ''}${esc(u.name)} ${u.latest && u.kai != null ? '<span class="new-badge">さいしん</span>' : ''}</span>
      <span class="u-meta">${u.cards.length}まい・🌟${m}・苦手 ${w}</span></button>`;
  }).join('');
  const kais = units.map((u) => u.kai).filter((k) => k != null);
  const rangeSel = kais.length > 2 ? `<div class="range">はんい：<select id="rFrom">${kais.map((k) => `<option ${k === kais[0] ? 'selected' : ''}>${k}</option>`).join('')}</select> 回 〜
      <select id="rTo">${kais.map((k) => `<option ${k === kais[kais.length - 1] ? 'selected' : ''}>${k}</option>`).join('')}</select> 回 <button class="btn soft mini" id="rApply">えらぶ</button></div>` : '';
  const cnt = (x) => (sel.by[x.id] || []).length;
  $app.innerHTML = `${confirmBanner()}
    <header class="bar-top"><h1>📝 見直し・過去の復習</h1></header>
    <a class="btn big mistake-btn" href="#/mistakes">🔁 まちがえた問題だけ復習する（${mistakeCards().length}まい）</a>
    <p class="small">えらんだ回（前の回も）のカードをまとめて見直せます。教科をまたいでえらべます。復習の予定は変わりません（記録は残ります）。</p>
    <div class="chips">${decks.map((x) => `<button class="chip ${x.id === d.id ? 'on' : ''}" data-deck="${x.id}">${x.emoji} ${esc(x.name)}${cnt(x) ? ` <b class="cnt">${cnt(x)}</b>` : ''}</button>`).join('')}</div>
    <h2 class="sec">${d.emoji} ${esc(d.name)}：回をえらぶ <small>（いくつでも・${units.length}回分）</small></h2>
    <div class="quick"><button class="btn soft mini" data-q="all">ぜんぶ</button><button class="btn soft mini" data-q="past">前の回だけ</button><button class="btn soft mini" data-q="latest">さいしんだけ</button><button class="btn soft mini" data-q="none">はずす</button></div>
    ${rangeSel}
    <div class="units">${unitRows}</div>
    <h2 class="sec">どれをやる？ <small>えらんだ回：${picked.length}回分</small></h2>
    <div class="seg">
      <button class="${sel.mode === 'all' ? 'on' : ''}" data-mode="all">ぜんぶ（${cards.length}）</button>
      <button class="${sel.mode === 'weak' ? 'on' : ''}" data-mode="weak">苦手だけ（${weakN}）</button>
    </div>
    <p class="small">苦手＝わすれたことがある・覚えにくい・最後に「わからない」「むずかしい」を押したカード</p>
    <button class="btn big primary" id="go" ${n ? '' : 'disabled'}>📝 ${n}まい 見直す</button>
    ${nav('review')}`;
  bindConfirmOff();
  const setKais = (k) => { sel.by[d.id] = k; viewReviewPicker(); };
  $app.querySelectorAll('[data-deck]').forEach((b) => (b.onclick = () => { sel.deck = b.dataset.deck; viewReviewPicker(); }));
  $app.querySelectorAll('[data-kai]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.kai === 'null' ? null : +b.dataset.kai;
    setKais(cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]);
  }));
  $app.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
    const q = b.dataset.q;
    setKais(q === 'all' ? units.map((u) => u.kai) : q === 'past' ? units.filter((u) => !u.latest).map((u) => u.kai) : q === 'latest' ? units.filter((u) => u.latest).map((u) => u.kai) : []);
  }));
  const ra = document.getElementById('rApply');
  if (ra) ra.onclick = () => { const a = +$('#rFrom').value, z = +$('#rTo').value; const lo = Math.min(a, z), hi = Math.max(a, z); setKais(units.filter((u) => u.kai != null && u.kai >= lo && u.kai <= hi).map((u) => u.kai)); };
  $app.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { sel.mode = b.dataset.mode; viewReviewPicker(); }));
  $('#go').onclick = () => {
    const list = sel.mode === 'weak' ? cards.filter((x) => isWeak(store.state(x.card.id), grades[x.card.id])) : cards.slice();
    startWith(shuffle(list), 'review', '#/review');
  };
}

// ---------- まちがえた問題の復習 ----------
let mistakeDeck = '';
/** まちがえたことがある・最後にまちがえた・覚えにくいカード（いまの回も前の回も、教科をまたいで） */
function mistakeCards(deckId = '') {
  const grades = store.derived.lastGrades;
  return DECKS.filter((d) => !deckId || d.id === deckId).flatMap((d) => d.allCards.filter((c) => isWeak(store.state(c.id), grades[c.id])).map((c) => ({ card: c, deck: d })));
}
function viewMistakes() {
  const all = mistakeCards();
  const list = mistakeCards(mistakeDeck);
  const byDeck = (id) => all.filter((x) => x.deck.id === id).length;
  $app.innerHTML = `${confirmBanner()}
    <header class="bar-top"><a href="#/review" class="back">‹</a><h1>🔁 まちがえた問題</h1></header>
    <p class="small">わすれたことがある・最後に「わからない」「むずかしい」を押した・覚えにくいカードです。「わかった」になるまで、何回でも出てくるよ。</p>
    <div class="chips"><button class="chip ${mistakeDeck ? '' : 'on'}" data-md="">ぜんぶ（${all.length}）</button>
      ${DECKS.map((d) => `<button class="chip ${mistakeDeck === d.id ? 'on' : ''}" data-md="${d.id}">${d.emoji} ${esc(d.name)}（${byDeck(d.id)}）</button>`).join('')}</div>
    ${list.length ? `<button class="btn big primary" id="goM">🔁 ${list.length}まい 復習する</button>` : '<p class="done-msg">まちがえた問題はないよ！すごい！🎉</p>'}
    <div class="list">${list.slice(0, 80).map((x) => `<div class="item">${x.deck.emoji} ${esc(x.card.q)}</div>`).join('')}</div>
    ${nav('review')}`;
  bindConfirmOff();
  $app.querySelectorAll('[data-md]').forEach((b) => (b.onclick = () => { mistakeDeck = b.dataset.md; viewMistakes(); }));
  const g = document.getElementById('goM'); if (g) g.onclick = () => startWith(shuffle(list.slice()), 'mistake', '#/mistakes');
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------- 勉強画面 ----------

function startSession(deckIds, tag, cram) {
  const today = dayIndex();
  let items = [];
  if (cram) {
    items = shuffle(filterCards(deckById(deckIds[0]), tag).map((c) => ({ card: c, deck: deckById(deckIds[0]) })));
  } else {
    const queues = deckIds.map((id) => {
      const d = deckById(id);
      return buildQueue(filterCards(d, tag), store.data.states, today, store.newLeft(id, today)).map((c) => ({ card: c, deck: d }));
    });
    let k = 0;
    while (queues.some((q) => q.length)) { const q = queues[k++ % queues.length]; if (q.length) items.push(q.shift()); }
  }
  const back = deckIds.length === 1 ? `#/deck/${deckIds[0]}` : '#/';
  if (!items.length) return go(back);
  startWith(items, cram ? 'cram' : 'study', back);
}

// テスト用（localhost だけ）：今の勉強の様子を見る・決まったカードで始める
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.__anki = {
    session: () => session,
    store: () => store,
    sync: () => cloud.sync(),
    start: (ids) => { const items = ids.map((id) => { for (const d of DECKS) { const c = d.allCards.find((x) => x.id === id); if (c) return { card: c, deck: d }; } return null; }).filter(Boolean); startWith(items, 'review', '#/'); },
  };
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const KIND_LABEL = { study: '今日の学習', cram: 'ぜんぶ練習', review: '見直し', mistake: 'まちがい復習' };
function startWith(items, kind, back, resume = null) {
  const cm = confirmMode();
  // とちゅうの勉強があるのに新しく始めるときは、たしかめる（確認モードはとちゅうの勉強を変えない）
  const old = store.resumable;
  if (!resume && !cm && old && old.i > 0) {
    if (!confirm(`とちゅうの勉強（${old.rg || KIND_LABEL[old.k] || ''}・${old.i}/${old.ids.length}まい）があるよ。\nそれをやめて、新しくはじめる？`)) return go('#/');
    store.setInprog(null); cloud.schedule(1500);
  }
  const rg = resume?.rg || itemsRangeLabel(items);
  const deckIds = [...new Set(items.map((x) => x.deck.id))];
  session = { items, i: 0, kind, done: 0, again: 0, total: items.length, back, engine: null, combo: 0, xp: 0, confirm: cm, game0: cm ? null : game(),
    sid: resume?.id || newId(), rg, deckIds, started: resume?.start || Date.now(),
    sit: { id: newId(), s: Date.now(), d: deckIds, rg, k: kind, rs: !!resume } };
  if (resume) Object.assign(session, { i: resume.i, done: resume.done || 0, again: resume.again || 0, combo: resume.combo || 0, xp: resume.xp || 0, total: resume.total || items.length });
  availableEngine(store.settings).then((e) => { if (session) { session.engine = e; if (e === 'gemini') warmAI(); if (session.phase === 'q') renderBottom(); } });
  renderCard();
}

const logMode = () => (session.kind === 'study' ? 's' : 'r');

function renderCard() {
  const s = session;
  if (!s) return go('#/');
  stopMedia(s);
  if (s.pad) { s.pad.destroy(); s.pad = null; }
  if (s.i >= s.items.length) return renderDone();
  const { card, deck } = s.items[s.i];
  // 「書いて答える」カード（四字熟語など）は、手書きを OFF にしていない限り、スマホでも手書きにする
  const oral = card.answerMode === 'oral';
  const hw = !oral && (card.answerMode === 'write' ? store.settings.handwriting !== 'off' : (hwOn() || (writeDefault(card) && store.settings.handwriting !== 'off')));
  stopSpeak();
  s.phase = 'q'; s.hint = false; s.cur = { start: Date.now(), plan: null, miss: new Set(), tries: 0, recog: '', result: null, fixed: false, sugg: null, img: null, override: false, oral, said: '', judge: null, ver: 0, spec: null };
  const left = s.items.length - s.i;
  const pct = Math.round((s.done / Math.max(1, s.done + left)) * 100);
  const writeMode = hw && !!card.w;
  s.cur.writeMode = writeMode;
  $app.innerHTML = `
    <div class="study ${hw ? 'with-pad' : ''}">
    <header class="study-top" style="--c:${deck.color}">
      <a href="${s.back}" class="back">✕</a>
      <div class="pbar"><span style="width:${pct}%"></span></div>
      <div class="left">のこり ${left}</div>
      <div class="combo" id="combo">${s.combo >= 2 ? `🔥${s.combo}<small>コンボ</small>` : ''}</div>
    </header>
    ${s.confirm ? '<div class="confirm-banner slim">🔍 確認モード（記録しないよ）</div>' : ''}
    <div class="study-grid">
      <main class="card-wrap"><div class="card" id="card" style="--c:${deck.color}"></div></main>
      ${hw ? '<section class="pad" id="pad"></section>' : ''}
    </div>
    <footer class="study-bottom" id="bottom"></footer>
    </div>`;
  if (hw) {
    // マスの数は答えの字数（cells.js の writeChars）。答えの画面も同じ数・同じ並びで出す
    const chars = gridChars(card);
    s.cur.chars = chars;
    const cells = writeMode ? chars.length : null;
    s.pad = new HandPad($('#pad'), {
      dir: store.settings.hwDir || 'h', masu: writeMode || !!store.settings.hwMasu, cells, answerCells: writeMode ? null : (chars ? chars.length : null),
      onChange: (what) => {
        if (what === 'dir') store.setSetting('hwDir', s.pad.dir);
        if (what === 'masu') store.setSetting('hwMasu', s.pad.masu);
        s.cur.ver++; scheduleSpec();
      },
    });
  }
  renderFace();
  renderBottom();
  // 社会・理科は、カードが出たら問題を読み上げる（1枚ずつ。前の読み上げは stopMedia で止めてある）
  if (autoReadDeck(deck.id)) speak(questionText(card, s.cur), { rate: ttsRate() });
}
/** 自動で読み上げる教科：社会・理科だけ（せっていで自動の読み上げを ON にしたとき） */
const AUTO_READ_DECKS = ['shakai', 'rika'];
function autoReadDeck(deckId) { return AUTO_READ_DECKS.includes(deckId) && ttsAutoOn(); }
/** 自動の読み上げ：せっていで「ON」にしたときだけ（はじめは OFF。「🎤 声で回答する」とは別） */
function ttsAutoOn() { return store.settings.ttsAuto === true; }
/** 読み上げる問題文（答えは読まない。書くカードは wq） */
function questionText(card, c) { return c && c.writeMode && card.wq ? card.wq : card.q; }

function renderFace() {
  const s = session, c = s.cur;
  const { card, deck } = s.items[s.i];
  const isNew = cardStatus(store.state(card.id)) === 'new';
  const yoji = deck.id === 'yoji';
  const tagLine = (card.tags || []).filter((t) => t !== '四字熟語').join('・');
  const badge = s.kind === 'study' ? (isNew ? '<span class="new-badge">NEW</span>' : '') : `<span class="cram-badge">${s.kind === 'review' ? '見直し' : s.kind === 'mistake' ? 'まちがえた問題' : '練習'}</span>`;
  let q;
  const big = yoji && !card.qsub; // 以前の形（熟語を見て意味を答える）だけ大きく表示
  const sub = card.qsub || (big ? '読みと意味は？' : '');
  if (c.writeMode) q = `<div class="q">${nl(card.wq)}</div>${card.qsub && s.phase === 'q' ? `<div class="q-sub">${esc(card.qsub)}</div>` : ''}${s.hint ? `<div class="hint">💭 ${nl(card.whint)}</div>` : ''}`;
  else q = `<div class="q ${big ? 'yoji' : ''}">${nl(card.q)}</div>${sub && s.phase === 'q' ? `<div class="q-sub">${esc(sub)}</div>` : ''}${s.hint && card.hint ? `<div class="hint">💭 ${nl(card.hint)}</div>` : ''}`;
  if (canSpeak()) q = `<button class="speak ${speechPending() && ttsAutoOn() ? 'needs-tap' : ''}" id="speakBtn" aria-label="読み上げ">🔊</button>` + q;
  let body = '';
  if (s.phase === 'checking') body = checkingHtml();
  if (c.oral && (s.phase === 'listening' || s.phase === 'judging' || s.phase === 'q') && c.said) body = `<div class="said">🎤 <span>${esc(c.said)}</span></div>`;
  if (s.phase === 'listening') body += '<div class="checking">👂 きいてるよ…話しおわったら「おわり」を押してね</div>';
  if (s.phase === 'judging') body += '<div class="checking">🐰 先生が考え中…</div>';
  if (s.phase === 'oral') body = oralResultHtml();
  if (s.phase === 'oralwrite' || s.phase === 'oralwritten') body = oralWriteHtml();
  if (s.phase === 'result' || s.phase === 'redo' || s.phase === 'answer') body = resultHtml();
  $('#card').innerHTML = `<div class="card-tags">${deck.emoji} ${esc(deck.name)}${tagLine ? '・' + esc(tagLine) : ''} ${badge}${c.oral ? (voiceOn() ? ' <span class="oral-badge">🎤 声で答える</span>' : ' <span class="oral-badge">🗣️ 答えを言ってから「こたえを見る」</span>') : ''}</div>${q}${body}`;
  const sb = document.getElementById('speakBtn');
  if (sb) sb.onclick = () => speakFromTap(questionText(card, c), { rate: ttsRate() }); // タップの中ですぐ読む（iPad）
}

function oralResultHtml() {
  const s = session, c = s.cur;
  const { card } = s.items[s.i];
  const j = c.judge;
  const head = j ? { good: '⭕ よく言えたね！', partial: '🔺 おしい！あと少し', miss: '🙈 ちがうみたい' }[j.result] : '📖 こたえ';
  return `<div class="a">
    ${c.said ? `<div class="said">🎤 <span>${esc(c.said)}</span></div>` : ''}
    <div class="verdict ${j ? (j.result === 'good' ? 'ok' : j.result === 'miss' ? 'ng' : 'redo') : ''}">${head}</div>
    ${j ? `<div class="tutor">🐰 ${esc(j.comment)}${j.praise ? `<div class="t-good">👍 ${esc(j.praise)}</div>` : ''}${j.missing ? `<div class="t-miss">💡 ${esc(j.missing)}</div>` : ''}</div>` : ''}
    <div class="a-box">${answerHtml(card)}</div></div>`;
}
function oralWriteHtml() {
  const s = session, c = s.cur;
  const t = c.judge.term;
  const r = c.termResult;
  return `<div class="a"><div class="verdict redo">✍️ 「${esc(readingFor(t, s.items[s.i].card))}」を漢字で書いてみよう（${[...t].length}字）</div>
    ${r ? (r.correct ? `<div class="verdict ok">⭕ 書けたね！ <span class="a-main">${esc(t)}</span></div>` : `<div class="recog">よみとり：<span class="chars">${diffHtml(r)}</span></div><div class="a-main">${esc(t)}</div>`) : ''}</div>`;
}
/** 用語の読み（答えの「用語（よみ）」から取れれば読みを出す。なければ「この言葉」） */
function readingFor(term, card) {
  const m = String(card.a).match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[（(]([ぁ-んー・]+)[）)]'));
  return m ? m[1] : (card.reading && card.a.startsWith(term) ? card.reading : 'この言葉');
}

/** マス目にする答えの字（自動で答え合わせできて、MAX_CELLS 字以下のときだけ） */
function gridChars(card) {
  if (!(card.w || isGradable(card))) return null;
  const ch = writeChars(card);
  return ch.length && ch.length <= MAX_CELLS ? ch : null;
}
/** 手書き欄と同じ並び（1行のマス数・行の数）。手書き欄がマス目でなくても、同じ大きさで並べたときの形にする */
function padLayout(n) {
  const p = session.pad;
  if (p && p.w) { const L = p.cellCount() === n ? p.layout() : null; return L || cellLayout(n, p.w, p.h, p.dir); }
  return cellLayout(n, 600, 400, store.settings.hwDir || 'h');
}
/** 答えのマス（手書き欄と同じ並び）。states: cellStates の cells */
function answerGridHtml(cells, L, { numbered = null, hideWrong = false } = {}) {
  const fit = L.dir === 'v' ? L.lines : L.per;
  const cs = Math.max(30, Math.min(52, Math.floor((Math.min(innerWidth, 900) - 72) / fit) - 6));
  let k = 0;
  return `<div class="agrid ${L.dir === 'v' ? 'v' : ''}" style="--per:${L.per};--cs:${cs}px">${cells.map((c, i) => numbered && numbered.has(i)
    ? `<span class="cell blank">${++k}</span>`
    : hideWrong && (c.st === 'bad' || c.st === 'miss')
      // なおす前は正しい字を見せない（書いた字＝よみとった字 か ？ を出す）
      ? `<span class="cell ${c.st}"><b>${esc(c.st === 'bad' && c.g ? c.g : '？')}</b></span>`
      : `<span class="cell ${c.st}"><b>${esc(c.e)}</b>${c.st === 'bad' && c.g ? `<small>${esc(c.g)}</small>` : ''}</span>`).join('')}</div>`;
}
/** 今のカードの答えマス（結果があれば色つき） */
function resultGridHtml(opts = {}) {
  const c = session.cur;
  const chars = c.chars;
  if (!chars) return '';
  const { cells, extra } = cellStates(c.result && !c.fixed && !c.override ? c.result : null, chars);
  const L = padLayout(cells.length);
  const shown = cells.map((x) => (x.st === 'none' || c.fixed || c.override ? { ...x, st: 'ok' } : x));
  const hideWrong = !c.fixed && !c.override && (session.phase === 'result' || session.phase === 'redo'); // 「こたえを見る」までは正しい字を見せない
  return answerGridHtml(shown, L, { hideWrong, ...opts }) + (extra.length && !opts.numbered ? `<div class="small">よぶんな字：<span class="chars">${extra.map((g) => `<span class="ch extra">${esc(g)}</span>`).join('')}</span></div>` : '');
}

/** 答え合わせ中の画面：すぐに出す（自分の字と、手書き欄と同じ並びの空のマス）。AIの結果はあとからうめる */
function checkingHtml() {
  const c = session.cur;
  const mine = c.img ? `<figure class="mine"><img src="${c.img}" alt="自分の答え"><figcaption>自分の答え</figcaption></figure>` : '';
  const grid = c.chars ? answerGridHtml(c.chars.map(() => ({ e: '', st: 'wait' })), padLayout(c.chars.length)).replace('class="agrid', 'class="agrid pending') : '';
  return `<div class="a"><div class="checking">🔍 よみとり中…</div>${grid}${mine ? `<div class="a-row">${mine}</div>` : ''}</div>`;
}

function answerHtml(card) {
  const c = session.cur;
  const meaning = card.m || (card.a !== card.w ? card.a : '');
  const main = (c.writeMode || (card.w && card.a === card.w))
    ? `<div class="a-main big">${esc(card.w)}</div><div class="reading">${esc(card.reading)}</div>${meaning ? `<div class="a-sub">${nl(meaning)}</div>` : ''}`
    : `${card.reading ? `<div class="reading">${esc(card.reading)}</div>` : ''}<div class="a-main">${nl(card.a)}</div>`;
  return `${main}${card.note ? `<div class="note">💡 ${nl(card.note)}</div>` : ''}`;
}

function diffHtml(res) {
  if (!res) return '';
  return res.ops.map((o) => o.t === 'ok' ? `<span class="ch ok">${esc(o.g)}</span>`
    : o.t === 'sub' ? `<span class="ch bad">${esc(o.g)}</span>`
    : o.t === 'ins' ? `<span class="ch extra">${esc(o.g)}</span>`
    : `<span class="ch miss">？</span>`).join('');
}

function maskHtml(plan) {
  const blanks = new Set(plan.blanks);
  let k = 0;
  return plan.chars.map((ch, i) => blanks.has(i) ? `<span class="ch blank">${++k}</span>` : `<span class="ch ok">${esc(ch)}</span>`).join('');
}

function resultHtml() {
  const s = session, c = s.cur;
  const { card } = s.items[s.i];
  const mine = c.img ? `<figure class="mine"><img src="${c.img}" alt="自分の答え"><figcaption>自分の答え</figcaption></figure>` : '';
  if (s.phase === 'answer') {
    return `<div class="a">${c.chars ? resultGridHtml() : c.result && !c.result.correct ? `<div class="recog">よみとり：<span class="chars">${diffHtml(c.result)}</span></div>` : ''}
      <div class="a-row">${mine}<div class="a-box">${answerHtml(card)}</div></div></div>`;
  }
  if (s.phase === 'redo') {
    const p = c.plan;
    const hint = readingOf(card);
    return `<div class="a"><div class="verdict redo">✏️ ${p.tries ? 'あと少し！' : ''}${p.blanks.length}文字だけ、もう一度書いてみよう</div>
      ${c.chars && p.chars.length === c.chars.length ? resultGridHtml({ numbered: new Set(p.blanks) }) : `<div class="mask">${maskHtml(p)}</div>`}
      ${p.kanjiOnly && hint ? `<div class="hint">💭 読み：${esc(hint)}</div>` : ''}
      <p class="small">番号のじゅんに、マスに書いてね（${p.tries}/3回）</p></div>`;
  }
  // result
  const r = c.result;
  if (r && (r.correct || c.override)) {
    return `<div class="a"><div class="verdict ok">⭕ ${c.fixed ? 'なおせたね！' : c.override ? 'OK！' : 'せいかい！'}</div>
      ${resultGridHtml()}
      <div class="a-row">${mine}<div class="a-box">${answerHtml(card)}</div></div></div>`;
  }
  return `<div class="a"><div class="verdict ng">${c.plan ? '🔎 おしい！' : '🙈 ちがうみたい'}</div>
    ${c.chars && r && r.got ? `${resultGridHtml()}<p class="small">${c.plan ? '赤いマスがちがうよ（「なおす」でそこだけ書き直そう）' : '赤いマスがちがうよ（小さい字＝よみとった字）'}</p>`
      : `<div class="recog">よみとり：<span class="chars">${r && r.got ? diffHtml(r) : '（よめなかった）'}</span></div>
    ${c.plan ? `<div class="mask">${maskHtml(c.plan)}</div><p class="small">赤い字・？のところがちがうよ</p>` : ''}`}
    ${mine ? `<div class="a-row">${mine}</div>` : ''}</div>`;
}

function gradeButtons(sugg) {
  const s = session, today = dayIndex();
  const { card } = s.items[s.i];
  const state = store.state(card.id);
  return `<div class="grades">${Object.entries(GRADES).map(([k, g]) => `
    <button class="grade g-${k} ${sugg === k ? 'sugg' : ''}" data-g="${k}">${sugg === k ? '<span class="sugg-tag">おすすめ</span>' : ''}<span class="ge">${g.emoji}</span><span class="gl">${g.label}</span>
    <span class="gp">${s.kind === 'study' ? previewLabel(state, k, today) : ''}</span></button>`).join('')}</div>`;
}

function renderBottom() {
  const s = session, c = s.cur;
  const { card } = s.items[s.i];
  const hw = !!s.pad;
  const canAuto = hw && s.engine && isGradable(card);
  const b = $('#bottom');
  if (!b) return;
  const hintAvail = c.writeMode ? !!card.whint : !!card.hint;
  if (c.oral && (s.phase === 'q' || s.phase === 'listening' || s.phase === 'judging')) {
    const mic = voiceOn() && canListen() && !s.confirmNoMic;
    b.innerHTML = s.phase === 'listening' ? '<div class="pre"><button class="btn big primary rec" id="micStop">⏹ おわり</button></div>'
      : s.phase === 'judging' ? '<div class="pre"><button class="btn soft" id="judgeSkip">自分で答え合わせ</button><button class="btn big soft" disabled>🐰 考え中…</button></div>'
      : `<div class="pre">${hintAvail && !s.hint ? '<button class="btn soft" id="hint">💭 ヒント</button>' : ''}
        ${mic ? '<button class="btn soft" id="reveal">こたえを見る</button><button class="btn big primary" id="micBtn">🎤 声で答える</button>' : '<button class="btn big primary" id="reveal">こたえを見る 👀</button>'}</div>`;
  } else if (s.phase === 'oral') {
    b.innerHTML = (c.judge && c.judge.term && s.engine ? `<div class="pre"><button class="btn big soft" id="termBtn">✍️「${esc(c.judge.term)}」を書いてみる</button></div>` : '') + gradeButtons(c.sugg);
  } else if (s.phase === 'oralwrite') {
    b.innerHTML = '<div class="pre"><button class="btn soft" id="termSkip">やめる</button><button class="btn big primary" id="termCheck">✍️ 答え合わせ</button></div>';
  } else if (s.phase === 'oralwritten') {
    b.innerHTML = gradeButtons(c.sugg);
  } else if (s.phase === 'q') {
    b.innerHTML = `<div class="pre">${hintAvail && !s.hint ? '<button class="btn soft" id="hint">💭 ヒント</button>' : ''}
      ${canAuto ? '<button class="btn soft" id="reveal">こたえを見る</button><button class="btn big primary" id="checkBtn">✍️ 答え合わせ</button>'
                : '<button class="btn big primary" id="reveal">こたえを見る 👀</button>'}</div>`;
  } else if (s.phase === 'checking') {
    b.innerHTML = '<div class="pre"><button class="btn soft" id="reveal">こたえを見る</button><button class="btn big soft" disabled>🔍 よみとり中…</button></div>';
  } else if (s.phase === 'result' && (c.result.correct || c.override)) {
    b.innerHTML = gradeButtons(c.sugg);
  } else if (s.phase === 'result') {
    b.innerHTML = `<div class="pre wrap">
      <button class="btn soft" id="override">🙆 あってたよ</button>
      ${c.plan ? '<button class="btn big primary" id="redo">✏️ なおす</button>' : (c.tries < 2 ? '<button class="btn big primary" id="again">✏️ もう一度書く</button>' : '')}
      <button class="btn soft" id="giveup">こたえを見る</button></div>`;
  } else if (s.phase === 'redo') {
    b.innerHTML = `<div class="pre"><button class="btn soft" id="giveup">こたえを見る</button><button class="btn big primary" id="checkBtn">✍️ 答え合わせ</button></div>`;
  } else if (s.phase === 'answer') {
    b.innerHTML = gradeButtons(c.sugg);
  }
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('hint', () => { s.hint = true; renderFace(); renderBottom(); });
  if (c.oral) { on('reveal', () => { stopSpeak(); s.phase = 'oral'; c.sugg = null; refresh(); }); }
  else on('reveal', () => { c.checkToken = null; c.img = s.pad ? s.pad.thumbnail() : null; if (c.result == null && s.pad && !s.pad.isEmpty() && s.engine && isGradable(card)) c.sugg = null; s.phase = 'answer'; refresh(); });
  on('checkBtn', () => doCheck());
  on('micBtn', () => startListen());
  on('micStop', () => { if (c.listener) c.listener.stop(); else { s.phase = 'q'; refresh(); } });
  on('judgeSkip', () => { c.judgeToken = null; c.sugg = null; s.phase = 'oral'; refresh(); });
  on('termBtn', () => startTermWrite());
  on('termSkip', () => { s.phase = 'oral'; removePad(); refresh(); });
  on('termCheck', () => checkTerm());
  on('override', () => { c.override = true; c.miss.clear(); c.sugg = 'good'; refresh(); });
  on('redo', () => startRedo());
  on('again', () => { c.tries++; s.pad.clear(); s.phase = 'q'; c.result = null; refresh(); });
  on('giveup', () => { c.sugg = 'again'; s.phase = 'answer'; refresh(); });
  $app.querySelectorAll('.grade').forEach((el) => (el.onclick = () => doGrade(el.dataset.g)));
}

function refresh() { renderFace(); renderBottom(); }

async function doCheck() {
  const s = session, c = s.cur;
  const { card } = s.items[s.i];
  if (!s.pad || s.pad.isEmpty()) { toast('マスに書いてから「答え合わせ」してね'); return; }
  const redo = s.phase === 'redo';
  if (!redo) c.img = s.pad.thumbnail();
  s.phase = 'checking'; refresh();
  const token = (c.checkToken = {});
  let text;
  const target = redo ? c.plan.expected : normalize(String(writeTarget(card)).replace(/[（(][^）)]*[）)]/g, ''));
  const ctx = { cells: s.pad.cellCount(), layout: s.pad.layout(), len: [...target].length, kanji: [...target].some(isKanji) };
  try {
    // 書き終わって少し待っている間に先に読み取っていれば、その結果を使う（速くなる）
    const spec = !redo && c.spec && c.spec.ver === c.ver ? c.spec.p : null;
    text = spec ? await spec.catch(() => recognize(s.engine, s.pad, ctx)) : await recognize(s.engine, s.pad, ctx);
  }
  catch (e) {
    console.warn(e);
    const code = e && e.code;
    toast(code === 'ai-quota' ? '今日のAI読み取りはおしまい。自分で答え合わせしてね'
      : code === 'ai-offline' ? '電波がないので、自分で答え合わせしてね'
      : code === 'ai-appcheck' ? 'AIの読み取りがいま使えません。自分で答え合わせしてね'
      : 'よみとりできなかったよ。自分で答え合わせしてね');
    if (code === 'ai-quota' || code === 'ai-appcheck') s.engine = null; // この回のあとは自己採点で進める
    if (session !== s || s.cur !== c || c.checkToken !== token) return;
    s.phase = 'answer'; c.sugg = null; refresh(); return;
  }
  if (session !== s || s.cur !== c || c.checkToken !== token) return; // 待っている間に「こたえを見る」を押した
  c.checkToken = null;
  c.recog = text;
  if (!redo) {
    const r = check(card, text);
    c.result = r;
    if (r.correct) {
      c.sugg = autoGrade({ correctFirst: c.tries === 0, ms: Date.now() - c.start, length: r.expected.length });
      if (c.tries > 0) c.sugg = 'hard';
      s.phase = 'result';
    } else {
      for (const i of r.wrong) c.miss.add([...r.expected][i]);
      c.plan = redoPlan(r);
      s.phase = 'result';
    }
  } else {
    const np = applyRedo(c.plan, text);
    if (np.done) {
      c.plan = np; c.fixed = true; c.result = { ...c.result, correct: true };
      c.sugg = autoGrade({ correctFirst: false, fixedByRedo: true });
      s.phase = 'result';
    } else if (np.tries >= 3) {
      c.plan = np; c.sugg = 'again'; s.phase = 'answer';
    } else {
      c.plan = np; s.phase = 'redo';
      setupRedoPad();
    }
  }
  refresh();
}

function startRedo() {
  const s = session;
  s.phase = 'redo';
  setupRedoPad();
  refresh();
}

function saveInprog(s) {
  if (!s || s.confirm) return;
  if (s.i >= s.items.length) { store.setInprog(null); return; }
  store.setInprog({ id: s.sid, k: s.kind, ids: s.items.map((x) => x.card.id), i: s.i, done: s.done, again: s.again, combo: s.combo, xp: s.xp, total: s.total, back: s.back, rg: s.rg, d: s.deckIds, start: s.started, dev: store.data.device });
  cloud.schedule(300); // すぐ送る（タブを閉じても、ほかの端末でつづきから）
}
/** とちゅうの勉強を、つづきから（ほかの端末で始めた分も） */
function resumeSession() {
  const p = store.resumable;
  if (!p) return go('#/');
  const find = (id) => { for (const d of DECKS) { const c = d.allCards.find((x) => x.id === id); if (c) return { card: c, deck: d }; } return null; };
  const all = p.ids.map(find);
  const items = all.filter(Boolean);
  const i = all.slice(0, p.i).filter(Boolean).length; // カードがなくなっていたら、そのぶんずらす
  if (i >= items.length) { store.setInprog(null); cloud.schedule(500); toast('つづきのカードが見つからなかったよ'); return go('#/'); }
  startWith(items, p.k || 'study', p.back || '#/', { ...p, i });
}
function resumeHtml() {
  const p = store.resumable;
  if (!p || confirmMode()) return '';
  const emo = (p.d || []).map((id) => deckById(id)?.emoji || '').join('');
  const when = p.t ? fmtDate(p.t) + ' ' + fmtHM(p.t) : '';
  return `<section class="resume">
    <div class="rs-h">⏸️ とちゅうの勉強があるよ</div>
    <div class="rs-b">${emo} <b>${esc(p.rg || '')}</b><br><small>${esc(KIND_LABEL[p.k] || '')}・<b>${p.i}</b>/${p.ids.length}まい おわった・${esc(when)}</small></div>
    <div class="bar"><span style="width:${Math.round((p.i / Math.max(1, p.ids.length)) * 100)}%"></span></div>
    <div class="rs-btns"><a class="btn big primary" href="#/resume" id="resumeGo">▶️ つづきから</a><button class="btn soft mini" id="resumeDrop">すてる</button></div></section>`;
}
function bindResume() {
  const b = document.getElementById('resumeDrop');
  if (b) b.onclick = () => { if (confirm('とちゅうの勉強をすてる？（ここまでの記録は残るよ）')) { store.setInprog(null); cloud.schedule(300); route(); } };
}
// 時刻はいつも日本時間で
const JST_HM = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
const JST_MD = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
const fmtHM = (t) => JST_HM.format(new Date(t));
const fmtDate = (t) => JST_MD.format(new Date(t));
const mins = (ms) => Math.max(1, Math.round((ms || 0) / 60000));
const minText = (ms) => ((ms || 0) < 60000 ? '<b>1</b>分未満' : `<b>${mins(ms)}</b>分`);

function setupRedoPad() {
  const s = session;
  const host = $('#pad');
  if (s.pad) s.pad.destroy();
  s.pad = new HandPad(host, { dir: store.settings.hwDir || 'h', masu: true, cells: s.cur.plan.blanks.length });
}

function doGrade(g) {
  const s = session, c = s.cur;
  const { card, deck } = s.items[s.i];
  const miss = c.override ? [] : [...c.miss];
  stopSpeak();
  if (!s.confirm) {
    store.grade(card, deck.id, g, { mode: logMode(), miss, auto: !!c.result || !!c.judge });
    store.logCard(s.sit, { g, cardMs: Date.now() - c.start }); // 勉強の記録（時刻・時間・まい数・正解）
  }
  s.done++;
  s.combo = g === 'again' ? 0 : s.combo + 1;
  if (!s.confirm) celebrate(g);
  if (g === 'again' || (s.kind === 'mistake' && g === 'hard')) { s.again++; s.items.splice(Math.min(s.items.length, s.i + 4), 0, s.items[s.i]); }
  s.i++;
  if (!s.confirm) saveInprog(s); // 1枚ごとに、とちゅうの勉強を保存（ほかの端末でもつづきから）
  if (navigator.vibrate) try { navigator.vibrate(8); } catch (e) {}
  renderCard();
}

/** がんばりの演出：XP・コンボ・目標たっせい・レベルアップ・バッジ */
function celebrate(g) {
  const s = session;
  const gain = (XP[g] || 0) + (s.combo >= 5 ? COMBO_BONUS : 0);
  s.xp += gain;
  floatText(`+${gain} XP`);
  const prev = s.game0 || game();
  const now = game();
  s.game0 = now;
  if (now.level.lv > prev.level.lv) { confetti(2); toast(`🎉 レベルアップ！ Lv.${now.level.lv} になったよ`); }
  else if (now.today >= now.goal && prev.today < prev.goal) { confetti(1.6); toast('🎯 今日の目標たっせい！すごい！'); }
  const newB = badgeList(now).filter((b) => b.got && !(b.id in (prev.badges || {})) && !(prev.masteredUnits || []).includes(b.id.slice(2)));
  if (newB.length) { confetti(1.6); setTimeout(() => toast(`${newB[0].e} バッジ「${newB[0].name}」をもらったよ！`), 400); }
  else if (s.combo && s.combo % 5 === 0) confetti(0.8);
  else if (g === 'good' || g === 'easy') { if (s.cur.result?.correct || s.cur.judge?.result === 'good') confetti(0.35); }
}
function floatText(t) {
  const el = document.createElement('div'); el.className = 'xp-float'; el.textContent = t;
  document.body.appendChild(el); setTimeout(() => el.remove(), 1100);
}

/** 書き終わって手が止まったら、先に読み取りをはじめておく */
let specTimer = null;
function scheduleSpec() {
  clearTimeout(specTimer);
  const s = session;
  if (!s || !s.pad || s.phase !== 'q' || s.engine !== 'gemini' || store.settings.specRecog === false) return;
  const c = s.cur, card = s.items[s.i].card;
  specTimer = setTimeout(() => {
    if (session !== s || s.cur !== c || s.phase !== 'q' || !s.pad || s.pad.isEmpty()) return;
    if (s.pad.cellCount() && countInkedCells(s.pad) < s.pad.cellCount()) return; // マスがうまるまで待つ
    const target = normalize(String(writeTarget(card)).replace(/[（(][^）)]*[）)]/g, ''));
    const ctx = { cells: s.pad.cellCount(), layout: s.pad.layout(), len: [...target].length, kanji: [...target].some(isKanji) };
    c.spec = { ver: c.ver, p: recognize(s.engine, s.pad, ctx) };
    c.spec.p.catch(() => {});
  }, 600);
}
function countInkedCells(pad) {
  const set = new Set();
  for (const st of pad.strokes) for (const p of st.points) { const k = pad.cellAt(p.x, p.y); if (k >= 0) set.add(k); }
  return set.size;
}

// ---------- 声で答える ----------
const JUDGE_MAX_MS = 12000;
/** 声・読み上げ・AI待ちを全部やめる（終わる・画面を出る・次のカードへ） */
function stopMedia(s = session) {
  stopSpeak();
  if (!s || !s.cur) return;
  const c = s.cur;
  if (c.listener) { try { c.listener.abort(); } catch {} c.listener = null; }
  c.judgeToken = null;
}
async function startListen() {
  if (!voiceOn()) return; // 設定で OFF のときは聞かない
  const s = session, c = s.cur;
  const card = s.items[s.i].card;
  let l;
  try { l = listen({ onPartial: (t) => { c.said = t; if (session === s && s.phase === 'listening') renderFace(); } }); }
  catch (e) { toast('この端末では声で答えられないみたい。こたえを見て自分で答え合わせしてね'); s.confirmNoMic = true; refresh(); return; }
  c.listener = l; s.phase = 'listening'; c.said = ''; refresh();
  let said = '';
  try { said = await l.done; }
  catch (e) {
    toast(/not-allowed|service-not-allowed/.test(e.code || '') ? 'マイクが使えないよ（設定でマイクをゆるしてね）' : '声がうまく聞きとれなかったよ');
    if (/not-allowed|service-not-allowed/.test(e.code || '')) s.confirmNoMic = true;
  }
  if (c.listener === l) c.listener = null;
  if (session !== s || s.cur !== c) return;
  c.said = said;
  if (!said) { s.phase = 'q'; refresh(); toast('もう一度、声で答えてみてね'); return; }
  if (!s.engine) { s.phase = 'oral'; c.sugg = null; refresh(); return; } // AI が使えないときは自分で答え合わせ
  s.phase = 'judging'; refresh();
  // AI先生の判定は待ちすぎない（12秒まで）。「自分で答え合わせ」でいつでもとばせる
  const token = (c.judgeToken = {});
  try {
    const j = await Promise.race([judgeOral(card, said), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('judge timeout'), { code: 'ai-timeout' })), JUDGE_MAX_MS))]);
    if (c.judgeToken !== token) return; // とばした・画面を出た
    c.judge = j; c.sugg = oralGrade(j.result);
  }
  catch (e) {
    if (c.judgeToken !== token) return;
    console.warn(e); toast('先生がいま答えられないみたい。自分で答え合わせしてね'); if (e.code === 'ai-quota' || e.code === 'ai-appcheck') s.engine = null;
  }
  c.judgeToken = null;
  if (session !== s || s.cur !== c) return;
  s.phase = 'oral'; refresh();
  if (c.judge && ttsAutoOn()) speak(c.judge.comment, { rate: ttsRate() });
}
function ensurePad(cells) {
  const s = session;
  const st = $app.querySelector('.study');
  st.classList.add('with-pad');
  let host = $('#pad');
  if (!host) { host = document.createElement('section'); host.className = 'pad'; host.id = 'pad'; $app.querySelector('.study-grid').appendChild(host); }
  if (s.pad) s.pad.destroy();
  s.pad = new HandPad(host, { dir: store.settings.hwDir || 'h', masu: true, cells });
}
function removePad() {
  const s = session;
  if (s.pad) { s.pad.destroy(); s.pad = null; }
  const host = $('#pad'); if (host) host.remove();
  const st = $app.querySelector('.study'); if (st) st.classList.remove('with-pad');
}
function startTermWrite() {
  const s = session, c = s.cur;
  stopSpeak();
  s.phase = 'oralwrite'; c.termResult = null;
  ensurePad([...c.judge.term].length);
  refresh();
}
async function checkTerm() {
  const s = session, c = s.cur;
  if (!s.pad || s.pad.isEmpty()) { toast('マスに書いてから「答え合わせ」してね'); return; }
  const t = c.judge.term;
  $('#bottom').innerHTML = '<div class="pre"><button class="btn big soft" disabled>🔍 よみとり中…</button></div>';
  let text = '';
  try { text = await recognize(s.engine, s.pad, { cells: [...t].length, len: [...t].length, kanji: true }); }
  catch (e) { toast('よみとりできなかったよ'); s.phase = 'oral'; removePad(); refresh(); return; }
  if (session !== s || s.cur !== c) return;
  c.termResult = check({ a: t, w: t }, text);
  if (!c.termResult.correct) for (const i of c.termResult.wrong) c.miss.add([...t][i]);
  if (c.termResult.correct && c.sugg === 'hard') c.sugg = 'good';
  s.phase = 'oralwritten'; refresh();
}

function renderDone() {
  const s = session;
  const stars = s.again === 0 ? '🌟🌟🌟' : s.again <= Math.ceil(s.total / 4) ? '🌟🌟' : '🌟';
  $app.innerHTML = `
    <main class="done">
      <div class="confetti">🎉</div>
      <h1>おつかれさま！</h1>
      <div class="stars">${stars}</div>
      <p>${s.total}まいのカードを ${s.done}回 ふりかえったよ。<br>${s.again ? 'わからなかったカードも、もう一度やったからバッチリ！' : 'ぜんぶわかったね、すごい！'}</p>
      ${s.confirm ? '<p class="small">🔍 確認モードだったので、記録はしていないよ</p>' : `<div class="done-xp">✨ +${s.xp} XP ／ Lv.${game().level.lv}</div>`}
      ${s.kind === 'study' ? '<p class="small">わすれかけたころに、また出してあげるね 🐰</p>' : ''}
      <a class="btn big primary" href="#/">ホームへ</a>
      ${s.kind === 'review' ? '<a class="btn big soft" href="#/review">📝 見直しにもどる</a>' : ''}${s.kind === 'mistake' ? '<a class="btn big soft" href="#/mistakes" id="homeMistakes">🔁 まちがえた問題にもどる</a>' : ''}
      <a class="btn big soft" href="#/progress">📊 進み具合を見る</a>
    </main>`;
  if (!s.confirm) { confetti(1.4); store.setInprog(null); }
  session = null;
  cloud.schedule(500);
}

// ---------- 進み具合 ----------

function progressHtml(st) {
  const max = Math.max(5, ...st.hist.map((h) => h[0]));
  const W = 320, H = 120, bw = W / 14;
  const today = st.today ?? dayIndex(new Date(st.at));
  const bars = st.hist.map(([r, c], i) => {
    const x = i * bw + 3, w = bw - 6;
    const hr = (r / max) * (H - 30), hc = (c / max) * (H - 30);
    const md = dayToISO(today - 13 + i).slice(5).replace('-', '/').replace(/^0/, '');
    return `<rect x="${x}" y="${H - 14 - hr}" width="${w}" height="${hr}" rx="3" fill="#ffc2d4"/>
      <rect x="${x}" y="${H - 14 - hc}" width="${w}" height="${hc}" rx="3" fill="#ff6f9c"/>
      ${r ? `<text x="${x + w / 2}" y="${H - 17 - hr}" font-size="9" text-anchor="middle" fill="#a0567a">${r}</text>` : ''}
      ${i % 2 === 1 || i === 13 ? `<text x="${x + w / 2}" y="${H - 2}" font-size="8.5" text-anchor="middle" fill="#9a8aa0">${md}</text>` : ''}`;
  }).join('');
  const stack = (x) => { const t = Math.max(1, x.total); return `<div class="stack"><span class="s-m" style="width:${(x.mastered / t) * 100}%"></span><span class="s-l" style="width:${(x.learning / t) * 100}%"></span><span class="s-n" style="width:${(x.new / t) * 100}%"></span></div>`; };
  const deckRows = st.decks.map((d) => `<div class="pdeck">
      <div class="pdeck-h">${d.emoji} <b>${esc(d.name)}</b> <small>${d.total}まい・今日の学習 ${d.due}</small></div>
      ${stack(d)}
      <div class="legend"><span>🌟覚えた ${d.mastered}</span><span>🟡学習中 ${d.learning}</span><span>⚪新しい ${d.new}</span></div>
    </div>`).join('');
  const unitRows = (st.units || []).slice().sort((a, b) => (a.deck === b.deck ? b.kai - a.kai : 0)).map((u) => `<div class="urow">
      <div class="urow-h">${u.emoji} 第${u.kai}回 ${esc(u.name)} ${u.latest ? '<span class="new-badge">さいしん</span>' : ''}</div>
      ${stack(u)}
      <div class="legend"><span>🌟${u.mastered}/${u.total}（${Math.round((u.mastered / Math.max(1, u.total)) * 100)}%）</span><span>🟡${u.learning}</span><span>苦手 ${u.weak}</span></div>
    </div>`).join('');
  const wc = (st.weakChars || []).length ? `<h2 class="sec">苦手な漢字 <small>（書きまちがえた回数）</small></h2>
    <div class="wchars">${st.weakChars.map(([ch, n]) => `<span class="wch">${esc(ch)}<small>×${n}</small></span>`).join('')}</div>` : '';
  const up = st.upcoming.map((n, i) => `<div><b>${n}</b><span>${i === 0 ? '今日' : i === 1 ? 'あした' : i + '日後'}</span></div>`).join('');
  return `
    <section class="kpis">
      <div class="kpi"><b>🔥 ${st.streak}</b><span>日れんぞく</span></div>
      <div class="kpi"><b>${st.retention == null ? '－' : st.retention + '%'}</b><span>いま覚えている<br>割合（推定）</span></div>
      <div class="kpi"><b>${st.accuracy30 == null ? '－' : st.accuracy30 + '%'}</b><span>正解率<br>（30日）</span></div>
      <div class="kpi"><b>${st.totalReviews}</b><span>ふりかえった<br>回数</span></div>
    </section>
    <div class="prog-grid"><div>
    <h2 class="sec">いまのデッキ</h2>
    ${deckRows}
    <h2 class="sec">回ごとの覚えぐあい</h2>
    ${unitRows || '<p class="small">まだありません</p>'}
    ${wc}
    </div><div>
    <h2 class="sec">この14日間 <small><i class="dot d1"></i>わかった <i class="dot d2"></i>ふりかえり回数</small></h2>
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="14日間の復習回数">${bars}</svg></div>
    <h2 class="sec">これからの復習（まい）</h2>
    <div class="upcoming">${up}</div>
    <p class="small">「いま覚えている割合」は、忘却曲線（復習日にちょうど90%になるように計算）から出した目安です。学習した日：${st.studyDays}日</p>
    </div></div>`;
}

function recentLogHtml(slog) {
  const list = Object.values(slog || {}).filter((e) => e.s).sort((a, b) => b.s - a.s).slice(0, 12);
  return `<section class="form"><h2 class="sec">📒 勉強の記録 <small>（さいきん・日本時間）</small></h2>
    ${list.length ? list.map((e) => logRowHtml(e, { date: true })).join('') : '<p class="small">まだ記録がないよ。勉強すると、始めた時刻と時間がここに出るよ。</p>'}
    <p class="small">くわしくは「達成シール」の📅カレンダーで、日にちをタップしてね。</p></section>`;
}
function viewProgress() {
  $app.innerHTML = `
    <header class="bar-top"><h1>📊 進み具合</h1></header>
    ${progressHtml(stats())}
    ${recentLogHtml(store.data.slog)}
    <p class="small">☁️ 記録はクラウドにも保存されていて、ママのスマホからいつでも見られます。</p>
    ${nav('progress')}`;
}

async function viewLive() {
  $app.innerHTML = `<header class="bar-top parent"><h1>👪 まなの進み具合 <span class="live">● リアルタイム</span></h1></header><div id="live"><p class="loading">よみこみ中…</p></div>
    <p class="small">まなが勉強すると、自動で更新されます（見るだけで、記録を変えることはできません）。</p>
    ${nav('progress')}`;
  try {
    unwatch = await cloud.watch((src) => {
      const box = document.getElementById('live');
      if (!box) return;
      const st = computeStats(DECKS, src);
      const lastN = Math.max(-1, ...Object.keys(src.daily || {}).map(Number).filter((n) => !isNaN(n)));
      const last = lastN >= 0 ? (() => { const [y, m, d] = dayToISO(lastN).split('-'); return `${+m}月${+d}日`; })() : '';
      LIVE = src;
      box.innerHTML = `<p class="snap-time">${last ? `最後に勉強した日 ${esc(last)}` : 'まだ記録がありません'}</p>
        ${src.dmsg && src.dmsg.day === dayIndex() ? sceneHtml(sceneFor(dayIndex(), new Date().getMonth() + 1), esc(src.dmsg.text)) : ''}
        ${src.game ? gameHeaderHtml(src.game, src.daily) : ''}
        <section class="form"><h2 class="sec">📅 勉強カレンダー</h2>${calendarHtml(src.daily, src.slog || {})}</section>
        ${progressHtml(st)}
        ${recentLogHtml(src.slog || {})}`;
      const redoCal = () => { const cb = box.querySelector('.calbox'); if (cb) { cb.outerHTML = calendarHtml(src.daily, src.slog || {}); bindCalendar(redoCal); } };
      bindCalendar(redoCal);
    }, (e) => { const box = document.getElementById('live'); if (box) box.innerHTML = `<p class="done-msg">読みこめませんでした（${esc(errText(e))}）</p>`; });
  } catch (e) { $('#live').innerHTML = `<p class="done-msg">つながりませんでした（${esc(errText(e))}）</p>`; }
}

// ---------- 達成シール（カレンダー・シール・シール交換・バッジ） ----------
let LIVE = null;      // 保護者の画面：クラウドから読んだ記録
let ADULT_OPEN = false;
let CAL_OFF = 0;      // カレンダー：今月から何か月前
let CAL_DAY = null;   // カレンダーでえらんだ日（null＝今日）
/** その日の勉強の記録（時刻・分・教科・はんい・まい数・正解） */
function dayLog(slog, day) { return Object.entries(slog || {}).map(([id, e]) => ({ id, ...e })).filter((e) => e.s && dayIndex(new Date(e.s)) === day).sort((a, b) => a.s - b.s); }
function logRowHtml(e, { date = false } = {}) {
  const emo = (e.d || []).map((id) => deckById(id)?.emoji || '').join('');
  return `<div class="lrow"><span class="lt">${date ? fmtDate(e.s) + ' ' : ''}${fmtHM(e.s)}〜${fmtHM(e.e || e.s)}</span><span class="lm">${minText(e.ms)}</span>
    <span class="ls">${emo} ${esc(e.rg || '')}<small>${esc(KIND_LABEL[e.k] || '')}${e.rs ? '（つづき）' : ''}</small></span>
    <span class="ln">${e.n || 0}まい・⭕${e.ok || 0}</span></div>`;
}
function dayLogHtml(slog, day) {
  const list = dayLog(slog, day);
  const [y, m, d] = dayToISO(day).split('-');
  const total = list.reduce((a, e) => a + (e.ms || 0), 0);
  return `<div class="daylog"><h3 class="sec small-h">🕒 ${+m}月${+d}日の勉強 ${list.length ? `<small>ぜんぶで ${minText(total)}・${list.reduce((a, e) => a + (e.n || 0), 0)}まい</small>` : ''}</h3>
    ${list.length ? list.map((e) => logRowHtml(e)).join('') : '<p class="small">この日の記録はないよ</p>'}</div>`;
}
function calendarHtml(daily = {}, slog = null) {
  const now = new Date(); const ym = new Date(now.getFullYear(), now.getMonth() - CAL_OFF, 1);
  const cells = monthCells(ym.getFullYear(), ym.getMonth(), daily, dayIndex());
  const si = streakInfo(daily, dayIndex());
  const cnt = cells.filter((c) => c && c.studied).length;
  return `<div class="calbox">
    <div class="cal-h"><button class="btn soft mini" data-cal="1">‹</button><b>${ym.getFullYear()}年${ym.getMonth() + 1}月</b><button class="btn soft mini" data-cal="-1" ${CAL_OFF ? '' : 'disabled'}>›</button></div>
    <div class="cal">${['日', '月', '火', '水', '木', '金', '土'].map((w) => `<div class="cal-w">${w}</div>`).join('')}
    ${cells.map((c) => !c ? '<div></div>' : `<div class="cal-d ${c.studied ? 'st' : ''} ${c.part ? 'pt' : ''} ${c.today ? 'td' : ''} ${c.future ? 'fu' : ''} ${slog && c.day === (CAL_DAY ?? dayIndex()) ? 'sel' : ''}" ${slog && !c.future ? `data-day="${c.day}"` : ''} title="${c.n}まい"><span class="cal-n">${c.date}</span>${c.studied ? `<span class="cal-s">${stickerFor(c.day)}</span>` : c.part ? '<span class="cal-s small-dot">・</span>' : ''}</div>`).join('')}</div>
    <div class="cal-f"><span>🔥 いま <b>${si.streak}</b>日れんぞく</span><span>🏆 さいこう <b>${si.best}</b>日</span><span>この月 <b>${cnt}</b>日</span></div>
    <p class="small">「勉強した日」＝その日に ${STUDY_MIN}まい以上ふりかえった日（日本時間）。${STICKER_DAYS}日れんぞくで シールが1まいもらえるよ。${slog ? '日にちをタップすると、その日の勉強の時刻と時間が見られるよ。' : ''}</p>
    ${slog ? dayLogHtml(slog, CAL_DAY ?? dayIndex()) : ''}</div>`;
}
function bindCalendar(redo) {
  $app.querySelectorAll('[data-cal]').forEach((b) => (b.onclick = () => { CAL_OFF = Math.max(0, CAL_OFF + +b.dataset.cal); redo(); }));
  $app.querySelectorAll('[data-day]').forEach((b) => (b.onclick = () => { CAL_DAY = +b.dataset.day; redo(); }));
}
function stickerHtml(daily) {
  const si = streakInfo(daily || {}, dayIndex());
  const bal = stickerBalance(si.earned, REWARDS.spends || []);
  const dots = Array.from({ length: STICKER_DAYS }, (_, i) => `<span class="sd ${i < si.progress ? 'on' : ''}">${i < si.progress ? '🌸' : ''}</span>`).join('');
  return `<section class="sticker-box">
    <div class="sb-top"><div class="sb-big">🎁<b>${bal.balance}</b><small>まい</small></div>
      <div class="sb-txt">シール貯金<br><small>これまで ${bal.earned}まい もらった・${bal.used}まい つかった</small></div></div>
    <div class="sb-next">つぎのシールまで <b>${si.progress}/${STICKER_DAYS}日</b>${si.todayDone ? '' : '<small>（今日もあと少し！）</small>'}</div>
    <div class="sdots">${dots}</div>
    <h3 class="sec small-h">📜 シール貯金の記録</h3>${stickerHistHtml([
      ...si.earnedDays.map((d) => ({ t: dayStart(d), text: 'シールを1枚もらう', sub: `${STICKER_DAYS}日れんぞく達成`, kind: 'get' })),
      ...(REWARDS.spends || []).map(spendRow)])}</section>`;
}
const dayStart = (d) => new Date(dayToISO(d) + 'T12:00:00').getTime();
const SPEND_ST = { req: '⏳ OK待ち', ok: '⭕ OK', no: '✖ こんどね' };
const spendRow = (x) => ({ t: x.t, text: `シールを${x.cost}枚使う`, sub: SPEND_ST[x.st] || x.st, kind: 'use ' + x.st, id: x.id, st: x.st });
/** 記録の行：左に日づけ、右に「シールを〇枚もらう／使う」（シール貯金とシールを使うで同じ形） */
function stickerHistHtml(rows, { actions = false } = {}) {
  rows = rows.slice().sort((a, b) => b.t - a.t).slice(0, 40);
  if (!rows.length) return '<p class="small">まだありません</p>';
  return `<div class="shist">${rows.map((r) => { const d = new Date(r.t); return `<div class="srow ${r.kind}"><span class="sr-d">${d.getMonth() + 1}/${d.getDate()}</span><span class="sr-t">${esc(r.text)}${r.sub ? ` <small>${esc(r.sub)}</small>` : ''}</span>${actions && isAdult() && r.st === 'req' ? `<span class="sr-a"><button class="btn primary mini" data-ok="${r.id}">OK</button><button class="btn soft mini" data-no="${r.id}">こんどね</button></span>` : ''}</div>`; }).join('')}</div>`;
}
// シールを使う：シール交換の一覧は「シール〇枚」だけ（名前なし）。ルールに合わせて items に n1〜n10 を入れておく
const SPEND_MAX = 10;
const genericItems = () => Object.fromEntries(Array.from({ length: SPEND_MAX }, (_, i) => [`n${i + 1}`, { name: `シール${i + 1}枚`, cost: i + 1, e: '🎁' }]));
let ENSURING = false;
async function ensureGenericItems() {
  if (ENSURING || !isAdult() || !REWARDS.ready || REWARDS.err) return;
  const items = REWARDS.items || {}, want = genericItems();
  const same = Object.keys(items).length === SPEND_MAX && Object.entries(want).every(([k, v]) => items[k] && items[k].name === v.name && items[k].cost === v.cost);
  if (same) return;
  ENSURING = true;
  try { await cloud.saveRewards(want); } catch (e) { console.warn('シール交換の準備', e); } finally { ENSURING = false; }
}
function rewardsHtml(daily) {
  daily = daily || (isParentRole() ? LIVE?.daily : store.derived.daily) || {};
  const si = streakInfo(daily, dayIndex());
  const bal = stickerBalance(si.earned, REWARDS.spends || []);
  if (REWARDS.err) return `<p class="small">シール交換の設定はまだ使えません（${esc(errText(REWARDS.err))}）。Firestore のルールを新しくすると使えるようになります。</p>`;
  if (!REWARDS.ready) return '<p class="loading">よみこみ中…</p>';
  ensureGenericItems();
  const canUse = !isParentRole() && !confirmMode();
  const ready = !!(REWARDS.items && REWARDS.items.n1);
  const max = Math.min(SPEND_MAX, bal.balance);
  const n = Math.max(1, Math.min(max || 1, USE_N));
  const use = !canUse ? ''
    : !ready ? '<p class="small">パパ・ママの画面（または父のアカウント）でこの画面を一度ひらくと、シールを使えるようになるよ。</p>'
    : max < 1 ? '<p class="small">シールがたまったら使えるよ。7日れんぞくで1枚もらえるよ！</p>'
    : `<div class="use-row"><select id="useN">${Array.from({ length: max }, (_, i) => `<option value="${i + 1}" ${i + 1 === n ? 'selected' : ''}>${i + 1}枚</option>`).join('')}</select><button class="btn primary" id="useBtn">交換</button></div>`;
  return `<h2 class="sec">${isParentRole() ? '🎀 シール交換' : '🎀 シールを使う'}</h2>
    <div class="use-bal">いま <b>シール${bal.balance}枚</b></div>${use}
    ${isAdult() ? `<details class="adult" id="adultBox" ${isParentRole() || ADULT_OPEN ? 'open' : ''}><summary>👪 おとな用：シール交換</summary>
      <p class="small">「シールを〇枚使う」のおねがいに「OK」すると、そのシールが使われます。「こんどね」にするとシールはもどります。下の記録から OK／こんどね を押してね。</p></details>` : ''}
    <h3 class="sec small-h">📜 使った記録</h3>${stickerHistHtml((REWARDS.spends || []).map(spendRow), { actions: true })}`;
}
let USE_N = 1;
function bindRewards() {
  const sel = document.getElementById('useN'), btn = document.getElementById('useBtn');
  if (sel) sel.onchange = () => { USE_N = +sel.value; };
  if (btn) btn.onclick = async () => {
    const k = +(sel ? sel.value : 1); const id = `n${k}`; const it = REWARDS.items && REWARDS.items[id];
    if (!it) return toast('まだ使えないよ。パパ・ママに聞いてね');
    if (!confirm(`シールを${k}枚使う？（パパ・ママのOKを待つよ）`)) return;
    try { await cloud.requestSpend(id, it); confetti(1); toast('おねがいしたよ！パパ・ママのOKを待ってね'); } catch (e) { toast('おねがいできませんでした：' + errText(e)); }
  };
  $app.querySelectorAll('[data-ok],[data-no]').forEach((b) => (b.onclick = async () => {
    try { await cloud.decideSpend(b.dataset.ok || b.dataset.no, !!b.dataset.ok); toast(b.dataset.ok ? 'OKしました' : '「こんどね」にしました'); } catch (e) { toast('できませんでした：' + errText(e)); }
  }));
  const ab = document.getElementById('adultBox'); if (ab) ab.ontoggle = () => { ADULT_OPEN = ab.open; };
}
function badgesHtml(g) {
  if (!g) return '';
  return `<h2 class="sec">🏅 バッジ <small>${badgeList(g).filter((b) => b.got).length}/${badgeList(g).length}</small></h2>
    <div class="badges">${badgeList(g).map((b) => `<div class="bdg ${b.got ? 'got' : ''}" title="${esc(b.desc)}"><span>${b.got ? b.e : '？'}</span><small>${esc(b.name)}</small></div>`).join('')}</div>`;
}
function viewRewards() {
  const render = () => {
    const daily = isParentRole() ? (LIVE?.daily || {}) : store.derived.daily;
    const g = isParentRole() ? LIVE?.game : game();
    $app.innerHTML = `${confirmBanner()}<header class="bar-top"><h1>🎁 達成シール</h1></header>
      ${g ? gameHeaderHtml(g, daily) : ''}
      <div class="prog-grid"><div>
      ${stickerHtml(daily)}
      <section class="form"><h2 class="sec">📅 勉強カレンダー</h2>${calendarHtml(daily, isParentRole() ? (LIVE?.slog || {}) : store.data.slog)}</section>
      </div><div>
      <section class="form" id="rewardsBox">${rewardsHtml(daily)}</section>
      ${badgesHtml(g)}
      </div></div>
      ${nav('rewards')}`;
    bindRewards(); bindCalendar(render); bindConfirmOff();
  };
  render();
  if (isParentRole()) cloud.watch((src) => { LIVE = src; if (location.hash === '#/rewards') render(); }).then((u) => { unwatch = u; }).catch(() => {});
}
function viewCards() {
  const deckHtml = DECKS.map((d) => `<a class="deck" href="#/deck/${d.id}" style="--c:${d.color}"><div class="deck-emoji">${d.emoji}</div>
      <div class="deck-body"><div class="deck-name">${esc(d.name)} <small>${d.cards.length}まい</small></div><div class="deck-meta">タップして試す（記録しないよ）</div></div><div class="chev">›</div></a>`).join('');
  $app.innerHTML = `${confirmBanner()}<header class="bar-top"><h1>🔍 カードを試す</h1></header>
    <p class="small">カードの出方を確かめられます。確認モードなので、まなの記録・XP・れんぞく日数・シールは変わりません。</p>
    <div class="decks">${deckHtml}</div>${nav('cards')}`;
}

// ---------- ログイン ----------

function viewLogin(msg = '') {
  $app.innerHTML = `
    <header class="hero"><div class="mascot">🐰</div><p class="greet">あんきカード</p></header>
    <section class="form login">
      <p class="small">家族専用のアプリです。登録されたアカウントでログインしてください。</p>
      <button class="btn big primary" id="gBtn">Google でログイン</button>
      <p class="small" id="lmsg">${esc(msg)}</p>
      <p class="small recaptcha-note">このサイトは reCAPTCHA で保護されています（Google の<a href="https://policies.google.com/privacy" target="_blank" rel="noopener">プライバシーポリシー</a>と<a href="https://policies.google.com/terms" target="_blank" rel="noopener">利用規約</a>）。</p>
    </section>`;
  $('#gBtn').onclick = async () => {
    $('#lmsg').textContent = 'ログインしています…';
    try { await signInGoogle(); await afterLogin(); } catch (e) { $('#lmsg').textContent = 'ログインできませんでした：' + errText(e); }
  };
}

function viewDenied(user, err) {
  $app.innerHTML = `
    <header class="hero"><div class="mascot">🙅</div><p class="greet">このアカウントでは使えません</p></header>
    <section class="form">
      <p class="small">${esc(user.email || '(メールなし)')} は登録されていません。家族のアカウントでログインしなおしてください。</p>
      ${err ? `<p class="small">${esc(errText(err))}</p>` : ''}
      <button class="btn big soft" id="outBtn">ログアウト</button>
    </section>`;
  $('#outBtn').onclick = async () => { await signOut(); location.reload(); };
}

/** ログインできたら：カードを読む → 役割を決める → 記録の同期をはじめる */
async function afterLogin() {
  const fb = await loadFirebase();
  USER = fb.auth.currentUser;
  if (!USER) return viewLogin();
  $app.innerHTML = '<p class="loading">🐰 カードをよみこみ中…</p>';
  try { await loadDecks(); }
  catch (e) {
    USER = null;
    if (e.code === 'permission-denied') return viewDenied(fb.auth.currentUser, e);
    $app.innerHTML = `<p class="done-msg">カードを読みこめませんでした（${esc(errText(e))}）。電波のよいところでもう一度ひらいてね。</p>`;
    return;
  }
  ROLE = roleOf(CONTENT.manifest, USER.email);
  startRewardsWatch();
  if (ROLE === 'learner') cloud.activate(USER).catch(() => {});
  else cloud.deactivate();
  await route();
}

// ---------- せってい ----------

function viewSettings() {
  const s = store.settings;
  const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
  $app.innerHTML = `
    <header class="bar-top"><h1>⚙️ せってい</h1></header>
    <div class="set-grid"><div>
    <section class="form">
      <label>1日に出す新しいカード（デッキごと）
        <select id="np">${[5, 10, 15, 20, 30].map((n) => opt(n, s.newPerDay, n)).join('')}</select></label>
      <label>ニックネーム（この端末・共有リンク・クラウドの中だけ）
        <input id="nn" maxlength="12" value="${esc(s.nickname)}" placeholder="例：うさこ"></label>
    </section>
    <section class="form">
      <h2 class="sec">🎯 目標・読み上げ</h2>
      <label>1日の目標（まい）
        <select id="goal">${[10, 15, 20, 30, 40].map((n) => opt(n, s.goal || 20, n + 'まい')).join('')}</select></label>
      <label>問題を自動で読み上げる（社会・理科）
        <select id="tts">${opt('off', s.ttsAuto === true ? 'on' : 'off', 'OFF（🔊を押したときだけ読む）')}${opt('on', s.ttsAuto === true ? 'on' : 'off', 'ON（カードが出たら読む）')}</select></label>
      <label class="switch-row">🎤 声で回答する
        <span class="switch"><input type="checkbox" id="voiceAns" ${voiceOn() ? 'checked' : ''}><span class="slider"></span></span></label>
      <p class="small">OFF にすると、声で答えるカードは「こたえを見る」→ 自分で答え合わせ になります（マイクは使いません）。</p>
      <label>読み上げの速さ
        <select id="ttsr">${[[1, 'ふつう'], [1.2, 'はやい']].map(([v, l]) => opt(v, ttsRate(), l)).join('')}</select></label>
      ${isParentRole() ? '' : `<label>🔍 確認モード（記録しないで試す・パパ／ママ用）
        <select id="cfm">${opt('off', s.confirm ? 'on' : 'off', 'OFF（まなの記録をつける）')}${opt('on', s.confirm ? 'on' : 'off', 'ON（記録しない）')}</select></label>`}
    </section>
    <section class="form">
      <h2 class="sec">✍️ 手書き</h2>
      <label>答えを指やペンで書く
        <select id="hw">${opt('auto', s.handwriting, `自動（タブレットはON）${isTablet() ? '…いまON' : '…いまOFF'}`)}${opt('on', s.handwriting, 'ON')}${opt('off', s.handwriting, 'OFF')}</select></label>
      <label>書いた字を読み取って答え合わせ（AI）
        <select id="rc">${opt('on', s.recognition, 'ON（AIが読んで答え合わせ）')}${opt('off', s.recognition, 'OFF（自分で答え合わせ）')}</select></label>
      <p class="small" id="rcInfo">「答え合わせ」を押したときだけ、書いた字の画像を Google の AI（Firebase AI Logic / Gemini）に送って読み取ります。送るのは画像だけで、名前やメールは送りません。画像は保存しません。
      読み取れないとき・1日の上限に達したときは、自分で答え合わせになります。AIの読みまちがいは「🙆 あってたよ」で直せます。${appCheckSiteKey ? '' : '<br>※ App Check の設定がまだなので、AIでの読み取りは使えません。'}</p>
      <p class="small recaptcha-note">このサイトは reCAPTCHA で保護されています（Google の<a href="https://policies.google.com/privacy" target="_blank" rel="noopener">プライバシーポリシー</a>と<a href="https://policies.google.com/terms" target="_blank" rel="noopener">利用規約</a>が適用されます）。</p>
    </section>
    </div><div>
    <section class="form" id="cloudBox"></section>
    <section class="form">
      <h2 class="sec">バックアップ</h2>
      <p class="small">機種変更するときは「書き出す」でファイルを保存して、新しいスマホで「読みこむ」してね。</p>
      <button class="btn soft" id="ex">💾 書き出す</button>
      <label class="btn soft">📂 読みこむ<input type="file" id="im" accept="application/json" hidden></label>
      <button class="btn danger" id="rs">🗑 ぜんぶリセット</button>
    </section>
    <section class="form">
      <h2 class="sec">このアプリについて</h2>
      <p class="small">わすれかけたころに出てくる「間隔をあけた復習」（SM-2 という方法）で覚えます。<br>
      😢わからない → すぐにもう一度／🤔むずかしい → 少し早めに／😊わかった → ふつう／🤩かんたん → ずっとあとに</p>
    </section></div></div>
    ${nav('settings')}`;
  $('#np').onchange = (e) => store.setSetting('newPerDay', +e.target.value);
  $('#nn').onchange = (e) => store.setSetting('nickname', e.target.value.trim());
  $('#hw').onchange = (e) => store.setSetting('handwriting', e.target.value);
  $('#goal').onchange = (e) => store.setSetting('goal', +e.target.value);
  $('#tts').onchange = (e) => store.setSetting('ttsAuto', e.target.value === 'on');
  $('#voiceAns').onchange = (e) => store.setSetting('voiceAnswer', e.target.checked);
  $('#ttsr').onchange = (e) => store.setSetting('ttsRate', +e.target.value);
  const cfm = document.getElementById('cfm'); if (cfm) cfm.onchange = (e) => { store.setSetting('confirm', e.target.value === 'on'); route(); };
  $('#rc').onchange = (e) => store.setSetting('recognition', e.target.value);
  $('#ex').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([store.exportJSON()], { type: 'application/json' }));
    a.download = `anki-cards-backup-${dayToISO(dayIndex())}.json`; a.click();
  };
  $('#im').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { store.importJSON(await f.text()); alert('読みこんだよ！'); go('#/'); } catch (err) { alert('読みこめませんでした：' + err.message); }
  };
  $('#rs').onclick = () => { if (confirm('この端末の進み具合をぜんぶ消します。いいですか？') && confirm('ほんとうに消していい？')) { store.reset(); go('#/'); } };
  renderCloudBox();
}

// よくあるエラーを、保護者の方にもわかる言葉に
function errText(err) {
  const c = (err && (err.code || err.message)) || '';
  if (/unauthorized-domain/.test(c)) return `${c}（Firebase の「承認済みドメイン」に samtoshi.github.io を追加してください）`;
  if (/operation-not-allowed|admin-restricted-operation/.test(c)) return `${c}（Firebase でこのログイン方法がまだ有効になっていません）`;
  if (/popup-closed-by-user|cancelled-popup-request/.test(c)) return 'ログインの画面が閉じられました';
  if (/permission-denied/.test(c)) return `${c}（このアカウントには使う権限がありません）`;
  if (/no-content/.test(c)) return 'カードがまだアップロードされていません';
  return c;
}

function renderCloudBox() {
  const box = document.getElementById('cloudBox');
  if (!box || !USER) return;
  const link = store.data.cloud;
  const st = { idle: '待機中', syncing: '同期中…', ok: '同期ずみ', offline: 'オフライン（あとで送ります）', error: 'エラー' }[cloud.status] || '';
  const last = link && link.lastSync ? new Date(link.lastSync) : null;
  box.innerHTML = `<h2 class="sec">👤 アカウント</h2>
    <p class="small">${esc(USER.email || '')}<br>${ROLE === 'learner' ? '📒 この端末は「まな」として記録します' : '👀 見るだけ（記録は変えられません）'}</p>
    ${link ? `<p class="small">☁️ 状態：${st}${cloud.error ? `（${esc(errText({ code: cloud.error }))}）` : ''}<br>最後の同期：${last ? `${last.getMonth() + 1}/${last.getDate()} ${last.getHours()}:${String(last.getMinutes()).padStart(2, '0')}` : 'まだ'}・まだ送っていない記録：${store.data.pending.length}件</p>
    <button class="btn soft" id="syncNow">🔄 今すぐ同期</button>` : ''}
    <button class="btn danger" id="logout">ログアウト</button>`;
  const sn = document.getElementById('syncNow');
  if (sn) sn.onclick = async () => { await cloud.sync(); renderCloudBox(); };
  document.getElementById('logout').onclick = async () => {
    if (store.data.pending.length && !confirm(`まだ送っていない記録が${store.data.pending.length}件あります。ログアウトしますか？（この端末には残ります）`)) return;
    await signOut(); cloud.deactivate(); location.reload();
  };
}

function nav(active) {
  const item = (k, href, icon, label) => `<a href="${href}" class="${active === k ? 'on' : ''}"><span>${icon}</span>${label}</a>`;
  if (isParentRole()) return `<nav class="tabbar">${item('progress', '#/', '📊', '進み具合')}${item('rewards', '#/rewards', '🎁', '達成シール')}${item('cards', '#/cards', '🔍', 'カード')}${item('settings', '#/settings', '⚙️', 'せってい')}</nav>`;
  return `<nav class="tabbar">${item('home', '#/', '🏠', 'ホーム')}${item('review', '#/review', '📝', '見直し')}${item('rewards', '#/rewards', '🎁', '達成シール')}${item('progress', '#/progress', '📊', '進み具合')}${item('settings', '#/settings', '⚙️', 'せってい')}</nav>`;
}

// ---------- ルーター ----------

function go(h) { if (location.hash === h) route(); else location.hash = h; }

async function route() {
  const h = location.hash || '#/';
  if (unwatch) { try { unwatch(); } catch {} unwatch = null; }
  if (session) { stopMedia(session); if (session.pad) session.pad.destroy(); }
  session = null;
  if (!USER || !DECKS.length) return viewLogin();
  const parts = h.slice(2).split('/').map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (isParentRole()) {
    switch (parts[0]) {
      case 'settings': return viewSettings();
      case 'rewards': return viewRewards();
    case 'mistakes': return viewMistakes();
      case 'cards': return viewCards();
      case 'deck': return viewDeck(parts[1], parts[2] || '');
      case 'study': case 'cram': return startSession([parts[1]], parts[2] || '', true);
      default: return viewLive();
    }
  }
  switch (parts[0]) {
    case '': return viewHome();
    case 'deck': return viewDeck(parts[1], parts[2] || '');
    case 'study': return parts[1] === 'all' ? startSession(DECKS.map((d) => d.id), '', false) : startSession([parts[1]], parts[2] || '', false);
    case 'cram': return startSession([parts[1]], parts[2] || '', true);
    case 'review': return viewReviewPicker();
    case 'resume': return resumeSession();
    case 'mistakes': return viewMistakes();
    case 'progress': return viewProgress();
    case 'rewards': return viewRewards();
    case 'settings': return viewSettings();
    case 'live': return viewLive();
    default: return viewHome();
  }
}

document.addEventListener('keydown', (e) => {
  if (!session || !session.cur || e.target.tagName === 'INPUT') return;
  if (session.phase === 'q' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); const b = document.getElementById('reveal'); b && b.click(); }
  else if (session.phase === 'answer' || (session.phase === 'result' && (session.cur.result?.correct || session.cur.override))) {
    const k = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[e.key];
    if (k) doGrade(k);
  }
});

(async function main() {
  await store.init();
  cloud.onDmsg = () => { const box = document.getElementById('dailyArt'); if (box) box.innerHTML = dailyArtHtml(); };
  cloud.gameSummary = () => { const g = game(); return { v: 1, xp: g.xp, level: g.level, today: g.today, goal: g.goal, streak: g.streak, best: g.best, maxCombo: g.maxCombo, total: g.total, badges: g.badges, masteredUnits: g.masteredUnits, unitNames: g.unitNames, at: Date.now() }; };
  store.onChange(() => cloud.schedule());
  cloud.onStatus(() => { if ((location.hash || '').startsWith('#/settings')) renderCloudBox(); });
  window.addEventListener('online', () => cloud.sync());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') cloud.sync(); });
  window.addEventListener('hashchange', () => { if (USER) route(); });
  // タブを閉じる・別のアプリへ：とちゅうの勉強と記録をすぐ送る
  window.addEventListener('pagehide', () => { if (session && !session.confirm && session.cur) saveInprog(session); cloud.sync(); });
  // ほかの端末で変わった（とちゅうの勉強・はんい・記録）→ 勉強中でなければ画面を新しくする
  cloud.onRemote = (w) => {
    if (w.sel) applyRanges();
    if (session || !USER || !DECKS.length) return;
    const h = location.hash || '#/';
    if (h === '#/' || h === '#' || (w.sel && h.startsWith('#/deck/')) || (w.slog && /^#\/(rewards|progress)/.test(h))) route();
  };
  armSpeechGestures(); // iPad：タップのたびに読み上げの準備。始められなかった問題は次のタップで読む
  onSpeechBlocked((on) => { const b = document.getElementById('speakBtn'); if (b) b.classList.toggle('needs-tap', on && ttsAutoOn()); });
  try {
    await loadFirebase();
    await afterLogin();
  } catch (e) {
    if (!$app.querySelector('.login')) $app.innerHTML = `<p class="done-msg">はじめられませんでした（${esc(errText(e))}）。電波のよいところでもう一度ひらいてね。</p>`;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
