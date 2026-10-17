import { GRADES, dayIndex, dayToISO, previewLabel, buildQueue, cardStatus, isDue } from './srs.js';
import { Store } from './store.js';
import { computeStats } from './stats.js';
import { selectReviewCards, isWeak } from './review.js';
import { check, redoPlan, applyRedo, autoGrade, isGradable, readingOf, isKanji, writeTarget, normalize } from './grade.js';
import { HandPad, isTablet } from './handwriting.js';
import { availableEngine, recognize } from './recognize.js';
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
const isParentRole = () => ROLE === 'parent';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl = (s) => esc(s).replace(/\n/g, '<br>');
const $ = (sel) => $app.querySelector(sel);

// ---------- データ ----------

async function loadDecks() {
  CONTENT = await loadContent();
  const m = CONTENT.manifest;
  DECKS = m.decks.map((d) => {
    const units = d.units.map((u) => ({ ...u, cards: (CONTENT.units[u.doc] || {}).cards || [], latest: !d.latest || d.latest.includes(u.kai) }));
    const cur = units.filter((u) => u.latest);
    return { ...d, units, cards: cur.flatMap((u) => u.cards), allCards: units.flatMap((u) => u.cards) };
  });
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
    const cur = d.units.filter((u) => u.latest && u.kai != null).map((u) => `第${u.kai}回 ${esc(u.name)}`).join('・');
    return `<a class="deck" href="#/deck/${d.id}" style="--c:${d.color}">
      <div class="deck-emoji">${d.emoji}</div>
      <div class="deck-body">
        <div class="deck-name">${esc(d.name)} <small>${cur || ''} ${c.total}まい</small></div>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div class="deck-meta">復習 <b>${c.due}</b>・新しい <b>${nNew}</b>・覚えた ${c.mastered}</div>
      </div><div class="chev">›</div></a>`;
  }).join('');
  const todo = totalDue + totalNew;
  $app.innerHTML = `
    <header class="hero">
      <div class="mascot">🐰</div>
      <p class="greet">${greeting()}</p>
      <div class="streak">🔥 ${st.streak}日れんぞく</div>
    </header>
    <div class="home-grid">
    <section class="today">
      <div class="today-num">${todo}<small>まい</small></div>
      <div class="today-label">今日の復習</div>
      ${todo ? `<a class="btn big primary" href="#/study/all">🌸 今日の復習をはじめる</a>`
             : `<p class="done-msg">今日の分はおわり！えらい！✨</p>`}
      <a class="btn big soft" href="#/review">📝 テスト前見直し</a>
    </section>
    <section>
    <h2 class="sec">デッキ</h2>
    <div class="decks">${deckHtml}</div>
    </section></div>
    ${nav('home')}`;
}

function viewDeck(id, tag = '') {
  const d = deckById(id);
  if (!d) return go('#/');
  const today = dayIndex();
  const tags = tagsOf(d);
  const cards = filterCards(d, tag);
  const c = counts(cards, today);
  const nNew = Math.min(c.fresh, store.newLeft(d.id, today));
  const chips = tags.length > 1 ? `<div class="chips">
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
    <header class="bar-top" style="--c:${d.color}"><a href="#/" class="back">‹</a><h1>${d.emoji} ${esc(d.name)}</h1></header>
    ${chips}
    <section class="stat-row">
      <div><b>${c.due}</b><span>復習</span></div>
      <div><b>${nNew}</b><span>今日の新しい</span></div>
      <div><b>${c.mastered}</b><span>覚えた</span></div>
      <div><b>${c.total}</b><span>ぜんぶ</span></div>
    </section>
    <div class="actions">
      ${c.due + nNew ? `<a class="btn big primary" href="#/study/${d.id}${tag ? '/' + encodeURIComponent(tag) : ''}">🌸 今日の復習（${c.due + nNew}まい）</a>`
                    : `<p class="done-msg">このデッキの今日の分はおわり！🎉</p>`}
      <a class="btn big soft" href="#/cram/${d.id}${tag ? '/' + encodeURIComponent(tag) : ''}">🔁 ぜんぶ練習</a>
      <p class="small">「ぜんぶ練習」と「テスト前見直し」は、復習の予定を変えずに記録だけ残します。</p>
    </div>
    <h2 class="sec">カード一覧 <small>⚪新しい 🟡学習中 🌟覚えた</small></h2>
    <div class="list">${list}</div>
    <p class="small src">${esc(d.source || '')}</p>
    ${nav('home')}`;
}

// ---------- テスト前見直し ----------

function viewReviewPicker() {
  const decks = DECKS;
  const sel = reviewSel || (reviewSel = { deck: decks[0].id, kai: null, mode: 'all' });
  const d = deckById(sel.deck) || decks[0];
  const units = d.units;
  if (!sel.kai || sel.deck !== d.id) sel.kai = units.map((u) => u.kai);
  const grades = store.derived.lastGrades;
  const chosen = units.filter((u) => sel.kai.includes(u.kai));
  const cards = chosen.flatMap((u) => u.cards);
  const weakN = selectReviewCards(cards, store.data.states, grades, 'weak').length;
  const n = sel.mode === 'weak' ? weakN : cards.length;
  const unitRows = units.map((u) => {
    const m = u.cards.filter((c) => cardStatus(store.state(c.id)) === 'mastered').length;
    const w = selectReviewCards(u.cards, store.data.states, grades, 'weak').length;
    const on = sel.kai.includes(u.kai);
    return `<button class="unit ${on ? 'on' : ''}" data-kai="${u.kai}">
      <span class="check">${on ? '✅' : '⬜'}</span>
      <span class="u-name">${u.kai != null ? `第${u.kai}回 ` : ''}${esc(u.name)} ${u.latest && u.kai != null ? '<span class="new-badge">さいしん</span>' : ''}</span>
      <span class="u-meta">${u.cards.length}まい・🌟${m}・苦手 ${w}</span></button>`;
  }).join('');
  $app.innerHTML = `
    <header class="bar-top"><h1>📝 テスト前見直し</h1></header>
    <p class="small">えらんだ回のカードをまとめて見直せます。復習の予定は変わりません（記録は残ります）。</p>
    <div class="chips">${decks.map((x) => `<button class="chip ${x.id === d.id ? 'on' : ''}" data-deck="${x.id}">${x.emoji} ${esc(x.name)}</button>`).join('')}</div>
    <h2 class="sec">回をえらぶ <small>（いくつでも）</small></h2>
    <div class="units">${unitRows}</div>
    <h2 class="sec">どれをやる？</h2>
    <div class="seg">
      <button class="${sel.mode === 'all' ? 'on' : ''}" data-mode="all">ぜんぶ（${cards.length}）</button>
      <button class="${sel.mode === 'weak' ? 'on' : ''}" data-mode="weak">苦手だけ（${weakN}）</button>
    </div>
    <p class="small">苦手＝わすれたことがある・覚えにくい・最後に「わからない」「むずかしい」を押したカード</p>
    <button class="btn big primary" id="go" ${n ? '' : 'disabled'}>📝 ${n}まい 見直す</button>
    ${nav('review')}`;
  $app.querySelectorAll('[data-deck]').forEach((b) => (b.onclick = () => { sel.deck = b.dataset.deck; sel.kai = null; viewReviewPicker(); }));
  $app.querySelectorAll('[data-kai]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.kai === 'null' ? null : +b.dataset.kai;
    sel.kai = sel.kai.includes(k) ? sel.kai.filter((x) => x !== k) : [...sel.kai, k];
    viewReviewPicker();
  }));
  $app.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { sel.mode = b.dataset.mode; viewReviewPicker(); }));
  $('#go').onclick = () => {
    let list = selectReviewCards(cards, store.data.states, grades, sel.mode).map((c) => ({ card: c, deck: d }));
    shuffle(list);
    startWith(list, 'review', '#/review');
  };
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

function startWith(items, kind, back) {
  session = { items, i: 0, kind, done: 0, again: 0, total: items.length, back, engine: null };
  availableEngine(store.settings).then((e) => { if (session) { session.engine = e; if (session.phase === 'q') renderBottom(); } });
  renderCard();
}

const logMode = () => (session.kind === 'study' ? 's' : 'r');

function renderCard() {
  const s = session;
  if (!s) return go('#/');
  if (s.pad) { s.pad.destroy(); s.pad = null; }
  if (s.i >= s.items.length) return renderDone();
  const { card, deck } = s.items[s.i];
  // 「書いて答える」カード（四字熟語など）は、手書きを OFF にしていない限り、スマホでも手書きにする
  const hw = hwOn() || (writeDefault(card) && store.settings.handwriting !== 'off');
  s.phase = 'q'; s.hint = false; s.cur = { start: Date.now(), plan: null, miss: new Set(), tries: 0, recog: '', result: null, fixed: false, sugg: null, img: null, override: false };
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
    </header>
    <div class="study-grid">
      <main class="card-wrap"><div class="card" id="card" style="--c:${deck.color}"></div></main>
      ${hw ? '<section class="pad" id="pad"></section>' : ''}
    </div>
    <footer class="study-bottom" id="bottom"></footer>
    </div>`;
  if (hw) {
    const cells = writeMode ? [...card.w].length : null;
    s.pad = new HandPad($('#pad'), {
      dir: store.settings.hwDir || 'h', masu: writeMode || !!store.settings.hwMasu, cells,
      onChange: (what) => {
        if (what === 'dir') store.setSetting('hwDir', s.pad.dir);
        if (what === 'masu') store.setSetting('hwMasu', s.pad.masu);
      },
    });
  }
  renderFace();
  renderBottom();
}

function renderFace() {
  const s = session, c = s.cur;
  const { card, deck } = s.items[s.i];
  const isNew = cardStatus(store.state(card.id)) === 'new';
  const yoji = deck.id === 'yoji';
  const tagLine = (card.tags || []).filter((t) => t !== '四字熟語').join('・');
  const badge = s.kind === 'study' ? (isNew ? '<span class="new-badge">NEW</span>' : '') : `<span class="cram-badge">${s.kind === 'review' ? '見直し' : '練習'}</span>`;
  let q;
  const big = yoji && !card.qsub; // 以前の形（熟語を見て意味を答える）だけ大きく表示
  const sub = card.qsub || (big ? '読みと意味は？' : '');
  if (c.writeMode) q = `<div class="q">${nl(card.wq)}</div>${card.qsub && s.phase === 'q' ? `<div class="q-sub">${esc(card.qsub)}</div>` : ''}${s.hint ? `<div class="hint">💭 ${nl(card.whint)}</div>` : ''}`;
  else q = `<div class="q ${big ? 'yoji' : ''}">${nl(card.q)}</div>${sub && s.phase === 'q' ? `<div class="q-sub">${esc(sub)}</div>` : ''}${s.hint && card.hint ? `<div class="hint">💭 ${nl(card.hint)}</div>` : ''}`;
  let body = '';
  if (s.phase === 'checking') body = '<div class="checking">🔍 よみとり中…</div>';
  if (s.phase === 'result' || s.phase === 'redo' || s.phase === 'answer') body = resultHtml();
  $('#card').innerHTML = `<div class="card-tags">${deck.emoji} ${esc(deck.name)}${tagLine ? '・' + esc(tagLine) : ''} ${badge}</div>${q}${body}`;
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
    return `<div class="a">${c.result && !c.result.correct ? `<div class="recog">よみとり：<span class="chars">${diffHtml(c.result)}</span></div>` : ''}
      <div class="a-row">${mine}<div class="a-box">${answerHtml(card)}</div></div></div>`;
  }
  if (s.phase === 'redo') {
    const p = c.plan;
    const hint = readingOf(card);
    return `<div class="a"><div class="verdict redo">✏️ ${p.tries ? 'あと少し！' : ''}${p.blanks.length}文字だけ、もう一度書いてみよう</div>
      <div class="mask">${maskHtml(p)}</div>
      ${p.kanjiOnly && hint ? `<div class="hint">💭 読み：${esc(hint)}</div>` : ''}
      <p class="small">番号のじゅんに、マスに書いてね（${p.tries}/3回）</p></div>`;
  }
  // result
  const r = c.result;
  if (r && (r.correct || c.override)) {
    return `<div class="a"><div class="verdict ok">⭕ ${c.fixed ? 'なおせたね！' : c.override ? 'OK！' : 'せいかい！'}</div>
      <div class="a-row">${mine}<div class="a-box">${answerHtml(card)}</div></div></div>`;
  }
  return `<div class="a"><div class="verdict ng">${c.plan ? '🔎 おしい！' : '🙈 ちがうみたい'}</div>
    <div class="recog">よみとり：<span class="chars">${r && r.got ? diffHtml(r) : '（よめなかった）'}</span></div>
    ${c.plan ? `<div class="mask">${maskHtml(c.plan)}</div><p class="small">赤い字・？のところがちがうよ</p>` : ''}
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
  if (s.phase === 'q') {
    b.innerHTML = `<div class="pre">${hintAvail && !s.hint ? '<button class="btn soft" id="hint">💭 ヒント</button>' : ''}
      ${canAuto ? '<button class="btn soft" id="reveal">こたえを見る</button><button class="btn big primary" id="checkBtn">✍️ 答え合わせ</button>'
                : '<button class="btn big primary" id="reveal">こたえを見る 👀</button>'}</div>`;
  } else if (s.phase === 'checking') {
    b.innerHTML = '<div class="pre"><button class="btn big soft" disabled>🔍 よみとり中…</button></div>';
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
  on('reveal', () => { c.img = s.pad ? s.pad.thumbnail() : null; if (c.result == null && s.pad && !s.pad.isEmpty() && s.engine && isGradable(card)) c.sugg = null; s.phase = 'answer'; refresh(); });
  on('checkBtn', () => doCheck());
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
  let text;
  const target = redo ? c.plan.expected : normalize(String(writeTarget(card)).replace(/[（(][^）)]*[）)]/g, ''));
  const ctx = { cells: s.pad.masu && s.pad.cells ? s.pad.cells : null, len: [...target].length, kanji: [...target].some(isKanji) };
  try { text = await recognize(s.engine, s.pad, ctx); }
  catch (e) {
    console.warn(e);
    const code = e && e.code;
    toast(code === 'ai-quota' ? '今日のAI読み取りはおしまい。自分で答え合わせしてね'
      : code === 'ai-offline' ? '電波がないので、自分で答え合わせしてね'
      : code === 'ai-appcheck' ? 'AIの読み取りがいま使えません。自分で答え合わせしてね'
      : 'よみとりできなかったよ。自分で答え合わせしてね');
    if (code === 'ai-quota' || code === 'ai-appcheck') s.engine = null; // この回のあとは自己採点で進める
    s.phase = 'answer'; c.sugg = null; refresh(); return;
  }
  if (session !== s) return;
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
  store.grade(card, deck.id, g, { mode: logMode(), miss, auto: !!c.result });
  s.done++;
  if (g === 'again') { s.again++; s.items.splice(Math.min(s.items.length, s.i + 4), 0, s.items[s.i]); }
  s.i++;
  if (navigator.vibrate) try { navigator.vibrate(8); } catch (e) {}
  renderCard();
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
      ${s.kind === 'study' ? '<p class="small">わすれかけたころに、また出してあげるね 🐰</p>' : ''}
      <a class="btn big primary" href="#/">ホームへ</a>
      ${s.kind === 'review' ? '<a class="btn big soft" href="#/review">📝 見直しにもどる</a>' : ''}
      <a class="btn big soft" href="#/progress">📊 進み具合を見る</a>
    </main>`;
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
      <div class="pdeck-h">${d.emoji} <b>${esc(d.name)}</b> <small>${d.total}まい・今日の復習 ${d.due}</small></div>
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

function viewProgress() {
  $app.innerHTML = `
    <header class="bar-top"><h1>📊 進み具合</h1></header>
    ${progressHtml(stats())}
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
      box.innerHTML = `<p class="snap-time">${last ? `最後に勉強した日 ${esc(last)}` : 'まだ記録がありません'}</p>${progressHtml(st)}`;
    }, (e) => { const box = document.getElementById('live'); if (box) box.innerHTML = `<p class="done-msg">読みこめませんでした（${esc(errText(e))}）</p>`; });
  } catch (e) { $('#live').innerHTML = `<p class="done-msg">つながりませんでした（${esc(errText(e))}）</p>`; }
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
  if (isParentRole()) return `<nav class="tabbar">${item('progress', '#/', '📊', '進み具合')}${item('settings', '#/settings', '⚙️', 'せってい')}</nav>`;
  return `<nav class="tabbar">${item('home', '#/', '🏠', 'ホーム')}${item('review', '#/review', '📝', '見直し')}${item('progress', '#/progress', '📊', '進み具合')}${item('settings', '#/settings', '⚙️', 'せってい')}</nav>`;
}

// ---------- ルーター ----------

function go(h) { if (location.hash === h) route(); else location.hash = h; }

async function route() {
  const h = location.hash || '#/';
  if (unwatch) { try { unwatch(); } catch {} unwatch = null; }
  if (session && session.pad) { session.pad.destroy(); }
  session = null;
  if (!USER || !DECKS.length) return viewLogin();
  const parts = h.slice(2).split('/').map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (isParentRole()) return parts[0] === 'settings' ? viewSettings() : viewLive();
  switch (parts[0]) {
    case '': return viewHome();
    case 'deck': return viewDeck(parts[1], parts[2] || '');
    case 'study': return parts[1] === 'all' ? startSession(DECKS.map((d) => d.id), '', false) : startSession([parts[1]], parts[2] || '', false);
    case 'cram': return startSession([parts[1]], parts[2] || '', true);
    case 'review': return viewReviewPicker();
    case 'progress': return viewProgress();
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
  store.onChange(() => cloud.schedule());
  cloud.onStatus(() => { if ((location.hash || '').startsWith('#/settings')) renderCloudBox(); });
  window.addEventListener('online', () => cloud.sync());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') cloud.sync(); });
  window.addEventListener('hashchange', () => { if (USER) route(); });
  try {
    await loadFirebase();
    await afterLogin();
  } catch (e) {
    if (!$app.querySelector('.login')) $app.innerHTML = `<p class="done-msg">はじめられませんでした（${esc(errText(e))}）。電波のよいところでもう一度ひらいてね。</p>`;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
