const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const logger = require('../utils/logger');

const CORE_DIR = path.join(__dirname, 'core');
const commands = new Map();

function loadCommands() {
  commands.clear();
  const files = fs.readdirSync(CORE_DIR).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    delete require.cache[require.resolve(path.join(CORE_DIR, file))];
    const cmd = require(path.join(CORE_DIR, file));
    if (!cmd?.name || typeof cmd.execute !== 'function') continue;
    commands.set(cmd.name, cmd);
    if (Array.isArray(cmd.aliases)) {
      for (const alias of cmd.aliases) commands.set(alias, cmd);
    }
  }
  logger.log('COMMANDS', `${files.length}個のコマンドファイルを読み込み (${commands.size}エントリ)`);
}

// 本人(アカウント所有者)、または.envのALLOWED_COMMAND_ROLE_ID[_N]で
// 指定したロールを持つメンバーだけコマンドを実行できる
function canRunCommands(msg, client, state) {
  if (msg.author.id === client.user.id) return true;
  if (state.commandRoleId && msg.member?.roles?.cache?.has(state.commandRoleId)) return true;
  return false;
}

// コマンド定義自体はアカウント間で共有(内容はアカウント非依存)なので、
// 複数アカウント分呼ばれても読み込みは最初の1回だけでよい。
function registerCommandHandler(client) {
  if (commands.size === 0) loadCommands();

  client.on('messageCreate', async (msg) => {
    if (!canRunCommands(msg, client, client.accountState)) return;

    const prefix = client.accountState.commandPrefix || config.commandPrefix || '!';
    if (!msg.content.startsWith(prefix)) return;

    const args = msg.content.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();
    if (!commandName) return;

    const state = client.accountState;
    // ロックダウン中は解除コマンド(lockdown/pause)以外を受け付けない
    if (state.lockedDown && commandName !== 'lockdown' && commandName !== 'pause') return;

    const cmd = commands.get(commandName);
    if (!cmd) return;

    try {
      await cmd.execute(msg, args, client);
    } catch (err) {
      logger.error('COMMAND', err);
    }
  });
}

module.exports = { registerCommandHandler };
