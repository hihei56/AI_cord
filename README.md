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
| `ALLOWED_GUILD_ID` | 動作させるサーバーID(カンマ区切りで複数可)。`src/utils/config.js`の`DEFAULT_GUILD_IDS`と合わせて掛け持ちする。初回起動時の初期値で、以降は`!guild add\|remove\|list [all]`で変更する |
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

### 統合コマンド(`ai!`、普段はこれだけ使えばよい)

全アカウントをまとめて操作する。対象は名前(前方一致)・番号・@メンションで絞れ、省略すると全員に効く。同じメッセージは最初に拾った1アカウントだけが処理するので、返事は1回だけ返る。prefixは`config/settings.json`の`controlPrefix`で変更できる。

| コマンド | 内容 |
|---|---|
| `ai! status` | 全アカウントの稼働状態・担当チャンネル数・AIプロバイダ・今日のトークン消費 |
| `ai! on [対象]` / `ai! off [対象]` | 動かす / 止める |
| `ai! here [対象]` / `ai! leave [対象]` | 今のチャンネルを担当にする / 外す |
| `ai! talk` | 今のチャンネルでアカウント同士の雑談をすぐ始める |
| `ai! agent [on\|off\|now\|status]` | 自律エージェント |
| `ai! report [channel\|now\|off]` | サーバー活性化レポート |
| `ai! provider [名前]` | AIプロバイダの切り替え |
| `ai! help` | 一覧 |

下の従来のアカウント別prefixのコマンドもそのまま使える(呼び名・学習・株価などの個別機能用)。

### 知識ベース・質問への回答・役割(れおうーん/Zerole風)

- **知識ベース**: `config/knowledge/`に`.md`/`.txt`(サーバーの歴史・内輪ネタ・用語集など)を置くと、会話の話題に関係する部分だけをAIが「知っていること」として使う。見出し(#)か空行で区切った単位で検索し、LLMやAPIは使わない(文字2-gramのIDF重み付き一致)。書き換えると1分以内に反映。書き方は`config/knowledge/README.sample`
- **役割**: `.env`の`ROLE[_N]`で各アカウントにキャラを付ける。`knower`(物知り)/`tsukkomi`(ツッコミ)/`boke`(ボケ)/`listener`(聞き役)。内容は`config/settings.json`の`roles`で変更・追加できる。グループ会話・返信・独り言すべてに反映される
- **物知り役の回答**: `knower`は、人間の事実を聞く質問(「いつ」「って何」「おすすめ」等を含むもの)に、知識ベースに無ければWeb検索(要`TAVILY_API_KEY`、1日`SEARCH_MAX_PER_DAY`回まで、既定30)してから答える。答える時だけ1行60文字の制限が外れ、句読点ありの1〜3文(`roles.knower.maxReplyLength`、既定140文字)になる。他のアカウントが返信役になった場合も、物知り役は補足として人間に答えに行く
- 人間のふりをしているアカウントなので、調べた内容も「さっき見たら〜らしい」程度の雑談の調子で、URL・出典・箇条書きは出さない

### 会話の自然さ(類似プロジェクトの仕組みを取り込んだもの)

| 仕組み | 参考元 | 内容 |
|---|---|---|
| 会話の継続 | Discord-AI-Selfbot(hold_conversation) | 返信した相手が3分以内に続けて喋ったら、リプライされた時と同じ扱いで、短いクールダウン(15秒)で返す。以前は返信直後のクールダウンと「直前が自分の発言なら返さない」ガードで、人間が返事をしてきても無視していた |
| 連投のまとめ | Discord-AI-Selfbot(batch_messages) | 同じ人が20秒以内に分けて送った発言をまとめて読み、最後の発言に返信する |
| 名前で呼ばれたら答える | SillyTavern(グループチャット) | @メンションでなくても、本文で呼び名・ユーザー名を呼ばれたら呼びかけとして扱う |
| 次の話者の選び方 | SillyTavern(natural/pooled order) | グループ会話で、名前を呼ばれた参加者 → まだ喋っていない参加者 → 喋りやすさ(`roles.<役割>.talkativeness`、無ければ返信確率倍率)の重み付き抽選 の順に選ぶ |
| 会話の切り上げ | a16z ai-town(leaveConversation) | AI同士の会話の最後の発言を、`crowd.closingChance`の確率で「そろそろ落ちる」等の切り上げの一言にする |
| AI同士の記憶 | a16z ai-town(会話の記憶) | AI同士のやり取りも相手ごとに記憶・要約し、次に同じ相手と話す時に前の話題を拾えるようにする |

設定は`config/settings.json`の`conversationHold`(`windowMs`/`cooldownSeconds`/`batchWindowMs`)と`crowd.closingChance`。

### 返信の作り方(無理して真似ている感を減らす)

- **本物の発言を手本にする**: そのアカウントのコーパス(`config/corpus/`)から、話題に近い発言とランダムな発言を5件ほど選び、「実際の人間の発言例」としてプロンプトに入れる。人格ありの通常アカウントでは、手本を渡せている時はマルコフ連鎖の下書きを渡さない(`MARKOV_PRIORITY`のアカウントと人格なしのアカウントは従来通り下書きを使う)
- **中身が先、口調は後**: 「まず相手の言いたいことと会話の流れを読む」「人格設定は背景であって毎回見せるものではない」をルールに入れている
- **言うことが無ければ返さない**: 直接呼ばれていない・会話中の相手でもない発言には、モデルが`SKIP`と答えたら投稿しない
- **会話履歴**: 直近12件を渡す(`ai.reply.historyContextSize`)
- **文の切り方**: 上限(`ai.reply.maxReplyLength`)を超えたら、文字数ちょうどではなく手前の区切り(空白・「w」「草」・「!?」等)で切る

### 他サーバーの会話の観察(`observe`、口調の手本)

監視対象に登録したチャンネル(他サーバーでもよい。どれかのアカウントがそのサーバーに参加している必要がある)の人間の発言を、本文だけのプレーンテキストで`data/observed.json`に溜め(直近2000件)、返信・独り言のプロンプトに「実際の人間の発言例」として6件ほど入れる。安いモデルは口調を説明するより実例を見せた方が自然に真似るため。

- 登録: `ai! watch add <チャンネルID>`(自分のサーバーから打てる) / `remove` / `show`(直近10件) / `clear`。`.env`の`WATCH_CHANNEL_IDS`(カンマ区切り)は初回の初期値
- 受信済みのメッセージを記録するだけで、履歴の追加fetchはしない。発言者の名前・IDは保存せず、メンション・URL・カスタム絵文字は取り除く。bot・コマンド・`@everyone`・2文字未満・80文字超は溜めない
- 手本はあくまで口調の参考で、そのまま投稿はさせない。生成結果が手本とほぼ同じ文(類似度0.8以上)になったら投稿を見送る
- 言語固定アカウント(`REPLY_LANGUAGE`)には手本を渡さない

### botの立ち位置: 人間の盛り立て役(`humanPresence`)

botは主役ではなく、人間が少なすぎる時だけ代わりに喋る係。直近15分のメッセージキャッシュから人間の人数を数え(APIは呼ばない)、出しゃばり具合を変える。

| 状況 | 通常発言への返信 | 他アカウントの乗っかり | AI同士の会話 |
|---|---|---|---|
| 人間3人以上 or 15分で10発言以上(busy) | ×0.25(引っ込む) | しない | しない |
| 人間2人(normal) | 普段どおり | たまに(主にリアクションだけ) | しない |
| 人間1人(few) | ×1.4(寂しくさせない) | よくする(主にその人に話しかける) | 割り込み会話はする |
| 人間なし(empty) | — | — | する(人が来たら譲る) |

メンション・リプライで直接呼ばれた時は人数に関係なく返す。数値は`config/settings.json`の`humanPresence`で上書きできる。

### 複数アカウントの同時感(`crowd`)

- **返信役と追従役**: 1つの人間の発言に複数アカウントが返信しようとした場合、最初の1つが普通に返信し(lead)、残りはleadの返信に乗っかる(follower、最大`maxFollowers`)。返信判定を通らなかったアカウントも`followChance`で乗っかる。followerはleadが入力中のうちから入力中表示を出すので「〇〇と△△が入力中…」になる。`replyToHumanChance`の確率でleadではなく人間に別角度で返す。追従の生成はバックグラウンド扱い(Logfare等に逃がす)
- **グループ会話**: AI同士の掛け合いに、同じチャンネルを担当する他のアカウントが`groupJoinChance`で途中参加する(最大`groupMaxSize`人)。3人以上の時は次の話者を直前以外からランダムに選び、`overlapTypingChance`で次の話者候補も同時に入力中表示を出す

### コマンド

アカウント本人(そのDiscordアカウント自身)と、コマンドを打ったサーバーのオーナー・管理者権限(Administrator)を持つメンバーは、どのサーバーでも常にコマンドを実行できる(掛け持ちした新しいサーバーでもロール設定なしで使えるように)。それに加えて、`src/utils/config.js`の`DEFAULT_COMMAND_ROLE_IDS`(複数指定可)で指定したロールのどれかを持つサーバーメンバーもコマンドを実行できる。別のロールに変えたい/アカウントごとに分けたい場合は`.env`で`ALLOWED_COMMAND_ROLE_ID`(カンマ区切りで複数可、2つ目以降は`_2`など)を指定すれば上書きされる。

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
| `!market channel` / `!market off` | 今いるチャンネルを米国株の市況まとめ(毎朝)の投稿先に設定 / 停止 |
| `!market now` / `!market status` | 市況まとめを今すぐ表示 / 設定状況を表示 |
| `!housewatch channel` / `off` | なんJ実況G(livegalileo)のお🏡スレ検知の通知先を今のチャンネルに設定 / 通知停止 |
| `!housewatch status` / `now` | 監視設定を表示 / 即時チェック |
| `!agent [status\|on\|off\|now]` | 自律エージェントの状態・行動ごとの効果を表示 / 実行中の有効化・無効化 / 今いるチャンネルで1回判断させる(動作確認用) |
| `!coach channel\|off\|now\|status` | サーバー活性化レポートの投稿先設定 / 停止 / 今すぐ作成 / 状態表示 |
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

### OpenRouter・接続失敗時の扱い

- **OpenRouter(`openrouter`)**: `OPENROUTER_API_KEY`と`OPENROUTER_MODEL`(`:free`の付いたモデルID)の両方を入れた時だけ使う。無料モデルのカタログは頻繁に変わるため既定のモデルIDは持たない
- **タイムアウトと接続失敗**: LLM呼び出しにはタイムアウト(`ai.requestTimeoutMs`、既定60秒)がある。接続できない・応答しない接続先は`budget.unreachableCooldownMs`(既定10分)スキップして次のプロバイダに回す
- **Discordのレート制限での自動停止**: 10分間にDiscordのレート制限を5回踏んだアカウントは30分間自動で`lockedDown`になり、時間が来たら自動で解除される(`discordGuard`で調整可。手動の`!pause`は自動解除しない)

### アカウント単位でのファインチューニングモデル切り替え

`AI_BASE_URL`は全アカウント共通だが、特定のアカウントだけ別のファインチューニング済みモデルを使いたい場合(例: PC側でOllama/vLLM等を立てて動かす3体目)は、そのアカウント番号で`FINETUNE_BASE_URL_N` / `FINETUNE_API_KEY_N` / `FINETUNE_MODEL_N`を`.env`に設定した上で、`!set mode @account finetune`で切り替える。

finetuneモードでは、そのアカウントの返信はペルソナ文書・マルコフ下書きを一切使わず、会話の流れをそのままファインチューニング済みモデルに投げるだけになる(ペルソナはモデル自体に学習済みという前提)。`!set mode @account markov`でいつでも今まで通りの方式(マルコフ下書き+Groq等での補正)に戻せる。`FINETUNE_BASE_URL_N`が未設定のアカウントでfinetuneモードに切り替えようとすると拒否される。

`!set mode`での切り替えは実行中の状態変更なので再起動すると消える(常にmarkovで起動し直す)。常時finetuneモードで運用したいアカウントは`.env`で`AI_MODE_N=finetune`を指定しておくと、起動時点からfinetuneモードになる。

### 5ch自動まとめスクリプト(`scripts/matome.js`)

ボット本体とは独立した単体スクリプト。スレを取得して、まとめブログ風のHTMLを`outputs/matome-<スレ番号>.html`(git管理外)に書き出す。Discordには何も投稿しない。

```
node scripts/matome.js https://nova.5ch.io/test/read.cgi/livegalileo/1234567890/   # 指定スレ
node scripts/matome.js --latest                                                     # 実況Gの最新ID非表示🏡スレ
node scripts/matome.js --file 1234567890.dat                                        # 手元のdat(Shift_JIS)
```

抜粋はAIを使わず安価の数だけで決める: `>>1` → 安価が`--min-replies`(既定3)以上付いたレス(最大`--max`件、既定30)と、それぞれへの返信(`--replies`件まで、既定5)。安価5以上は赤字・大きく、3以上は青字。スレ取得はお🏡検知と同じ`src/utils/fivechApi.js`(dat優先、失敗時read.cgi)を使う。

### AI投稿の一括停止(`aiPosting.enabled`)

`config/settings.json`の`aiPosting.enabled`を`false`にすると、AIによる返信(`messageHandler`)・アカウント同士の掛け合いと割り込みリプライ(`conversationSeedHandler`)・自発投稿(`selfTalkHandler`)を止める。`!pause`(ロックダウン)と違い、コマンド・リアクション・価格アラート・ご飯投稿・お🏡検知は動いたままで、設定ファイルなので再起動しても停止状態が保たれる。再開は`true`に戻して再起動(mainにpushすれば自動デプロイで反映)。リアクションも止めたい場合は`reactions.enabled`を`false`にする。

### お🏡スレ検知(`!housewatch`)

`src/handlers/houseWatchHandler.js`が`config/settings.json`の`houseWatch.checkIntervalMs`(既定2分、ジッター付き)ごとに`houseWatch.boardUrl`(既定 なんでも実況G `https://nova.5ch.io/livegalileo/`)の`subject.txt`を取得し、レスが2件以上付いた未判定スレの先頭数レスだけ(datをRangeで先頭8KB、失敗時read.cgiの1-11レス目)を取得して、ID非表示のスレのURLだけを`!housewatch channel`で設定したチャンネルに通知する。`houseWatch.keyword`を設定するとスレタイにそれを含むスレだけに絞る(既定は空=全スレ。例: `"🏡"`)。初回は一覧の全スレを1件ずつ判定するので数分かかるが、2回目以降は新しく立ったスレだけを見る。ID非表示の判定は`>>2`以降(最大10レス)に`ID:`が1つも出ていないかで行う。実況Gでは`!extend:none:none:1000:512`で立てても`>>1`末尾に`VIPQ2_EXTDAT: none:none:...`が付くだけで`>>2`以降にIDが出るスレが実在し(浪人以外はID非表示にできない板設定のため)、`>>1`自身はどちらでもIDが出ないので、EXTDATや`>>1`では判定できない。`>>2`が付くまでは判定を保留し次回再チェックする。`houseWatch.requireIdHidden`を`false`にするとID判定を省いてタイトル一致だけで通知する。判定済みスレキーは`data/house-watch.json`に保存され、再起動しても二重通知しない(取得に失敗したスレは次回再試行)。投稿役は投稿の都度、ログイン済み・ロックダウン中でない・通知先チャンネルが見えるアカウントから選ぶ(`houseWatch.accountOrder`にアカウントIDの配列を書けばその優先順、空ならアカウント番号順)。アカウント1が落ちていても他のアカウントが代わりに投稿し、送信に失敗した場合も次のアカウントで送り直す。

### 仮想通貨の価格アラート(`!pricealert`)

`src/handlers/priceAlertHandler.js`が`config/settings.json`の`priceAlert.checkIntervalMs`(既定15分、ジッター付き)ごとに監視銘柄の価格をチェックし、前回アラート時の基準価格から`priceAlert.changeThresholdPercent`(既定±5%)以上動いていたら`!pricealert channel`で設定したチャンネルに通知する。アカウントに紐づかない全体機能で、`clients[0]`(1つ目のアカウント)が通知を投稿する。

銘柄の価格解決は`src/utils/priceApi.js`が担当し、優先順位は「`!pricealert setid`での手動指定」→「CoinGecko検索(ティッカーの完全一致のみ採用)」→「DexScreener検索(CoinGecko未上場の新興トークン向け、シンボル一致かつ流動性最大のペアを採用)」。どちらのAPIも無料でAPIキー不要。ただしCoinGeckoはクラウドサーバーのIPからだとキー無しのリクエストを403で弾くことがあるため、その場合はCoinGeckoのDeveloper Dashboardで無料のDemo APIキーを発行して`.env`の`COINGECKO_API_KEY`に設定する。自動解決に失敗した銘柄は`!pricealert list`/`!pricealert now`で「取得失敗」と表示されるので、正しいCoinGecko idか`チェーンID:ペアアドレス`(DexScreenerの表記)が分かれば`!pricealert setid <銘柄> <id>`で手動指定できる。

監視銘柄は毎日1回(日本時間`priceAlert.dip.checkHourJST`時以降、既定9時)、日足で米国株と同じ基準の押し目判定も行い、該当した銘柄だけ同じチャンネルに通知する(`!pricealert dip`で即時判定)。仮想通貨は値動きが大きいので線への接近幅は`priceAlert.dip.touchPercent`(既定±3%)。日足はCoinGeckoの`market_chart`(無料APIは過去365日まで)から取るため、DexScreener由来の銘柄(CoinGecko未上場のトークン)は判定対象外。

初期監視銘柄は`priceAlert.defaultSymbols`(既定: `hype`, `ponz`, `zec`, `btc`)。`!pricealert add|remove`で運用中に増減でき、設定は`.env`ではなく`data/price-alerts.json`に永続化されるので、通知先チャンネル・銘柄構成の変更に`.env`編集や再起動は不要。

### 米国株の市況まとめ(`!market`)

`src/handlers/marketReportHandler.js`が日本時間の`marketReport.postHourJST`(既定7時)以降に1日1回、NASDAQ100(`^NDX`)とS&P500(`^GSPC`)の前日終値をもとに次の内容を`!market channel`で設定したチャンネルへ投稿する。米国の取引日が前回投稿時から変わっていない日(土日祝の翌朝)は投稿しない。

普段は`🍆 21,340 (-1.2%)`(🍆=NASDAQ100) / `P500 6,450 (-0.8%)` / `VIX 18.4 / PER 28.7`(PERはS&P500の実績PER)の3行だけにし、次のことが起きた日だけ⚠️行を足す。

- 押し目(`🎯`): 上昇トレンド中(200日線が20営業日前より上向き、かつ終値が200日線より上)に、上から下がってきて50/120日線の±`touchPercent`%以内に入った・割り込んだ日。200日線への接近は「深い押し目」、200日線割れは押し目ではなく「トレンド転換注意(⚠️)」として出す。下降トレンド中の線タッチは通知しない。1日に複数の線をまたいだ時は一番深い線だけ
- RSI(14)が70以上/30以下、VIXが`vixAlert`以上

押し目には「押し目らしさ」の★(1〜4)が付く。線タッチで★1、高値からの下落率が`dipScore.drawdownMin`〜`drawdownMax`%(既定5〜15%。浅すぎる揺れと暴落の途中は加点しない)、RSIが`rsiMax`(既定40)以下、VIXが`vixMin`(既定25)以上、一目均衡表の雲の上限付近〜雲の中まで下がってきた(`☁`を表示)でそれぞれ+1(最大★5)。仮想通貨は`priceAlert.dip`の同名項目(既定: 下落率15〜40%、RSI40以下、VIX加点なし。CoinGeckoの日足は終値しか無いので、雲は終値で近似計算する)。配点は根拠データ無しで決めたもので、各条件は相関も強いため、`npm run dip:backtest -- ^NDX`(`BTC-USD`や`--csv 日付,終値のCSV`も可)で過去の成績を「毎日買った場合」と比べてから信用すること。

通知は本人向けの短い記号表記: `🎯🍆 50 -6.2`(押し目、50日線、高値から-6.2%)、`🎯🎯`=深い押し目(200日線)、`💀`=200日線割れ、`🔥`/`🧊`=RSI70以上/30以下、`VIX 32.1!`=VIXが警戒水準。凡例は`!market`(引数なし)で表示される。

`marketReport.aiSummary`を`true`にすると、値動きの理由も1行足す(既定はオフ)。理由はYahoo FinanceのヘッドラインRSSの見出しだけを渡してAIに1文で要約させる(予想・売買推奨はさせない。読み取れなければ行ごと省く)。AIは会話とは別枠の`seed`接続を使う。

データ取得元はYahoo Financeのchart API/RSS(非公式・APIキー不要)とmultpl.com(S&P500のPER、スクレイピング)。どれも予告なく使えなくなる可能性があり、取れなかった項目は表示から省く。ナスダック100のPERは無料で安定して取れる取得元が無いため表示しない。

### スラッシュコマンド自動送信(`!slashbump`)

[disssoku](https://github.com/hihei56/disssoku)のbump(サーバー宣伝BOTへの`/up`等の自動送信)機能をAI_cordに統合したもの。`npm run mealpost`(`src/mealPostBot.js`)で動くご飯画像投稿と同じ専用アカウント・同じ別プロセスで動く(ai_cordのメインプロセスとは無関係。詳細は[Oracle Cloudへのデプロイ](#oracle-cloudへのデプロイ)節参照)。`!slashbump add`で登録した対象(BOTのユーザーID・実行するスラッシュコマンド名・チャンネル)ごとに、`src/handlers/slashBumpHandler.js`が自動で実行し続ける。

> `mealpost`プロセスも、ai_cord本体の`DISCORD_TOKEN[_N]`と同じ考え方で`MEALPOST_DISCORD_TOKEN_2`のように番号を付ければ2体目以降のアカウントを同一プロセスに追加できる(`MEALPOST_COMMAND_PREFIX_2`/`MEALPOST_COMMAND_ROLE_ID_2`も個別指定可)。slashbump/relayはチャンネルIDからどのアカウントが担当するか自動で解決するため、複数アカウントを足しても既存の対象設定に影響しない。

- コマンドのprefixはai_cord本体(`toku!`/`sui!`等)とは別で、既定`meshi!`(`.env`の`MEALPOST_COMMAND_PREFIX`で変更可)。ロール権限も`MEALPOST_COMMAND_ROLE_ID`で個別に指定できる(未指定時はai_cordと同じ既定ロール)
- `!slashbump add <botId> <command> [#channel] [表示名]`(省略時は今のチャンネル。同じbotId×チャンネルに再度addするとコマンド/表示名を上書き更新)
- `!slashbump remove <botId> [#channel]` / `!slashbump list` — 登録解除 / 登録一覧表示
- `!slashbump now [botId] [#channel]` — クールダウンを無視して即時実行(省略時は登録済み全対象)
- 対象BOTからの応答メッセージを監視し、`successfully`を含めば成功、`please wait`/`cooldown`/`failed`/`error`等を含めばクールダウン中と判定する。クールダウン応答に`try again in N minutes/hours/days`のような記載があればその時間を読み取って次回実行時刻を調整し、読み取れなければ既定15分後にする
- 応答が全く無い場合は30〜40分のランダムな間隔で再試行する
- 設定は`.env`ではなく`data/slash-bump.json`に永続化される。対象の追加/削除は`!slashbump add`/`remove`だけで完結し、再起動不要で実行ループが即座に開始/停止する
- `mealpost`アカウントは`MEALPOST_DISCORD_TOKEN_2`, `_3`...で複数動かせる。どのアカウントが実行するかは`!slashbump assign <アカウント番号> [serverId]`でサーバーごとに割り当てる(省略時は今のサーバー、`!slashbump unassign`で解除、`!slashbump list`で確認)。割り当てが無いサーバーでは、対象チャンネルにアクセスできる(そのギルドに参加している)最初のアカウントが実行する。会話用のペルソナ・アカウント設定とは独立した全体機能
- ご飯画像の定期投稿もアカウントごとに独立して行う。投稿先・画像フォルダは`MEALPOST_CHANNEL_ID[_N]` / `MEALPOST_IMAGE_FOLDER[_N]`で変更でき、未設定なら`config/settings.json`の`mealPosts.channelId` / `folderBase`を使う

**`mode`(1日1回モード):** `!slashbump mode <botId> <daily|continuous> [#channel]`で、対象ごとに実行方式を切り替えられる。既定(`continuous`)は上記の「クールダウンを見ながら繰り返し実行」だが、`daily`にすると**1日1回、`config/settings.json`の`slashBumpDaily`(既定8時〜23時、日中活動時間帯のイメージ)からランダムに選んだ時刻に1回だけ**実行するようになる(Discord側の応答・クールダウンは一切見ない)。`mealImageHandler.js`のご飯画像投稿と同じ「その日の予定時刻を一度だけ抽選し、日付が変わるまで固定する」方式(`data/daily-bump.json`に永続化、再起動を挟んでも同じ日なら再抽選しない・二重実行しない)。

### チャンネル転送/マルチポスト(`relay`)

特定サーバーの特定チャンネルの投稿を、他の複数チャンネルへそのまま転送(ミラー)する機能。`!slashbump`と同じ`mealpost`プロセス(`src/mealPostBot.js`)専用で動く(ai_cordのメインプロセスとは無関係)。設定は**コマンドを実行したアカウントに紐づく**(`client.accountState.relay`、`data/relay-<アカウントID>.json`に永続化)。`.env`の`RELAY_SOURCE_GUILD_ID`/`RELAY_SOURCE_CHANNEL_ID`/`RELAY_DESTINATION_CHANNEL_IDS`は初回起動時の初期値としてのみ使われ、以降は`!relay`コマンドで再起動不要に変更できる。

- `src/handlers/relayHandler.js`が各アカウントの設定を見る。監視元チャンネルへメッセージが投稿されると、本文はそのままコピペし、添付ファイル・embed画像/動画はダウンロード/再アップロードせずDiscordのCDN URLをそのまま本文に含めて転送する(URLがあればDiscord側が自動でプレビュー展開する)
- 本文中にtwitter.com/x.com/nitter等のツイートリンクが含まれていれば、`src/utils/vxtwitter.js`でvxtwitter.com形式に変換してから転送する(生のツイートリンクはDiscordの埋め込みプレビューが展開されないため)。それ以外のURL・テキストはそのまま
- 転送元・転送先チャンネルには、監視を担当するアカウント(転送先は`mealpost`プロセスのいずれかのアカウント)が参加している必要がある
- 連続投稿があっても即座に全部転送せず、1件ずつ`relay.delayMs`(既定5秒)±`delayJitter`の間隔を空けて順番に転送する(機械的な連投に見えないようにするため)

| コマンド | 内容 |
|---|---|
| `!relay source [#channel]` | 監視元チャンネルを設定(省略時は今のチャンネル) |
| `!relay adddest [#channel]` / `removedest [#channel]` | 転送先の追加/削除(複数可、省略時は今のチャンネル) |
| `!relay on` / `off` | 有効化/無効化 |
| `!relay list` | 現在の設定確認 |

### RSSフィード経由のツイートリンク自動投稿(`rssTwitterPost`)

nitter等のRSSフィードを定期的にポーリングし、フィード内のツイートリンク(nitterインスタンス経由が主だが`/ユーザー名/status/ID`の形式ならtwitter.com/x.comのリンクでも可)を埋め込みプレビューの展開されるvxtwitter.com形式のURLに変換して指定チャンネルへ投稿する機能。`!slashbump`/`relay`と同じ`mealpost`プロセス専用。設定は**コマンドを実行したアカウントに紐づく**(`client.accountState.rssFeed`、`data/rss-feed-<アカウントID>.json`に永続化)。`.env`の`RSS_FEED_URL`/`RSS_POST_CHANNEL_ID`は初回起動時の初期値としてのみ使われ、以降は`!rssfeed`コマンドで再起動不要に変更できる。

- `src/handlers/rssTwitterPostHandler.js`が`config/settings.json`の`rssTwitterPost.checkIntervalMs`(既定10分)±`checkIntervalJitter`ごとにフィードを取得し、`src/utils/rssTwitterStore.js`(`data/rss-twitter-seen-<アカウントID>.json`)で既に見たアイテムを記録して新着だけを拾う
- **初回起動時だけ**、フィードの既存アイテムを全部「新着」として一気に投稿してしまわないよう、既読登録のみ行い投稿はスキップする。2回目以降のチェックで見つかった本当の新着だけを投稿する
- 変換は`src/utils/vxtwitter.js`が担当。リンクのパスが`/ユーザー名/status/ID`の形式でなければ(リツイートの一覧ページ等、ツイート個別リンクでない場合)そのアイテムはスキップする
- 新着が複数件あっても連続投稿せず、`rssTwitterPost.postDelayMs`(既定4秒)±`postDelayJitter`の間隔を空けて古い順に1件ずつ投稿する
- 一部のNitterミラーはUser-Agent無しのリクエストを拒否するため、`User-Agent: Mozilla/5.0`を付けて取得する
- ミラーURLはカンマ区切り(または`!rssfeed add`)で複数指定でき、先頭から順に試して最初に成功したものを使う(1つのミラーが落ちていても他のミラーで拾えるフォールバック。単独の外部プロキシサーバーを別途立てる必要が無いよう、このフォールバック自体をBot側に持たせている)

| コマンド | 内容 |
|---|---|
| `!rssfeed add <URL>` / `remove <URL>` | ミラーURLの追加/削除 |
| `!rssfeed channel [#channel]` | 投稿先チャンネルを設定(省略時は今のチャンネル) |
| `!rssfeed on` / `off` | 有効化/無効化 |
| `!rssfeed list` | 現在の設定確認(`!rss`でも可) |

> `!relay`/`!rssfeed`/`!slashbump`/`!gifgenre`はいずれも**コマンドを実行したアカウント**に紐づくため、`MEALPOST_DISCORD_TOKEN_2`のような2体目以降のアカウントを追加すれば、「1体目のアカウントで`!relay`を管理、2体目のアカウントで`!rssfeed`を管理」のように役割を分けられる。ただし2体目以降のコマンドprefix(`MEALPOST_COMMAND_PREFIX_2`)を1体目と同じにすると、同じチャンネルで打った1つのコマンドを両方のアカウントが受信して二重に実行してしまうため、複数アカウントを使う場合は必ず別々のprefixにすること。

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

### 絵文字/GIFのみモード(`emojiGifOnlyMode`)

`config/settings.json`の`emojiGifOnlyMode.enabled`をtrueにすると、ai_cord本体の返信生成経路(人間への通常返信・自発投稿・AI同士の掛け合い、全て)がLLMを一切呼ばなくなり、代わりに絵文字1つかGIF1つのどちらかだけを送るようになる(ペルソナ・マルコフ下書きによる文章生成を完全に止める、いわば「自我を消す」モード)。

- `src/utils/emojiGifReply.js`が本体。アカウントに`gifGenres`(`!gifgenre`で管理)が設定されていれば`emojiGifOnlyMode.gifChance`(既定50%)の確率でKlipy検索したGIFを、それ以外は`src/utils/reactionEmoji.js`のキーワードパターンマッチ絵文字(該当無しならランダムプールから)を返す
- LLM呼び出し(`getAIResponse`/`generateSelfTalk`/`planConversationTopic`)は該当箇所で丸ごとスキップされるため、この間はAPIコストが一切発生しない。画像添付の読み取り(vision API)もLLM返信にしか使わないため合わせてスキップする
- `false`に戻せば、既存の通常のLLM返信(+ときどきGIFを混ぜる従来の`gif`セクションの挙動)にそのまま戻る

### 宣伝RPC(`promo`)

各アカウントのRPCの先頭に「〇〇をプレイ中」+「サーバーに参加」ボタン(招待リンク)を出す。RPCはそのアカウントがいる**全サーバー**のメンバー一覧・プロフィールに表示されるので、別サーバーにいるだけ(発言不要)で入口になる。

- 必要なもの: `.env`の`PROMO_INVITE_URL`(招待リンク。期限なし・使用回数無制限で作る)と`PROMO_APPLICATION_ID`(https://discord.com/developers/applications で作ったアプリのID。ボタン表示に必須)
- 文言は`config/settings.json`の`promo.names/details/states`の候補から、アカウントごとに固定で1つずつ選ばれる(全アカウントが同じ文言だと量産アカウントだと一目で分かるため)。`promo.accounts`で対象アカウントを絞れる
- 自分のRPCのボタンは自分の画面には表示されない(Discordの仕様)ので、表示確認は別アカウントから行う
- 招待リンクの使用回数を週次レポート(`ai! report`)に出す(要: そのアカウントにサーバー管理権限)。宣伝が効いているかはこの数字で判断する

### サーバー活性化コーチ(`serverCoach`)

週1回(既定: 月曜21時以降)、サーバー全体の状態を数字で診断し、問題の具体化と打ち手をレポートとして投稿する。投稿先は`!coach channel`(または`.env`の`SERVER_COACH_CHANNEL_ID`)で指定する。`!coach now`で今すぐ作れる。

- **計測**: 受信済みのメッセージを数えるだけで、追加の履歴fetchはしない。ユーザーIDはサーバーごとのランダムなsaltでハッシュ化して`data/server-stats-<guildId>.json`に保存する(「同じ人か」は分かるが「誰か」は保存しない)
- **指標**: 1日あたり発言数・発言者数、週の発言者数、先週からの定着率、上位3人の発言シェア、リプライ率、AIの発言シェア、新規参加数・新規の発言率・新規の初発言に30分以内に反応があった率、チャンネル別・時間帯別の発言数
- **問題検出(LLMを使わない)**: 発言数の前週比-20%以下、上位3人で50%以上、定着率50%未満、新規参加0、新規の発言率30%未満、新規の初発言への反応率70%未満、AIの発言シェア30%超、使われていないチャンネルが4割以上、1チャンネルに8割以上集中
- **具体化と打ち手(LLM)**: 検出した問題と数字だけを渡し、原因の仮説・来週すぐできる打ち手(構造整理・客引き・イベント・運営・AIの使い方)・効果の測り方を書かせる。客引きは掲載サイトやSNSなど規約内の方法に限定し、他サーバーやDMへの宣伝は提案させない
- **追跡**: 前回のレポートで出した問題が今回どうなったかを数字で並べる

### 自律エージェント(`agent`)

`config/settings.json`の`agent.enabled`をtrueにすると(実行中は`!agent on`)、各アカウントが一定間隔(既定10分±40%)で「観察 → 判断 → 行動 → 効果測定」を回す。

1. **観察**: 応答チャンネルの直近20件を1回だけfetchし、最後の発言からの経過時間、人間同士で盛り上がっている最中か、放置された質問があるか、を集計する
2. **足切り(LLMを使わない)**: 人間同士で会話中、深夜(`sleepHoursJST`)、直前が自分たちの発言、同じチャンネルで最近行動済み、人間が`maxQuietHours`以上いない、のどれかなら何もしない
3. **候補出し**: 足切りを通った時だけ、LLM(`kind: 'seed'`の枠)に状況と直近の会話を渡して、`reply`(人間の発言を拾う) / `topic`(話題振り) / `question`(軽い質問) / `news` / `search`(Web検索してネタにする、要`TAVILY_API_KEY`) / `seed`(仲間のアカウントと雑談を始める)のうち「今やっても不自然でないもの」と、その中身(返信先・話題・検索語)を出させる。LLMが失敗してもLLM無しで出せる候補で続行する
4. **選択(トンプソン抽出)**: 候補+`wait`(何もしない)の中から、どれを実行するかは**LLMではなく実測データで**決める。行動ごとの報酬の事後分布から値を1回ずつ引いて最大のものを選ぶので、効いている行動ほど選ばれやすく、データの少ない行動も不確かさの分だけ試される。探索率などの手動調整は不要
5. **効果測定**: 行動を送信してから`evalWindowMinutes`(既定10分)の間に増えた人間の発言数(自分たちへの返信は2倍)を数え、行動ごとに`data/agent-stats-<id>.json`へ記録する(`!agent status`で平均・標準誤差・`wait`との差を表示)
6. **自動調整**: 「何かした時」と「waitの時」の報酬差の95%信頼区間が0を下回ったら(=口を出すと逆に人間が黙る)、行動間隔を1.5倍に伸ばす(最大4倍)。有意に上回ったら縮める(設定値より短くはしない)。誤差の範囲なら何もしない

**Logfareへの逃がし**: `.env`に`LOGFARE_API_KEY`を入れると、エージェントとAI同士の掛け合い(バックグラウンド処理)のLLM呼び出しはすべて[Logfare](https://logfare.ai)(無料・レート制限なしを謳うOpenAI互換API、既定モデル`logfare/auto`)に回り、人間への返信用プロバイダ(Groq等)の枠を使わなくなる。Logfareが落ちた時だけ通常のフォールバックで人間用プロバイダに流れ、その分だけが下記の上限に数えられる。Logfareは運営者不明で全リクエストを記録すると報告されているため、人間への返信の既定には使っていない。

**トークン上限**: エージェントとAI同士の掛け合いの消費は「バックグラウンド」として`data/token-usage.json`に日ごとに記録し、`budget.backgroundDailyTokens`(既定8万)に達したらその日はバックグラウンド側だけ止める。Groqの無料枠(1日20万)のうち人間への返信用を必ず残すため。429を返したプロバイダは`retry-after`(無ければ`budget.rateLimitCooldownMs`)の間スキップする。消費量は`!agent status`で見られる。

設定ファイルを人が触らなくても、上の4〜6が回り続けることで「効く行動を増やし、逆効果なら黙る」方向に勝手に寄っていく。ただし1日の行動回数の上限(`maxActionsPerDay`)・深夜停止・足切り条件は安全装置として固定で、自動調整の対象外。

1日の行動回数は`maxActionsPerDay`(既定30回)まで。`aiPosting.enabled`がfalseの間は動かない。

### AI同士の掛け合い・常時チャットモード(`conversationSeed`)

2アカウント以上動かしている時、`conversationSeedHandler.js`が定期的にランダムな2アカウントのペアを選び、共通の応答チャンネルで会話の掛け合いを起こす(`minTurns`〜`maxTurns`ターン、`continueChance`の確率で早めに切り上げ)。この掛け合いでは、相手のアカウントが人間ではなく別のAIチャットボットであることをプロンプトに明示しているので、AI同士が互いを人間だと誤認したような受け答えにはならない。

- 通常時: `checkIntervalMs`ごとに`triggerChance`の確率で発火し、対象チャンネルが`quietThresholdMs`以上発言が無い(過疎ってる)時だけ会話を始める
- `alwaysOn: true`にすると、この確率チェックと過疎チェックを両方無視し、より短い`alwaysOnIntervalMs`間隔で必ずどこかのペアが会話を始める(「AIだけで常時チャットを動かす」モード)。常時人間の発言を待たずにサーバーを賑やかに見せたい場合に使う。人間の発言に対する通常の返信ロジック(`messageHandler.js`)はそのまま生きているので、人間が話しかければ普通に反応する
- 誰も一度も発言していない完全な無人チャンネルも「過疎ってる」判定に含まれる(むしろ最優先で賑やかす対象)。掛け合いの最中にユーザーが発言してきたら検知して打ち切り、そこからは通常の返信ロジックに譲る
- お題決め(`planConversationTopic`)は、NHKニュースの見出し候補を複数取得してその中から雑談にしやすそうなものを優先させるようにしている(政治・事件・訃報のような重い話題は避ける指示を明示)。候補が無い/全部話題にしにくい時だけ人格に合いそうな別の話題に切り替わる
- `botReplyChance`(既定0.15)を設定すると、過疎チェックによる定期発火とは別に、兄弟アカウント(自発投稿・通常の返信・別の掛け合いの一言、いずれも)の発言を見て別のアカウントが確率的にDiscordのリプライとして割り込み、そのまま短い掛け合いに発展する。1つの掛け合いが終わった直後に連鎖して発火し続けないよう`botReplyCooldownMs`(既定10分)のクールダウンを挟む。`0`にすると無効化される

### リアクション(`reactions`)

`messageHandler.js`が、人間・兄弟アカウント両方の発言(本物のBotは除く)に対して`reactions.chance`(既定8%、±`chanceJitter`で揺らぎ)の確率で絵文字リアクションを付ける。返信するかどうかの判定(クールダウン・確率等)とは完全に独立しており、返信しない発言にもリアクションだけ付くことがある。絵文字はLLMを呼ばずキーワードの単純なパターンマッチ(`src/utils/reactionEmoji.js`)で選ぶため、追加のAPIコストは発生しない。`reactions.enabled: false`で無効化できる。

### GIF投稿(`gif`)

自発投稿・AI同士の掛け合いは、LLM生成のテキストが続くとどうしてもぎこちなくなりがちなので、アカウントに`.env`の`GIF_GENRE[_N]`(カンマ区切りで検索キーワードを複数指定可)を設定すると、一部の投稿をKlipyのGIF検索APIで見つけたGIFをキャプション無しでそのまま貼るだけの投稿に置き換える(LLM呼び出しをしないのでAPIコストもかからない)。要`KLIPY_API_KEY`(無料、[klipy.com/developers](https://klipy.com/developers)で取得)。

> **注:** 以前はTenor(Google)のAPIを使っていたが、Tenor APIは2026年6月30日付で完全に終了した(1月13日以降は新規APIキー発行も停止)ため、Tenorの元社員が立ち上げた後継サービスKlipyに移行した。

- `config/settings.json`の`gif.chance`(既定35%、±`chanceJitter`)が自発投稿・掛け合いの話し始めに、`gif.turnChance`(既定20%)が掛け合いの2ターン目以降・割り込みリプライに適用される
- 投稿のたびに設定した複数キーワードからランダムに1つ選んで検索し、直近選んだGIFは同じキーワードでは避けるようにしている
- `GIF_GENRE[_N]`を設定していないアカウントはこの機能を一切使わない(オプトイン)

上記は自発投稿・掛け合いの「発生タイミングに混ざる」形なので、`selfTalk.enabled`がfalseのまま(既定)だったりアカウントが1つしか無かったりすると、GIF投稿自体もほぼ発生しない。他の機能の有効/無効に関係なく単独で一定間隔ごとに必ず投稿したい場合は、`src/handlers/gifPostHandler.js`が`GIF_GENRE[_N]`を設定した各アカウントごとに`gif.postIntervalMs`(既定1時間)±`postIntervalJitter`の間隔で、応答チャンネルの中からランダムに1つ選んでGIFを投稿する(LLM不使用)。

検索キーワードは`.env`の`GIF_GENRE[_N]`は初回起動時の初期値としてのみ使われ、以降は`!gifgenre`コマンド(`src/commands/core/gifgenre.js`)で管理する。追加/削除内容は`data/gif-genres-<アカウントID>.json`に永続化され、再起動不要ですぐ反映される。

> `mealpost`プロセスのアカウントでもこの定期投稿だけを単独で使える。`mealpost`には会話用の応答チャンネル(`channelStore`)という概念が無いため、代わりに`.env`の`MEALPOST_GIF_GENRE[_N]`(ai_cord本体の`GIF_GENRE[_N]`とは別のキーなので衝突しない)と固定の投稿先`MEALPOST_GIF_POST_CHANNEL_ID[_N]`を設定する。`meshi!gifgenre add/remove/list`でキーワードを管理できる(自発投稿・掛け合いへのGIF混在はai_cord本体専用の機能なので、`mealpost`側は単独の定期投稿のみ)。

| コマンド | 内容 |
|---|---|
| `!gifgenre add <キーワード>` | 検索キーワードを追加(スペース区切りでそのまま検索語になる) |
| `!gifgenre remove <キーワード>` | 削除 |
| `!gifgenre list` | 登録中のキーワード一覧を表示 |

### ニュースをネタにした自発投稿(`news`)

`.env`の`NEWS_POST[_N]=true`にしたアカウントは、`src/handlers/newsPostHandler.js`がGIF投稿と同じパターンで`news.postIntervalMs`(既定90分)±`postIntervalJitter`ごとに単独で動き、NHKニュースの見出しを1つ取得して`generateSelfTalk`に話のきっかけ(topicHint)として渡し、ペルソナの口調で短く一言コメントする投稿を生成して送る。記事本文の取得・要約・引用は行わず、見出しの内容をきっかけにした一言をLLMに生成させるだけ(既存のconversationSeedのお題決めと同じ仕組みの再利用)。

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
- 複数アカウント運用時、過疎ってるチャンネルでAI同士に掛け合いをさせる(相手がAIであることはお互い認識した上で会話する)。`alwaysOn`設定で確率・過疎チェックを無視した常時チャットモードにもできる。`botReplyChance`を設定すると、過疎チェック起点だけでなく兄弟アカウントの発言そのものに別のアカウントが確率的にリプライで割り込むこともある
- 人間・兄弟アカウント両方の発言に確率的に絵文字リアクションを付ける(`reactions`、LLM不使用)
- アカウントに検索キーワードを設定すると、自発投稿・掛け合いの一部をLLM生成テキストの代わりにKlipy検索したGIFに置き換える(`gif`、LLM不使用)
- Spotify再生中/動画視聴中を模したPresence(RPC)のローテーション更新
- `!lockdown all` / `!channel add|remove|list all` による全アカウント一括操作
- テスト用チャンネル(`TEST_CHANNEL_ID`)、応答相手を制限する許可リスト(`ALLOWED_REPLY_USER_IDS`)
- 仮想通貨の価格アラート(`!pricealert`)。指定チャンネルで監視銘柄を一定間隔でチェックし、前回アラート時から±5%(既定)以上動いたら通知する
- 他BOTへのスラッシュコマンド自動送信(`!slashbump`)。サーバー宣伝BOT等への`/up`を対象BOTの応答(成功/クールダウン)に応じて自動でスケジュールし続ける
- 特定サーバーの特定チャンネルの投稿を、間隔を空けつつ複数チャンネルへそのまま転送するミラー機能(`relay`、`mealpost`プロセス専用。テキストはコピペ・メディアはDiscord CDN URLをそのまま使用)
- RSSフィードを定期ポーリングし、ツイートリンクをvxtwitter.com形式に変換して自動投稿する機能(`rssTwitterPost`、`mealpost`プロセス専用)
- Klipy検索キーワードのGIFを固定チャンネルへ一定間隔で投稿する機能(`gif`、`mealpost`プロセスのアカウントでも`MEALPOST_GIF_GENRE[_N]`設定でオプトイン可能)
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
