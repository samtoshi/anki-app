// Firebase の設定（docs/FIREBASE_SETUP.md の手順で作ったプロジェクトの値を入れます）
// ※ この値は公開されても大丈夫な設計です（守りは firestore.rules と App Check で行います）。
// 値が "YOUR_..." のままのときは、クラウド記録なし（この端末だけ＋共有リンク）で動きます。
export const firebaseConfig = {
  apiKey: 'AIzaSyCEmU1udKpvPLfeK6dzRc_89B2iHQ6rK-k',
  authDomain: 'anki-54902.firebaseapp.com',
  projectId: 'anki-54902',
  storageBucket: 'anki-54902.firebasestorage.app',
  messagingSenderId: '1050192493102',
  appId: '1:1050192493102:web:68a291191cb3687815fdbf',
};

// 手書きの読み取り（Firebase AI Logic / Gemini Developer API）で使うモデル
export const aiModel = 'gemini-3.5-flash';

// App Check：reCAPTCHA Enterprise のサイトキーを入れると有効になります。
// クラウド記録だけなら空でも動きます。AI読み取り（AI Logic）は、2026年7月以降の新しい設定では
// App Check が自動で「適用」になるため、このキーがないと読み取りが失敗します（失敗したら自分で答え合わせに戻ります）。
export const appCheckSiteKey = '';

export function isFirebaseConfigured(cfg = firebaseConfig) {
  return !!(cfg && cfg.apiKey && cfg.projectId && !String(cfg.apiKey).startsWith('YOUR') && !String(cfg.projectId).startsWith('YOUR'));
}
