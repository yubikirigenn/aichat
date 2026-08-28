# Nemotron Workspace

Render からそのまま公開できる、Nemotron 3 Ultra 用のワークスペース型チャットです。

## 構成

```text
ブラウザ
  └─ /api/chat（同一オリジン、各ユーザーのキーを中継）
        ↓
Render の server.mjs
  └─ ブラウザから受け取ったキーをOpenRouter用の認証へ変換
        ↓
OpenRouter / chat/completions
```

ブラウザの JavaScript は OpenRouter へ直接アクセスせず、`/api/chat` と `/api/diagnostics` にだけ接続します。各ユーザーが設定画面へ自分のAPIキーを入力し、既定ではブラウザに保存しません。Renderのサーバー環境変数へ共通APIキーを置く必要はありません。

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
2. Build Command は `npm ci`、Start Command は `npm start` のままにします。
3. 任意で `PUBLIC_APP_URL` に Render の URL を設定します。
4. 公開後、設定画面から各ユーザーが自分のOpenRouter APIキーを入力します。

`render.yaml` を使う場合は Blueprint として読み込めます。API キーはこのリポジトリへコミットしないでください。

## ローカル起動

```bash
npm install
npm start
```

ブラウザで `http://localhost:3000` を開き、設定画面からAPIキーを入力します。キーは「このブラウザにAPIキーを保存」をONにした場合だけローカル保存されます。
