const logger = require('../../utils/logger');
const { formatSummary } = require('../../utils/engagementStats');
const { runOnce, AGENT } = require('../../handlers/agentHandler');
const usageLedger = require('../../utils/usageLedger');

module.exports = {
  name: 'agent',
  description:
    '自律エージェント(状況を見て話題振り・返信・AI同士の雑談などを自分で選ぶ)の操作。!agent [status|on|off|now]。statusは行動ごとの効果(行動後に人間の発言が何件増えたか)を表示、nowは今いるチャンネルで1回判断させる(動作確認用)',
  async execute(msg, args, client) {
    const state = client.accountState;
    const sub = (args[0] || 'status').toLowerCase();

    if (!state.agentStats) {
      return msg.channel.send('⚠️ エージェントが初期化されていません');
    }

    if (sub === 'on' || sub === 'off') {
      state.agentEnabled = sub === 'on';
      logger.log('AGENT', `[${state.id}] ${state.agentEnabled ? '有効化' : '無効化'}`);
      return msg.channel.send(`${state.agentEnabled ? '▶️' : '⏸️'} エージェントを${state.agentEnabled ? '有効' : '無効'}にしました(再起動で設定ファイルの値に戻る)`);
    }

    if (sub === 'now') {
      const outcome = await runOnce(client, msg.channel, { force: true });
      if (outcome.skipped) return msg.channel.send(`判断なし: ${outcome.skipped}`);
      return; // 行動自体がチャンネルへの返答になる
    }

    return msg.channel.send(
      `🤖 エージェント: **${state.agentEnabled ? '有効' : '無効'}** / 今日の行動 ${state.agentStats.actionsToday()}/${AGENT.maxActionsPerDay}回\n` +
        `今日のトークン消費: 人間への返信 ${usageLedger.summary().human} / バックグラウンド ${usageLedger.summary().background}(上限 ${usageLedger.summary().backgroundBudget})\n` +
        `行動ごとの効果(行動後${AGENT.evalWindowMinutes}分間に増えた人間の発言数):\n\`\`\`\n${formatSummary(state.agentStats.summary())}\n\`\`\``
    );
  }
};
