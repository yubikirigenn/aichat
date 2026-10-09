# Nemotron Workspace

Render からそのまま公開できる、画像入力とワークスペース機能を備えたチャットです。

## 構成

```text
ブラウザ
  └─ /api/chat（同一オリジン、アクセスパスワードを送信）
        ↓
      Render の server.mjs（許可リストで選択モデルを検証）
        ├─ Render環境変数の GROQ_API_KEY → Groq
        ├─ Render環境変数の GEMINI_API_KEY → Gemini（Free Tier確認後）
        ├─ Experiential Labs → 課金安全性の確認中、送信停止
        └─ Render環境変数の OPENROUTER_API_KEY → OpenRouter
```

ブラウザの JavaScript は各プロバイダへ直接アクセスせず、`/api/chat` と `/api/diagnostics` にだけ接続します。APIキーはRenderの環境変数にだけ置き、ブラウザには渡しません。各ユーザーは設定画面へアクセスパスワードを入力します。

## 主な機能

- Gemini / Groq / OpenRouter のプロバイダ選択（XPLは送信停止中）
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
- Xのキーワード検索 `x_search`（Web検索をONにして利用）
  - [X公式Recent Search](https://docs.x.com/x-api/posts/search/quickstart/recent-search)で直近7日間の公開投稿を検索。投稿URLの入力は不要です。`from:ユーザー名`、`lang:ja`、`-is:retweet`、ハッシュタグ、完全一致、ORなどのX検索構文に対応
  - Renderに `X_BEARER_TOKEN` を設定し、[Xの料金・クレジットと検索権限](https://docs.x.com/x-api/getting-started/pricing)を確認後のみ `X_SEARCH_ENABLED=true` を設定。公式APIは無料を保証せず従量課金が発生し得るため初期値はfalseです。キーはブラウザやモデルへ送りません
  - 1回10〜20件・1ページのみ。`sort_order` は `recency` / `relevancy`、必要時だけ `next_token` で次ページへ。自動ページ送り・自動再試行なし。同一クエリ・条件は30秒キャッシュし同時要求をまとめます（単一サーバープロセス内）。画像内容・返信全体は取得しません
- X/Twitterの公開投稿を読む `x_read_post`（Web検索をONにして利用）
  - 投稿URLを渡すと本文・投稿者・日時・取得できた引用・メディアURLを取得し、実行履歴に表示。通常の`web_fetch`に渡された投稿URLも同じ経路を使います
  - [FxEmbedの公開API](https://github.com/FxEmbed/FxEmbed/wiki/Status-Fetch-API)をRenderから利用。XのAPIキー・ログインは不要ですが、投稿IDがこの第三者サービスに送られます
  - 非公開・削除・取得制限には対応せず、スレッド全体や返信一覧は取得しません。画像・動画の内容解析は行いません。取得元の停止や制限で利用できない場合があります
  - 成功結果は最大200件・60秒キャッシュ。一時的な取得障害は1回再試行します
- Gemini / Groq / OpenRouterで使える汎用 Web検索
  - `web_search` は単一の `query` に加え `queries`（最大6件）に対応。最大3クエリを並列実行し、各クエリの成功・失敗・0件を区別して返します。共通フィルターを適用し、結果URLを重複排除します
  - `/api/web-search`（Bing / DuckDuckGoを並列取得、必要時にLiteへフォールバック）と `/api/web-fetch` をサーバで実行
  - 有効な検索結果が届いたら追加200msだけ別エンジンの結果を集約し、遅い通信をキャンセル。1秒間有効結果がなければLiteを先行開始し、1クエリ全体の待ち時間を6.5秒に制限します。結果の `elapsed_ms` / `backend_timings` / `partial` / `deadline_reached` で時間・一部返却を確認できます。絞り込みは緩めません
  - 複数クエリは全件完了後に返します（3並列・最大6件）。全エンジンの取得完了前に返す場合は網羅性が下がり得ます。OpenRouter標準Server Toolの検索時間にはこの制御は適用されません
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

Experiential Labsの `qwen3.8-flash-next-uncensored` は、2026-10-09の公開データに無料プロモーション表示と従量料金（入力$0.15/M・出力$0.47/M）が併存しています。無料表示だけではアカウントの適用条件・Waterfall・Credits overflowを保証できず、課金の報告があるため、このアプリからのXPL送信を停止しています（診断の生成も停止）。以前の「FREE promo」表示は撤回しました。実際の請求原因はXPLの利用履歴で、クレジット消費・BYOK請求・適用プロモーション・ルーティングを確認してください。既存の請求の取り消しはできません。参照: [公開モデルデータ](https://api.experientiallabs.ai/api/models/qwen3.8-flash-next-uncensored) / [請求仕様](https://platform.experientiallabs.ai/docs/billing)。

OpenRouterは、Models APIで入力・出力料金がともに$0のチャットモデルを登録し、画像入力の有無をモデルごとに反映しています（音楽生成は除外）。無料提供に期限があるモデルは選択欄にも期限を表示します。Groqは公式Free Plan Limitsに掲載されたチャット対応モデルを登録しています。

参照元: [Experiential Labs公開モデルカタログ](https://platform.experientiallabs.ai/models) / [Experiential Labs API仕様](https://platform.experientiallabs.ai/llms.txt) / [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) / [OpenRouter無料モデル一覧](https://openrouter.ai/collections/free-models)

## Render への設定

Geminiは[Google公式料金表](https://ai.google.dev/gemini-api/docs/pricing)で無料入力・出力のあるチャットモデルを登録し、[OpenAI互換API](https://ai.google.dev/gemini-api/docs/openai)へ接続します。画像入力・Function Tool・ストリーミングに対応。検索はこのアプリのFunction Toolを使用し、Googleの有料Groundingには切り替えません。Google AI Studioで**Free Tier**のプロジェクトを選び、そのキーを使用してください。有料Tierでは同じモデルでも課金されます。確認後のみ `GEMINI_FREE_TIER_CONFIRMED=true` を設定してください。この値は管理者の確認記録であって、Googleの課金状態を自動検証したり無料利用を強制するものではありません。無料枠にはレート・日次制限とデータ利用条件があり、上限時に別の有料モデルへ自動切替しません。

1. GitHub でこのリポジトリを Render に接続します。
2. Environment Variables に設定します。
   - `APP_ACCESS_PASSWORD`: アプリに入力するアクセスパスワード
   - `OPENROUTER_API_KEY`: OpenRouterを使う場合のAPIキー
   - `GROQ_API_KEY`: Groqを使う場合のAPIキー
   - `GEMINI_API_KEY`: Google AI StudioのFree TierプロジェクトのAPIキー
   - `GEMINI_FREE_TIER_CONFIRMED`: 上記を確認した場合のみ`true`（既定`false`）
   - `EXPERIENTIAL_LABS_API_KEY`: 現在は送信停止のため使用しません
   - `PUBLIC_APP_URL`: 任意。OpenRouterの`HTTP-Referer`用
3. Build Command は `npm ci`、Start Command は `npm start` のままにします。
4. 任意で `PUBLIC_APP_URL` に Render の URL を設定します。
5. 公開後、設定画面からアクセスパスワードを入力します。

`render.yaml` を使う場合は Blueprint として読み込めます。API キーはこのリポジトリへコミットしないでください。

## ハーネス

`public/harness.js` が単一エージェントの実行ポリシーを担当します。サブエージェントやサーバー上のコード実行は追加していません。

- **実行順序**: Web検索・Web取得・X投稿・ファイル読取など、許可リストの読取系は最大3件並列。編集・削除・計画更新・未知のツールは直列の待ち合わせ地点として扱います。同じ引数の重複呼び出しも直列化し、APIへ返すTool結果は元の呼び出し順序を維持します。依存する読取はモデルが次ラウンドで要求する必要があります。
- **結果の保存**: 8,000文字超の受信結果はIndexedDBの専用ストアへ保存し、短いプレビューと `result_ref` を返します。`tool_result_search` / `tool_result_read` で必要箇所を検索・範囲読取でき、Tool履歴からJSONをダウンロードできます。保存対象は受信した結果であり、取得元サイトの全文を保証しません。
- **保存範囲**: 同じブラウザ・同じチャットでのみ再参照可能。最大100件・合計1,000万文字（各結果200万文字まで）を新しい順に保持し、古い結果は削除します。チャット削除時も関連する保存結果を削除します。保存失敗・参照切れは明示的なエラーにします。チャットJSONのエクスポートには保存結果の全文は含まれないため、必要なら個別ダウンロードしてください。
- **コンテキスト**: システム指示・ツール定義の長さを差し引いた概算文字数で過去の会話をターン単位で省略し、`chat_history_read` で元メッセージを範囲読取できます。現在のターンの古いToolプレビューも参照IDへ縮小します。元の会話をこの処理で書き換えません。これは追加LLMを使った要約ではなく、切り詰めと再読取です。実際のトークン数・モデルごとの上限とは一致しません。
- **復旧・停止**: エラーは `code` と `next_action` を含み、同じツール・引数で2回失敗した後の再実行を抑止します。抑止が3回続く場合はユーザーへ不足条件の確認を促して停止。既存の最大ラウンド数に加え、1ターン80呼び出しの上限もあります。停止時は通信を中断し、進行中の読取が終わるまで次の書込を始めません。タブを閉じた後のバックグラウンド継続・中断ジョブの自動再開には未対応です。
- **変更の保護**: Toolによるファイル削除と既存ファイルの全文置換は確認ダイアログで許可が必要です。拒否済みの同一操作はそのターンでは再実行しません。モデルへの文章指示だけではなく実行側でも制限します。XPLとGeminiの課金ガードは引き続きサーバーで適用します。

IndexedDBはv1からv2へ追加ストアのみを移行し、既存Playgroundファイルを維持します。複数タブで開いている場合は他のタブを閉じて再読み込みしてください。`npm test` の実行ポリシーテストと、任意のブラウザテストで並列数・書込順・失敗抑止・保存／再参照・移行・削除拒否を検証します。モデルの実際のツール選択品質を採点する評価セットは今後の段階です。

## ローカル起動手順

会話画面は `public/chat-ui.css` / `public/chat-ui.js` に分離しています。途中説明・Thinking・Tool操作は時系列で表示し、生成中も展開状態と閲覧位置を維持します。上へスクロールすると追従を止め、「最新へ戻る」で追従を再開できます。モデル・ツール設定・停止は入力欄から操作できます。

`npm run check` と `npm test` で構文・回帰テストを実行できます。Playwrightが利用できる環境では `CHAT_UI_BROWSER=1 node --test tests/chat-ui.test.mjs` で画面操作も検証できます（必要に応じて `PLAYWRIGHT_MODULE` と `CHROME_PATH` を指定）。画面テストのモデル応答はモックで、実際のプロバイダ通信は行いません。

```bash
npm install
APP_ACCESS_PASSWORD='十分に長いパスワード' OPENROUTER_API_KEY=sk-or-v1-... npm start
```

Groqには `GROQ_API_KEY`、Geminiには `GEMINI_API_KEY` と確認済みの `GEMINI_FREE_TIER_CONFIRMED=true` を設定します。XPLへの送信は停止中です。

ブラウザで `http://localhost:3000` を開き、設定画面からアクセスパスワードを入力します。パスワードは「このブラウザにアクセスパスワードを保存」をONにした場合だけローカル保存されます。
