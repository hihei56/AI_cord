const config = require('./config');
const logger = require('./logger');
const webSearch = require('./webSearch');
const knowledgeBase = require('./knowledgeBase');

// 物知り役(roles.<役割>.searchQuestions)が人間の質問に答える前に、必要ならWeb検索する。
// 検索は無料枠(1日の上限あり)と時間を使うので、次の全部を満たす時だけ:
// - 事実を聞いている質問っぽい(疑問の語を含み、ある程度の長さがある。「今何してる？」のような
//   相手個人への質問は「？」で終わっていても対象外)
// - 知識ベースに関係する内容が無い(内輪ネタは検索しても出てこないため)
const QUESTION_RE = /(教えて|って何|ってなに|とは[?？]?$|いつ|どこ|誰|だれ|なぜ|なんで|どうやって|どれくらい|いくら|何時|何日|何年|何人|おすすめ|違い)/;
const SMALLTALK_RE = /^(元気|おは|こんにち|こんばん|おやす|眠い|暇|ひま)/;

function cleanQuery(text) {
  return text
    .replace(/<@!?\d+>|<#\d+>|<a?:\w+:\d+>/g, '')
    .replace(/\[添付画像の内容:[^\]]*\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim();
}

function isFactQuestion(text) {
  const t = cleanQuery(text);
  if (t.length < 6 || SMALLTALK_RE.test(t)) return false;
  return QUESTION_RE.test(t);
}

async function factsFor(accountState, text) {
  const role = accountState?.charRole ? config.roles?.[accountState.charRole] : null;
  if (!role?.searchQuestions || !webSearch.isAvailable() || !isFactQuestion(text)) return null;
  if (knowledgeBase.lookup(text).length > 0) return null;

  const query = cleanQuery(text).slice(0, 120);
  const summary = webSearch.summarize(await webSearch.search(query));
  if (summary) logger.log('SEARCH', `[${accountState.id}] 「${query}」を検索して回答に使う`);
  return summary;
}

module.exports = { factsFor, isFactQuestion };
