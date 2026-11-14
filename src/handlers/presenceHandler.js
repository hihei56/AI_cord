const crypto = require('crypto');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { scheduleWithJitter } = require('../utils/scheduler');

// 宣伝用のRPC: 「〇〇をプレイ中」+「サーバーに参加」ボタン(招待リンク)をプロフィールに出す。
// RPCはアカウント単位で、そのアカウントがいる全サーバーのメンバー一覧・プロフィールに
// 表示されるので、別サーバーにいるだけで(発言しなくても)入口になる。
// ボタンを表示するにはDiscordアプリケーションのID(application_id)が必要。
// 全アカウントが同じ文言・同じボタンだと同一人物の量産アカウントだと一目で分かるため、
// 対象アカウントを絞れる(promo.accounts)ようにし、文言は候補からアカウントごとに固定で選ぶ
const PROMO = config.promo || {};
const promoStartedAt = Date.now() - Math.floor(Math.random() * 3 * 3600000);

function promoTargets(accountId) {
  const list = PROMO.accounts;
  return !list || list === 'all' || (Array.isArray(list) && list.map(String).includes(String(accountId)));
}

// アカウントIDから決まる固定の選択(再起動しても同じ文言になる)
function stablePick(arr, accountId, salt) {
  if (!Array.isArray(arr) || arr.length === 0) return arr || undefined;
  const h = crypto.createHash('md5').update(`${salt}:${accountId}`).digest()[0];
  return arr[h % arr.length];
}

function buildPromoActivity(client, presence) {
  const inviteUrl = process.env.PROMO_INVITE_URL || PROMO.inviteUrl;
  const applicationId = process.env.PROMO_APPLICATION_ID || PROMO.applicationId || presence.watching?.applicationId;
  if (!PROMO.enabled || !inviteUrl || !promoTargets(client.accountState.id)) return null;
  if (!applicationId) {
    if (!client.accountState.promoWarned) {
      client.accountState.promoWarned = true;
      logger.error('RPC', `[${client.accountState.id}] 宣伝RPCにはPROMO_APPLICATION_ID(DiscordアプリのID)が必要なため表示しません`);
    }
    return null;
  }
  const id = client.accountState.id;
  return {
    name: stablePick(PROMO.names, id, 'name') || PROMO.name || '雑談',
    type: 0,
    application_id: applicationId,
    details: stablePick(PROMO.details, id, 'details'),
    state: stablePick(PROMO.states, id, 'state'),
    timestamps: { start: promoStartedAt },
    buttons: [PROMO.buttonLabel || 'サーバーに参加'],
    metadata: { button_urls: [inviteUrl] }
  };
}

function pickSpotifyTrack(presence) {
  const tracks = presence.spotifyTracks;
  if (!tracks?.length) return null;
  return tracks[Math.floor(Math.random() * tracks.length)];
}

function buildActivities(client, presence) {
  const activities = [];
  const now = Date.now();

  const track = pickSpotifyTrack(presence);
  if (track) {
    activities.push({
      name: 'Spotify',
      type: 2,
      flags: 48,
      details: track.details,
      state: track.state,
      sync_id: track.syncId,
      ...(track.albumId
        ? { metadata: { album_id: track.albumId, context_uri: `spotify:album:${track.albumId}` } }
        : {}),
      assets: {
        large_image: track.largeImage,
        ...(track.smallImage ? { small_image: track.smallImage } : {}),
        large_text: track.details
      },
      party: { id: `spotify:${client.user.id}` }
    });
  }

  const watching = presence.watching;
  if (watching) {
    activities.push({
      name: watching.name,
      type: 3,
      application_id: watching.applicationId,
      details: watching.details,
      state: watching.state,
      assets: {
        large_image: watching.largeImage,
        ...(watching.smallImage ? { small_image: watching.smallImage } : {}),
        ...(watching.largeText ? { large_text: watching.largeText } : {})
      },
      timestamps: {
        start: now - watching.elapsedMs,
        end: now - watching.elapsedMs + watching.durationMs
      }
    });
  }

  // 宣伝RPCは先頭に置く(メンバー一覧に表示されるのは基本的に先頭のアクティビティのため)
  const promo = buildPromoActivity(client, presence);
  if (promo) activities.unshift(promo);

  return activities;
}

// 表示内容が変わらない時は送り直さない(既定30秒ごとに全アカウントがGatewayへ同じ
// プレゼンスを送り続けていた)。再接続等で表示が消えていても直るよう、この間隔ごとには送る
const PRESENCE_REFRESH_MS = 10 * 60000;

async function updatePresence(client) {
  const { presence } = client.accountState;
  const state = client.accountState;
  try {
    const activities = buildActivities(client, presence);
    const signature = activities.map((a) => `${a.name}(${a.details || ''})`).join(', ') || '(なし)';
    if (signature === state.lastRpcSignature && Date.now() - (state.lastRpcSentAt || 0) < PRESENCE_REFRESH_MS) return;

    await client.user.setPresence({
      activities,
      status: presence.status
    });
    state.lastRpcSentAt = Date.now();

    if (signature !== state.lastRpcSignature) {
      state.lastRpcSignature = signature;
      logger.log('RPC', `[${state.id}] 更新: ${signature}`);
    }
  } catch (err) {
    logger.error('RPC', err);
  }
}

function registerPresenceHandler(client) {
  updatePresence(client);
  // 完全固定周期での更新はRPCの切り替わりタイミングが規則的に見えるため、ここもジッターを掛ける
  scheduleWithJitter(client.accountState.presence.updateIntervalMs, 0.3, () => updatePresence(client));
}

module.exports = { registerPresenceHandler, updatePresence };
