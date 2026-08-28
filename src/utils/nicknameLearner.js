// 日本語の呼びかけは文頭付近に「名前+敬称」が来ることが多い(例: 「しゅーちゃんそれな」)。
// 対象ユーザー宛て(メンション/リプライ)のメッセージだけを対象に、この形のトークンを拾って集計する。
// 誤爆のリスクがあるので自動登録はせず、候補を人間が確認してから!nickname setで登録する運用にする。
const HONORIFIC_SUFFIXES = ['ちゃん', 'くん', '君', 'さん', '様', '氏', 'たん', 'っち', 'やん', '殿'];
const MAX_NAME_LEN = 8;

function extractVocative(text) {
  const trimmed = text.trim();
  for (const suffix of HONORIFIC_SUFFIXES) {
    const idx = trimmed.indexOf(suffix);
    if (idx <= 0 || idx > MAX_NAME_LEN) continue;
    const candidate = trimmed.slice(0, idx + suffix.length);
    if (/^[^\s、。！？!?@<>]+$/.test(candidate)) return candidate;
  }
  return null;
}

async function learnNicknames(channel, targetUserId, fetchLimit = 300) {
  const candidates = new Map();
  let before;
  let scanned = 0;

  while (scanned < fetchLimit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, fetchLimit - scanned), ...(before ? { before } : {}) });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      scanned++;
      before = msg.id;
      if (msg.author.id === targetUserId) continue;

      const directedAtTarget = msg.mentions.has(targetUserId) || msg.mentions.repliedUser?.id === targetUserId;
      if (!directedAtTarget) continue;

      const vocative = extractVocative(msg.content);
      if (vocative) candidates.set(vocative, (candidates.get(vocative) || 0) + 1);
    }

    if (batch.size < 100) break;
  }

  return [...candidates.entries()].sort((a, b) => b[1] - a[1]);
}

module.exports = { learnNicknames };
