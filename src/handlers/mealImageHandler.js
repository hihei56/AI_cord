const fs = require('fs');
const path = require('path');
const { MessageAttachment } = require('discord.js-selfbot-v13');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { createMealPostStore } = require('../utils/mealPostStore');
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

async function checkMeal(channel, store, tag, mealKey, mealConfig, folderBase) {
  const { hour, jitterHours = 0, label = mealKey } = mealConfig;
  const today = todayJST();

  if (store.getLastPostedDate(mealKey) === today) return;

  let target = store.getTodayTarget(mealKey, today);
  if (target === null) {
    target = rollTargetHourOfDay(hour, jitterHours);
    store.setTodayTarget(mealKey, today, target);
  }

  if (hourOfDayJST() < target) return;

  // 朝食/昼食/夕食で画像を分けて管理する必要はない(食事の写真は見た目だけでは
  // 時間帯を区別できないため)、投稿するタイミング(hour/jitterHours)だけを
  // mealKeyごとに分け、画像は全mealKeyで共通の1つのフォルダから選ぶ
  const folderPath = path.join(__dirname, '..', '..', folderBase);
  const images = listImages(folderPath);
  if (images.length === 0) {
    logger.error('MEALPOST', `[${tag}][${mealKey}] ${folderPath} に画像が無いため投稿をスキップ`);
    // 画像が用意されるまで毎回同じ時刻判定を繰り返さないよう、今日はもう
    // 試さない扱いにする(フォルダが空のままだと延々エラーログが出るのを防ぐ)
    store.setLastPostedDate(mealKey, today);
    return;
  }

  const imagePath = images[Math.floor(Math.random() * images.length)];
  try {
    await channel.send({ files: [new MessageAttachment(imagePath)] });
    store.setLastPostedDate(mealKey, today);
    logger.log('MEALPOST', `[${tag}][${mealKey}] ${label} 投稿: ${path.basename(imagePath)}`);
  } catch (err) {
    logger.error('MEALPOST', err);
  }
}

const warnedChannels = new Set();

async function checkOnce(client, store) {
  const mealPosts = config.mealPosts;
  if (!mealPosts?.enabled) return;

  const { id, mealChannelId, mealFolder } = client.accountState;
  const channelId = mealChannelId || mealPosts.channelId;
  const channel = client.channels?.cache.get(channelId);
  if (!channel) {
    // 5分おきのチェックのたびに同じエラーを出し続けないよう、チャンネルごとに1回だけ出す
    const warnKey = `${id}:${channelId}`;
    if (!warnedChannels.has(warnKey)) {
      warnedChannels.add(warnKey);
      logger.error('MEALPOST', `[${id}] 投稿先チャンネル${channelId}にアクセスできない(未参加のサーバー? .envのMEALPOST_CHANNEL_ID[_N]で変更可)`);
    }
    return;
  }

  for (const [mealKey, mealConfig] of Object.entries(mealPosts.meals || {})) {
    await checkMeal(channel, store, id, mealKey, mealConfig, mealFolder || mealPosts.folderBase);
  }
}

// mealpostアカウントごとに独立して投稿する(投稿先チャンネル・画像フォルダ・
// その日の投稿予定時刻はアカウント別)。LLMは一切使わず、フォルダから
// ランダムに選んだ画像をそのまま貼るだけ
function registerMealImageHandler(clients) {
  if (!config.mealPosts?.enabled) return;
  const checkIntervalMs = config.mealPosts.checkIntervalMs || 300000;

  for (const client of clients) {
    const store = createMealPostStore(client.accountState.id);
    const run = () => checkOnce(client, store).catch((err) => logger.error('MEALPOST', err));
    setInterval(run, checkIntervalMs);
    // 起動直後にも1回チェックする(その日の投稿予定時刻を既に過ぎていれば、
    // 次のcheckIntervalMsを待たずすぐ投稿する)
    run();
  }
}

module.exports = { registerMealImageHandler, checkOnce };
