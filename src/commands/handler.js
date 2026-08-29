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

// 本人(アカウント所有者)、または.envのALLOWED_COMMAND_ROLE_ID[_N](カンマ区切りで複数可)で
// 指定したロールのどれかを持つメンバーだけコマンドを実行できる。
// msg.memberはギルドのメンバーキャッシュ頼みで、selfbotはメンバーキャッシュが薄いことが
// 多く(全メンバーキャッシュは重すぎるため)、キャッシュに無いと本当はロールを持っていても
// nullになってしまう。そのためキャッシュに無ければ明示的にfetchして確実に判定する
async function canRunCommands(msg, client, state) {
  if (msg.author.id === client.user.id) return { allowed: true };
  if (!state.commandRoleIds?.length) return { allowed: false, reason: 'commandRoleIds未設定' };
  if (!msg.guild) return { allowed: false, reason: 'DM(サーバー外)' };

  try {
    const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id));
    const allowed = state.commandRoleIds.some((id) => member.roles.cache.has(id));
    return {
      allowed,
      reason: allowed
        ? undefined
        : `guild=${msg.guild.id} 期待するroleId一覧=[${state.commandRoleIds.join(',')}] 実際のroleId一覧=[${[...member.roles.cache.keys()].join(',')}]`
    };
  } catch (err) {
    return { allowed: false, reason: `member取得失敗: ${err.message}` };
  }
}

// コマンド定義自体はアカウント間で共有(内容はアカウント非依存)なので、
// 複数アカウント分呼ばれても読み込みは最初の1回だけでよい。
function registerCommandHandler(client) {
  if (commands.size === 0) loadCommands();

  client.on('messageCreate', async (msg) => {
    const prefix = client.accountState.commandPrefix || config.commandPrefix || '!';
    if (!msg.content.startsWith(prefix)) return;

    // プレフィックス一致した(=コマンドの可能性がある)メッセージだけ権限チェックする。
    // 全メッセージに対してやるとメンバーfetchが無駄に飛んでしまう
    const permission = await canRunCommands(msg, client, client.accountState);
    if (!permission.allowed) {
      logger.log(
        'COMMAND',
        `[${client.accountState.id}] ${msg.author.username}のコマンドを権限なしで拒否 (${permission.reason}): ${msg.content.slice(0, 50)}`
      );
      return;
    }

    const args = msg.content.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();
    if (!commandName) return;

    const state = client.accountState;
    // ロックダウン中は解除コマンド(lockdown/pause)以外を受け付けない
    if (state.lockedDown && commandName !== 'lockdown' && commandName !== 'pause') return;

    const cmd = commands.get(commandName);
    if (!cmd) {
      logger.log('COMMAND', `[${client.accountState.id}] 未知のコマンド: ${commandName}`);
      return;
    }

    try {
      await cmd.execute(msg, args, client);
      logger.log('COMMAND', `[${client.accountState.id}] ${msg.author.username}が実行: ${commandName}`);
    } catch (err) {
      logger.error('COMMAND', err);
    }
  });
}

module.exports = { registerCommandHandler };
