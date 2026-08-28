const fs = require('fs');
const path = require('path');

function storePath(accountId) {
  return path.join(__dirname, '..', '..', 'data', `channels-${accountId}.json`);
}

// アカウントごとに独立した応答チャンネル一覧を持つ。
// data/channels-<accountId>.json に永続化する。
function createChannelStore(accountId, seedChannelId) {
  const filePath = storePath(accountId);

  function load() {
    try {
      return new Set(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } catch {
      return new Set([seedChannelId].filter(Boolean));
    }
  }

  const channels = load();

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([...channels], null, 2));
  }

  return {
    isAllowedChannel: (channelId) => channels.has(channelId),
    addChannel: (channelId) => {
      const added = !channels.has(channelId);
      channels.add(channelId);
      if (added) save();
      return added;
    },
    removeChannel: (channelId) => {
      const removed = channels.delete(channelId);
      if (removed) save();
      return removed;
    },
    listChannels: () => [...channels]
  };
}

module.exports = { createChannelStore };
