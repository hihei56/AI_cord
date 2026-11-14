const config = require('./config');
const { isOwnAccount } = require('./ownAccounts');

// botの立ち位置は「人間の盛り立て役」で、人間が少なすぎる時だけ代わりに喋る係。
// そのため、どれだけ出しゃばるかを「今このチャンネルに人間が何人いるか」で決める。
//
//   busy  : 人間同士で回っている → botは引っ込む(普段の返信も控えめ、乗っかり・AI同士の会話なし)
//   normal: 人間が2人程度 → 普段どおり。乗っかりはたまに、それもリアクション中心
//   few   : 人間が1人だけ → その人が寂しくないよう、人間に向けて積極的に反応する
//   empty : 人間がいない → AI同士の雑談で場を温めてよい(人が来たら譲る)
//
// 判定は既に受信済みのメッセージキャッシュだけで行い、Discord APIは呼ばない
const P = {
  windowMinutes: 15,
  fewMaxHumans: 1,
  busyMinHumans: 3,
  busyMinMessages: 10,
  // 通常発言(メンション・リプライ以外)への返信確率に掛ける倍率
  replyFactor: { busy: 0.25, normal: 1, few: 1.4, empty: 1 },
  // 返信役の返信に他のアカウントが乗っかる確率に掛ける倍率
  followFactor: { busy: 0, normal: 0.35, few: 1, empty: 1 },
  // 乗っかる時に何をするか(重み)。人が少ない時ほど人間に向けて話しかけ、
  // 人がいる時はリアクションだけにして会話の主役を人間に残す
  followActions: {
    normal: { react: 0.6, replyHuman: 0.25, replyLead: 0.15 },
    few: { react: 0.2, replyHuman: 0.5, replyLead: 0.3 },
    empty: { react: 0.2, replyHuman: 0.4, replyLead: 0.4 }
  },
  ...(config.humanPresence || {})
};

// 「人間の発言か」の判定はここ1か所に置く。以前は同じ判定がハンドラごとに少しずつ違う形で
// 書かれていて、AI同士の掛け合い側だけTupperbox等のWebhookプロキシ経由の人間を
// 人間として数えていなかった(その人が話しかけても掛け合いが止まらなかった)
function isHuman(m) {
  return (!m.author.bot || Boolean(m.webhookId)) && !isOwnAccount(m.author.id);
}

function level(channel) {
  const since = Date.now() - P.windowMinutes * 60000;
  const recent = [...(channel?.messages?.cache?.values() || [])].filter((m) => m.createdTimestamp >= since && isHuman(m));
  const humans = new Set(recent.map((m) => m.author.id)).size;
  if (humans === 0) return 'empty';
  if (humans >= P.busyMinHumans || recent.length >= P.busyMinMessages) return 'busy';
  if (humans <= P.fewMaxHumans) return 'few';
  return 'normal';
}

function pickWeighted(weights) {
  const entries = Object.entries(weights || {});
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) {
    if ((r -= w) <= 0) return k;
  }
  return entries.at(-1)?.[0] || null;
}

module.exports = {
  isHuman,
  level,
  replyFactor: (lv) => P.replyFactor[lv] ?? 1,
  followFactor: (lv) => P.followFactor[lv] ?? 0,
  pickFollowAction: (lv) => pickWeighted(P.followActions[lv])
};
