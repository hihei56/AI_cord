"""
Unslothでgatts_chatml.jsonl(system/user/assistantのmessages形式)をQwen2.5-7B-Instructに
QLoRAで学習させ、Ollamaでそのまま使えるGGUFまで書き出すスクリプト。RTX 3060 12GB想定。

Alpaca形式(instruction/input/output の素のテキスト)ではなくChatML形式で学習するのは、
Ollama/vLLM等のサービング側がChatMLテンプレート(<|im_start|>user...)を使うため。
学習と本番で入力の「型」を揃えないと、スタイルがうまく転写されない
(語彙だけ拾って意味不明なループに陥る、などの症状が出た)。
データセットは scripts/build-chatml-dataset.js で作る。

事前準備:
  pip install unsloth
  (公式が環境に応じたインストールコマンドを案内している。CUDA/torchのバージョンが
  合わないと動かないことがあるので、詰まったら https://github.com/unslothai/unsloth
  のインストール手順を確認する)

使い方:
  node scripts/build-chatml-dataset.js gatts gatts 2
  python scripts/finetune-unsloth.py
  (config/corpus/gatts_chatml.jsonl を読み、outputs/gatts_lora と outputs/gatts_gguf に書き出す)

学習後、Ollamaで使う場合:
  1. outputs/gatts_gguf/ にできたModelfileを使って:
       ollama create gatts -f outputs/gatts_gguf/Modelfile
  2. ollama serve (常駐してる場合は不要)
  3. .env の FINETUNE_BASE_URL_3=http://localhost:11434/v1 、
     FINETUNE_MODEL_3=gatts を設定
"""

import inspect

import torch
from datasets import load_dataset
from trl import SFTConfig, SFTTrainer
from unsloth import FastLanguageModel
from unsloth.chat_templates import get_chat_template

MAX_SEQ_LENGTH = 1024
DATASET_PATH = "config/corpus/gatts_chatml.jsonl"
LORA_OUT = "outputs/gatts_lora"
GGUF_OUT = "outputs/gatts_gguf"


def formatting_prompts_func(examples, tokenizer):
    texts = [
        tokenizer.apply_chat_template(convo, tokenize=False, add_generation_prompt=False)
        for convo in examples["messages"]
    ]
    return {"text": texts}


def main():
    # 4bit量子化でロード。RTX 3060 12GBならQwen2.5-7Bが余裕を持って乗る
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name="unsloth/Qwen2.5-7B-Instruct-bnb-4bit",
        max_seq_length=MAX_SEQ_LENGTH,
        dtype=None,  # 自動判定(RTX 3060はAmpereなのでbf16が使える)
        load_in_4bit=True,
    )

    # QwenのChatMLテンプレート(<|im_start|>...)を明示的に適用する。これがOllama側の
    # Modelfileが使うテンプレートと一致するので、学習・本番で入力の型がずれなくなる
    tokenizer = get_chat_template(tokenizer, chat_template="qwen-2.5")

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
        lambda examples: formatting_prompts_func(examples, tokenizer),
        batched=True,
    )

    # trlのバージョンによってSFTConfigが受け付ける引数名がよく変わる
    # (例: max_seq_length → max_length)。バージョン差異で毎回落ちるのを避けるため、
    # 実際にインストールされているSFTConfigのシグネチャを見て、対応してる名前だけ渡す
    sft_config_params = set(inspect.signature(SFTConfig.__init__).parameters)

    config_kwargs = dict(
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
        dataset_text_field="text",
        dataset_num_proc=2,
        packing=False,
    )

    # max_seq_lengthは新しいtrlではmax_lengthにリネームされている
    seq_len_key = "max_seq_length" if "max_seq_length" in sft_config_params else "max_length"
    config_kwargs[seq_len_key] = MAX_SEQ_LENGTH

    # UnslothがSFTConfigのeos_tokenに未解決のプレースホルダー("<EOS_TOKEN>"という
    # 文字列そのもの)を埋め込んでしまうことがあり、それだとtrlの語彙チェックで
    # 弾かれる。ChatMLテンプレート適用後の実際のeos_token(Qwenなら<|im_end|>)を
    # 明示的に渡して上書きする
    config_kwargs["eos_token"] = tokenizer.eos_token

    training_args = SFTConfig(**{k: v for k, v in config_kwargs.items() if k in sft_config_params})

    # processing_classという引数名も比較的新しいtrlでの名称(以前はtokenizer)なので、
    # ここも実際のシグネチャを見て合わせる
    sft_trainer_params = set(inspect.signature(SFTTrainer.__init__).parameters)
    tokenizer_kwarg = "processing_class" if "processing_class" in sft_trainer_params else "tokenizer"

    trainer = SFTTrainer(
        model=model,
        train_dataset=dataset,
        args=training_args,
        **{tokenizer_kwarg: tokenizer},
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
