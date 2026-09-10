const aiProvider = require('../../utils/aiProvider');
const logger = require('../../utils/logger');

module.exports = {
  name: 'provider',
  aliases: ['ai'],
  description:
    '会話生成に使うAIプロバイダ(groq/gemini/cerebras/nvidia/cloudflare)を実行中に切り替える。!provider [groq|gemini|cerebras|nvidia|cloudflare] (引数省略で現在の状態を表示)。.envの書き換え・再起動不要、全アカウント共通',
  async execute(msg, args) {
    const target = args[0]?.toLowerCase();

    if (!target) {
      const available = aiProvider.availableProviders();
      return msg.channel.send(
        `現在のAIプロバイダ: **${aiProvider.getProvider()}**\n` +
          `切り替え可能(APIキー設定済み): ${available.length ? available.join(', ') : '(GROQ_API_KEY/GEMINI_API_KEY/CEREBRAS_API_KEY/NVIDIA_API_KEY/CLOUDFLARE_API_KEYが.envに未設定)'}\n` +
          `使い方: !provider groq|gemini|cerebras|nvidia|cloudflare`
      );
    }

    const result = aiProvider.setProvider(target);
    if (!result.ok) {
      return msg.channel.send(`⚠️ 切り替え失敗: ${result.reason}`);
    }

    logger.log('PROVIDER', `AIプロバイダを ${aiProvider.getProvider()} に切り替え`);
    await msg.channel.send(`✅ AIプロバイダを **${aiProvider.getProvider()}** に切り替えました(全アカウント共通、再起動不要)`);
  }
};
