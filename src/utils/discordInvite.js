// ツイート本文・展開済みURLからDiscordの招待コードを抜き出し、Discordの公開API
// (認証不要の GET /invites/{code})で中身(サーバー名・人数・有効性)を確かめる。
// 招待の照会にDiscordアカウントのトークンは使わない(セルフボットのアカウントで
// 大量に招待を照会すると不審な挙動としてフラグが立ちやすいため)
const INVITE_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,32})/gi;

function extractInviteCodes(texts) {
  const codes = new Set();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(INVITE_PATTERN)) {
      codes.add(match[1]);
    }
  }
  return [...codes];
}

// 戻り値:
//   { status: 'valid', invite }  有効な招待(invite.guild等を含むDiscord APIのレスポンス)
//   { status: 'invalid' }        存在しない・期限切れの招待(404)。以後も照会し直す意味が無い
//   { status: 'retry' }          レート制限・一時的な通信失敗。次回のチェックで再照会する
async function resolveInvite(code) {
  let res;
  try {
    res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
  } catch {
    return { status: 'retry' };
  }

  if (res.status === 404) return { status: 'invalid' };
  if (!res.ok) return { status: 'retry', httpStatus: res.status };

  const invite = await res.json().catch(() => null);
  // グループDMの招待等、サーバー招待以外はguildが無いので共有対象外にする
  if (!invite?.guild) return { status: 'invalid' };
  return { status: 'valid', invite };
}

module.exports = { extractInviteCodes, resolveInvite };
