/**
 * config/corpus/ の1行1発言コーパスから、LLaMA-Factory等で使えるAlpaca形式の
 * SFT(instruction tuning)データセットをJSONLで作る。
 *
 * コーパスは「誰かの発言→ガッツの返答」というきれいな会話ペアではなく、
 * ガッツ自身の発言だけを抜き出した羅列なので、完璧な会話データにはならない。
 * 直前の数行を「文脈」、次の行を「ガッツの返答」とみなす簡易的なペア化をする
 * (継続する話題であることが多いので、口調・語彙・テンポを学習させる分には機能する)。
 *
 * 使い方:
 *   node scripts/build-sft-dataset.js [corpusFile] [contextWindow]
 *
 * 例:
 *   node scripts/build-sft-dataset.js gatts 2
 *   → config/corpus/gatts を直前2行を文脈として config/corpus/gatts_sft.jsonl に出力
 */

const fs = require('fs');
const path = require('path');

const corpusFile = process.argv[2] || 'gatts';
const contextWindow = parseInt(process.argv[3], 10) || 2;

const corpusPath = path.join(__dirname, '..', 'config', 'corpus', corpusFile);
const outputPath = path.join(__dirname, '..', 'config', 'corpus', `${corpusFile}_sft.jsonl`);

const INSTRUCTION =
  'あなたは「ガッツ」というキャラクターとしてDiscordで雑談しています。次の会話の流れに続けて、ガッツらしく短く返答してください。';

function main() {
  if (!fs.existsSync(corpusPath)) {
    console.log(`[build-sft-dataset] ${corpusPath} が見つかりません。`);
    process.exit(1);
  }

  const lines = fs
    .readFileSync(corpusPath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const pairs = [];
  for (let i = 1; i < lines.length; i++) {
    const context = lines.slice(Math.max(0, i - contextWindow), i).join('\n');
    pairs.push({ instruction: INSTRUCTION, input: context, output: lines[i] });
  }

  const jsonl = pairs.map((p) => JSON.stringify(p)).join('\n');
  fs.writeFileSync(outputPath, `${jsonl}\n`, 'utf-8');

  console.log(`[build-sft-dataset] コーパス行数: ${lines.length}`);
  console.log(`[build-sft-dataset] 生成ペア数: ${pairs.length}`);
  console.log(`[build-sft-dataset] 出力先: ${outputPath}`);
}

main();
