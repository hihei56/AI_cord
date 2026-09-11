// GitHubへのpushを検知して自動でgit pull + pm2再起動する常駐スクリプト。
// Webhook(インバウンド接続が必要)ではなく、一定間隔でgit fetchしてorigin/<branch>と
// ローカルHEADを比較するポーリング方式にしている。Oracle CloudのAlways Free枠は
// アウトバウンド接続だけで完結させたい(ポートを開けたくない)構成のため、README記載の
// 「このBotはアウトバウンド接続するだけ」という既存の運用方針とも合う。
// スマホのGitHubアプリ等からpushするだけで、次のポーリングのタイミングで
// サーバー側に反映される(SSHでの手動pull/pm2 restartが不要になる)。
//
// 使い方:
//   pm2 start scripts/auto-deploy.js --name deploy-watch
//   pm2 save
//
// 環境変数(任意、.envから読み込む):
//   DEPLOY_BRANCH               追跡するブランチ(既定: main)
//   DEPLOY_CHECK_INTERVAL_MS    ポーリング間隔ms(既定: 60000 = 1分)
//   DEPLOY_PM2_PROCESSES        新しいコミットを検知した時に再起動するpm2プロセス名
//                                (カンマ区切り、既定: ai_cord,mealpost)
require('dotenv').config();

const { execFileSync } = require('child_process');
const path = require('path');

const REPO_DIR = path.join(__dirname, '..');
const BRANCH = process.env.DEPLOY_BRANCH || 'main';
const INTERVAL_MS = Number(process.env.DEPLOY_CHECK_INTERVAL_MS) || 60000;
const PM2_PROCESSES = (process.env.DEPLOY_PM2_PROCESSES || 'ai_cord,mealpost')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// execSyncではなくexecFileSyncを使うのは、シェル経由にしないことでコマンド
// インジェクションの余地を無くすため(引数は固定値のみで外部入力は含まないが、
// 念のため安全な方を採用する)
function run(file, args) {
  return execFileSync(file, args, { cwd: REPO_DIR, encoding: 'utf-8' }).trim();
}

let running = false;

async function checkAndDeploy() {
  // 前回のチェック(pull/npm install/pm2 restart)がまだ終わっていない間に
  // 次のタイマーが発火しても二重実行しないようにする
  if (running) return;
  running = true;

  try {
    run('git', ['fetch', 'origin', BRANCH]);
    const local = run('git', ['rev-parse', 'HEAD']);
    const remote = run('git', ['rev-parse', `origin/${BRANCH}`]);
    if (local === remote) return;

    log(`新しいコミットを検知 (${local.slice(0, 7)} → ${remote.slice(0, 7)})。デプロイを開始します`);

    const changedFiles = run('git', ['diff', '--name-only', local, remote]);
    run('git', ['pull', 'origin', BRANCH]);

    // package.json/package-lock.jsonが変わっていない限りnpm installは省略する
    // (依存関係に変化が無いたびに毎回インストールし直すのは無駄なため)
    if (changedFiles.includes('package.json') || changedFiles.includes('package-lock.json')) {
      log('package.json(またはpackage-lock.json)が変更されたためnpm installを実行します');
      run('npm', ['install', '--no-audit', '--no-fund']);
    }

    for (const name of PM2_PROCESSES) {
      try {
        run('pm2', ['restart', name]);
        log(`pm2再起動しました: ${name}`);
      } catch (err) {
        // 対象プロセスがまだ起動していない等でも、他のプロセスの再起動は続行する
        log(`pm2再起動に失敗しました(${name}。起動済みか確認してください): ${err.message}`);
      }
    }

    log('デプロイ完了');
  } catch (err) {
    // ローカルの未コミット変更とのコンフリクト等で失敗しても、プロセス自体は
    // 落とさず次回のポーリングで再試行する(手動でpm2 logs deploy-watchを見て
    // 気づけるようにエラー内容だけ残す)
    log(`デプロイチェックに失敗しました: ${err.message}`);
  } finally {
    running = false;
  }
}

log(`自動デプロイ監視を開始します (branch=${BRANCH}, interval=${INTERVAL_MS}ms, pm2=[${PM2_PROCESSES.join(', ')}])`);
checkAndDeploy();
setInterval(checkAndDeploy, INTERVAL_MS);
