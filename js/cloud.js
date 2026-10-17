// Firebase（Google ログイン ＋ Firestore）
// - 使えるのは家族の3人だけ（Firestore のルールで決めています。アプリ側の表示はその結果に合わせるだけ）
// - カードの中身は Firestore の content/... にあり、ログインした家族だけが読めます
// - 記録は「まな」1人分（learners/main）。まな・父（タブレット）が書けて、ママは見るだけ
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { mergeStates, mergeReviews } from './merge.js';

export const SDK_VERSION = '13.0.0';
const CDN = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
export const LID = 'main';
const CONTENT_KEY = 'anki-cards:content';

// テスト用：localhost のときだけ、エミュレーターにつなぐ設定を localStorage から読む
function emulatorCfg() {
  try {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) return null;
    return JSON.parse(localStorage.getItem('anki-cards:emulator') || 'null');
  } catch { return null; }
}
export const cloudEnabled = () => true;

let fbPromise = null;
/** Firebase を読みこむ（ログインはしない） */
export function loadFirebase() {
  if (!fbPromise) fbPromise = (async () => {
    const appM = await import(CDN + 'firebase-app.js');
    const emu = emulatorCfg();
    const app = appM.initializeApp(emu ? { apiKey: 'demo-key', projectId: emu.projectId, appId: 'demo', authDomain: 'localhost' } : firebaseConfig);
    let appCheck = null;
    if (appCheckSiteKey && !emu) {
      // App Check はほかのサービスより先に。失敗してもログインと記録はそのまま使える
      try {
        const ac = await import(CDN + 'firebase-app-check.js');
        appCheck = ac.initializeAppCheck(app, { provider: new ac.ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
      } catch (e) { console.warn('App Check', e); }
    }
    const authM = await import(CDN + 'firebase-auth.js');
    const fs = await import(CDN + 'firebase-firestore.js');
    const auth = authM.initializeAuth(app, {
      persistence: [authM.indexedDBLocalPersistence, authM.browserLocalPersistence],
      popupRedirectResolver: authM.browserPopupRedirectResolver,
    });
    auth.languageCode = 'ja';
    const db = fs.getFirestore(app);
    if (emu) {
      authM.connectAuthEmulator(auth, `http://${emu.host}:${emu.authPort}`, { disableWarnings: true });
      fs.connectFirestoreEmulator(db, emu.host, emu.fsPort);
    }
    await auth.authStateReady();
    return { app, auth, authM, fs, db, appCheck };
  })().catch((e) => { fbPromise = null; throw e; });
  return fbPromise;
}

// ---------- ログイン ----------

export async function currentUser() { const fb = await loadFirebase(); return fb.auth.currentUser; }

export async function signInGoogle() {
  const fb = await loadFirebase();
  const p = new fb.authM.GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  try { return await fb.authM.signInWithPopup(fb.auth, p); }
  catch (e) {
    // ポップアップが開けないときは、ページごと移動するログインにする
    if (/popup-blocked|operation-not-supported/.test(e.code || '')) return fb.authM.signInWithRedirect(fb.auth, p);
    throw e;
  }
}

export async function signOut() {
  const fb = await loadFirebase();
  localStorage.removeItem(CONTENT_KEY); // カードの中身はこの端末に残さない
  await fb.authM.signOut(fb.auth);
}

// ---------- カードの中身 ----------

/** content/manifest とカードを読む。オフラインのときは前回の分を使う */
export async function loadContent() {
  const fb = await loadFirebase();
  const uid = fb.auth.currentUser?.uid;
  try {
    const ms = await fb.fs.getDoc(fb.fs.doc(fb.db, 'content', 'manifest'));
    if (!ms.exists()) throw Object.assign(new Error('カードがまだアップロードされていません'), { code: 'no-content' });
    const manifest = ms.data();
    const units = {};
    await Promise.all(manifest.decks.flatMap((d) => d.units.map(async (u) => {
      const s = await fb.fs.getDoc(fb.fs.doc(fb.db, 'content', u.doc));
      units[u.doc] = s.exists() ? s.data() : { cards: [] };
    })));
    const data = { uid, at: Date.now(), manifest: { ...manifest, updatedAt: null }, units };
    try { localStorage.setItem(CONTENT_KEY, JSON.stringify(data)); } catch {}
    return data;
  } catch (e) {
    if (e.code === 'permission-denied' || e.code === 'no-content') throw e;
    const cached = JSON.parse(localStorage.getItem(CONTENT_KEY) || 'null');
    if (cached && cached.uid === uid) return { ...cached, offline: true };
    throw e;
  }
}

/** ログインしている人の役割（ルールで読めた manifest の roles から。表示用） */
export function roleOf(manifest, email) {
  return (manifest.roles || {})[String(email || '').toLowerCase()] || 'parent';
}

// ---------- 同期 ----------

export class CloudSync {
  constructor(store) {
    this.store = store;
    this.status = 'idle'; // idle | syncing | ok | offline | error
    this.error = '';
    this.timer = null;
    this.listeners = new Set();
  }
  get link() { return this.store.data.cloud; }
  onStatus(fn) { this.listeners.add(fn); }
  setStatus(s, err = '') { this.status = s; this.error = err; for (const f of this.listeners) try { f(s); } catch {} }

  refs(fb) {
    const { fs, db } = fb;
    return {
      state: fs.doc(db, 'learners', LID, 'data', 'state'),
      reviews: fs.collection(db, 'learners', LID, 'reviews'),
      review: (id) => fs.doc(db, 'learners', LID, 'reviews', id),
      rewards: fs.doc(db, 'learners', LID, 'data', 'rewards'),
      spend: fs.collection(db, 'learners', LID, 'spend'),
    };
  }

  /**
   * この端末で「まな」として記録する（まな・父のアカウント）。
   * 以前の記録（端末の中の分・以前の匿名ログインのときの分）は、最初の1回にまとめて送る（＝引っ越し）
   */
  async activate(user) {
    const link = this.store.data.cloud;
    if (link && link.lid === LID && link.uid === user.uid) return this.sync();
    this.store.data.cloud = { lid: LID, role: 'writer', uid: user.uid, email: user.email, pullT: 0, lastSync: 0, migratedAt: Date.now() };
    this.store.data.pending = this.store.data.reviews.map((e) => e.id);
    this.store.save();
    return this.sync();
  }

  /** この端末は記録しない（ママ＝見るだけ、またはログアウト） */
  deactivate() { this.store.data.cloud = null; this.store.save(); this.setStatus('idle'); }

  schedule(ms = 2500) {
    if (!this.link) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync().catch(() => {}), ms);
  }

  /** 引っぱる → まぜる → 送る */
  async sync() {
    if (!this.link || this.link.role !== 'writer') return;
    if (this.running) return this.running;
    if (globalThis.navigator && navigator.onLine === false) { this.setStatus('offline'); return; }
    this.running = (async () => {
      this.setStatus('syncing');
      try {
        const fb = await loadFirebase();
        if (!fb.auth.currentUser) { this.setStatus('error', 'ログインしていません'); return; }
        const { fs } = fb;
        const store = this.store, data = store.data, link = this.link;
        const r = this.refs(fb);
        // 1) 引っぱる
        const snap = await fs.getDoc(r.state);
        const remote = snap.exists() ? snap.data() : {};
        // 今日のひとこと：同じ日なら先に作った方にそろえる（どの端末でも同じものを出す）
        if (remote.dmsg && remote.dmsg.day && (!data.dmsg || remote.dmsg.day > data.dmsg.day || (remote.dmsg.day === data.dmsg.day && (remote.dmsg.at || 0) < (data.dmsg.at || 0)))) { data.dmsg = remote.dmsg; this.onDmsg && this.onDmsg(); }
        const m = mergeStates(data.states, remote.states || {});
        data.states = m.states;
        const since = Math.max(0, (link.pullT || 0) - 3600e3);
        const rs = await fs.getDocs(fs.query(r.reviews, fs.where('t', '>=', since)));
        const remoteReviews = rs.docs.map((d) => ({ id: d.id, ...d.data() }));
        const mr = mergeReviews(data.reviews, remoteReviews);
        data.reviews = mr.reviews;
        const maxT = remoteReviews.reduce((a, e) => Math.max(a, e.t || 0), link.pullT || 0);
        store._cache = null;
        // 2) 送る（記録は1件ずつのドキュメント、カードの状態と集計は1つのドキュメント）
        const pendingSet = new Set(data.pending);
        const toSend = data.reviews.filter((e) => pendingSet.has(e.id));
        for (let i = 0; i < toSend.length; i += 400) {
          const b = fs.writeBatch(fb.db);
          for (const e of toSend.slice(i, i + 400)) {
            const { id, ...rest } = e;
            const clean = Object.fromEntries(Object.entries(rest).filter(([k, v]) => 'cdkgtmnxa'.includes(k) && k.length === 1 && v !== undefined));
            b.set(r.review(id), clean);
          }
          await b.commit();
          // 送れた分はすぐ「送信ずみ」にする（このあと失敗しても、二重に送らないように）
          const done = new Set(toSend.slice(i, i + 400).map((e) => e.id));
          data.pending = data.pending.filter((id) => !done.has(id));
          store.save();
        }
        const d = store.derived;
        const statesPush = {};
        for (const id of m.push) statesPush[id] = data.states[id];
        // 注意：merge:true で空の {} を送ると states 全体が {} に上書きされるので、送るものがある時だけ入れる
        await fs.setDoc(r.state, {
          ...(Object.keys(statesPush).length ? { states: statesPush } : {}),
          daily: d.daily,
          lastGrades: d.lastGrades,
          charMiss: d.charMiss,
          ...(this.gameSummary ? { game: this.gameSummary() } : {}),
          ...(data.dmsg ? { dmsg: data.dmsg } : {}),
          nickname: store.settings.nickname || '',
          updatedAt: fs.serverTimestamp(),
          clientAt: Date.now(),
        }, { merge: true });
        link.pullT = Math.max(maxT, ...toSend.map((e) => e.t), link.pullT || 0);
        link.lastSync = Date.now();
        store.save();
        if (m.pulled.length || mr.added) store.changed();
        this.setStatus('ok');
      } catch (e) {
        console.warn('sync failed', e);
        this.setStatus(navigator.onLine === false ? 'offline' : 'error', e.code || e.message);
      } finally { this.running = null; }
    })();
    return this.running;
  }

  /** リアルタイムで見る。cb(srcData, meta) */
  async watch(cb, onErr) {
    const fb = await loadFirebase();
    return fb.fs.onSnapshot(this.refs(fb).state, (snap) => {
      const d = snap.exists() ? snap.data() : {};
      cb({ states: d.states || {}, daily: d.daily || {}, lastGrades: d.lastGrades || {}, charMiss: d.charMiss || {}, game: d.game || null, dmsg: d.dmsg || null, settings: { nickname: d.nickname || '' } },
        { at: d.clientAt || null, exists: snap.exists() });
    }, (e) => onErr && onErr(e));
  }

  // ---------- ごほうび（シール） ----------
  /** ごほうびの一覧と、シールを使う申しこみを見つづける。cb({items, spends}) */
  async watchRewards(cb, onErr) {
    const fb = await loadFirebase();
    const r = this.refs(fb);
    let items = {}, spends = [];
    const u1 = fb.fs.onSnapshot(r.rewards, (snap) => { items = (snap.exists() && snap.data().items) || {}; cb({ items, spends }); }, (e) => onErr && onErr(e));
    const u2 = fb.fs.onSnapshot(r.spend, (q) => { spends = q.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.t - a.t); cb({ items, spends }); }, (e) => onErr && onErr(e));
    return () => { u1(); u2(); };
  }
  async saveRewards(items) {
    const fb = await loadFirebase();
    await fb.fs.setDoc(this.refs(fb).rewards, { items, updatedAt: Date.now() });
  }
  async requestSpend(id, item) {
    const fb = await loadFirebase();
    await fb.fs.addDoc(this.refs(fb).spend, { r: id, name: item.name, cost: item.cost, t: Date.now(), st: 'req' });
  }
  async decideSpend(sid, ok) {
    const fb = await loadFirebase();
    await fb.fs.updateDoc(fb.fs.doc(fb.db, 'learners', LID, 'spend', sid), { st: ok ? 'ok' : 'no', dt: Date.now() });
  }
}
