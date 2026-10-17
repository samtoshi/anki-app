# あんきカード（家族専用） 🐰

忘れかけたころにもう一度出してくれる（SM-2 方式の間隔反復）単語カードアプリです。
**家族の登録されたアカウントだけ** が使えます。このリポジトリにはアプリ本体（画面とプログラム）だけが入っていて、
カードの中身や記録は入っていません（ログインした家族だけが Firebase から読みます）。

- 公開URL：https://samtoshi.github.io/anki-app/
- ログイン：Google アカウントだけ（登録された家族の3人）
- 毎日の復習・📝 テスト前の見直し（回をえらんで、全部／苦手だけ）
- タブレットでは答えを指やペンで書ける（AI 読み取り・まちがえた字だけ書き直し：設定したときだけ）
- 記録はクラウド（Firestore）に保存。どの端末でも同じ記録で続けられ、保護者はリアルタイムで見られる（見るだけ）
- オフラインでも勉強できます（つながったときに送ります）

設定の手順は [docs/SETUP.md](docs/SETUP.md)。

## 開発

ビルド不要の静的サイト（HTML / CSS / JavaScript モジュール）。Firebase JS SDK 13.0.0 を CDN から読みます。

```sh
python3 -m http.server   # http://localhost:8000
npm test                 # 復習スケジュール・同期のマージ・苦手の選び方・読み取りの答え合わせのテスト
```

| ファイル | 役割 |
|---|---|
| `js/app.js` | 画面・ログイン |
| `js/cloud.js` | Firebase（ログイン・カードの読みこみ・記録の同期・リアルタイム表示） |
| `js/srs.js` | 復習スケジュール（SM-2）・忘却曲線 |
| `js/store.js` / `js/sync.js` | 端末の中の記録 |
| `js/merge.js` | 端末どうしの記録のマージ |
| `js/stats.js` / `js/review.js` | 進み具合の集計・苦手の判定 |
| `js/handwriting.js` / `js/recognize.js` / `js/grade.js` | 手書き・読み取り・1文字ずつの答え合わせ |
| `js/firebase-config.js` | Firebase の設定値（Web アプリ用の公開される前提の値） |

アプリ本体のファイルを変えたときは `sw.js` の `VERSION` を上げてください。
