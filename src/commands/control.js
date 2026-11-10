const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const logger = require('../utils/logger');
const aiProvider = require('../utils/aiProvider');
const usageLedger = require('../utils/usageLedger');
const { canRunCommands } = require('./handler');
const { getAllClients } = require('../utils/accountRegistry');

// 全アカウントをまとめて操作する統合コマンド(既定prefix: ai!)。
//
// 以前はアカウントごとに別のprefix(toku! / sui! / mi! …)があり、17種類のコマンドを
// 「どのアカウント宛てか」込みで打ち分ける必要があった。普段の操作(止める・動かす・
// 担当チャンネル・状態確認・会話を起こす)はほぼ「全アカウントまとめて」なので、
// 1つのprefixで全アカウントに効き、必要な時だけ対象を名前/番号で絞る形にする。
// 同じメッセージは全clientが受信するので、最初に拾った1アカウントだけが処理する。
// 従来のアカウント別prefixのコマンドもそのまま使える(helpには出さない)
const PREFIX = config.controlPrefix || 'ai!';
const handled = new Set();

// 'all'/省略 → 全員。番号(1,2…)・ユーザー名の前方一致・メンションで個別指定
function resolveTargets(arg) {
  const all = getAllClients().filter((c) => c.user);
  if (!arg || arg === 'all' || arg === '全員') return all;
  const id = arg.match(/^<@!?(\d+)>$/)?.[1];
  const lower = arg.toLowerCase();
  return all.filter(
    (c) => c.user.id === id || c.accountState.id === arg || c.user.username.toLowerCase().startsWith(lower)
  );
}

const names = (clients) => clients.map((c) => c.user.username).join(', ');

function loadCore(name) {
  return require(path.join(__dirname, 'core', `${name}.js`));
}

const SUBCOMMANDS = {
  async status(msg) {
    const usage = usageLedger.summary();
    const lines = getAllClients()
      .filter((c) => c.user)
      .map((c) => {
        const st = c.accountState;
        const here = st.channelStore.isAllowedChannel(msg.channel.id) ? '◎このch担当' : '';
        return `${st.lockedDown ? '⏸️' : '▶️'} **${c.user.username}**(${st.id}) 担当ch ${st.channelStore.listChannels().length}個 ${here}${st.agentEnabled ? ' / エージェントON' : ''}${st.autoPaused ? ' / ⚠️レート制限で自動停止中' : ''}`;
      });
    return msg.channel.send(
      `${lines.join('\n')}\n` +
        `AI投稿: ${config.aiPosting?.enabled === false ? '停止中(settings.json)' : '有効'} / 会話プロバイダ: ${aiProvider.getProvider()}(使用可: ${aiProvider.availableProviders().join(', ')})\n` +
        `今日のトークン: 人間への返信 ${usage.human} / バックグラウンド ${usage.background}`
    );
  },

  async on(msg, args) {
    const targets = resolveTargets(args[0]);
    for (const c of targets) {
      c.accountState.lockedDown = false;
      c.accountState.autoPaused = false;
    }
    return msg.channel.send(`▶️ 再開: ${names(targets) || '(該当なし)'}`);
  },

  async off(msg, args) {
    const targets = resolveTargets(args[0]);
    for (const c of targets) {
      c.accountState.lockedDown = true;
      c.accountState.autoPaused = false;
    }
    return msg.channel.send(`⏸️ 停止: ${names(targets) || '(該当なし)'}`);
  },

  async here(msg, args) {
    const targets = resolveTargets(args[0]);
    for (const c of targets) c.accountState.channelStore.addChannel(msg.channel.id);
    return msg.channel.send(`📍 このチャンネルを担当に追加: ${names(targets) || '(該当なし)'}`);
  },

  async leave(msg, args) {
    const targets = resolveTargets(args[0]);
    for (const c of targets) c.accountState.channelStore.removeChannel(msg.channel.id);
    return msg.channel.send(`👋 このチャンネルの担当から外す: ${names(targets) || '(該当なし)'}`);
  },

  // 今いるチャンネルで、担当アカウント同士のグループ会話を今すぐ始める
  async talk(msg) {
    const { seedConversation } = require('../handlers/conversationSeedHandler');
    const pool = getAllClients()
      .filter((c) => c.user && !c.accountState.lockedDown && c.accountState.channelStore.isAllowedChannel(msg.channel.id))
      .sort(() => Math.random() - 0.5);
    if (pool.length < 2) return msg.channel.send('このチャンネルを担当しているアカウントが2つ以上必要です(ai! here で追加)');
    usageLedger.runBackground(() => seedConversation(pool[0], pool[1], msg.channel.id)).catch((err) => logger.error('CONTROL', err));
  },

  async agent(msg, args, client) {
    const sub = args[0]?.toLowerCase();
    if (sub === 'on' || sub === 'off') {
      const targets = resolveTargets(args[1]);
      for (const c of targets) c.accountState.agentEnabled = sub === 'on';
      return msg.channel.send(`🤖 エージェント${sub === 'on' ? 'ON' : 'OFF'}: ${names(targets) || '(該当なし)'}`);
    }
    return loadCore('agent').execute(msg, args, client);
  },

  provider: (msg, args, client) => loadCore('provider').execute(msg, args, client),
  report: (msg, args, client) => loadCore('coach').execute(msg, args, client),

  async help(msg) {
    const legacy = fs
      .readdirSync(path.join(__dirname, 'core'))
      .map((f) => f.replace(/\.js$/, ''))
      .filter((n) => !['help', 'agent', 'coach', 'provider', 'lockdown', 'channel'].includes(n));
    return msg.channel.send(
      [
        `**${PREFIX}** — 全アカウントまとめて操作(対象は 名前/番号/@メンション で絞れる。省略で全員)`,
        `\`${PREFIX} status\` 全アカウントの状態`,
        `\`${PREFIX} on|off [対象]\` 動かす / 止める`,
        `\`${PREFIX} here|leave [対象]\` このチャンネルを担当にする / 外す`,
        `\`${PREFIX} talk\` ここでアカウント同士の雑談を今すぐ始める`,
        `\`${PREFIX} agent [on|off|now|status]\` 自律エージェント`,
        `\`${PREFIX} report [channel|now|off]\` サーバー活性化レポート`,
        `\`${PREFIX} provider [名前]\` AIの切り替え`,
        `その他(アカウント別prefixで従来通り): ${legacy.join(' / ')}`
      ].join('\n')
    );
  }
};
SUBCOMMANDS.start = SUBCOMMANDS.on;
SUBCOMMANDS.stop = SUBCOMMANDS.off;
SUBCOMMANDS.pause = SUBCOMMANDS.off;

function registerControlCommand(clients) {
  for (const client of clients) {
    client.on('messageCreate', async (msg) => {
      if (!msg.content.startsWith(PREFIX) || handled.has(msg.id)) return;
      handled.add(msg.id);
      if (handled.size > 500) handled.delete(handled.values().next().value);

      const permission = await canRunCommands(msg, client, client.accountState);
      if (!permission.allowed) return;

      const args = msg.content.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
      const sub = (args.shift() || 'status').toLowerCase();
      const fn = SUBCOMMANDS[sub];
      if (!fn) return msg.channel.send(`不明なサブコマンド: ${sub}(\`${PREFIX} help\`)`).catch(() => {});
      try {
        await fn(msg, args, client);
        logger.log('CONTROL', `${msg.author.username}: ${PREFIX} ${sub} ${args.join(' ')}`);
      } catch (err) {
        logger.error('CONTROL', err);
      }
    });
  }
}

module.exports = { registerControlCommand, resolveTargets, PREFIX };
