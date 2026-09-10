const config = require('./utils/config');
const { createChannelStore } = require('./utils/channelStore');
const { createReminderStore } = require('./utils/reminderStore');
const { createMemoryStore } = require('./utils/memoryStore');

// アカウント1つ分の実行時状態(ペルソナ・コーパス・応答チャンネル・
// クールダウン・ロックダウン・マルコフ連鎖・リマインダー)をひとまとめにする。
// これをclientに紐付けることで、複数アカウントを同一プロセスで
// 動かしてもお互いの状態が混ざらないようにする。
function buildAccountState(account) {
  const memoryStore = createMemoryStore(account.id);

  return {
    id: account.id,
    discordToken: account.discordToken,
    allowedGuildId: account.allowedGuildId,
    // テスト用チャンネル(任意)。設定すると応答チャンネル登録・クールダウン・
    // 確率・crowdGuardを無視して常に即応答する(動作確認用)
    testChannelId: account.testChannelId,
    // 応答してよい相手を制限したい場合(任意)。空なら誰にでも今まで通り反応する
    allowedReplyUserIds: account.allowedReplyUserIds || [],
    personaName: account.personaName,
    persona: config.readPersona(account.personaName),
    corpusPath: config.corpusPathFor(account.corpusFile),
    presence: config.presenceFor(account.presenceFile),
    cooldownSeconds: account.cooldownSeconds,
    replyChanceMultiplier: account.replyChanceMultiplier,
    commandPrefix: account.commandPrefix,
    commandRoleIds: account.commandRoleIds,
    // !set mode で実行中に切り替えられる。markov: 今まで通りマルコフ下書き+Groq補正。
    // finetune: ファインチューニング済みモデルに直接投げる(下書き・ペルソナ文書は使わない)。
    // 起動時点の初期値は .env の AI_MODE[_N] で指定できる(未設定ならmarkov)
    aiMode: account.aiMode,
    finetuneBaseUrl: account.finetuneBaseUrl,
    finetuneApiKey: account.finetuneApiKey,
    finetuneModel: account.finetuneModel,
    // 同じプロバイダ内でアカウントごとに違うモデルを使い分けたい時の上書き先
    // (.envのCHAT_MODEL[_N])。未指定ならプロバイダの既定モデルを使う
    chatModel: account.chatModel,
    channelStore: createChannelStore(account.id, account.allowedChannelId),
    reminderStore: createReminderStore(account.id),
    // ユーザーごとの長期記憶(特徴メモ)。会話が続くと相手について「覚えている」ように見せる
    memoryStore,
    lastReplyTime: 0,
    lockedDown: false,
    markovChain: null,
    // 直近の自分の発言を数件保持し、同じ感嘆詞・絵文字の組み合わせを連発しないよう
    // プロンプトに「これは避けて」として渡す(bot臭さ対策)。memoryStoreの永続化ファイルから
    // 読み込むことで、pm2再起動を挟んでも直近の言い回しを覚えたままにする
    recentReplies: [...memoryStore.getRecentReplies()]
  };
}

module.exports = { buildAccountState };
