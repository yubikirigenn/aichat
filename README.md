# Nemotron Workspace

Render からそのまま公開できる、画像入力とワークスペース機能を備えたチャットです。

## 構成

```text
ブラウザ
  └─ /api/chat（同一オリジン、アクセスパスワードを送信）
        ↓
      Render の server.mjs（許可リストで選択モデルを検証）
        ├─ Render環境変数の GROQ_API_KEY → Groq
        ├─ Render環境変数の BAI_API_KEY → B.AI
        ├─ Render環境変数の EXPERIENTIAL_LABS_API_KEY → Experiential Labs
        └─ Render環境変数の OPENROUTER_API_KEY → OpenRouter
```

ブラウザの JavaScript は各プロバイダへ直接アクセスせず、`/api/chat` と `/api/diagnostics` にだけ接続します。APIキーはRenderの環境変数にだけ置き、ブラウザには渡しません。各ユーザーは設定画面へアクセスパスワードを入力します。

## 主な機能

- Groq / B.AI / Experiential Labs / OpenRouter のプロバイダ選択
- 2026-10-04時点で確認した無料プラン・無料オファー・無料モデルの登録
- モデル選択を「画像対応」「画像非対応」に分離
- クリップボード画像の貼り付け、画像ファイル添付、画像プレビュー
- OpenAI互換のマルチモーダル`messages[].content`による画像送信
- ストリーミング回答と展開可能な Thinking 表示
- Agent Activity（推論、Planner、Playground、グラフ、Web Search の状態）
- Planner の計画作成・更新・完了
- IndexedDB の Playground（作成、読込、差分編集、追記、検索、名前変更、削除、履歴、プレビュー）
- `chart_render` による SVG の折れ線・棒グラフ
- OpenRouter Web Search / Web Fetch Server Tool
- OpenRouter 以外（Groq / B.AI / Experiential Labs）でも使える汎用 Web検索
  - `/api/web-search`（Bing / DuckDuckGo / Wikipedia を順に試行）と `/api/web-fetch` をサーバで実行
  - モデルからは `web_search` / `web_fetch` Function Tool として公開
- Web Search Server Tool が失敗した場合の Function Tool フォールバック
- `/api/diagnostics` による APIキー、最小生成、Tool Calling の 401 診断
- チャット履歴、ダークモード、JSON エクスポート

Experiential Labsは、2026-10-04に公開モデルカタログで無料表示を確認したチャット対応プロモーションモデルと、公式仕様にある日次無料枠モデルを登録しています。日次無料枠（`gpt-6-astra`、`claude-fable-5.1`）には保存済みカードと合計$1以上の決済実績が必要で、時間・日次上限があります。チャットAPIに対応しないJevは除外しています。プロモーションや上限は変更される場合があります。

OpenRouterは、Models APIで入力・出力料金がともに$0、テキストを出力するモデルを登録し、画像入力の有無をモデルごとに反映しています。無料提供に期限があるモデルは選択欄にも期限を表示します。

参照元: [Experiential Labs公開モデルカタログ](https://platform.experientiallabs.ai/models) / [Experiential Labs API仕様](https://platform.experientiallabs.ai/llms.txt) / [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) / [OpenRouter無料モデル一覧](https://openrouter.ai/collections/free-models)

## Render への設定

1. GitHub でこのリポジトリを Render に接続します。
2. Environment Variables に設定します。
   - `APP_ACCESS_PASSWORD`: アプリに入力するアクセスパスワード
   - `OPENROUTER_API_KEY`: OpenRouterを使う場合のAPIキー
   - `GROQ_API_KEY`: Groqを使う場合のAPIキー
   - `BAI_API_KEY`: B.AIを使う場合のAPIキー
   - `EXPERIENTIAL_LABS_API_KEY`: Experiential Labsを使う場合のAPIキー
   - `PUBLIC_APP_URL`: 任意。OpenRouterの`HTTP-Referer`用
3. Build Command は `npm ci`、Start Command は `npm start` のままにします。
4. 任意で `PUBLIC_APP_URL` に Render の URL を設定します。
5. 公開後、設定画面からアクセスパスワードを入力します。

`render.yaml` を使う場合は Blueprint として読み込めます。API キーはこのリポジトリへコミットしないでください。

## ローカル起動

```bash
npm install
APP_ACCESS_PASSWORD='十分に長いパスワード' OPENROUTER_API_KEY=sk-or-v1-... npm start
```

他のプロバイダを使う場合は、必要な `GROQ_API_KEY`、`BAI_API_KEY`、`EXPERIENTIAL_LABS_API_KEY` も同じように設定します。

ブラウザで `http://localhost:3000` を開き、設定画面からアクセスパスワードを入力します。パスワードは「このブラウザにアクセスパスワードを保存」をONにした場合だけローカル保存されます。
