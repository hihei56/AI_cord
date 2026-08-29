# AI_cord

Groq(またはOpenAI互換API)を使って人間っぽく雑談・自発投稿するDiscordセルフボット。[TomoriBot](https://github.com/) のような `config/` `src/` `handlers/` `utils/` に分割したモジュール構成。

> **注意**: セルフボット(ユーザーアカウントの自動化)はDiscordの利用規約で禁止されています。利用は自己責任で、アカウント停止のリスクを理解した上で行ってください。

## 目次

- [ディレクトリ構成](#ディレクトリ構成)
- [ローカルでのセットアップ](#ローカルでのセットアップ)
- [設定](#設定)
- [主な機能](#主な機能)
- [Oracle Cloudへのデプロイ](#oracle-cloudへのデプロイ)
- [依存関係](#依存関係)

## ディレクトリ構成

```
AI_cord/
├── config/
│   ├── settings.json          # 動作設定(クールダウン、返信確率、AI/Markovパラメータ、Presenceなど)
│   ├── personas/
│   │   └── default.txt        # 人格プロンプト(システムプロンプト)
│   ├── prompts/
│   │   └── self_talk.txt      # 自発投稿用プロンプト
│   └── corpus/
│       └── default.txt        # Markov連鎖の学習元テキスト(任意機能、1行1発言)
├── src/
│   ├── index.js                # エントリーポイント
│   ├── client.js                # discord.js-selfbot-v13 クライアント生成
│   ├── handlers/
│   │   ├── messageHandler.js    # メッセージ受信・返信ロジック
│   │   ├── selfTalkHandler.js   # 自発投稿(テキスト/画像)ロジック
│   │   └── presenceHandler.js   # RPC(Spotify/視聴中ステータス)更新
│   └── utils/
│       ├── config.js            # settings.json + persona + prompt + corpus + .env の統合読み込み
│       ├── aiClient.js          # OpenAI互換Chat Completions API 呼び出し(返信生成・自発投稿生成)
│       ├── markovChain.js       # 口調再現用マルコフ連鎖(下書き生成、任意機能)
│       ├── animalImage.js       # 動物画像取得
│       └── logger.js            # ログ出力
├── scripts/
│   └── markov-demo.js          # マルコフ連鎖の学習・生成を単体で試すデモスクリプト
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## ローカルでのセットアップ

```bash
npm install
cp .env.example .env
# .env にトークン・APIキー・サーバー/チャンネルIDを設定
npm start
```

## 設定

### `.env`(機密情報・環境依存値)

| 変数 | 内容 |
|---|---|
| `DISCORD_TOKEN` | Discordアカウントのトークン |
| `AI_BASE_URL` | Chat Completions APIのベースURL(OpenAI互換なら何でも可。省略時Groq) |
| `AI_API_KEY` | 上記APIのキー(未設定時は`GROQ_API_KEY`にフォールバック) |
| `ALLOWED_GUILD_ID` | 動作させるサーバーID |
| `ALLOWED_CHANNEL_ID` | 初回起動時の初期応答チャンネルID(以降は`!channel`コマンドで動的に追加/削除可能) |
| `PERSONA` | `config/personas/` 内で使用する人格ファイル名(拡張子なし、省略時 `default`) |
| `CORPUS_FILE` | `config/corpus/` 内で使用するコーパスファイル名(省略時 `config/settings.json`の`markov.corpusFile`) |

### 複数アカウントの同時運用

1プロセスで複数のDiscordアカウントを同時に動かせる。`DISCORD_TOKEN`(無印)が1つ目のアカウントで、2つ目以降は`_2`, `_3`...を付けた変数名で追加する。

```
DISCORD_TOKEN_2=...
ALLOWED_GUILD_ID_2=...
ALLOWED_CHANNEL_ID_2=...
PERSONA_2=別の人格ファイル名
CORPUS_FILE_2=別のコーパスファイル名
```

アカウントごとに応答チャンネル一覧・ロックダウン状態・マルコフ連鎖・人格は完全に独立している(`src/account.js`でアカウントごとの実行時状態をまとめている)。AIバックエンド(`AI_BASE_URL`/`AI_API_KEY`)と`config/settings.json`の挙動設定(返信確率・遅延・モデルなど)は全アカウント共通。

### コマンド

デフォルトはアカウント本人(そのDiscordアカウント自身)が送ったメッセージだけがコマンドとして処理される。`.env`で`ALLOWED_COMMAND_ROLE_ID`(2つ目以降は`_2`など)にロールIDを指定すると、そのロールを持つサーバーメンバーも本人と同じようにコマンドを実行できるようになる(未設定なら従来通り本人限定)。プレフィックスは`config/settings.json`の`commandPrefix`(デフォルト`!`)。

| コマンド | 内容 |
|---|---|
| `!channel add\|remove\|list [channelId]` | 応答チャンネルの追加/削除/一覧(省略時は今いるチャンネル) |
| `!lockdown` / `!pause [@account]` | 自動応答・自発投稿を緊急停止/再開するトグル。ロール経由(本人以外)で実行する時は`@account`で対象アカウントの指定が必須(未指定だと全アカウント一斉停止になってしまうため) |
| `!set channel @account #channel` | 指定アカウントに応答チャンネルを追加。複数アカウント運用中にロール経由でどれか1つだけ操作したい時用 |
| `!train [件数] [@ユーザー]` | チャンネルの発言を集めてコーパスに追加し即再学習(省略時は自分自身、直近200件) |
| `!nickname learn @user [件数]` | 会話履歴からその人への呼びかけ方の候補を探索して提示(省略時は直近300件) |
| `!nickname set @user 名前` | 呼び名を個別登録 |
| `!nickname remove @user` / `!nickname list` | 呼び名の削除 / 一覧表示 |
| `!help` | コマンド一覧を表示 |

### ユーザーへの呼び方(`config/nicknames.json`)

呼び名の優先順位は「`config/nicknames.json`の個別登録」→「サーバーのニックネーム(メンバー設定)」→「Discordのusername」。ほとんどのユーザーはサーバーニックネームがあれば追加設定不要で、それすら無い/違う呼び方をしたい相手だけ個別登録すればいい。

個別登録は`!nickname set`コマンドで行うのが基本(直接ファイルを編集しなくてよい)。手動で書く場合は`config/nicknames.json`に`{ "Discordユーザー ID": "呼び名" }`の形で追加する。

`!nickname learn @user`は、そのユーザー宛てのメンション/リプライの中から「文頭付近の名前+敬称(〜ちゃん/くん/さん等)」というパターンをヒューリスティックに拾って集計するだけで、自動では登録しない(誤爆した呼び名をAIが覚えると気まずいため)。出てきた候補を見て、正しそうなものだけ`!nickname set`で確定させる運用。

### AIバックエンドの切り替え

`src/utils/aiClient.js` はOpenAI互換の `/chat/completions` エンドポイントを叛く汎用実装。`AI_BASE_URL` / `AI_API_KEY` を変更するだけで、Groq以外(自前ホストのvLLM・Ollama・text-generation-inferenceなど、OpenAI互換API公開しているもの全般)に差し替え可能。モデル名は `config/settings.json` の `ai.model` で指定する。`messageHandler.js` / `selfTalkHandler.js` / persona周りはバックエンドに依存しないため変更不要。

### `config/settings.json`(動作パラメータ)

| セクション | 内容 |
|---|---|
| `cooldownSeconds` | 返信後の最短間隔(秒) |
| `replyChance` | メンション/リプライ/通常発言それぞれの返信確率 |
| `activityRhythm` | 時間帯ごとの返信確率倍率(深夜は低活動、夜がピーク)。アカウントごとにoffset/energyで個体差あり |
| `crowdGuard` | 直近に発言者が多い(盛り上がっている)時に返信確率をそっと下げる設定 |
| `recentDuplicateGuard` | 連投・自己連続投稿の抑制設定 |
| `typingDelay` / `replyDelay` | typing表示や返信送信までの擬似的な遅延 |
| `selfTalk` | 自発投稿の間隔・確率・画像混在率・対象動物 |
| `markov` | マルコフ連鎖の口調下書き機能の設定(後述) |
| `ai` | モデル名、温度、履歴参照件数など |
| `presence` | Spotify/視聴中ステータス(RPC)のローテーション内容 |

### `config/personas/default.txt`

返信生成に使う人格・口調のシステムプロンプト。別人格を使いたい場合は同じディレクトリに新しいファイルを追加し、`.env` の `PERSONA` を切り替える。

### `config/prompts/self_talk.txt`

一定間隔で自発的につぶやく際のプロンプトテンプレート。

### マルコフ連鎖による口調の下書き(任意機能)

`config/settings.json` の `markov.enabled` を `true` にすると、`config/corpus/<corpusFile>` (改行区切りのテキスト、1行1発言目安)からマルコフ連鎖モデルを構築し、返信生成のたびに短い「口調の下書き」を作ってLLMへのプロンプトに添える。LLMには「意味は無視して口調・言い回しだけ参考にする」よう指示している。

生成開始位置は、直近の会話履歴・ユーザーの発言に含まれる単語と一致する学習データがあればそこを優先し、無ければ従来通りランダムに選ぶ(可能な範囲で文脈に寄せる、というだけの弱いバイアス)。

- `order`: マルコフ連鎖のn-gram長(大きいほど元の言い回しに忠実、小さいほど崩れやすい。2〜3推奨)
- `corpusFile`: `config/corpus/` 内のファイル名
- `draftMaxWords`: 下書きの最大単語数

Botを起動せずに単体で学習・生成結果を確認したい場合は `scripts/markov-demo.js` を使う。

```bash
node scripts/markov-demo.js [corpusFile] [order] [count]
# 例: config/corpus/default.txt を order=2 で学習し、5個生成
node scripts/markov-demo.js default.txt 2 5
npm run markov:demo
```

## 主な機能

- サーバー内の特定チャンネルでのメンション/リプライ/通常発言に確率的に返信(OpenAI互換API経由でLLM生成、デフォルトはGroq)
- 直近の会話履歴を踏まえた返信生成、連投防止・クールダウン制御
- 一定間隔でのランダムな自発投稿(テキストのみ、または動物画像+一言)
- Spotify再生中/動画視聴中を模したPresence(RPC)のローテーション更新
- (任意)マルコフ連鎖による口調の下書き生成

## Oracle Cloudへのデプロイ

インスタンスへのSSH接続ができる状態から、Botを常駅させるまでの手順。GPUは不要(推論は外部APIまたは自前ホストのAPIに任せる構成のため)。

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
# DISCORD_TOKEN / AI_API_KEY / ALLOWED_GUILD_ID / ALLOWED_CHANNEL_ID を設定
```

### 4. 動作確認

```bash
npm start
# [READY] ユーザー名#0000 のようなログが出ればOK。Ctrl+Cで停止
```

### 5. pm2で常駅化

```bash
sudo npm install -g pm2
pm2 start src/index.js --name ai_cord
pm2 save
pm2 startup
# 表示されたコマンド(sudo env PATH=... pm2 startup systemd -u ... など)をそのまま実行するとOS起動時にも自動起動する
```

運用コマンド:

```bash
pm2 logs ai_cord      # ログ確認
pm2 restart ai_cord   # 再起動(.env や config/ 変更後など)
pm2 stop ai_cord      # 停止
```

### 6. ネットワーク/ファイアウォールについて

このBotはDiscordとAI APIへ**アウトバウンド接続するだけ**で、外部からインスタンスへの**インバウンド接続を一切必要としない**。そのためOracle CloudのSecurity List/NSGで新たにポートを開放する必要はない(SSH用8番ポートのみで足りる)。

自前ホストのAI(Ollama/vLLMなど、別マシンで動かしている場合)を `AI_BASE_URL` で参照する構成にするときは、そのAPIサーバー側の到達性(Tailscale/Cloudflare Tunnelなど)を別途用意する。

### 7. 更新の反映

```bash
cd AI_cord
git pull
npm install   # 依存関係が変わっていた場合のみ
pm2 restart ai_cord
```

### 8. Always Free枠のインスタンス回収について

**課金インスタンスの場合はこの節は無関係。** Always Free枠のインスタンスを使う場合のみ、7日間のCPU使用率(95パーセンタイル)が20%を下回ると回収対象になりうる。このBotは待機中ほとんどCPUを使わないため、Always Free枠を使う場合は軽いcronのヘルスチェックなどを仕込んでおくと安全。

## 依存関係

- [discord.js-selfbot-v13](https://www.npmjs.com/package/discord.js-selfbot-v13)
- [dotenv](https://www.npmjs.com/package/dotenv)
- [@sefinek/random-animals](https://www.npmjs.com/package/@sefinek/random-animals)
