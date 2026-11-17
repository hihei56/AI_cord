#!/usr/bin/env node
// GitHub Actions上で実行し、VPSから回収した不具合の報告(export-bug-reports.jsの出力)をissueにする。
// 同じ種類・アカウント・内容の未解決issueがあればコメントで件数と例を足し、無ければ新しく立てる。
// ラベル auto-report を付け、Claude Codeの定期タスクがそれを読んで修正する。
//   GH_TOKEN, GITHUB_REPOSITORY が必要。 node scripts/file-bug-issues.js reports.json
const fs = require('fs');

const LABEL = 'auto-report';
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const api = (p, opts = {}) =>
  fetch(`https://api.github.com/repos/${repo}${p}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 422) throw new Error(`${opts.method || 'GET'} ${p}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  });

const FOOTER = '\n\n---\n_VPS上の監視役(src/utils/selfMonitor.js)が自動で報告。Claude Codeの定期タスクが修正する_';

function titleOf(r) {
  return `[自動報告] ${r.kind}${r.account ? ` (${r.account})` : ''}: ${r.detail}`.slice(0, 200);
}

function bodyLines(r) {
  return [
    `- 種類: \`${r.kind}\``,
    `- アカウント: ${r.account ? `\`${r.account}\`` : '(全体)'}`,
    `- 件数: ${r.count}(${new Date(r.firstAt).toISOString()} 〜 ${new Date(r.at).toISOString()})`,
    r.samples?.length ? `- botの発言の例:\n${r.samples.map((s) => `  - ${JSON.stringify(s)}`).join('\n')}` : null
  ]
    .filter(Boolean)
    .join('\n');
}

async function main() {
  const { reports = [] } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8') || '{}');
  if (reports.length === 0) return console.log('報告なし');
  await api('/labels', { method: 'POST', body: JSON.stringify({ name: LABEL, color: 'd93f0b', description: 'botの監視役が自動で報告した不具合' }) });
  const open = await api(`/issues?labels=${LABEL}&state=open&per_page=100`);

  // 同じタイトルにまとまる報告は1回のコメントにまとめる
  const groups = new Map();
  for (const r of reports) {
    const t = titleOf(r);
    groups.set(t, [...(groups.get(t) || []), r]);
  }
  for (const [title, rs] of groups) {
    const body = rs.map(bodyLines).join('\n\n');
    const existing = open.find((i) => i.title === title && !i.pull_request);
    if (existing) {
      await api(`/issues/${existing.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `再発:\n${body}${FOOTER}` }) });
      console.log(`#${existing.number} に追記: ${title}`);
    } else {
      const created = await api('/issues', { method: 'POST', body: JSON.stringify({ title, body: `${body}${FOOTER}`, labels: [LABEL] }) });
      console.log(`#${created.number} を作成: ${title}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
