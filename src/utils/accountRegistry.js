// このプロセスで動かしている全アカウントのclientを共有で保持する。
// !lockdown all / !channel add all のような「全アカウント一括操作」コマンドが、
// 自分以外のアカウントのaccountStateにもアクセスできるようにするため。
const clients = [];

function registerClient(client) {
  clients.push(client);
}

function getAllClients() {
  return clients;
}

module.exports = { registerClient, getAllClients };
