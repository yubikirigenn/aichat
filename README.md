# Nemotron Workspace

Render からそのまま公開できる、画像入力とワークスペース機能を備えたチャットです。

## 構成

```text
ブラウザ
  └─ /api/chat（同一オリジン、アクセスパスワードを送信）
        ↓
      Render の server.mjs（許可リストで選択モデルを検証）
        ├─ Render環境変数の GROQ_API_KEY → Groq
        ├─ Render環境変数の TOKENHARBOR_API_KEY → Token Harbor（:freeルートのみ）
        ├─ Render環境変数の GEMINI_API_KEY → Gemini（Free Tier確認後）
        ├─ Experiential Labs → 課金安全性の確認中、送信停止
        └─ Render環境変数の OPENROUTER_API_KEY → OpenRouter
```

ブラウザの JavaScript は各プロバイダへ直接アクセスせず、`/api/chat` と `/api/diagnostics` にだけ接続します。APIキーはRenderの環境変数にだけ置き、ブラウザには渡しません。各ユーザーは設定画面へアクセスパスワードを入力します。

## 主な機能

- Token Harbor / Gemini / Groq / OpenRouter のプロバイダ選択（XPLは送信停止中）
- 2026-10-09時点で確認した無料プラン・無料オファー・無料モデルの登録
- モデル選択を「画像対応」「画像非対応」に分離
- クリップボード画像の貼り付け、画像ファイル添付、画像プレビュー
- OpenAI互換のマルチモーダル`messages[].content`による画像送信
- ストリーミング回答と展開可能な Thinking 表示
  - Geminiの回答受信前の502/503/504は1秒待って1回だけ再送します（無料枠を追加消費する可能性があります）。認証・設定・429や受信開始後の失敗は自動再送しません。HTMLの中継エラーページは画面に貼り付けず、プロバイダのJSONエラーと区別します
  - Renderとの接続維持のためHTTP keep-aliveを120秒に設定し、ストリーミング接続後は15秒ごとにSSEコメントを送ります。サーバー停止・メモリ不足・外部障害そのものを解消する機能ではありません。継続する502は[Renderのログ・Events](https://render.com/docs/troubleshooting-deploys)で確認してください
- 最初の回答後、選択中の同じモデルで会話タイトルを非同期生成。タイトル専用に最初の質問・回答の抜粋を1回追加送信するため、無料枠を消費します。画像やツールは送らず、失敗時は仮タイトルを維持します。既存チャットは次の回答後が対象です
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
- Token Harbor / Gemini / Groq / OpenRouterで使える汎用 Web検索
  - **主検索: Tavily**。Renderに `TAVILY_API_KEY` を設定し、Tavily管理画面で **Freeプラン・Pay As You Go OFF** を確認してから `TAVILY_FREE_TIER_CONFIRMED=true` を設定してください。[公式料金](https://docs.tavily.com/documentation/api-credits)では無料枠は月1,000 credits、Basic検索は1クエリ1 creditです（6クエリなら最大6 credits）。確認フラグは管理者の申告であり、課金状態や他アプリの消費を検証するものではありません。無料を保つにはTavily側の課金設定が必要です
  - Basic固定・自動パラメータ選択OFF。APIキーはサーバだけで保持し、上限・認証・接続エラー時の自動再送や別検索先への自動切替はしません。Tavily設定時はOpenRouter標準検索も登録せず、全プロバイダでFunction Tool経由に統一します
  - 1要求8秒上限。同一キー・検索条件の成功応答を最大128件・60秒キャッシュし、同時の重複要求もまとめて消費を抑えます。`credits_consumed` はAPIが返した消費数（不明ならnull）、キャッシュ・同時要求の共有側は0。月間消費をアプリ全体でカウントする機能ではありません
  - TavilyはAPIの順位を維持し、単純な語句一致の閾値で関連ページを落としません。指定ドメイン・形式・除外語・URL重複は従来どおり検査します。検索抜粋は未信頼データで、事実の確認には本文の取得が必要です
  - `web_search` は単一の `query` に加え `queries`（最大6件）に対応。最大3クエリを並列実行し、各クエリの成功・失敗・0件を区別して返します。共通フィルターを適用し、結果URLを重複排除します
  - `TAVILY_API_KEY` が未設定の場合に限り、旧HTML検索（Bing / DuckDuckGo、必要時Lite）を使用し警告を返します。キーを設定したが確認フラグがfalseの場合は送信せず設定エラーになります
  - 旧HTML検索では有効な検索結果が届いたら追加200msだけ別エンジンの結果を集約し、遅い通信をキャンセル。1秒間有効結果がなければLiteを先行開始し、1クエリ全体の待ち時間を6.5秒に制限します。結果の `elapsed_ms` / `backend_timings` / `partial` / `deadline_reached` で時間・一部返却を確認できます。絞り込みは緩めません
  - 複数クエリは全件完了後に返します（3並列・最大6件）。全エンジンの取得完了前に返す場合は網羅性が下がり得ます。OpenRouter標準Server Toolの検索時間にはこの制御は適用されません
  - モデルからは `web_search` / `web_fetch` Function Tool として公開
  - 旧HTML検索のみ、一時的なHTTP・接続障害は1回だけ再試行（上記6.5秒の上限内）。429はその場で再試行しません。失敗時もHTTP状態・接続エラー・再試行可能性をTool結果に保持し、モデルが原因に応じて次の操作を選べます
  - ページ読取は1試行10秒・最大2試行。取得サイズ上限は初期値20MB（20,000,000バイト）。Renderの `WEB_FETCH_MAX_BYTES` で1〜100,000,000バイトに変更可能です。展開後の受信データもストリーム中に検査し、超過時は中断します。無制限にはせず、リダイレクト先のローカルURL検査も維持します
  - `web_fetch` は初期抜粋（`max_chars`、最大5万文字）とは別に、抽出した本文を最大2,000万文字までブラウザに送って保存します。AIには `result_ref` 付きの短い表示を返し、`tool_result_search` / `tool_result_read` で末尾も検索・分割読取できます。本文の保存上限を超えた場合は `full_content_truncated` を明示します。HTMLのスクリプト等を除いたテキストであり、動的描画・PDF解析には未対応です
  - 403など恒久的な拒否は繰り返さず、429は時間を置くよう案内します。取得先のアクセス制限を回避する機能ではなく、Renderからの接続成功は保証しません
- 検索の詳細絞り込み（OpenRouterでもFunction Toolとして利用可能）
  - 対象・除外ドメイン、完全一致フレーズ、除外語、ファイル形式、直近1日／1週／1か月／1年、言語・地域
  - ドメイン・形式・除外語はサーバでも検査。言語・地域・期間・完全一致は検索先への指定で、厳密な本文一致や公開日は保証しません
  - 旧HTML検索では複数エンジンの結果を語句一致と元の順位で並べ替え、URL重複を除去。明らかな無関連結果は返さず、0件なら検索語修正へ戻します
  - 旧HTML検索の英字は単語境界で照合し、短い語が別の単語内にあるだけの一致を除外します（例: `AI` と `daily`）。複数語では最低2語・50%以上の一致を必要とし、モデルID・略称がある検索ではその識別語の一致も必要です。これは語句ベースの補助判定で、抜粋不足の関連ページを除外する場合もあります
  - 旧HTML検索で識別語のある検索に関連結果がない場合、その語を引用符で囲む検索を各検索先で1回だけ追加します。全体6.5秒の上限は維持します。0件時は `no_relevant_results` を返し、対象の不存在と断定しません
  - Wikipedia・Instant Answerの関連トピックを通常のWeb検索結果に混ぜません
  - 絞り込み演算子・地域指定の参照: [DuckDuckGo検索構文](https://duckduckgo.com/duckduckgo-help-pages/results/syntax) / [地域パラメータ](https://duckduckgo.com/duckduckgo-help-pages/settings/params)
- Web Search Server Tool が失敗した場合の Function Tool フォールバック
- `/api/diagnostics` による APIキー、最小生成、Tool Calling の 401 診断
- チャット履歴、ダークモード、JSON エクスポート

Experiential Labsの `qwen3.8-flash-next-uncensored` は、2026-10-09の公開データに無料プロモーション表示と従量料金（入力$0.15/M・出力$0.47/M）が併存しています。無料表示だけではアカウントの適用条件・Waterfall・Credits overflowを保証できず、課金の報告があるため、このアプリからのXPL送信を停止しています（診断の生成も停止）。以前の「FREE promo」表示は撤回しました。実際の請求原因はXPLの利用履歴で、クレジット消費・BYOK請求・適用プロモーション・ルーティングを確認してください。既存の請求の取り消しはできません。参照: [公開モデルデータ](https://api.experientiallabs.ai/api/models/qwen3.8-flash-next-uncensored) / [請求仕様](https://platform.experientiallabs.ai/docs/billing)。

OpenRouterは、Models APIで入力・出力料金がともに$0のチャットモデルを登録し、画像入力の有無をモデルごとに反映しています（音楽生成は除外）。無料提供に期限があるモデルは選択欄にも期限を表示します。Groqは公式Free Plan Limitsに掲載されたチャット対応モデルを登録しています。

参照元: [Experiential Labs公開モデルカタログ](https://platform.experientiallabs.ai/models) / [Experiential Labs API仕様](https://platform.experientiallabs.ai/llms.txt) / [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) / [OpenRouter無料モデル一覧](https://openrouter.ai/collections/free-models)

## Render への設定

Token Harborは2026-10-10 JSTに[公式Free一覧](https://www.tokenharbor.ai/models?category=free)で確認した `claude-haiku-5.5:free`（期間限定）、`deepseek-v4.1-flash:free`、`mimo-v2.6-flash:free` の3ルートのみ登録しています。すべて画像入力あり。音声・動画・ファイル入力はこのアプリでは未対応です。[OpenAI互換API](https://www.tokenharbor.ai/docs/api/curl)へサーバーから接続します。Thinkingは「非対応」ではなくモデルの自動設定として扱い、返された内容を表示します。ゲートウェイでの明示ON/OFFは未確認のため、未確認パラメーターは送りません（画面の設定で強制ON/OFFできる保証はありません）。DeepSeek・MiMoのTool継続時は返された推論を `reasoning_content` として保持します。Function Toolの実利用はアカウント・ルートの対応に依存します。

GroqのThinkingは[公式仕様](https://console.groq.com/docs/reasoning)に合わせてモデル別に指定します。GPT-OSSは `reasoning_effort` と `include_reasoning`、Qwenは `reasoning_effort` と `reasoning_format` を使用し、非対応モデルには送りません。GPT-OSSのOFFは推論の完全停止ではなく、低いeffortと推論表示の非表示です。これらのリクエスト形式はモックで検証し、実モデルの生成品質は未検証です。

[無料アクセス条件](https://www.tokenharbor.ai/docs/billing/cashback)では、`:free`ルートは残高に課金せず、無料枠には利用上限があります。無料モデルを有効化すると入力・出力が保存される場合があるため、Token Harborのダッシュボードで条件を確認・有効化後、`TOKENHARBOR_FREE_ACCESS_CONFIRMED=true` を設定してください。この値は管理者の確認記録であり、上流の条件を自動検証するものではありません。期間終了・枠超過時に有料IDへ自動変更しません。

Geminiは[Google公式料金表](https://ai.google.dev/gemini-api/docs/pricing)で無料入力・出力のあるチャットモデルを登録し、[OpenAI互換API](https://ai.google.dev/gemini-api/docs/openai)へ接続します。画像入力・Function Tool・ストリーミングに対応。検索はこのアプリのFunction Toolを使用し、Googleの有料Groundingには切り替えません。Google AI Studioで**Free Tier**のプロジェクトを選び、そのキーを使用してください。有料Tierでは同じモデルでも課金されます。確認後のみ `GEMINI_FREE_TIER_CONFIRMED=true` を設定してください。この値は管理者の確認記録であって、Googleの課金状態を自動検証したり無料利用を強制するものではありません。無料枠にはレート・日次制限とデータ利用条件があり、上限時に別の有料モデルへ自動切替しません。

1. GitHub でこのリポジトリを Render に接続します。
2. Environment Variables に設定します。
   - `APP_ACCESS_PASSWORD`: アプリに入力するアクセスパスワード
   - `OPENROUTER_API_KEY`: OpenRouterを使う場合のAPIキー
   - `GROQ_API_KEY`: Groqを使う場合のAPIキー
   - `TOKENHARBOR_API_KEY`: Token HarborのAPIキー（`thk_live_…`）
   - `TOKENHARBOR_FREE_ACCESS_CONFIRMED`: 無料利用・データ保存条件を確認し有効化した場合のみ`true`（既定`false`）
   - `GEMINI_API_KEY`: Google AI StudioのFree TierプロジェクトのAPIキー
   - `GEMINI_FREE_TIER_CONFIRMED`: 上記を確認した場合のみ`true`（既定`false`）
   - `EXPERIENTIAL_LABS_API_KEY`: 現在は送信停止のため使用しません
   - `PUBLIC_APP_URL`: 任意。OpenRouterの`HTTP-Referer`用
3. Build Command は `npm ci`、Start Command は `npm start` のままにします。
4. 任意で `PUBLIC_APP_URL` に Render の URL を設定します。
5. 公開後、設定画面からアクセスパスワードを入力します。

`render.yaml` を使う場合は Blueprint として読み込めます。API キーはこのリポジトリへコミットしないでください。

## ハーネス

### プロンプトキャッシュ

固定System Promptを会話の先頭に維持し、履歴省略の通知・Tool復旧指示は末尾のハーネス状態メッセージとして送ります。検索の再試行でも既存メッセージを書き換えず、共通Function Toolの順序を固定します。[Groq](https://console.groq.com/docs/prompt-caching)・[Gemini](https://ai.google.dev/gemini-api/docs/caching)などの自動キャッシュが同一prefixを再利用しやすい構成です。

OpenRouterにはチャットID由来の `session_id` を送り、[公式のSticky Routing](https://openrouter.ai/docs/guides/best-practices/prompt-caching#using-session_id-for-sticky-sessions)を利用します。タイトル生成は別セッションに分離し、他プロバイダにはこのパラメーターを送りません。プロバイダの固定やフォールバックの無効化、有料キャッシュオブジェクトの作成、未確認のToken Harborキャッシュ指定は行いません。

回答の「使用量・実行情報」に、上流が報告したキャッシュ済みトークン数と入力トークンに対する割合を表示します。未報告は0ヒットと区別し、一部ラウンドだけ報告された場合は対象ラウンド数を併記します。タイトル生成の使用量は回答の集計に含みません。最低トークン数・保持時間・無料ルートの対応・接続先の変更に依存し、ヒットや短縮率は保証しません。履歴編集・モデル／設定変更・コンテキスト上限による省略時はキャッシュが外れることがあります。完了後のTool内部ログを破棄する既存方針も維持するため、ターンをまたぐ全文prefixの一致は保証しません。回答そのものを保存して使い回すレスポンスキャッシュではありません。

`public/harness.js` が単一エージェントの実行ポリシーを担当します。サブエージェントやサーバー上のコード実行は追加していません。

- **実行順序**: Web検索・Web取得・X投稿・ファイル読取など、許可リストの読取系は最大3件並列。編集・削除・計画更新・未知のツールは直列の待ち合わせ地点として扱います。同じ引数の重複呼び出しも直列化し、APIへ返すTool結果は元の呼び出し順序を維持します。依存する読取はモデルが次ラウンドで要求する必要があります。
- **結果の保存**: 8,000文字超の受信結果はIndexedDBの専用ストアへ保存し、短いプレビューと `result_ref` を返します。`tool_result_search` / `tool_result_read` で必要箇所を検索・範囲読取でき、Tool履歴からJSONをダウンロードできます。保存対象は受信した結果であり、取得元サイトの全文を保証しません。
- **保存範囲**: 同じブラウザ・同じチャットでのみ再参照可能。最大100件・合計4,800万文字（JSON形式の各結果2,400万文字まで）を新しい順に保持し、古い結果は削除します。ブラウザの容量制限によって保存できない場合もあります。チャット削除時も関連する保存結果を削除します。保存失敗・参照切れは明示的なエラーにします。チャットJSONのエクスポートには保存結果の全文は含まれないため、必要なら個別ダウンロードしてください。
- **コンテキスト**: アプリの保護枠は合計24万文字相当（旧6万文字）で、システム指示・ツール定義を差し引いて使用します。過去の会話をターン単位で省略し、必要なら `chat_history_read` で再読取できます。それでも超える場合は古いラウンドのプレーンな推論文をAPI送信時だけ除外し、Toolプレビュー・途中本文を `result_ref` / `history_message_index` 付きの短い表示へ縮小します。直近ラウンド・Tool呼び出しと結果の組・プロバイダ署名は維持し、画面や元の保存履歴は書き換えません。これは追加LLMによる要約ではなく、切り詰めと再読取です。概算文字数であり、実際のトークン数・モデルごとの上限とは一致しません。モデルの上限や無料枠を拡張する機能ではありません。
- **復旧・停止**: エラーは `code` と `next_action` を含み、同じツール・引数で2回失敗した後の再実行を抑止します。抑止が3回続く場合はユーザーへ不足条件の確認を促して停止。既存の最大ラウンド数に加え、1ターン80呼び出しの上限もあります。停止時は通信を中断し、進行中の読取が終わるまで次の書込を始めません。タブを閉じた後のバックグラウンド継続・中断ジョブの自動再開には未対応です。
- **中断後の引継ぎ**: Toolの開始・終了ごとに、直近80操作の対象・完了／失敗／結果不明・取得結果の参照IDを同じチャットのローカル保存へ記録します。停止・エラー・ラウンド上限後の次の送信では、その記録と計画・最後の進捗をAIへ渡し、既存ファイルを確認して続けるよう指示します。再読込にも対応し、正常終了で引継ぎ記録を解除します。自動的にツールを再実行する機能ではなく、最新のユーザー指示が優先です。保存容量不足やタブ強制終了直前の未保存データは保証できません。結果不明の書込の重複を完全に保証するトランザクション機能ではなく、現在のファイル内容を読んで確認する必要があります。
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
