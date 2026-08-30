/**
 * config/corpus/ の1行1発言コーパスから、ChatML(system/user/assistantのmessages形式)の
 * SFTデータセットをJSONLで作る。
 *
 * build-sft-dataset.js(Alpaca形式: instruction/input/output)との違いはここが重要:
 * Ollama/vLLM等で実際にサービングする時はChatMLテンプレート(<|im_start|>user...)で
 * 呼ばれるのに、Alpaca形式の素のテキストで学習すると学習時と本番の「型」が違うせいで
 * スタイルが転写されにくい(語彙だけ拾ってループする、等の症状が出る)。
 * このスクリプトはsystemメッセージにペルソナ(config/personas/<persona>.txt)を含めて
 * messages配列を作るので、tokenizer.apply_chat_template()でそのままChatML化できる。
 *
 * 使い方:
 *   node scripts/build-chatml-dataset.js [corpusFile] [personaFile] [contextWindow]
 *
 * 例:
 *   node scripts/build-chatml-dataset.js gatts gatts 2
 *   → config/corpus/gatts + config/personas/gatts.txt から
 *     config/corpus/gatts_chatml.jsonl に出力
 */

const fs = require('fs');
const path = require('path');

const corpusFile = process.argv[2] || 'gatts';
const personaFile = process.argv[3] || corpusFile;
const contextWindow = parseInt(process.argv[4], 10) || 2;

const corpusPath = path.join(__dirname, '..', 'config', 'corpus', corpusFile);
const personaPath = path.join(__dirname, '..', 'config', 'personas', `${personaFile}.txt`);
const outputPath = path.join(__dirname, '..', 'config', 'corpus', `${corpusFile}_chatml.jsonl`);

function main() {
  if (!fs.existsSync(corpusPath)) {
    console.log(`[build-chatml-dataset] ${corpusPath} が見つかりません。`);
    process.exit(1);
  }
  if (!fs.existsSync(personaPath)) {
    console.log(`[build-chatml-dataset] ${personaPath} が見つかりません。`);
    process.exit(1);
  }

  const systemPrompt = fs.readFileSync(personaPath, 'utf-8').trim();
  const lines = fs
    .readFileSync(corpusPath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const examples = [];
  for (let i = 1; i < lines.length; i++) {
    const context = lines.slice(Math.max(0, i - contextWindow), i).join('\n');
    examples.push({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: context },
        { role: 'assistant', content: lines[i] }
      ]
    });
  }

  const jsonl = examples.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(outputPath, `${jsonl}\n`, 'utf-8');

  console.log(`[build-chatml-dataset] コーパス行数: ${lines.length}`);
  console.log(`[build-chatml-dataset] ペルソナ: ${personaPath}`);
  console.log(`[build-chatml-dataset] 生成件数: ${examples.length}`);
  console.log(`[build-chatml-dataset] 出力先: ${outputPath}`);
}

main();
