const fs = require('fs');
const path = require('path');
const { loadAccountConfigs, createAccountConfig } = require('./multiAccountManager');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');

function readText(relativePath) {
  return fs.readFileSync(path.join(CONFIG_DIR, relativePath), 'utf-8').trim();
}

// グローバル設定を読み込む（全アカウントで共通）
const settings = JSON.parse(readText('settings.json'));

/**
 * 単一の設定オブジェクトを生成
 * @param {Object} accountSettings - multiAccountManager.js から取得したアカウント設定
 * @returns {Object} マージされた設定
 */
function buildConfig(accountSettings) {
  const env = {
    discordToken: accountSettings.token,
    aiBaseUrl: accountSettings.aiBaseUrl,
    aiApiKey: accountSettings.aiApiKey,
    allowedGuildId: accountSettings.guildId,
    allowedChannelId: accountSettings.channelId,
    personaName: accountSettings.persona,
    accountId: accountSettings.id
  };

  const persona = readText(path.join('personas', `${env.personaName}.txt`));
  const selfTalkPrompt = readText(path.join('prompts', 'self_talk.txt'));
  const corpusPath = path.join(CONFIG_DIR, 'corpus', settings.markov?.corpusFile || 'default.txt');

  // アカウント個別のクールダウンを適用
  const cooldownSeconds = accountSettings.cooldownSeconds ?? settings.cooldownSeconds;

  return {
    ...settings,
    cooldownSeconds,
    env,
    persona,
    selfTalkPrompt,
    corpusPath
  };
}

/**
 * 複数アカウント設定を取得
 * @returns {Array<Object>} 各アカウントの設定オブジェクトの配列
 */
function getMultiAccountConfigs() {
  const accountSettings = loadAccountConfigs();
  return accountSettings.map((acc) => buildConfig(acc));
}

/**
 * 単一アカウント設定を取得（後方互換性）
 * MULTI_ACCOUNT_MODE=false の場合のみ使用
 * @returns {Object} 単一の設定オブジェクト
 */
function getSingleConfig() {
  const accountSettings = loadAccountConfigs()[0];
  return buildConfig(accountSettings);
}

module.exports = {
  getMultiAccountConfigs,
  getSingleConfig,
  buildConfig
};
