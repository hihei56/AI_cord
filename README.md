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
│       ├── config.js            # settings.json + persona + prompt + corpus + .env の統合読み込み
│       ├── aiClient.js          # OpenAI互換Chat Completions API 呼び出し（返信生成・自発投稿生成）
│       ├── markovChain.js       # 口調再現用マルコフ連鎖（下書き生成、任意機能）
│       ├── animalImage.js       # 動物画像取得
│       └── logger.js            # ログ出力
├── scripts/
│   └── markov-demo.js          # マルコフ連鎖の学習・生成を単体で試せるデモスクリプト
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
| `AI_BASE_URL` | Chat Completions APIのベースURL(OpenAI互換なら何でも可。省略時Groq) |
| `AI_API_KEY` | 上記APIのキー(未設定時は`GROQ_API_KEY`にフォールバック) |
| `ALLOWED_GUILD_ID` | 動作させるサーバーID |
| `ALLOWED_CHANNEL_ID` | 動作させるチャンネルID |
| `PERSONA` | `config/personas/` 内で使用する人格ファイル名（拡張子なし、省略時 `default`） |

### AIバックエンドの切り替え

`src/utils/aiClient.js` はOpenAI互換の `/chat/completions` エンドポイントを叛く汎用実装になっている。`AI_BASE_URL` / `AI_API_KEY` を変更するだけで、Groq以外(自前ホストのvLLM・Ollama・text-generation-inferenceなど、OpenAI互換API公開しているもの全般)に差し替え可能。モデル名は `config/settings.json` の `ai.model` で指定する。`messageHandler.js` / `selfTalkHandler.js` / persona 周りはバックエンドに依存しないため変更不要。

### `config/settings.json`（動作パラメータ）

クールダウン秒数、返信確率（メンション/リプライ/通常）、深夜帯の抑制、自発投稿の間隔・確率・画像混在率、AIモデル名や温度、Presence（Spotify/視聴中ステータス）のローテーションなどをここで調整する。

### `config/personas/default.txt`

返信生成に使う人格・口調のシステムプロンプト。別人格を使いたい場合は同じディレクトリに新しいファイルを追加し、`.env` の `PERSONA` を切り替える。

### `config/prompts/self_talk.txt`

一定間隔で自発的につぶやく際のプロンプトテンプレート。

### マルコフ連鎖による口調の下書き(任意機能)

`config/settings.json` の `markov.enabled` を `true` にすると、`config/corpus/<corpusFile>` (改行区切りのテキスト、1行1発言目安)からマルコフ連鎖モデルを構築し、返信生成のたびに短い「口調の下書き」を作ってGroq(等のLLM)へのプロンプトに添える。LLMには「意味は無視して口調・言い回しだけ参考にする」よう指示しており、下書き自体は文脈を無視した単語列でも構わない。

- `order`: マルコフ連鎖のn-gram長(大きいほど元の言い回しに忠実、小さいほど崩れやすい。2〜3推奨)
- `corpusFile`: `config/corpus/` 内のファイル名
- `draftMaxWords`: 下書きの最大単語数

`config/corpus/default.txt` は空のプレースホルダーです。**学習元テキストには、実在の第三者の発言が混ざらないよう本人が用意したものだけを使ってください。** 同意の取れていない他者の発言データを学習・生成に使うことは想定していません。

Botを起動せずに単体で学習・生成結果を確認したい場合は、`scripts/markov-demo.js` を使う。

```bash
node scripts/markov-demo.js [corpusFile] [order] [count]
# 例: config/corpus/default.txt を order=2 で学習し、5個生成
node scripts/markov-demo.js default.txt 2 5
# npm経由でも実行可能(corpusFile等は node scripts/markov-demo.js 直接呼び出しで指定)
npm run markov:demo
```
