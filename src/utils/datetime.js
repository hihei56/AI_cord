const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

// プロンプトに差し込む「今」の情報。サーバーのタイムゾーン設定に依存せず
// 日本時間で表示したいので、Intl.DateTimeFormatでAsia/Tokyoに固定する
function formatNowJST(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}年${get('month')}月${get('day')}日(${get('weekday')}) ${get('hour')}:${get('minute')}`;
}

module.exports = { formatNowJST, WEEKDAYS_JA };
