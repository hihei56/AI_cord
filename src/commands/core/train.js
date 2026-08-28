const fs = require('fs');
const logger = require('../../utils/logger');
const { loadCorpus } = require('../../utils/markovChain');
const { initMarkov } = require('../../utils/aiClient');

const MAX_FETCH = 1000;

module.exports = {
  name: 'train',
  aliases: ['学習'],
  description: 'チャンネルの発言をコーパスに追加して再学習。!train [件数] [@ユーザー] (省略時は自分自身、直近200件)',
  async execute(msg, args, client) {
    const state = client.accountState;
    const countArg = parseInt(args[0], 10);
    const limit = Number.isFinite(countArg) ? Math.min(countArg, MAX_FETCH) : 200;
    const targetUser = msg.mentions.users.first() || msg.author;

    await msg.channel.send(`📥 直近${limit}件から ${targetUser.username} の発言を収集中...`);

    const collected = [];
    let before;
    while (collected.length < limit) {
      const batch = await msg.channel.messages.fetch({ limit: 100, before });
      if (batch.size === 0) break;
      for (const m of batch.values()) {
        if (m.author.id === targetUser.id && m.content.trim()) collected.push(m.content.trim());
      }
      before = batch.last().id;
      if (batch.size < 100) break;
    }

    if (collected.length === 0) {
      await msg.channel.send('該当する発言が見つかりませんでした');
      return;
    }

    const existing = loadCorpus(state.corpusPath);
    const merged = [...new Set([...existing, ...collected])];
    fs.writeFileSync(state.corpusPath, `${merged.join('\n')}\n`);

    await initMarkov(state);
    logger.log('TRAIN', `[${state.id}] ${targetUser.username}: ${collected.length}件追加 (計${merged.length}行)`);
    await msg.channel.send(`✅ ${collected.length}件追加(重複除去後 計${merged.length}行) → 再学習完了`);
  }
};
