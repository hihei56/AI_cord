const fs = require('fs');
const path = require('path');

function storePath(accountId) {
  return path.join(__dirname, '..', '..', 'data', `reminders-${accountId}.json`);
}

// アカウントごとに独立したリマインダー一覧を持つ。
// data/reminders-<accountId>.json に永続化し、再起動後も残り時間分だけ再スケジュールする。
function createReminderStore(accountId) {
  const filePath = storePath(accountId);

  function load() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return [];
    }
  }

  let reminders = load();

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(reminders, null, 2));
  }

  return {
    add: (reminder) => {
      reminders.push(reminder);
      save();
    },
    remove: (id) => {
      reminders = reminders.filter((r) => r.id !== id);
      save();
    },
    list: () => [...reminders]
  };
}

module.exports = { createReminderStore };
