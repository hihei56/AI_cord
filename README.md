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
| `TEST_CHANNEL_ID` | (任意)テスト用チャンネルID。設定すると、このチャンネルでは応答チャンネル登録・クールダウン・返信確率・crowdGuardを全部無視して常に即応答する(動作確認用) |
| `ALLOWED_REPLY_USER_IDS` | (任意、カンマ区切り)応答してよい相手を制限したい場合のユーザーID一覧。未設定なら今まで通り誰にでも反応する |
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

アカウントごとに応答チャンネル一覧・ロックダウン状態・マルコフ連鎖・人格は完全に独立している(`src/account.js`でアカウントごとの実行時状態をまとめている)。AIバックエンド(`AI_BASE_URL`/`AI_API_KEY`)と`config/settings.json`の挙動設定(返信確率・遅延・モデルなど)は全アカウント共通。上限は無く、`DISCORD_TOKEN_N`が設定されている番号まで自動的に読み込まれる(`.env.example`に3〜6体目までのテンプレあり)。

### 全アカウント一括操作

`src/utils/accountRegistry.js`がこのプロセスで動いている全アカウントのclientを共有で保持しており、`!lockdown`/`!pause`と`!channel`は引数に`all`を指定すると対象アカウントを1つずつ指定しなくても全アカウントに一括で効く。

- `!pause all` — 全アカウントのロックダウン状態を一括で反転(自分の現在状態を反転させた値を全員に適用)
- `!channel add all [channelId]` / `!channel remove all [channelId]` — 全アカウントの応答チャンネルに一括追加/削除(省略時は今いるチャンネル)
- `!channel list all` — 全アカウントの応答チャンネル一覧をまとめて表示

### コマンド

アカウント本人(そのDiscordアカウント自身)に加えて、`src/utils/config.js`の`DEFAULT_COMMAND_ROLE_IDS`(複数指定可)で指定したロールのどれかを持つサーバーメンバーもコマンドを実行できる。別のロールに変えたい/アカウントごとに分けたい場合は`.env`で`ALLOWED_COMMAND_ROLE_ID`(カンマ区切りで複数可、2つ目以降は`_2`など)を指定すれば上書きされる。

コマンドのprefixもアカウントごとに別々(どのアカウント宛てか紛らわしくならないよう)。既定値は`src/utils/config.js`の`DEFAULT_COMMAND_PREFIXES`(1つ目`toku!`、2つ目`sui!`)で、`.env`の`COMMAND_PREFIX`(2つ目以降`_2`など)で上書きできる。例: `sui!lockdown`はsuisui(2つ目)アカウントだけに効く。

| コマンド | 内容 |
|---|---|
| `!channel add\|remove\|list [all] [channelId]` | 応答チャンネルの追加/削除/一覧(省略時は今いるチャンネル、`all`で全アカウント一括) |
| `!lockdown` / `!pause [@account\|all]` | 自動応答・自発投稿を緊急停止/再開するトグル。`all`で全アカウント一括。ロール経由(本人以外)で個別アカウントに実行する時は`@account`で対象の指定が必須(未指定だと全アカウント一斉停止になってしまうため) |
| `!set channel @account #channel` | 指定アカウントに応答チャンネルを追加。複数アカウント運用中にロール経由でどれか1つだけ操作したい時用 |
| `!set mode @account markov\|finetune` | 返信生成方式の切り替え(後述) |
| `!train [件数] [@ユーザー]` | チャンネルの発言を集めてコーパスに追加し即再学習(省略時は自分自身、直近200件) |
| `!nickname learn @user [件数]` | 会話履歴からその人への呼びかけ方の候補を探索して提示(省略時は直近300件) |
| `!nickname set @user 名前` | 呼び名を個別登録 |
| `!nickname remove @user` / `!nickname list` | 呼び名の削除 / 一覧表示 |
| `!provider [groq\|gemini]` / `!ai [groq\|gemini]` | 会話生成に使うAIプロバイダを実行中に切り替え(引数省略で現在の状態を表示)。`.env`の書き換え・再起動不要、全アカウント共通 |
| `!pricealert channel` | 今いるチャンネルを仮想通貨の価格アラート通知先に設定 |
| `!pricealert add\|remove <銘柄>` | 監視銘柄を追加/削除(既定: hype, ponz, zec, btc) |
| `!pricealert list` / `!pricealert now` | 監視設定を表示 / 現在価格を即時取得して表示 |
| `!pricealert setid <銘柄> <id>` | 自動解決に失敗した銘柄をCoinGecko idか`チェーン:ペアアドレス`で手動指定 |
| `!help` | コマンド一覧を表示 |

`!slashbump`(他BOTへのスラッシュコマンド自動送信)はai_cordプロセスのコマンドではなく、[ご飯画像の定期投稿と同じ別プロセス](#スラッシュコマンド自動送信slashbump)側のコマンド。詳細は後述。

### ユーザーへの呼び方(`config/nicknames.json`)

呼び名の優先順位は「`config/nicknames.json`の個別登録」→「サーバーのニックネーム(メンバー設定)」→「Discordのusername」。ほとんどのユーザーはサーバーニックネームがあれば追加設定不要で、それすら無い/違う呼び方をしたい相手だけ個別登録すればいい。

個別登録は`!nickname set`コマンドで行うのが基本(直接ファイルを編集しなくてよい)。手動で書く場合は`config/nicknames.json`に`{ "Discordユーザー ID": "呼び名" }`の形で追加する。

`!nickname learn @user`は、そのユーザー宛てのメンション/リプライの中から「文頭付近の名前+敬称(〜ちゃん/くん/さん等)」というパターンをヒューリスティックに拾って集計するだけで、自動では登録しない(誤爆した呼び名をAIが覚えると気まずいため)。出てきた候補を見て、正しそうなものだけ`!nickname set`で確定させる運用。

### 長期記憶(`src/utils/memoryStore.js`)

アカウントごとに、話しかけてきたユーザーとのやり取りを`data/memory-<accountId>.json`に記録する。1往復ごとに要点だけの短い断片(「〇〇「発言の一部」→ 自分「返信の一部」」)を追記し、8件溜まるとLLMに1回投げてその人物の特徴・好み・口癖を3行以内の箇条書きに要約、生ログを置き換える。次回そのユーザーと話す時、システムプロンプトの【〇〇について覚えていること】セクションとして自動で渡される。要約後にまた生ログを追記すると、次の圧縮までは要約と生ログが混ざらないよう一旦リセットされる。

### 自我・一貫性

各ペルソナ(`config/personas/*.txt`)の冒頭に「自分について(一貫して守ること)」セクションを設け、生活リズム・価値観・態度の一貫性(素性をはぐらかす、意見をコロコロ変えない、等)を明記している。あわせて、返信は必ず1行に収めるようsystemPrompt側で強制している(`src/utils/aiClient.js`の`toSingleLine`、ペルソナ側の行数指定より優先)。

### AIバックエンドの切り替え(Groq / Gemini)

`src/utils/aiClient.js` はOpenAI互換の `/chat/completions` エンドポイントを叩く汎用実装で、実際の接続先は`src/utils/aiProvider.js`が管理している。`.env`に`GROQ_API_KEY`と`GEMINI_API_KEY`を**両方**入れておけば、起動後は`.env`を書き換えず**Discord上で`!provider groq`または`!provider gemini`と打つだけ**で会話生成のバックエンドを切り替えられる(即時反映、再起動不要、全アカウント共通)。`!provider`だけ打つと現在の状態と切り替え可能なプロバイダ一覧を表示する。

切り替えると接続先URL・APIキー・モデル名(既定: groq=`openai/gpt-oss-120b`、gemini=`gemini-2.5-flash`)が自動で対応するものになる。特定のモデルを固定したい場合は`.env`の`AI_MODEL`で明示指定すれば常にそちらが優先される。`.env`の`AI_PROVIDER`は起動時点の初期値としてのみ使う(省略時`groq`)。

画像解析(vision)も同じ仕組みで、未指定なら`!provider`で選択中の会話用プロバイダをそのまま使い回す(会話をGeminiに切り替えれば画像解析も自動でGeminiになる)。会話はGroq、画像解析だけGeminiのように分けたい場合だけ`.env`の`VISION_AI_PROVIDER`を個別に指定する。

`AI_BASE_URL` / `AI_API_KEY`を明示指定すると`!provider`/`AI_PROVIDER`より優先されるので、自前ホストのvLLM・Ollama・text-generation-inferenceなど、上記2つ以外のOpenAI互換APIに差し替えたい場合はそちらを使う。`messageHandler.js` / `selfTalkHandler.js` / persona周りはバックエンドに依存しないため変更不要。

### アカウント単位でのファインチューニングモデル切り替え

`AI_BASE_URL`は全アカウント共通だが、特定のアカウントだけ別のファインチューニング済みモデルを使いたい場合(例: PC側でOllama/vLLM等を立てて動かす3体目)は、そのアカウント番号で`FINETUNE_BASE_URL_N` / `FINETUNE_API_KEY_N` / `FINETUNE_MODEL_N`を`.env`に設定した上で、`!set mode @account finetune`で切り替える。

finetuneモードでは、そのアカウントの返信はペルソナ文書・マルコフ下書きを一切使わず、会話の流れをそのままファインチューニング済みモデルに投げるだけになる(ペルソナはモデル自体に学習済みという前提)。`!set mode @account markov`でいつでも今まで通りの方式(マルコフ下書き+Groq等での補正)に戻せる。`FINETUNE_BASE_URL_N`が未設定のアカウントでfinetuneモードに切り替えようとすると拒否される。

`!set mode`での切り替えは実行中の状態変更なので再起動すると消える(常にmarkovで起動し直す)。常時finetuneモードで運用したいアカウントは`.env`で`AI_MODE_N=finetune`を指定しておくと、起動時点からfinetuneモードになる。

### 仮想通貨の価格アラート(`!pricealert`)

`src/handlers/priceAlertHandler.js`が`config/settings.json`の`priceAlert.checkIntervalMs`(既定15分、ジッター付き)ごとに監視銘柄の価格をチェックし、前回アラート時の基準価格から`priceAlert.changeThresholdPercent`(既定±5%)以上動いていたら`!pricealert channel`で設定したチャンネルに通知する。アカウントに紐づかない全体機能で、`clients[0]`(1つ目のアカウント)が通知を投稿する。

銘柄の価格解決は`src/utils/priceApi.js`が担当し、優先順位は「`!pricealert setid`での手動指定」→「CoinGecko検索(ティッカーの完全一致のみ採用)」→「DexScreener検索(CoinGecko未上場の新興トークン向け、シンボル一致かつ流動性最大のペアを採用)」。どちらのAPIも無料でAPIキー不要。自動解決に失敗した銘柄は`!pricealert list`/`!pricealert now`で「取得失敗」と表示されるので、正しいCoinGecko idか`チェーンID:ペアアドレス`(DexScreenerの表記)が分かれば`!pricealert setid <銘柄> <id>`で手動指定できる。

初期監視銘柄は`priceAlert.defaultSymbols`(既定: `hype`, `ponz`, `zec`, `btc`)。`!pricealert add|remove`で運用中に増減でき、設定は`.env`ではなく`data/price-alerts.json`に永続化されるので、通知先チャンネル・銘柄構成の変更に`.env`編集や再起動は不要。

### スラッシュコマンド自動送信(`!slashbump`)

[disssoku](https://github.com/hihei56/disssoku)のbump(サーバー宣伝BOTへの`/up`等の自動送信)機能をAI_cordに統合したもの。`npm run mealpost`(`src/mealPostBot.js`)で動くご飯画像投稿と同じ専用アカウント・同じ別プロセスで動く(ai_cordのメインプロセスとは無関係。詳細は[Oracle Cloudへのデプロイ](#oracle-cloudへのデプロイ)節参照)。`!slashbump add`で登録した対象(BOTのユーザーID・実行するスラッシュコマンド名・チャンネル)ごとに、`src/handlers/slashBumpHandler.js`が自動で実行し続ける。

- コマンドのprefixはai_cord本体(`toku!`/`sui!`等)とは別で、既定`meshi!`(`.env`の`MEALPOST_COMMAND_PREFIX`で変更可)。ロール権限も`MEALPOST_COMMAND_ROLE_ID`で個別に指定できる(未指定時はai_cordと同じ既定ロール)
- `!slashbump add <botId> <command> [#channel] [表示名]`(省略時は今のチャンネル。同じbotId×チャンネルに再度addするとコマンド/表示名を上書き更新)
- `!slashbump remove <botId> [#channel]` / `!slashbump list` — 登録解除 / 登録一覧表示
- `!slashbump now [botId] [#channel]` — クールダウンを無視して即時実行(省略時は登録済み全対象)
- 対象BOTからの応答メッセージを監視し、`successfully`を含めば成功、`please wait`/`cooldown`/`failed`/`error`等を含めばクールダウン中と判定する。クールダウン応答に`try again in N minutes/hours/days`のような記載があればその時間を読み取って次回実行時刻を調整し、読み取れなければ既定15分後にする
- 応答が全く無い場合は30〜40分のランダムな間隔で再試行する
- 設定は`.env`ではなく`data/slash-bump.json`に永続化される。対象の追加/削除は`!slashbump add`/`remove`だけで完結し、再起動不要で実行ループが即座に開始/停止する
- 対象チャンネルにアクセスできる(そのギルドに参加している)`mealpost`アカウントが実行する。会話用のペルソナ・アカウント設定とは独立した全体機能

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
| `conversationSeed` | 過疎ってるチャンネルでAIアカウント同士に掛け合いをさせる機能の設定(後述) |
| `markov` | マルコフ連鎖の口調下書き機能の設定(後述) |
| `ai` | モデル名、温度、履歴参照件数など |
| `presence` | Spotify/視聴中ステータス(RPC)のローテーション内容 |

### `config/personas/default.txt`

返信生成に使う人格・口調のシステムプロンプト。別人格を使いたい場合は同じディレクトリに新しいファイルを追加し、`.env` の `PERSONA` を切り替える。現在同梱されているのは `default`(率直・シニカル) / `gatts` / `original` / `suisui` / `discord_cutiest`(甘え上手で人懐っこい)。`discord_cutiest`アカウントは`config/corpus/Cutiest_discord.txt`をマルコフ下書き用コーパスとして使う想定なので、`.env`で該当アカウントの`PERSONA_N=discord_cutiest` / `CORPUS_FILE_N=Cutiest_discord.txt`をセットで指定する。

`.env`の`PERSONA[_N]`を空文字(`PERSONA=`)か`none`にすると、そのアカウントは人格プロンプト無しで動く。人格・口調の指示が一切無い状態で、マルコフ下書き(有効な場合)を「最低限の誤字脱字修正+会話の流れへの整合」だけで補正した返信になる(`src/utils/aiClient.js`のdraftSection参照)。コーパスの口調をLLMの解釈で上書きさせたくない場合に使う。

### AI同士の掛け合い・常時チャットモード(`conversationSeed`)

2アカウント以上動かしている時、`conversationSeedHandler.js`が定期的にランダムな2アカウントのペアを選び、共通の応答チャンネルで会話の掛け合いを起こす(`minTurns`〜`maxTurns`ターン、`continueChance`の確率で早めに切り上げ)。この掛け合いでは、相手のアカウントが人間ではなく別のAIチャットボットであることをプロンプトに明示しているので、AI同士が互いを人間だと誤認したような受け答えにはならない。

- 通常時: `checkIntervalMs`ごとに`triggerChance`の確率で発火し、対象チャンネルが`quietThresholdMs`以上発言が無い(過疎ってる)時だけ会話を始める
- `alwaysOn: true`にすると、この確率チェックと過疎チェックを両方無視し、より短い`alwaysOnIntervalMs`間隔で必ずどこかのペアが会話を始める(「AIだけで常時チャットを動かす」モード)。常時人間の発言を待たずにサーバーを賑やかに見せたい場合に使う。人間の発言に対する通常の返信ロジック(`messageHandler.js`)はそのまま生きているので、人間が話しかければ普通に反応する
- 誰も一度も発言していない完全な無人チャンネルも「過疎ってる」判定に含まれる(むしろ最優先で賑やかす対象)。掛け合いの最中にユーザーが発言してきたら検知して打ち切り、そこからは通常の返信ロジックに譲る

### `config/prompts/self_talk.txt`

一定間隔で自発的につぶやく際のプロンプトテンプレート。

### マルコフ連鎖による口調の下書き(任意機能)

`config/settings.json` の `markov.enabled` を `true` にすると、`config/corpus/<corpusFile>` (改行区切りのテキスト、1行1発言目安)からマルコフ連鎖モデルを構築し、返信生成のたびに短い「口調の下書き」を作ってLLMへのプロンプトに添える。LLMには「意味は無視して口調・言い回しだけ参考にする」よう指示している。

生成開始位置は、直近の会話履歴・ユーザーの発言に含まれる単語と一致する学習データがあればそこを優先し、無ければ従来通りランダムに選ぶ(可能な範囲で文脈に寄せる、というだけの弱いバイアス)。

- `order`: マルコフ連鎖のn-gram長(大きいほど元の言い回しに忠実、小さいほど崩れやすい。2〜3推奨)
- `corpusFile`: `config/corpus/` 内のファイル名
- `draftMaxWords`: 下書きの最大単語数
- `directReplyChance` / `directReplyMinLength`: 下書きをLLMを介さずそのまま返信に採用する確率/最低文字数(全アカウント共通の既定値)

ペルソナ(`config/personas/*.txt`)がある場合、通常は下書きを「軽い参考」程度に扱い、LLMが人格の口調で言い換える。逆にコーパスの口調そのものを主役にしたい(=ペルソナを必要最低限にして、LLMの言い換えより下書きの言い回しを優先したい)アカウントは、`.env`で`MARKOV_PRIORITY[_N]=true`にすると、LLM補正時も下書きの言い回しをできるだけそのまま活かすようプロンプトが切り替わり、下書きをそのまま採用する確率/最低文字数も(明示上書きが無ければ)既定0.5/2文字まで緩和される(`MARKOV_DIRECT_REPLY_CHANCE[_N]` / `MARKOV_DIRECT_REPLY_MIN_LENGTH[_N]`で個別上書きも可能)。`discord_cutiest`ペルソナ+`corpus/Cutiest_discord.txt`の組み合わせで使う想定。

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
- 直近の自分の発言と似すぎている返信は再生成し、機械的な連投・似た言い回しの繰り返しを抑える(`aiClient.js`の類似度チェック、messageHandler/selfTalk/conversationSeed全経路共通)
- 一定間隔でのランダムな自発投稿(テキストのみ、または動物画像+一言)。既定では無効(`config/settings.json`の`selfTalk.enabled`をtrueにすると有効化)
- 複数アカウント運用時、過疎ってるチャンネルでAI同士に掛け合いをさせる(相手がAIであることはお互い認識した上で会話する)。`alwaysOn`設定で確率・過疎チェックを無視した常時チャットモードにもできる
- Spotify再生中/動画視聴中を模したPresence(RPC)のローテーション更新
- `!lockdown all` / `!channel add|remove|list all` による全アカウント一括操作
- テスト用チャンネル(`TEST_CHANNEL_ID`)、応答相手を制限する許可リスト(`ALLOWED_REPLY_USER_IDS`)
- 仮想通貨の価格アラート(`!pricealert`)。指定チャンネルで監視銘柄を一定間隔でチェックし、前回アラート時から±5%(既定)以上動いたら通知する
- 他BOTへのスラッシュコマンド自動送信(`!slashbump`)。サーバー宣伝BOT等への`/up`を対象BOTの応答(成功/クールダウン)に応じて自動でスケジュールし続ける
- 自発投稿・AI同士の掛け合いチェック・Presence更新・返信クールダウンは全て`setInterval`の完全固定周期ではなく`src/utils/scheduler.js`でランダムな揺らぎ(ジッター)を持たせたスケジューリングにしている(投稿タイミングが規則的になりbotだとバレやすくなるのを防ぐため)。返信までの間も`typingDelay.longPauseChance`の確率でたまに長考(既定15〜90秒)を挟み、毎回同じテンポで即レスしないようにしている
- メッセージへの添付画像・URL貼り付け時のembed画像を読み取り、内容を踏まえて返信する(vision対応モデル経由。複数枚添付にも対応)
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

### 7.5 pushするだけで自動デプロイ(`scripts/auto-deploy.js`)

毎回SSHして`git pull && pm2 restart`を打つ代わりに、GitHubへのpushを検知して自動で反映する常駐プロセスを立てられる。Webhookのようにインスタンス側でポートを開けてインバウンド接続を待ち受ける方式ではなく、一定間隔で`git fetch`してリモートと比較するポーリング方式にしているので、[6.のネットワーク方針](#6-ネットワークファイアウォールについて)(アウトバウンドのみ)を崩さない。

```bash
cd AI_cord
pm2 start scripts/auto-deploy.js --name deploy-watch
pm2 save
```

- 既定では`main`ブランチを1分間隔でチェックし、新しいコミットを検知したら`git pull`→(`package.json`が変わっていれば)`npm install`→`pm2 restart ai_cord mealpost`まで自動で行う
- 追跡するブランチ・ポーリング間隔・再起動対象のpm2プロセス名は`.env`の`DEPLOY_BRANCH` / `DEPLOY_CHECK_INTERVAL_MS` / `DEPLOY_PM2_PROCESSES`(カンマ区切り)で変更できる
- サーバー側で直接ファイルを編集した後や、リモートと競合する変更がある状態だと`git pull`に失敗することがある。その場合はデプロイ自体は成功しないが`deploy-watch`プロセスは落ちずに次回のポーリングで再試行し続けるので、`pm2 logs deploy-watch`でエラー内容を確認して手動で解消する
- スマホのGitHubアプリ等からpushするだけで、次のポーリングのタイミング(既定最大1分後)で反映される

### 8. Always Free枠のインスタンス回収について

**課金インスタンスの場合はこの節は無関係。** Always Free枠のインスタンスを使う場合のみ、7日間のCPU使用率(95パーセンタイル)が20%を下回ると回収対象になりうる。このBotは待機中ほとんどCPUを使わないため、Always Free枠を使う場合は軽いcronのヘルスチェックなどを仕込んでおくと安全。

## 依存関係

- [discord.js-selfbot-v13](https://www.npmjs.com/package/discord.js-selfbot-v13)
- [dotenv](https://www.npmjs.com/package/dotenv)
- [@sefinek/random-animals](https://www.npmjs.com/package/@sefinek/random-animals)
