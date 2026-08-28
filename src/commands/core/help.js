const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'help',
  aliases: ['ヘルプ'],
  description: '利用可能なコマンド一覧を表示',
  async execute(msg) {
    const coreDir = __dirname;
    const files = fs.readdirSync(coreDir).filter((f) => f.endsWith('.js'));
    const lines = files.map((f) => {
      const cmd = require(path.join(coreDir, f));
      return `**!${cmd.name}** - ${cmd.description || ''}`;
    });
    await msg.channel.send(lines.join('\n'));
  }
};
