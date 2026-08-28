# Nemotron Workspace

Render からそのまま公開できる、Nemotron 3 Ultra 用のワークスペース型チャットです。

## 構成

```text
ブラウザ
  └─ /api/chat（同一オリジン、APIキーなし）
        ↓
Render の server.mjs
  └─ OPENROUTER_API_KEY を環境変数から読み込み
        ↓
OpenRouter / chat/completions
```

ブラウザの JavaScript は OpenRouter へ直接アクセスせず、`Authorization` ヘッダーも生成しません。API キーは Render の環境変数にだけ置きます。

## 主な機能

- `nvidia/nemotron-3-ultra-550b-a55b:free` 固定
- ストリーミング回答と展開可能な Thinking 表示
- Agent Activity（推論、Planner、Playground、グラフ、Web Search の状態）
- Planner の計画作成・更新・完了
- IndexedDB の Playground（作成、読込、差分編集、追記、検索、名前変更、削除、履歴、プレビュー）
- `chart_render` による SVG の折れ線・棒グラフ
- OpenRouter Web Search / Web Fetch Server Tool
- Web Search Server Tool が 502 の場合の旧 `web` プラグインへの互換フォールバック
- `/api/diagnostics` による APIキー、最小生成、Tool Calling の 401 診断
- チャット履歴、ダークモード、JSON エクスポート

## Render への設定

1. GitHub でこのリポジトリを Render に接続します。
2. Environment Variables に `OPENROUTER_API_KEY` を追加します。
3. Build Command は `npm ci`、Start Command は `npm start` のままにします。
4. 任意で `PUBLIC_APP_URL` に Render の URL を設定します。

`render.yaml` を使う場合は Blueprint として読み込めます。API キーはこのリポジトリへコミットしないでください。

## ローカル起動

```bash
npm install
OPENROUTER_API_KEY=sk-or-v1-... npm start
```

ブラウザで `http://localhost:3000` を開きます。キーを設定しない場合でも UI と `/api/health` は起動し、設定画面から未設定状態を確認できます。
