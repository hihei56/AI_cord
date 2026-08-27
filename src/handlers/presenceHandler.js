const config = require('../utils/config');
const logger = require('../utils/logger');

function pickSpotifyTrack() {
  const tracks = config.presence.spotifyTracks;
  return tracks[Math.floor(Math.random() * tracks.length)];
}

function buildActivities(client) {
  const track = pickSpotifyTrack();
  const watching = config.presence.watching;
  const now = Date.now();

  return [
    {
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
    },
    {
      name: watching.name,
      type: 3,
      application_id: watching.applicationId,
      details: watching.details,
      state: watching.state,
      assets: { large_image: watching.largeImage },
      timestamps: {
        start: now - watching.elapsedMs,
        end: now - watching.elapsedMs + watching.durationMs
      }
    }
  ];
}

async function updatePresence(client) {
  try {
    await client.user.setPresence({
      activities: buildActivities(client),
      status: config.presence.status
    });
  } catch (err) {
    logger.error('RPC', err);
  }
}

function registerPresenceHandler(client) {
  updatePresence(client);
  setInterval(() => updatePresence(client), config.presence.updateIntervalMs);
}

module.exports = { registerPresenceHandler, updatePresence };
