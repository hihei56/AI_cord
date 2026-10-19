// Discordサーバーの宣伝ツイートを定期的にXへ投稿する独立プロセス用エントリポイント。
// ai_cord/mealpost/twinviteのどのプロセスとも状態を共有しないため、pm2で別プロセスとして起動する。
//
// 1回の投稿の流れ:
//   1. (PROMO_USE_TRENDS=trueの時だけ)Xのトレンドを取得(twinviteと同じCookieで内部APIを叩く)
//   2. AIにサーバー紹介文(とトレンド一覧)を渡して宣伝文を書かせる。トレンドを使う時は2〜4個選ばせる
//   3. Discordで招待リンクを新規発行(投稿ごとに別コードにして、どの投稿から何人来たか追えるようにする)
//   4. 公式X API(POST /2/tweets)で投稿
require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const { TwitterApi } = require('twitter-api-v2');
const { Scraper } = require('@the-convocation/twitter-scraper');
const logger = require('./utils/logger');
const { scheduleWithJitter } = require('./utils/scheduler');
const { callChatCompletion } = require('./utils/aiClient');
const store = require('./utils/xPromoStore');

const discordToken = process.env.PROMO_DISCORD_TOKEN || process.env.MEALPOST_DISCORD_TOKEN || process.env.DISCORD_TOKEN;
const inviteChannelId = process.env.PROMO_INVITE_CHANNEL_ID;
const serverDescription = process.env.PROMO_SERVER_DESCRIPTION || '';
const DRY_RUN = process.env.PROMO_DRY_RUN === 'true';

const INTERVAL_MS = Number(process.env.PROMO_INTERVAL_MS || 24 * 60 * 60 * 1000);
// 投稿時刻になったかの確認間隔。再起動のたびに即投稿すると(auto-deployでの再起動等)
// 1日に何度も投稿してしまうため、前回の投稿時刻をdata/x-promo.jsonから見て判定する
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
// トレンドタグを使うか(既定false)。無関係なトレンドタグはXのスパム規約に触れるため、
// 既定ではPROMO_TAGSの宣伝・募集用タグだけを付ける
const USE_TRENDS = process.env.PROMO_USE_TRENDS === 'true';
// 招待リンクの有効期限(秒)。投稿ごとに発行するので、無期限だと招待がどんどん溜まる
const INVITE_MAX_AGE = Number(process.env.PROMO_INVITE_MAX_AGE ?? 7 * 24 * 60 * 60);
const TREND_TAG_MIN = Number(process.env.PROMO_TREND_TAG_MIN || 2);
const TREND_TAG_MAX = Number(process.env.PROMO_TREND_TAG_MAX || 4);
const FIXED_TAGS = splitTags(process.env.PROMO_FIXED_TAGS || '#discord');
// 宣伝・募集用のタグ。トレンドを使わない時はこれを付け、使う時はトレンドが取れなかった時の予備にする
const PROMO_TAGS = splitTags(process.env.PROMO_TAGS || '#Discordサーバー宣伝,#Discord募集');

const TWEET_MAX_WEIGHT = 280;
// Xの文字数計算ではURLは長さに関係なく一律23文字扱い
const URL_WEIGHT = 23;

function splitTags(value) {
  return value.split(',').map((t) => t.trim()).filter(Boolean).map(toHashtag).filter(Boolean);
}

// トレンド名は「#」付きとは限らない(「大谷」「三連休」等)ので、ハッシュタグとして
// 成立する形に整える。空白や記号が入っているとタグがそこで途切れるので取り除く
function toHashtag(name) {
  const body = String(name).replace(/^#/, '').replace(/[\s!-/:-@[-^`{-~、。・「」『』（）！？]/g, '');
  return body ? `#${body}` : null;
}

// Xの重み付き文字数(日本語などの全角文字は2、半角英数は1)
function tweetWeight(text) {
  let weight = 0;
  for (const ch of text) {
    weight += /[\u0000-ჿ -‍‐-‟′-‷]/.test(ch) ? 1 : 2;
  }
  return weight;
}

function truncateToWeight(text, maxWeight) {
  let result = '';
  for (const ch of text) {
    if (tweetWeight(result + ch) > maxWeight - 2) return `${result}…`;
    result += ch;
  }
  return result;
}

if (!DRY_RUN && !discordToken) {
  logger.error('FATAL', 'PROMO_DISCORD_TOKEN(またはMEALPOST_DISCORD_TOKEN/DISCORD_TOKEN)が設定されていません');
  process.exit(1);
}
if (!DRY_RUN && !inviteChannelId) {
  logger.error('FATAL', 'PROMO_INVITE_CHANNEL_IDを.envに設定してください(招待リンクを発行するチャンネル)');
  process.exit(1);
}
if (!DRY_RUN && !(process.env.X_API_KEY && process.env.X_API_SECRET && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_SECRET)) {
  logger.error('FATAL', 'X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRETを.envに設定してください');
  process.exit(1);
}

process.on('unhandledRejection', (err) => logger.error('UNHANDLED', err));
process.on('uncaughtException', (err) => logger.error('UNCAUGHT', err));

const xClient = DRY_RUN ? null : new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET
}).readWrite;

const client = new Client({
  checkUpdate: false,
  syncStatus: true,
  ws: { properties: { $os: 'Windows', $browser: 'Discord Client', $device: 'Discord Client' } }
});

let scraper = null;

async function fetchTrends() {
  if (!process.env.TWITTER_AUTH_TOKEN || !process.env.TWITTER_CT0) return [];
  try {
    if (!scraper) {
      scraper = new Scraper({ experimental: { xClientTransactionId: true, xpff: true } });
      await scraper.setCookies([
        `auth_token=${process.env.TWITTER_AUTH_TOKEN}; Domain=x.com; Path=/; Secure; HttpOnly`,
        `ct0=${process.env.TWITTER_CT0}; Domain=x.com; Path=/; Secure`
      ]);
    }
    return await scraper.getTrends();
  } catch (err) {
    logger.error('XPROMO', `トレンド取得失敗、予備タグで代用: ${err.message}`);
    return [];
  }
}

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

// AIに宣伝文とトレンドの選択を同時にやらせる。タグだけ後付けするより、選んだトレンドに
// 文面が少しでも触れていた方が「無関係なタグの羅列」に見えにくく、読まれやすい
async function generatePromo(trends) {
  const tagCount = TREND_TAG_MIN + Math.floor(Math.random() * (TREND_TAG_MAX - TREND_TAG_MIN + 1));
  const recent = store.recentTexts(5);

  const system = [
    'あなたはDiscordサーバーの宣伝ツイートを書く担当です。',
    '出力は必ず次のJSONだけにしてください: {"text": "宣伝文", "trends": ["選んだトレンド", ...]}',
    '- textは日本語で80文字以内。ハッシュタグ・URLはtextに含めない(後で付け足す)',
    ...(trends.length ? [
      `- trendsはトレンド一覧からちょうど${tagCount}個、一覧の表記そのままで選ぶ`,
      '- 選んだトレンドの話題に一言触れて、そこからサーバーへの誘いに自然につなげる'
    ] : ['- trendsは空配列にする']),
    '- 毎回言い回しを変える。過去の投稿と似た書き出し・構成にしない',
    '- 絵文字は0〜2個まで。誇大な表現や嘘は書かない'
  ].join('\n');

  const user = [
    `サーバーの紹介: ${serverDescription || '(未設定。気軽に雑談できるDiscordサーバー)'}`,
    trends.length ? `トレンド一覧: ${trends.join(' / ')}` : '',
    recent.length ? `過去の投稿(これらと似せない):\n${recent.map((t) => `- ${t}`).join('\n')}` : ''
  ].filter(Boolean).join('\n');

  const raw = await callChatCompletion(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: 1.0, maxTokens: 400, logTag: 'XPROMO' }
  );
  if (!raw) return null;

  try {
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    // AIが一覧に無いトレンドを捏造した場合は捨てる
    const chosen = (json.trends || []).filter((t) => trends.includes(t)).slice(0, tagCount);
    if (!json.text) return null;
    return { text: String(json.text).trim(), trendTags: chosen.map(toHashtag).filter(Boolean) };
  } catch {
    logger.error('XPROMO', `AIの出力をJSONとして読めませんでした: ${raw}`);
    return null;
  }
}

async function createInvite() {
  const channel = await client.channels.fetch(inviteChannelId);
  // unique: trueにしないと既存の同条件の招待が使い回され、投稿ごとの効果測定ができない
  return channel.createInvite({ maxAge: INVITE_MAX_AGE, maxUses: 0, unique: true, reason: 'X宣伝' });
}

function composeTweet(text, inviteUrl, trendTags, fixedTags) {
  // 本文が長すぎる時は本文の方を切り詰める。タグが長すぎて本文が40文字分も
  // 残らない時だけ、トレンドタグを後ろから削る(固定タグは残す)
  const trend = trendTags.filter((t) => !fixedTags.includes(t));
  const tagLine = () => [...new Set([...trend, ...fixedTags])].join(' ');
  const reserved = () => 1 + URL_WEIGHT + 1 + tweetWeight(tagLine());

  while (trend.length > 0 && TWEET_MAX_WEIGHT - reserved() < 40) trend.pop();
  const available = TWEET_MAX_WEIGHT - reserved();
  const body = tweetWeight(text) > available ? truncateToWeight(text, available) : text;
  return `${body}\n${inviteUrl}\n${tagLine()}`;
}

async function runPromo() {
  const trends = USE_TRENDS ? await fetchTrends() : [];
  const promo = await generatePromo(trends);
  if (!promo) {
    logger.error('XPROMO', '宣伝文を生成できなかったため今回は投稿をスキップ');
    return;
  }
  // トレンドを使わない(または取れなかった)時は宣伝・募集用タグを付ける。
  // トレンドを使う時もAIが選んだ数が足りなければ宣伝・募集用タグから補う
  const trendTags = [...promo.trendTags];
  const minTags = trends.length ? TREND_TAG_MIN : PROMO_TAGS.length;
  for (const tag of shuffle(PROMO_TAGS)) {
    if (trendTags.length >= minTags) break;
    if (!trendTags.includes(tag)) trendTags.push(tag);
  }

  const invite = DRY_RUN ? { code: 'DRYRUN' } : await createInvite();
  const inviteUrl = `https://discord.gg/${invite.code}`;
  const tweetText = composeTweet(promo.text, inviteUrl, trendTags, FIXED_TAGS);

  if (DRY_RUN) {
    logger.log('XPROMO', `[DRY RUN] 投稿内容:\n${tweetText}`);
    return;
  }

  const { data } = await xClient.v2.tweet(tweetText);
  store.addPost({
    tweetId: data.id,
    inviteCode: invite.code,
    text: promo.text,
    tags: trendTags,
    postedAt: new Date().toISOString()
  });
  logger.log('XPROMO', `投稿: https://x.com/i/status/${data.id} (招待 ${invite.code})`);
}

async function safeRunPromo() {
  const last = store.lastPostedAt();
  // 毎時の確認がずれても1日の投稿時刻が少しずつ後ろへずれていかないよう、30分の余裕を持たせる
  if (!DRY_RUN && last && Date.now() - last < INTERVAL_MS - 30 * 60 * 1000) return;
  try {
    await runPromo();
  } catch (err) {
    // X APIのエラーは中身(レート制限・重複投稿・権限不足等)がdataに入っている
    logger.error('XPROMO', err?.data ? JSON.stringify(err.data) : err);
  }
}

async function start() {
  logger.log('READY', `[XPROMO] 約${Math.round(INTERVAL_MS / 360000) / 10}時間間隔で投稿${USE_TRENDS ? '(トレンドタグあり)' : ''}${DRY_RUN ? '(DRY RUN)' : ''}`);
  await safeRunPromo();
  scheduleWithJitter(DRY_RUN ? INTERVAL_MS : CHECK_INTERVAL_MS, 0.3, safeRunPromo);
}

// DRY RUNでは招待を発行しないので、Discordにログインせずに文面だけ確認できる
if (DRY_RUN) {
  start();
} else {
  client.once('ready', () => {
    logger.log('READY', `[XPROMO] ${client.user.tag}`);
    start();
  });
  client.login(discordToken).catch((err) => {
    logger.error('LOGIN', err);
    process.exit(1);
  });
}
