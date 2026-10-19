// X(Twitter)を定期的に検索して、ツイートに貼られたDiscordサーバーの招待リンクを
// 抜き出し、Discordのチャンネルへ共有する独立プロセス用エントリポイント。
// ai_cord/mealpostのどちらのプロセスとも状態を共有しないため、pm2で別プロセスとして
// 起動する(片方のクラッシュ・再起動がほかに波及しないように)。
//
// - 検索: ブラウザでログイン済みのXアカウントのCookie(auth_token/ct0)を使い、
//   Web版の検索と同じ内部APIを叩く(公式API v2の検索はmin_faves演算子が使えず有料のため)
// - 共有: DiscordのWebhookで投稿する(セルフボットのトークンは不要)
require('dotenv').config();

const { Scraper, SearchMode, ErrorRateLimitStrategy } = require('@the-convocation/twitter-scraper');
const logger = require('./utils/logger');
const { scheduleWithJitter } = require('./utils/scheduler');
const { extractInviteCodes, resolveInvite } = require('./utils/discordInvite');
const store = require('./utils/twitterInviteStore');

const authToken = process.env.TWITTER_AUTH_TOKEN;
const ct0 = process.env.TWITTER_CT0;
const webhookUrl = process.env.TWITTER_INVITE_WEBHOOK_URL;

const QUERY = process.env.TWITTER_SEARCH_QUERY || 'discord.gg min_faves:50 lang:ja';
// min_favesは検索側で効くはずだが、念のため取得したいいね数でも足切りする
const MIN_LIKES = Number(process.env.TWITTER_MIN_LIKES ?? 50);
const MAX_TWEETS = Number(process.env.TWITTER_SEARCH_MAX_TWEETS || 60);
const INTERVAL_MS = Number(process.env.TWITTER_SEARCH_INTERVAL_MS || 30 * 60 * 1000);
const SEARCH_MODE = process.env.TWITTER_SEARCH_MODE === 'top' ? SearchMode.Top : SearchMode.Latest;
// 招待照会・Webhook投稿の間隔(Discord側のレート制限避け)
const STEP_DELAY_MS = 1500;

if (!authToken || !ct0) {
  logger.error('FATAL', 'TWITTER_AUTH_TOKENとTWITTER_CT0を.envに設定してください');
  process.exit(1);
}
if (!webhookUrl) {
  logger.error('FATAL', 'TWITTER_INVITE_WEBHOOK_URLを.envに設定してください');
  process.exit(1);
}

process.on('unhandledRejection', (err) => logger.error('UNHANDLED', err));
process.on('uncaughtException', (err) => logger.error('UNCAUGHT', err));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 429を受けたらその回の検索は諦め、次回のスケジュールまで待つ(WaitingRateLimitStrategyだと
// 最大15分ブロックしたままになり、その間にスケジュールが詰まるため)
const scraper = new Scraper({
  rateLimitStrategy: new ErrorRateLimitStrategy(),
  experimental: { xClientTransactionId: true, xpff: true }
});

async function login() {
  await scraper.setCookies([
    `auth_token=${authToken}; Domain=x.com; Path=/; Secure; HttpOnly`,
    `ct0=${ct0}; Domain=x.com; Path=/; Secure`
  ]);
  if (!(await scraper.isLoggedIn())) {
    throw new Error('Cookieでログインできませんでした(auth_token/ct0が期限切れの可能性)');
  }
}

function formatInviteMessage(invite, code, tweet) {
  const guild = invite.guild;
  const members = invite.approximate_member_count;
  const online = invite.approximate_presence_count;
  const iconUrl = guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
    : undefined;

  return {
    content: `https://discord.gg/${code}`,
    embeds: [{
      title: guild.name,
      url: `https://discord.gg/${code}`,
      description: guild.description || undefined,
      thumbnail: iconUrl ? { url: iconUrl } : undefined,
      color: 0x5865f2,
      fields: [
        { name: 'メンバー', value: members != null ? `${members}人(オンライン${online ?? '?'})` : '不明', inline: true },
        { name: '♥', value: String(tweet.likes ?? '?'), inline: true },
        { name: '元ツイート', value: tweet.permanentUrl || `https://x.com/i/status/${tweet.id}` }
      ],
      timestamp: tweet.timeParsed ? tweet.timeParsed.toISOString() : undefined
    }],
    // 招待先サーバー名等に@everyone等が含まれていてもメンションさせない
    allowed_mentions: { parse: [] }
  };
}

async function postToWebhook(body) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    await sleep(Math.ceil((data.retry_after ?? 5) * 1000));
    return postToWebhook(body);
  }
  if (!res.ok) throw new Error(`Webhook投稿失敗 HTTP ${res.status}`);
}

async function handleTweet(tweet) {
  // RTの場合はRT元の本文・URLを見る
  const source = tweet.retweetedStatus || tweet;
  if ((source.likes ?? 0) < MIN_LIKES) return 0;

  const codes = extractInviteCodes([...(source.urls || []), source.text]);
  let posted = 0;

  for (const code of codes) {
    if (store.hasCode(code)) continue;

    const result = await resolveInvite(code);
    await sleep(STEP_DELAY_MS);

    if (result.status === 'retry') {
      logger.log('TWINVITE', `招待 ${code} の照会を次回に持ち越し (HTTP ${result.httpStatus ?? '-'})`);
      continue;
    }
    const guildId = result.invite?.guild?.id;
    if (result.status === 'invalid' || store.hasGuild(guildId)) {
      store.markCode(code);
      continue;
    }

    // 投稿に失敗した招待は既読にしない(次回の検索で再挑戦させる)
    await postToWebhook(formatInviteMessage(result.invite, code, source));
    store.markCode(code);
    store.markGuild(guildId);
    posted++;
    logger.log('TWINVITE', `共有: ${result.invite.guild.name} (discord.gg/${code}) ← ${source.permanentUrl}`);
    await sleep(STEP_DELAY_MS);
  }
  return posted;
}

async function runSearch() {
  let scanned = 0;
  let posted = 0;
  try {
    for await (const tweet of scraper.searchTweets(QUERY, MAX_TWEETS, SEARCH_MODE)) {
      scanned++;
      posted += await handleTweet(tweet);
    }
  } catch (err) {
    logger.error('TWINVITE', err);
  }
  logger.log('TWINVITE', `検索完了: ${scanned}件のツイートを確認、${posted}件のサーバーを共有`);
}

(async () => {
  try {
    await login();
  } catch (err) {
    logger.error('LOGIN', err);
    process.exit(1);
  }
  logger.log('READY', `[TWINVITE] 検索クエリ「${QUERY}」を約${Math.round(INTERVAL_MS / 60000)}分間隔で巡回`);

  await runSearch();
  scheduleWithJitter(INTERVAL_MS, 0.3, runSearch);
})();
