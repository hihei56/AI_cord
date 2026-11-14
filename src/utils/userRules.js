const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// 特定の相手にだけ適用する「接し方」のルール(config/user_rules.json)。
// 相手はユーザー名か表示名で、適用するアカウント(bot)は省略すれば全アカウント。
// 人格と口調は変えず、その相手への返し方だけをプロンプトで指示する
const FILE = path.join(__dirname, '..', '..', 'config', 'user_rules.json');

let rules = [];
try {
  rules = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  if (!Array.isArray(rules)) rules = [];
} catch (err) {
  if (err.code !== 'ENOENT') logger.error('USER-RULES', `config/user_rules.json を読めません: ${err.message}`);
}

const lower = (s) => (s || '').toLowerCase();

function namesOf(user, member) {
  return [user?.username, user?.globalName, user?.displayName, member?.nickname, member?.displayName].filter(Boolean).map(lower);
}

function matchesUser(rule, author, member) {
  const names = namesOf(author, member);
  if ((rule.usernames || []).some((u) => lower(author?.username) === lower(u))) return true;
  return (rule.nameIncludes || []).some((part) => names.some((n) => n.includes(lower(part))));
}

function matchesBot(rule, botUser, botMember) {
  if (!rule.bots?.length) return true;
  const names = namesOf(botUser, botMember);
  return rule.bots.some((b) => names.includes(lower(b)));
}

// この相手に、このアカウントが適用するルール。{ instructions: [...], replyChance: 最大値またはnull }
function rulesFor(author, member, botUser, botMember) {
  const matched = rules.filter((r) => matchesUser(r, author, member) && matchesBot(r, botUser, botMember));
  const chances = matched.map((r) => r.replyChance).filter((c) => typeof c === 'number');
  return {
    instructions: matched.flatMap((r) => r.instructions || []),
    replyChance: chances.length ? Math.max(...chances) : null
  };
}

module.exports = { rulesFor };
