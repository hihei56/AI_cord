const config = require('./utils/config');
const { createChannelStore } = require('./utils/channelStore');
const { createGuildStore } = require('./utils/guildStore');
const { createReminderStore } = require('./utils/reminderStore');
const { createMemoryStore } = require('./utils/memoryStore');
const gifGenreStore = require('./utils/gifGenreStore');

// 保存されている直近の自分の発言から、今の返信言語と違う文字の発言を外す。返信言語の既定が
// タミル語だった時期(〜2026-11-14)の発言が、めったに喋らないアカウントの記録に残ったままになり、
// 「直近の発言」として毎回プロンプトに入って日本語の返信を引っ張り、人格判定でも誤報告されていた
// (issue #54)。言語を固定しているアカウントは対象外
function usableRecentReplies(replies, replyLanguage) {
  if (replyLanguage) return [...replies];
  const { isGarbledOutput } = require('./utils/aiClient');
  return replies.filter((r) => !isGarbledOutput(r));
}

// アカウント1つ分の実行時状態(ペルソナ・コーパス・応答チャンネル・
// クールダウン・ロックダウン・マルコフ連鎖・リマインダー)をひとまとめにする。
// これをclientに紐付けることで、複数アカウントを同一プロセスで
// 動かしてもお互いの状態が混ざらないようにする。
function buildAccountState(account) {
  const memoryStore = createMemoryStore(account.id);

  return {
    id: account.id,
    discordToken: account.discordToken,
    // 動作してよいサーバー一覧(複数掛け持ち可)。!guild add/remove で実行中に変更できる
    guildStore: createGuildStore(account.id, account.allowedGuildIds),
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
    // マルコフ連鎖の下書きをLLMの言い換えより優先させるか(.envのMARKOV_PRIORITY[_N])。
    // trueだとaiClient.jsのプロンプトが「下書きの言い回しを活かし、人格は軽く添える程度」に
    // 切り替わり、下書きをそのまま採用する確率・最低文字数も緩和される
    markovPriority: account.markovPriority,
    markovDirectReplyChance: account.markovDirectReplyChance,
    markovDirectReplyMinLength: account.markovDirectReplyMinLength,
    // 自発投稿・AI同士の掛け合いの一部をKlipy GIF検索でそのまま貼るだけの投稿にする
    // 機能用の検索キーワード一覧。初回起動時は.envのGIF_GENRE[_N](カンマ区切り)を
    // 初期値としてdata/gif-genres-<id>.jsonに永続化し、以降は!gifgenreコマンドで
    // 追加/削除した内容を使う(.envを書き換えず再起動不要でキーワードを管理できる)。
    // 空配列ならこのアカウントはGIF投稿をしない
    gifGenres: gifGenreStore.loadOrInit(account.id, account.gifGenres || []),
    // ニュース見出しをネタにした定期の自発投稿(.envのNEWS_POST[_N])をするか
    newsPostEnabled: account.newsPostEnabled || false,
    // 返信・自発投稿をこの言語に固定する(.envのREPLY_LANGUAGE[_N]、nullなら日本語のまま)
    replyLanguage: account.replyLanguage || null,
    // 会話での役割(settings.jsonのroles参照)。設定に無い名前なら役割なし扱い
    charRole: config.roles?.[account.charRole] ? account.charRole : null,
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
    recentReplies: usableRecentReplies(memoryStore.getRecentReplies(), account.replyLanguage)
  };
}

module.exports = {
  usableRecentReplies, buildAccountState };
