# Firebase の設定（保護者の方の作業）

画面のボタン名は 2026年10月時点の公式ドキュメントにもとづいています。（ ）の日本語名は目安で、確実ではありません。

## A. ログインの設定（必須）

1. Firebase コンソール → **Security → Authentication** →「**Sign-in method**」（ログイン方法）タブ
2. 「**Add new provider**」（新しいプロバイダを追加）→ **Google** → **Enable**（有効にする）→ サポートメールに自分のメールをえらぶ → Save
3. 「Add new provider」→ **Email/Password**（メール/パスワード）→
   - 上の「Email/Password」を **Enable**
   - 下の「**Email link (passwordless sign-in)**」（メールリンク）も **Enable** → Save
   - ※ メールリンクを使うには、上の Email/Password も有効にする必要があります（カード書きこみ専用アカウントもこれを使います）
4. 「**Settings**」（設定）タブ →「**Authorized domains**」（承認済みドメイン）→「Add domain」→ **`samtoshi.github.io`** を追加
5. 終わったら知らせてください（カード書きこみ専用アカウントを作って、カードをアップロードします）

## B. セキュリティルール（必須）

1. **Databases & Storage → Firestore** →「**Rules**」（ルール）タブ
2. 中身を全部消して、送られてきた（非公開リポジトリ `anki-cards-content` の）`firestore.rules` を全部はりつける →「**Publish**」（公開）

このルールで、登録された3つのアカウント以外は（ログインできても）カードも記録も読めません。

## C. 引っ越しがすんだら

1. 勉強に使う端末（まなのスマホ・父のアカウントのタブレット）で新しいアプリを開いてログイン
   → その端末に残っていた記録が、自動でクラウドの「まな」の記録にまとめられます
2. 全部の端末で引っ越しがすんだら、**Security → Authentication → Sign-in method → Anonymous（匿名）→ 無効** にする
3. （任意）Firestore の「Data」タブで、以前の匿名ログイン時代の `learners/…`（`main` 以外）と `invites` を削除

## D. AI 機能（任意）

手書きの AI 読み取りを使うときだけ：AI Services → AI Logic → Get started → Gemini Developer API、
さらに App Check（reCAPTCHA Enterprise）の設定が必要です（くわしい手順は別にお知らせします）。
設定しなくても、アプリは自分で答え合わせする形でそのまま使えます。

## 注意

- メールのリンクでログインするときは、**リンクを送ったのと同じ端末** で開くのがかんたんです（別の端末で開くと、メールアドレスを聞かれます）
- 見覚えのない「メールアドレスを確認してください」というメールが Firebase から届いたら、リンクを押さずに削除してください
