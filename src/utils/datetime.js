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

function hourJST(date = new Date()) {
  return Number(new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false }).format(date));
}

// 時間帯ごとのざっくりした呼び名。挨拶(おはよう/おやすみ等)のきっかけとして
// プロンプトに渡すためのラベルで、時刻そのもの(formatNowJST)と別に持たせておくと
// 「6〜7時台=朝」のような判定をプロンプト側の文章から都度読み取らせずに済む
function timeOfDayLabel(date = new Date()) {
  const hour = hourJST(date);
  if (hour >= 5 && hour < 7) return '早朝';
  if (hour >= 7 && hour < 10) return '朝';
  if (hour >= 10 && hour < 17) return '昼';
  if (hour >= 17 && hour < 19) return '夕方';
  if (hour >= 19 && hour < 23) return '夜';
  return '深夜';
}

module.exports = { formatNowJST, timeOfDayLabel, WEEKDAYS_JA };
