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

// 日本時間での「今、その日の何時何分か」を分単位の小数で返す(9:30なら9.5)。
// 定時投稿系の機能(mealImageHandler等)で「今日のこの時刻を過ぎたか」を
// 判定するのに使う
function hourOfDayJST(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return get('hour') + get('minute') / 60;
}

// 日本時間での日付をYYYY-MM-DD形式で返す(「今日もう投稿したか」の判定キーに使う)
function todayJST(date = new Date()) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
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

module.exports = { formatNowJST, timeOfDayLabel, hourOfDayJST, todayJST, WEEKDAYS_JA };
