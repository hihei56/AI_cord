"""
Unslothでgatts_sft.jsonl(Alpaca形式)をQwen2.5-7B-InstructにQLoRAで学習させ、
Ollamaでそのまま使えるGGUFまで書き出すスクリプト。RTX 3060 12GB想定。

事前準備:
  pip install unsloth
  (公式が環境に応じたインストールコマンドを案内している。CUDA/torchのバージョンが
  合わないと動かないことがあるので、詰まったら https://github.com/unslothai/unsloth
  のインストール手順を確認する)

使い方:
  python scripts/finetune-unsloth.py
  (config/corpus/gatts_sft.jsonl を読み、outputs/gatts_lora と outputs/gatts_gguf に書き出す)

学習後、Ollamaで使う場合:
  1. outputs/gatts_gguf/ にできたModelfileを使って:
       ollama create gatts -f outputs/gatts_gguf/Modelfile
  2. ollama serve (常駐してる場合は不要)
  3. .env の FINETUNE_BASE_URL_3=http://localhost:11434/v1 、
     FINETUNE_MODEL_3=gatts を設定
"""

import torch
from datasets import load_dataset
from transformers import TrainingArguments
from trl import SFTTrainer
from unsloth import FastLanguageModel

MAX_SEQ_LENGTH = 1024
DATASET_PATH = "config/corpus/gatts_sft.jsonl"
LORA_OUT = "outputs/gatts_lora"
GGUF_OUT = "outputs/gatts_gguf"

ALPACA_PROMPT = """以下はガッツというキャラクターとしての振る舞いを指示する内容と、直前の会話の流れです。指示に従って、ガッツらしい応答を書いてください。

### 指示:
{}

### 会話の流れ:
{}

### ガッツの応答:
{}"""


def formatting_prompts_func(examples, eos_token):
    texts = []
    for instruction, input_, output in zip(examples["instruction"], examples["input"], examples["output"]):
        texts.append(ALPACA_PROMPT.format(instruction, input_, output) + eos_token)
    return {"text": texts}


def main():
    # 4bit量子化でロード。RTX 3060 12GBならQwen2.5-7Bが余裕を持って乗る
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name="unsloth/Qwen2.5-7B-Instruct-bnb-4bit",
        max_seq_length=MAX_SEQ_LENGTH,
        dtype=None,  # 自動判定(RTX 3060はAmpereなのでbf16が使える)
        load_in_4bit=True,
    )

    # LoRAアダプタを追加。rank16は口調模写くらいの軽いタスクなら十分
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_alpha=16,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=3407,
    )

    dataset = load_dataset("json", data_files=DATASET_PATH, split="train")
    dataset = dataset.map(
        lambda examples: formatting_prompts_func(examples, tokenizer.eos_token),
        batched=True,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=MAX_SEQ_LENGTH,
        dataset_num_proc=2,
        packing=False,
        args=TrainingArguments(
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            warmup_steps=10,
            num_train_epochs=3,
            learning_rate=2e-4,
            fp16=not torch.cuda.is_bf16_supported(),
            bf16=torch.cuda.is_bf16_supported(),
            logging_steps=10,
            optim="adamw_8bit",
            weight_decay=0.01,
            lr_scheduler_type="linear",
            seed=3407,
            output_dir="outputs/checkpoints",
        ),
    )

    trainer.train()

    model.save_pretrained(LORA_OUT)
    tokenizer.save_pretrained(LORA_OUT)
    print(f"LoRAアダプタを {LORA_OUT} に保存しました")

    # Ollamaでそのまま使えるGGUF(q4_k_m量子化)を書き出す。Modelfileも自動生成される
    model.save_pretrained_gguf(GGUF_OUT, tokenizer, quantization_method="q4_k_m")
    print(f"GGUFを {GGUF_OUT} に書き出しました")


if __name__ == "__main__":
    main()
