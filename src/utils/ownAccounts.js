// このプロセスで動かしている全アカウントのuser IDを共有で持つ。
// 他アカウントの発言を「本物のユーザーの発言」として誤って自動返信の
// トリガーにしないようにするため。
const ids = new Set();

function registerOwnAccount(userId) {
  ids.add(userId);
}

function isOwnAccount(userId) {
  return ids.has(userId);
}

module.exports = { registerOwnAccount, isOwnAccount };
