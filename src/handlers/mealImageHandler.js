const fs = require('fs');
const path = require('path');
const { MessageAttachment } = require('discord.js-selfbot-v13');
const config = require('../utils/config');
const logger = require('../utils/logger');
const store = require('../utils/mealPostStore');
const { hourOfDayJST, todayJST } = require('../utils/datetime');

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

function listImages(folderPath) {
  try {
    return fs
      .readdirSync(folderPath)
      .filter((name) => IMAGE_EXT_RE.test(name))
      .map((name) => path.join(folderPath, name));
  } catch {
    return [];
  }
}

// hour±jitterHoursの範囲でその日の投稿予定時刻をランダムに決める。
// 毎日きっちり同じ時刻に投稿すると機械的に見えるため、日替わりでばらつかせる
function rollTargetHourOfDay(hour, jitterHours) {
  const target = hour + (Math.random() * 2 - 1) * jitterHours;
  return Math.min(23.98, Math.max(0, target));
}

async function checkMeal(channel, mealKey, mealConfig, folderBase) {
  const { hour, jitterHours = 0, label = mealKey } = mealConfig;
  const today = todayJST();

  if (store.getLastPostedDate(mealKey) === today) return;

  let target = store.getTodayTarget(mealKey, today);
  if (target === null) {
    target = rollTargetHourOfDay(hour, jitterHours);
    store.setTodayTarget(mealKey, today, target);
  }

  if (hourOfDayJST() < target) return;

  const folderPath = path.join(__dirname, '..', '..', folderBase, mealKey);
  const images = listImages(folderPath);
  if (images.length === 0) {
    logger.error('MEALPOST', `[${mealKey}] ${folderPath} に画像が無いため投稿をスキップ`);
    // 画像が用意されるまで毎回同じ時刻判定を繰り返さないよう、今日はもう
    // 試さない扱いにする(フォルダが空のままだと延々エラーログが出るのを防ぐ)
    store.setLastPostedDate(mealKey, today);
    return;
  }

  const imagePath = images[Math.floor(Math.random() * images.length)];
  try {
    await channel.send({ files: [new MessageAttachment(imagePath)] });
    store.setLastPostedDate(mealKey, today);
    logger.log('MEALPOST', `[${mealKey}] ${label} 投稿: ${path.basename(imagePath)}`);
  } catch (err) {
    logger.error('MEALPOST', err);
  }
}

async function checkOnce(client) {
  const mealPosts = config.mealPosts;
  if (!mealPosts?.enabled) return;

  const channel = client.channels?.cache.get(mealPosts.channelId);
  if (!channel) return;

  for (const [mealKey, mealConfig] of Object.entries(mealPosts.meals || {})) {
    await checkMeal(channel, mealKey, mealConfig, mealPosts.folderBase);
  }
}

// 食事画像の定期投稿はアカウント(persona)に依存しない全体機能なので、
// 複数アカウント運用時もclients[0]だけが投稿を担当する(priceAlertHandlerと同じ方針)。
// LLMは一切使わず、フォルダからランダムに選んだ画像をそのまま貼るだけ
function registerMealImageHandler(clients) {
  if (!config.mealPosts?.enabled) return;
  const client = clients[0];
  if (!client) return;

  const checkIntervalMs = config.mealPosts.checkIntervalMs || 300000;
  setInterval(() => checkOnce(client).catch((err) => logger.error('MEALPOST', err)), checkIntervalMs);
  // 起動直後にも1回チェックする(その日の投稿予定時刻を既に過ぎていれば、
  // 次のcheckIntervalMsを待たずすぐ投稿する)
  checkOnce(client).catch((err) => logger.error('MEALPOST', err));
}

module.exports = { registerMealImageHandler, checkOnce };
