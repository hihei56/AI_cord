# AI_cord

Groq(またはOpenAI互換API)を使って人間っぽく雑談・自発投稿するDiscordセルフボット。[TomoriBot](https://github.com/) のような `config/` `src/` `handlers/` `utils/` 構造。

> **注意**: セルフボット(ユーザーアカウントの自動化)はDiscordの利用規約で禁止されています。利用は自己責任で、アカウント停止のリスクを理解した上で使用してください。

## 目次

- [ディレクトリ構成](#ディレクトリ構成)
- [ローカルでのセットアップ](#ローカルでのセットアップ)
- [設定](#設定)
- [複数アカウント運用](#複数アカウント運用)
- [主な機能](#主な機能)
- [Oracle Cloudへのデプロイ](#oracle-cloudへのデプロイ)
- [依存関係](#依存関係)

## ディレクトリ構成

```
AI_cord/
├── config/
│   ├── settings.json          # 動作設定(クールダウン、返信確率、AI/Markovパラメータ、Presenceなど)
│   ├── personas/
│   │   ├── default.txt        # 人格プロンプト(システムプロンプト) - 😿
│   │   └── original.txt       # 別の人格プロンプト
│   ├── prompts/
│   │   └── self_talk.txt      # 自発投稿用プロンプト
│   └── corpus/
│       └── default.txt        # Markov連鎖の学習元テキスト(任意機能、1行1発言)
├── src/
│   ├── index.js                # エントリーポイント
│   ├── client.js               # discord.js-selfbot-v13 クライアント生成
│   ├── handlers/
│   │   ├── messageHandler.js   # メッセージ受信・返信ロジック
│   │   ├── selfTalkHandler.js  # 自発投稿(テキスト/画像)ロジック
│   │   └── presenceHandler.js  # RPC(Spotify/視聴中ステータス)更新
│   └── utils/
│       ├── config.js            # 設定統合読み込み（複数アカウント対応）
│       ├── multiAccountManager.js # 複数アカウント管理
│       ├── aiClient.js          # OpenAI互換Chat Completions API 呼び出し
│       ├��─ markovChain.js       # 口調再現用マルコフ連鎖
│       ├── animalImage.js       # 動物画像取得
│       └── logger.js            # ログ出力
├── scripts/
│   └── markov-demo.js          # マルコフ連鎖のデモスクリプト
├── .env.example                # 環境変数の例（複数アカウント対応）
├── .gitignore
├── package.json
├── pm2.config.js               # pm2設定（複数アカウント並行運用用）
└── README.md
```

## ローカルでのセットアップ

### 単一アカウントモード（従来方式）

```bash
npm install
cp .env.example .env
# .env にトークン・APIキー・サーバー/チャンネルIDを設定
npm start
```

### 複数アカウントモード

```bash
npm install
cp .env.example .env
# .env で MULTI_ACCOUNT_MODE=true に設定
# ACCOUNT_1_*, ACCOUNT_2_* 等を設定
npm start
```

## 設定

### `.env`(機密情報・環境依存値)

#### 単一アカウントモード（MULTI_ACCOUNT_MODE=false）

| 変数 | 内容 |
|---|---|
| `DISCORD_TOKEN` | Discordアカウントのトークン |
| `AI_BASE_URL` | Chat Completions APIのベースURL(デフォルト: Groq) |
| `AI_API_KEY` | 上記APIのキー(未設定時は`GROQ_API_KEY`にフォールバック) |
| `ALLOWED_GUILD_ID` | 動作させるサーバーID |
| `ALLOWED_CHANNEL_ID` | 動作させるチャンネルID |
| `PERSONA` | `config/personas/` 内で使用する人格ファイル名(デフォルト: `default`) |

#### 複数アカウントモード（MULTI_ACCOUNT_MODE=true）

各アカウント `N` に対して以下を設定：

| 変数 | 内容 |
|---|---|
| `ACCOUNT_N_TOKEN` | **(必須)** Discordアカウントのトークン |
| `ACCOUNT_N_GUILD_ID` | **(必須)** 動作させるサーバーID |
| `ACCOUNT_N_CHANNEL_ID` | **(必須)** 動作させるチャンネルID |
| `ACCOUNT_N_PERSONA` | 人格ファイル名(デフォルト: `default`) |
| `ACCOUNT_N_AI_BASE_URL` | Chat Completions APIのベースURL(デフォルト: 共通設定) |
| `ACCOUNT_N_AI_API_KEY` | APIキー(デフォルト: 共通設定) |
| `ACCOUNT_N_COOLDOWN_SECONDS` | 返信クールダウン秒数(デフォルト: settings.json) |

**例:**

```env
MULTI_ACCOUNT_MODE=true

# アカウント1: 😿
ACCOUNT_1_TOKEN=nOO...
ACCOUNT_1_GUILD_ID=1476...
ACCOUNT_1_CHANNEL_ID=1540...
ACCOUNT_1_PERSONA=default

# アカウント2: ほうちゃん
ACCOUNT_2_TOKEN=abc...
ACCOUNT_2_GUILD_ID=1476...
ACCOUNT_2_CHANNEL_ID=1540...
ACCOUNT_2_PERSONA=houChan

# 共通設定
AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=gsk_...
```

### AIバックエンドの切り替え

`src/utils/aiClient.js` はOpenAI互換の `/chat/completions` エンドポイントを使用。`AI_BASE_URL` / `AI_API_KEY` を変更するだけで、Groq以外(自前ホストのvLLM/Ollama等)でも動作します。

### `config/settings.json`(動作パラメータ)

| セクション | 内容 |
|---|---|
| `cooldownSeconds` | 返信後の最短間隔(秒) |
| `replyChance` | メンション/リプライ/通常発言それぞれの返信確率 |
| `nightMode` | 指定時間帯(デフォルト1〜5時)の返信確率抑制倍率 |
| `recentDuplicateGuard` | 連投・自己連続投稿の抑制設定 |
| `typingDelay` / `replyDelay` | typing表示や返信送信までの擬似的な遅延 |
| `selfTalk` | 自発投稿の間隔・確率・画像混在率・対象動物 |
| `markov` | マルコフ連鎖の口調下書き機能の設定(後述) |
| `ai` | モデル名、温度、履歴参照件数など |
| `presence` | Spotify/視聴中ステータス(RPC)のローテーション内容 |

### `config/personas/` - 人格プロンプト

返信生成に使う人格・口調のシステムプロンプト。

- `default.txt` - 😿の人格（シニカル、句読点なし、完結しない口調）
- `original.txt` - 別の人格

別人格を追加する場合は同じディレクトリに新しいファイルを作成し、`.env` の `PERSONA` (単一モード) または `ACCOUNT_N_PERSONA` (複数モード) で指定します。

### `config/prompts/self_talk.txt`

一定間隔で自発的につぶやく際のプロンプトテンプレート。

### マルコフ連鎖による口調の下書き(任意機能)

`config/settings.json` の `markov.enabled` を `true` にすると、`config/corpus/<corpusFile>` (改行区切りのテキスト、1行1発言目安)からマルコフ連鎖モデルを構築します。

生成開始位置は、直近の会話履歴・ユーザーの発言に含まれる単語と一致する学習データがあればそこを優先し、無ければ従来通りランダムに選択されます。

**パラメータ:**

- `order`: マルコフ連鎖のn-gram長(大きいほど元の言い回しに忠実、小さいほど崩れやすい。2〜3推奨)
- `corpusFile`: `config/corpus/` 内のファイル名
- `draftMaxWords`: 下書きの最大単語数

Botを起動せずに単体で学習・生成結果を確認したい場合:

```bash
node scripts/markov-demo.js [corpusFile] [order] [count]
# 例: config/corpus/default.txt を order=2 で学習し、5個生成
node scripts/markov-demo.js default.txt 2 5
npm run markov:demo
```

## 複数アカウント運用

### シングルプロセス（同じプロセスで複数アカウント）

`.env` で `MULTI_ACCOUNT_MODE=true` に設定し、`ACCOUNT_1_*`, `ACCOUNT_2_*` を定義すると、1つのNode.jsプロセスで複数アカウントが動作します。

```bash
npm start
# ログ例:
# [STARTUP] 複数アカウントモード: 2個のアカウントを起動
# [READY] nOrSX6c23bg7Tk8-jneyD3FH5 [Account: account1]
# [READY] abc123def456ghi789jkl [Account: account2]
```

**メリット:**
- メモリ効率が良い
- セットアップが簡単

**デメリット:**
- 1つのアカウントが落ちるともう片方も影響を受ける可能性

### マルチプロセス（pm2で複数インスタンス）

pm2の設定ファイルを使って、各アカウント用に別々のプロセスを起動します。

```bash
sudo npm install -g pm2
pm2 start pm2.config.js
pm2 save
```

**pm2.config.js の内容:**
```javascript
module.exports = {
  apps: [
    { name: 'ai_cord_account1', script: 'src/index.js', env: { MULTI_ACCOUNT_MODE: 'true' } },
    { name: 'ai_cord_account2', script: 'src/index.js', env: { MULTI_ACCOUNT_MODE: 'true' } }
  ]
};
```

**運用コマンド:**

```bash
pm2 list                        # プロセス一覧
pm2 logs                        # 全ログ表示
pm2 logs ai_cord_account1       # 特定アカウントのログ
pm2 restart ai_cord_account1    # 特定アカウント再起動
pm2 restart all                 # 全アカウント再起動
pm2 stop ai_cord_account1       # 特定アカウント停止
pm2 delete ai_cord_account1     # 特定アカウント削除
```

**メリット:**
- 各アカウントが独立して動作
- 1つのアカウントが落ちても他に影響なし
- ログを分離できる

**デメリット:**
- メモリ使用量が増加
- プロセス管理がやや複雑

### 複数アカウント運用時の注意事項

1. **レート制限**
   - Groq/OpenAI等のAPIにレート制限がある場合、複数アカウントからの同時リクエストに注意
   - 必要に応じて `ACCOUNT_N_COOLDOWN_SECONDS` を増やす

2. **Discord検知リスク**
   - 同じIPアドレスからの複数ボット アカウント = 垢バンのリスク増加
   - VPN/Proxyの使用は逆にDiscordの検知を招くため非推奨

3. **人格の区別**
   - 各アカウントに異なる `PERSONA` を指定して人格を分ける
   - `config/personas/` に複数のプロンプト��準備

4. **設定の独立**
   - アカウントごとに異なる `COOLDOWN_SECONDS` を設定可能
   - 必要に応じて異なるAI設定も可能（`ACCOUNT_N_AI_*`）

## 主な機能

- 🤖 **返信生成** - サーバー内の特定チャンネルでのメンション/リプライ/通常発言に確率的に返信
- 📝 **人格管理** - 複数の人格プロンプトをサポート（😿、その他の人格等）
- 💬 **会話履歴** - 直近の会話履歴を踏まえた文脈を意識した返信生成
- ⏰ **クールダウン・連投防止** - 返信後の最短間隔制御、自己連続投稿の抑制
- 🎲 **自発投稿** - 一定間隔でのランダムな自発投稿（テキストのみ、または動物画像+一言）
- 🎵 **Presence** - Spotify再生中/動画視聴中を模したRPCのローテーション更新
- 🔄 **マルコフ連鎖** - (任意) 口調の下書き生成で発言を自然化
- 📱 **複数アカウント** - 複数のDiscordアカウントを同時運用可能

## Oracle Cloudへのデプロイ

インスタンスへのSSH接続ができる状態から、Botを常駐させるまでの手順。GPUは不要(推論は外部APIまたは自前ホストのAPIに任せる構成のため)。

### 1. Node.jsのインストール

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash -
sudo apt-get install -y nodejs git
node -v
```

### 2. リポジトリのクローン

```bash
git clone https://github.com/hihei56/AI_cord.git
cd AI_cord
npm install
```

### 3. `.env` の設定

```bash
cp .env.example .env
nano .env
# MULTI_ACCOUNT_MODE / ACCOUNT_N_* / AI_API_KEY を設定
```

### 4. 動作確認

```bash
npm start
# [READY] のようなログが出ればOK。Ctrl+Cで停止
```

### 5. pm2で常駐化（単一アカウント）

```bash
sudo npm install -g pm2
pm2 start src/index.js --name ai_cord
pm2 save
pm2 startup
# 表示されたコマンドをそのまま実行
```

### 5b. pm2で常駐化（複数アカウント）

```bash
sudo npm install -g pm2
pm2 start pm2.config.js
pm2 save
pm2 startup
```

**運用コマンド:**

```bash
pm2 logs                        # ログ確認
pm2 restart all                 # 再起動
pm2 stop all                    # 停止
```

### 6. ネットワーク/ファイアウォール

このBotはDiscordとAI APIへ**アウトバウンド接続するだけ**で、外部からインスタンスへの**インバウンド接続を一切必要としない**。そのためOracle Cloudのインスタンスレベルのセキュリティーリストは設定不要です。

自前ホストのAI(Ollama/vLLMなど、別マシンで動かしている場合)を `AI_BASE_URL` で参照する構成にするときは、そのAPIサーバー側の到達性(Tailscale/Cloudflare Tunnel等)を別途確保してください。

### 7. 更新の反映

```bash
cd AI_cord
git pull
npm install   # 依存関係が変わっていた場合のみ
pm2 restart all
```

### 8. Always Free枠のインスタンス回収について

**課金インスタンスの場合はこの節は無関係。** Always Free枠のインスタンスを使う場合のみ、7日間のCPU使用率(95パーセンタイル)が20%を下回ると回収されます。

複数ボットを常駐させる場合、一定の負荷を意図的に発生させる必要があります。例:

```bash
# 毎日定期的に軽いコマンド実行
(crontab -l 2>/dev/null; echo "0 8 * * * curl -s https://api.groq.com/") | crontab -
```

## 依存関係

- [discord.js-selfbot-v13](https://www.npmjs.com/package/discord.js-selfbot-v13)
- [dotenv](https://www.npmjs.com/package/dotenv)
- [@sefinek/random-animals](https://www.npmjs.com/package/@sefinek/random-animals)
- [kuromoji](https://www.npmjs.com/package/kuromoji) - 日本語トークナイザー（マルコフ連鎖用）
