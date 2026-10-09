# Nemotron Workspace

Render からそのまま公開できる、画像入力とワークスペース機能を備えたチャットです。

## 構成

```text
ブラウザ
  └─ /api/chat（同一オリジン、アクセスパスワードを送信）
        ↓
      Render の server.mjs（許可リストで選択モデルを検証）
        ├─ Render環境変数の GROQ_API_KEY → Groq
        ├─ Render環境変数の EXPERIENTIAL_LABS_API_KEY → Experiential Labs
        └─ Render環境変数の OPENROUTER_API_KEY → OpenRouter
```

ブラウザの JavaScript は各プロバイダへ直接アクセスせず、`/api/chat` と `/api/diagnostics` にだけ接続します。APIキーはRenderの環境変数にだけ置き、ブラウザには渡しません。各ユーザーは設定画面へアクセスパスワードを入力します。

## 主な機能

- Groq / Experiential Labs / OpenRouter のプロバイダ選択
- 2026-10-09時点で確認した無料プラン・無料オファー・無料モデルの登録
- モデル選択を「画像対応」「画像非対応」に分離
- クリップボード画像の貼り付け、画像ファイル添付、画像プレビュー
- OpenAI互換のマルチモーダル`messages[].content`による画像送信
- ストリーミング回答と展開可能な Thinking 表示
- Agent Activity（推論、Planner、Playground、グラフ、Web Search の状態）
- Planner の計画作成・更新・完了
- IndexedDB の Playground（作成、読込、差分編集、追記、検索、名前変更、削除、履歴、プレビュー）
- `chart_render` による SVG の折れ線・棒グラフ
- OpenRouter Web Search / Web Fetch Server Tool
- OpenRouter 以外（Groq / Experiential Labs）でも使える汎用 Web検索
  - `/api/web-search`（Bing / DuckDuckGoを並列取得、必要時にLiteへフォールバック）と `/api/web-fetch` をサーバで実行
  - モデルからは `web_search` / `web_fetch` Function Tool として公開
- 検索の詳細絞り込み（OpenRouterでもFunction Toolとして利用可能）
  - 対象・除外ドメイン、完全一致フレーズ、除外語、ファイル形式、直近1日／1週／1か月／1年、言語・地域
  - ドメイン・形式・除外語はサーバでも検査。言語・地域・期間・完全一致は検索先への指定で、厳密な本文一致や公開日は保証しません
  - 複数エンジンの結果を語句一致と元の順位で並べ替え、URL重複を除去。明らかな無関連結果は返さず、0件なら検索語修正へ戻します
  - Wikipedia・Instant Answerの関連トピックを通常のWeb検索結果に混ぜません
  - 絞り込み演算子・地域指定の参照: [DuckDuckGo検索構文](https://duckduckgo.com/duckduckgo-help-pages/results/syntax) / [地域パラメータ](https://duckduckgo.com/duckduckgo-help-pages/settings/params)
- Web Search Server Tool が失敗した場合の Function Tool フォールバック
- `/api/diagnostics` による APIキー、最小生成、Tool Calling の 401 診断
- チャット履歴、ダークモード、JSON エクスポート

Experiential Labsは、2026-10-09の公開プロモーションデータと個別ページで無料チャット枠を確認した `qwen3.8-flash-next-uncensored` を登録しています（時間・日次上限あり、画像非対応）。有料プラン限定の100%割引は無料枠と区別し、Clef / Clef Flash / GPT-6 Luna Decisions / Jevなど非チャットAPIは除外しています。過去の日次無料枠は現在の提供経路に無料枠がなく、公開プロモーションデータにもないため外しています。XPL側でCredits overflowが有効な場合は上限後に課金される可能性があるため、無料利用では無効にしてください。公式の一覧・個別ページ・請求ガイドの表示に差異があるため、利用時にもアカウントの適用条件をご確認ください。

OpenRouterは、Models APIで入力・出力料金がともに$0のチャットモデルを登録し、画像入力の有無をモデルごとに反映しています（音楽生成は除外）。無料提供に期限があるモデルは選択欄にも期限を表示します。Groqは公式Free Plan Limitsに掲載されたチャット対応モデルを登録しています。

参照元: [Experiential Labs公開モデルカタログ](https://platform.experientiallabs.ai/models) / [Experiential Labs API仕様](https://platform.experientiallabs.ai/llms.txt) / [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) / [OpenRouter無料モデル一覧](https://openrouter.ai/collections/free-models)

## Render への設定

1. GitHub でこのリポジトリを Render に接続します。
2. Environment Variables に設定します。
   - `APP_ACCESS_PASSWORD`: アプリに入力するアクセスパスワード
   - `OPENROUTER_API_KEY`: OpenRouterを使う場合のAPIキー
   - `GROQ_API_KEY`: Groqを使う場合のAPIキー
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

他のプロバイダを使う場合は、必要な `GROQ_API_KEY`、`EXPERIENTIAL_LABS_API_KEY` も同じように設定します。

ブラウザで `http://localhost:3000` を開き、設定画面からアクセスパスワードを入力します。パスワードは「このブラウザにアクセスパスワードを保存」をONにした場合だけローカル保存されます。
