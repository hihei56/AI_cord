function parseUserMention(str) {
  if (!str) return null;
  const mention = str.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  return /^\d{15,20}$/.test(str) ? str : null;
}

function parseChannelMention(str) {
  if (!str) return null;
  const mention = str.match(/^<#(\d+)>$/);
  if (mention) return mention[1];
  return /^\d{15,20}$/.test(str) ? str : null;
}

module.exports = { parseUserMention, parseChannelMention };
