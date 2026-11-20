const { isOwnAccount } = require('./ownAccounts');

// 「どのアカウントが、どの発言に返信したか」の台帳。返信を作る経路(通常の返信・自律エージェント・
// 乗っかり)はそれぞれ別に返信先を決めていて、既に返信済みかはメッセージキャッシュの一部
// (エージェントは直近20件)でしか見ていなかった。会話が流れて自分の返信が見える範囲から外れると、
// 同じ発言に30分後にもう一度返信していた(issue #56)。実際に送られた自分たちのリプライを
// messageCreateで記録し、どの経路も送る前にここを見る
const TTL_MS = 24 * 3600000;
const MAX_ENTRIES = 5000;
// `${返信したアカウントのユーザーID}:${返信先の発言ID}` → 記録時刻
const replied = new Map();

function record(msg) {
  const refId = msg.reference?.messageId;
  if (!refId || !isOwnAccount(msg.author.id)) return;
  replied.set(`${msg.author.id}:${refId}`, Date.now());
  if (replied.size > MAX_ENTRIES) replied.delete(replied.keys().next().value);
}

function fresh(key) {
  const at = replied.get(key);
  if (!at) return false;
  if (Date.now() - at > TTL_MS) {
    replied.delete(key);
    return false;
  }
  return true;
}

// そのアカウントが既にその発言に返信したか
function hasReplied(userId, messageId) {
  return fresh(`${userId}:${messageId}`);
}

// 運用中のどれかのアカウントが既にその発言に返信したか
function anyReplied(messageId) {
  for (const key of replied.keys()) if (key.endsWith(`:${messageId}`) && fresh(key)) return true;
  return false;
}

function register(clients) {
  for (const client of clients) client.on('messageCreate', (msg) => msg.author.id === client.user?.id && record(msg));
}

module.exports = { register, record, hasReplied, anyReplied };
