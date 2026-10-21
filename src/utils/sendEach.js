// 通知を1件ずつ別メッセージで送る(1通にまとめると一覧になって読みにくいため)。
// 連投でDiscordのレート制限に当たらないよう少し間を空ける
async function sendEach(channel, texts, gapMs = 1500) {
  for (let i = 0; i < texts.length; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
    await channel.send(texts[i]);
  }
}

module.exports = { sendEach };
