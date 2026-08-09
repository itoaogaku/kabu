# かぶトラッカー(Vercel フロントエンド版)

見た目の良い URL で公開したい場合の構成です。データの保存・株価取得は
これまで通り [`../gas/`](../gas/) の Google Apps Script(スプレッドシート + Yahoo Finance)が
行い、ここにあるのは **Vercel でホストする静的なフロントエンド(画面)だけ** です。

```
ブラウザ ── (fetch) ──> Vercel (静的ファイルを配信するだけ)
ブラウザ ── (fetch) ──> GAS Web App (?action=... の JSON API) ──> Google スプレッドシート
```

Vercel 自体はデータを保存しない。バックエンドは引き続き GAS。

## 前提: GAS 側の準備

先に [`../gas/README.md`](../gas/README.md) の手順でGASのデプロイを済ませ、
「外部フロントエンド(Vercelなど)から呼び出す場合の JSON API」の節に従って

1. スクリプトプロパティ `API_TOKEN` を設定する
2. デプロイのアクセス権を「全員」にして再デプロイする
3. `/exec` で終わる Web アプリ URL を控える

を行っておくこと。この2つ(URLとトークン)がないと Vercel 側は動かない。

## Vercel へのデプロイ手順

1. このリポジトリを GitHub に push しておく(既に push 済みならOK)。
2. [vercel.com](https://vercel.com) に GitHub アカウントでログインする。
3. 「Add New...」→「Project」→ このリポジトリ(`itoaogaku/kabu`)を Import する。
4. プロジェクト設定画面で以下を指定する。
   - **Root Directory**: `web` (「Edit」を押してこのフォルダを選択する。これを忘れると
     リポジトリ直下を Vercel がビルドしようとしてしまう)
   - Framework Preset: 「Other」のままでよい(`web/vercel.json` に
     ビルドコマンド・出力ディレクトリが書いてあるので自動で使われる)
5. 「Environment Variables」で以下を追加する。
   - `GAS_API_URL` = GASのWebアプリ URL(`.../exec` で終わるもの)
   - `GAS_API_TOKEN` = GAS側で設定した `API_TOKEN` と同じ値
6. 「Deploy」をクリック。ビルドが終わると `https://(プロジェクト名).vercel.app` のような
   URL が発行され、そこでダッシュボードが使えるようになる。

## 動作確認

デプロイ後の URL を開いて、以前 GAS 単体で確認したのと同じように銘柄の追加・売却記録・
チャート表示ができれば成功。うまく表示されない場合は、ブラウザの開発者ツール(F12)の
コンソールにエラーが出ていないか確認する。

- 画面に「設定エラー: apiUrl が未設定です」と出る
  → Vercel の環境変数 `GAS_API_URL` が未設定、またはビルドが古い。環境変数を設定して
  「Redeploy」する。
- コンソールに `Failed to fetch` や CORS 関連のエラーが出る
  → GAS 側のデプロイのアクセス権が「全員」になっているか確認する。「自分のみ」のままだと
  Google のログイン画面が返ってきてしまい失敗する。
- レスポンスが `{"ok":false,"error":"unauthorized"}` になる
  → `GAS_API_TOKEN`(Vercel側)と `API_TOKEN`(GASのスクリプトプロパティ)が一致しているか
  確認する。

## コードを更新したとき

- `web/public/` 以下(画面側)を直接編集して push すれば、Vercel が自動で再デプロイする。
- `gas/Code.gs`(API側)を変更した場合は、GAS エディタ側でも同じ変更を反映して
  再デプロイする必要がある(Vercel の再デプロイだけでは GAS 側には反映されない)。

## ローカルで動作確認したい場合

```bash
cd web
cp public/config.example.js public/config.js
# public/config.js の apiUrl / token を実際の値に書き換える
python3 -m http.server 8000 --directory public
```

`http://localhost:8000` を開く。`public/config.js` は `.gitignore` 済みなのでコミットされない。

## ファイル構成

- `public/index.html` / `style.css` / `app.js` — 画面本体(GAS版の見た目・挙動を踏襲)
- `public/chart.umd.min.js` — Chart.js をローカル同梱(CDN不要)
- `public/favicon.ico` / `apple-touch-icon.png` / `icon-192.png` / `icon-512.png` / `manifest.json` —
  ブラウザタブおよびiPhone/Androidの「ホーム画面に追加」用アイコン。iOSでホーム画面に
  追加するとこのアイコンで独立したアプリのように起動する(Safariのアドレスバー等は非表示)
- `public/config.example.js` — ローカル動作確認用のテンプレート(`config.js` は各自作成)
- `build.js` — Vercel のビルド時に環境変数から `public/config.js` を生成するスクリプト
- `vercel.json` — ビルドコマンド・出力ディレクトリの指定
- `package.json` — `npm run build` で `build.js` を実行するだけの最小構成(依存パッケージなし)

## セキュリティについて

GAS 側のデプロイを「全員アクセス可」にするため、Web アプリ URL と `API_TOKEN` を
知っている人は誰でもこのスプレッドシートの株データを読み書きできる。

- `GAS_API_URL` と `GAS_API_TOKEN` は **リポジトリにコミットしない**(Vercel の環境変数のみに
  置く)。
- `API_TOKEN` は他人に推測されない十分ランダムな文字列にする。
- ブラウザの開発者ツールで `window.KABU_CONFIG` を見ればトークンが見えてしまうため、
  完全に秘匿はできない(あくまで簡易的な防御)。第三者に公開したくない場合は、
  Vercel プロジェクトを Public にリンクを広めない、または Vercel の
  [Password Protection](https://vercel.com/docs/deployment-protection)(Pro プラン以上)などを
  併用する。
