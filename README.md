# discord-selfbot

Groq (Llama3) を使って人間っぽく雑談・自発投稿する Discord セルフボット。
[TomoriBot](https://github.com/) のような `config/` `src/` `handlers/` `utils/` に分割したモジュール構成にリファクタリング済み。

> **注意**: セルフボット（ユーザーアカウントの自動化）は Discord の利用規約で禁止されています。
> 利用は自己責任で、アカウント停止のリスクを理解した上で行ってください。

## ディレクトリ構成

```
discord-selfbot/
├── config/
│   ├── settings.json          # 動作設定（クールダウン、返信確率、AIパラメータ、Presence など）
│   ├── personas/
│   │   └── default.txt        # 人格プロンプト（システムプロンプト）
│   └── prompts/
│       └── self_talk.txt      # 自発投稿用プロンプト
├── src/
│   ├── index.js                # エントリーポイント
│   ├── client.js                # discord.js-selfbot-v13 クライアント生成
│   ├── handlers/
│   │   ├── messageHandler.js    # メッセージ受信・返信ロジック
│   │   ├── selfTalkHandler.js   # 自発投稿（テキスト/画像）ロジック
│   │   └── presenceHandler.js   # RPC（Spotify/視聴中ステータス）更新
│   └── utils/
│       ├── config.js            # settings.json + persona + prompt + .env の統合読み込み
│       ├── aiClient.js          # Groq API 呼び出し（返信生成・自発投稿生成）
│       ├── animalImage.js       # 動物画像取得
│       └── logger.js            # ログ出力
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## セットアップ

```bash
npm install
cp .env.example .env
# .env にトークン・APIキー・サーバー/チャンネルIDを設定
npm start
```

## 設定

### `.env`（機密情報・環境依存値）

| 変数 | 内容 |
|---|---|
| `DISCORD_TOKEN` | Discordアカウントのトークン |
| `GROQ_API_KEY` | Groq APIキー |
| `ALLOWED_GUILD_ID` | 動作させるサーバーID |
| `ALLOWED_CHANNEL_ID` | 動作させるチャンネルID |
| `PERSONA` | `config/personas/` 内で使用する人格ファイル名（拡張子なし、省略時 `default`） |

### `config/settings.json`（動作パラメータ）

クールダウン秒数、返信確率（メンション/リプライ/通常）、深夜帯の抑制、自発投稿の間隔・確率・画像混在率、Groqモデル名や温度、Presence（Spotify/視聴中ステータス）のローテーションなどをここで調整する。

### `config/personas/default.txt`

返信生成に使う人格・口調のシステムプロンプト。別人格を使いたい場合は同じディレクトリに新しいファイルを追加し、`.env` の `PERSONA` を切り替える。

### `config/prompts/self_talk.txt`

一定間隔で自発的につぶやく際のプロンプトテンプレート。

## 主な機能

- サーバー内の特定チャンネルでのメンション/リプライ/通常発言に確率的に返信（Groq Llama3で生成）
- 直近の会話履歴を踏まえた返信生成、連投防止・クールダウン制御
- 一定間隔でのランダムな自発投稿(テキストのみ、または動物画像＋一言）
- Spotify再生中/動画視聴中を模したPresence（RPC）のローテーション更新

## 依存関係

- [discord.js-selfbot-v13](https://www.npmjs.com/package/discord.js-selfbot-v13)
- [dotenv](https://www.npmjs.com/package/dotenv)
- [@sefinek/random-animals](https://www.npmjs.com/package/@sefinek/random-animals)
