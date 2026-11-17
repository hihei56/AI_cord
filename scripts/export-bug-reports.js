#!/usr/bin/env node
// VPS上で実行し、監視役(src/utils/selfMonitor.js)が data/bug-reports.jsonl に書いた不具合の報告のうち、
// まだ回収していない分をJSONで標準出力に出す。GitHub Actions(.github/workflows/bug-reports.yml)が
// SSH越しに呼ぶ。
//   node scripts/export-bug-reports.js           → { "offset": 次の位置, "reports": [...] }
//   node scripts/export-bug-reports.js --ack N   → 位置Nまで回収済みにする(issue化が成功してから呼ぶ。
//                                                  失敗した時は報告を失わず、次回また回収される)
// bot本体は追記しかしないので、読み取りと競合しない。書きかけの最終行は次回に回す
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA, 'bug-reports.jsonl');
const OFFSET_FILE = path.join(DATA, 'bug-reports.offset');

function readOffset() {
  try {
    return Number(fs.readFileSync(OFFSET_FILE, 'utf8')) || 0;
  } catch {
    return 0;
  }
}

const ackIndex = process.argv.indexOf('--ack');
if (ackIndex !== -1) {
  const n = Number(process.argv[ackIndex + 1]);
  if (!Number.isFinite(n) || n < readOffset()) {
    console.error('invalid offset');
    process.exit(1);
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(OFFSET_FILE, String(n));
  process.exit(0);
}

let buf = Buffer.alloc(0);
try {
  buf = fs.readFileSync(FILE);
} catch {
  // まだ何も報告されていない
}
let offset = readOffset();
// ファイルが作り直されて短くなっていたら最初から読む
if (offset > buf.length) offset = 0;
const rest = buf.subarray(offset);
const end = rest.lastIndexOf(0x0a) + 1;
const reports = rest
  .subarray(0, end)
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
process.stdout.write(JSON.stringify({ offset: offset + end, reports }));
