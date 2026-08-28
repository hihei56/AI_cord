const fs = require('fs');
const path = require('path');

/**
 * 複数アカウントの設定を環境変数から読み込む
 * MULTI_ACCOUNT_MODE=true の場合、ACCOUNT_1_*, ACCOUNT_2_* ... を解析
 * MULTI_ACCOUNT_MODE=false の場合、従来の DISCORD_TOKEN など単一設定を使用
 */
function loadAccountConfigs() {
  const multiAccountMode = process.env.MULTI_ACCOUNT_MODE === 'true';

  if (!multiAccountMode) {
    // 従来の単一アカウントモード
    return [
      {
        id: 'default',
        token: process.env.DISCORD_TOKEN,
        guildId: process.env.ALLOWED_GUILD_ID,
        channelId: process.env.ALLOWED_CHANNEL_ID,
        persona: process.env.PERSONA || 'default',
        aiBaseUrl: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
        aiApiKey: process.env.AI_API_KEY || process.env.GROQ_API_KEY,
        cooldownSeconds: null // 共通設定を使う
      }
    ];
  }

  // 複数アカウントモード
  const accounts = [];
  let accountNum = 1;

  while (process.env[`ACCOUNT_${accountNum}_TOKEN`]) {
    const token = process.env[`ACCOUNT_${accountNum}_TOKEN`];
    const guildId = process.env[`ACCOUNT_${accountNum}_GUILD_ID`];
    const channelId = process.env[`ACCOUNT_${accountNum}_CHANNEL_ID`];

    if (!token || !guildId || !channelId) {
      throw new Error(
        `ACCOUNT_${accountNum} は TOKEN, GUILD_ID, CHANNEL_ID が必須です`
      );
    }

    accounts.push({
      id: `account${accountNum}`,
      accountNum,
      token,
      guildId,
      channelId,
      persona: process.env[`ACCOUNT_${accountNum}_PERSONA`] || 'default',
      aiBaseUrl:
        process.env[`ACCOUNT_${accountNum}_AI_BASE_URL`] ||
        process.env.AI_BASE_URL ||
        'https://api.groq.com/openai/v1',
      aiApiKey:
        process.env[`ACCOUNT_${accountNum}_AI_API_KEY`] ||
        process.env.AI_API_KEY ||
        process.env.GROQ_API_KEY,
      cooldownSeconds: process.env[`ACCOUNT_${accountNum}_COOLDOWN_SECONDS`]
        ? parseInt(process.env[`ACCOUNT_${accountNum}_COOLDOWN_SECONDS`], 10)
        : null
    });

    accountNum++;
  }

  if (accounts.length === 0) {
    throw new Error(
      'MULTI_ACCOUNT_MODE=true ですが、ACCOUNT_1_TOKEN が設定されていません'
    );
  }

  return accounts;
}

/**
 * アカウント��別の設定を生成（共通設定とマージ）
 */
function createAccountConfig(accountSettings, globalSettings) {
  return {
    ...globalSettings,
    // アカウント固有の設定で上書き
    env: {
      ...globalSettings.env,
      discordToken: accountSettings.token,
      aiBaseUrl: accountSettings.aiBaseUrl,
      aiApiKey: accountSettings.aiApiKey,
      allowedGuildId: accountSettings.guildId,
      allowedChannelId: accountSettings.channelId,
      personaName: accountSettings.persona,
      accountId: accountSettings.id
    },
    // アカウント個別のクールダウンを適用
    cooldownSeconds: accountSettings.cooldownSeconds ?? globalSettings.cooldownSeconds
  };
}

module.exports = {
  loadAccountConfigs,
  createAccountConfig
};
