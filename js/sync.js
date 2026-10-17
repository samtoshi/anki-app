// 進み具合の保存先（同期レイヤー）
//
// アプリは SyncAdapter のインターフェースだけを使います。
// いまは LocalStorageAdapter（この端末の中だけに保存）を使っています。
// あとで自動同期（Supabase / Firebase など）にしたくなったら、
// 同じメソッドを持つアダプターを作って createAdapter() で切りかえるだけです。
// くわしくは docs/SYNC.md を見てください。

/**
 * @interface SyncAdapter
 *   name: string
 *   load(): Promise<object|null>      保存されている全データを読む
 *   save(data: object): Promise<void> 全データを書く（書きこみはこの端末の持ち主だけ）
 *   publishSnapshot?(snap: object): Promise<string|null>
 *        保護者が見るための「進み具合のまとめ」を公開し、見るためのURLを返す（任意）
 */

const KEY = 'anki-cards:v1';

export class LocalStorageAdapter {
  constructor(key = KEY, storage = globalThis.localStorage) {
    this.name = 'local';
    this.key = key;
    this.storage = storage;
  }
  async load() {
    try {
      const raw = this.storage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('load failed', e);
      return null;
    }
  }
  async save(data) {
    this.storage.setItem(this.key, JSON.stringify(data));
  }
  // ローカル保存ではスナップショットの公開はできないので、共有リンク（share.js）を使う
  async publishSnapshot() { return null; }
}

export function createAdapter() {
  // 将来: if (window.ANKI_SYNC_CONFIG?.type === 'supabase') return new SupabaseAdapter(...)
  return new LocalStorageAdapter();
}
