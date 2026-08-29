const logger = require('../utils/logger');

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

  return activities;
}

async function updatePresence(client) {
  const { presence } = client.accountState;
  try {
    const activities = buildActivities(client, presence);
    await client.user.setPresence({
      activities,
      status: presence.status
    });

    // 更新間隔が短い(既定30秒)ため、選ばれた内容が前回と同じ時まで毎回ログすると
    // 他のログが埋もれてしまう。実際に表示内容が変わった時だけログする
    const signature = activities.map((a) => `${a.name}(${a.details || ''})`).join(', ') || '(なし)';
    if (signature !== client.accountState.lastRpcSignature) {
      client.accountState.lastRpcSignature = signature;
      logger.log('RPC', `[${client.accountState.id}] 更新: ${signature}`);
    }
  } catch (err) {
    logger.error('RPC', err);
  }
}

function registerPresenceHandler(client) {
  updatePresence(client);
  setInterval(() => updatePresence(client), client.accountState.presence.updateIntervalMs);
}

module.exports = { registerPresenceHandler, updatePresence };
