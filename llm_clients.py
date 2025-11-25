
"""
llm_clients.py
---------------
Two LLM clients: OpenAIClient (cloud) and LocalTransformerClient (offline).
Usage:
  - pip install openai transformers accelerate torch typing-extensions
  - For OpenAIClient, set env var OPENAI_API_KEY and call OpenAIClient().chat(...)
  - For LocalTransformerClient, download a local model into ./models/<model-name> and call LocalTransformerClient(model_path="./models/<model-name>").chat(...)
Security notes:
  - Never commit API keys to source. Use environment variables.
  - For production, put API calls behind a server-side proxy (never call from browser with a key embedded).
References:
  - OpenAI Quickstart & best practices: https://platform.openai.com/docs/quickstart, https://platform.openai.com/docs/guides/production-best-practices
  - API key safety: https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety
"""

import os
import time
import json
from typing import Optional, List, Dict

# ---- OpenAI client (cloud) ----
class OpenAIClient:
    def __init__(self, api_key: Optional[str] = None, model: str = "gpt-4o-mini"):
        """
        Requires `openai` package and internet access.
        Provide API key via environment variable OPENAI_API_KEY or pass in directly.
        """
        try:
            import openai
        except Exception as e:
            raise ImportError("openai package not installed. pip install openai") from e

        self.openai = openai
        self.api_key = api_key or os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError("OPENAI_API_KEY not set. Export it in your environment.")
        self.openai.api_key = self.api_key
        self.model = model

    def chat(self, messages: List[Dict[str, str]], temperature: float = 0.2, max_tokens: int = 512):
        """
        messages: list like [{"role":"system","content":"You are..."}, {"role":"user","content":"..."}]
        Returns assistant content string.
        """
        # Basic input validation to avoid accidental huge prompts
        total_length = sum(len(m.get("content","")) for m in messages)
        if total_length > 20000:
            raise ValueError("Prompt too long. Reduce message size.")

        # Simple retry with exponential backoff
        for attempt in range(4):
            try:
                resp = self.openai.ChatCompletion.create(
                    model=self.model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    timeout=30
                )
                # The response structure varies by client; handle defensively
                choice = resp.choices[0]
                return choice.message.content.strip() if hasattr(choice, "message") else choice.text.strip()
            except Exception as e:
                wait = (2 ** attempt) + 0.2
                print(f"OpenAI request failed (attempt {attempt+1}): {e}. Retrying in {wait}s...")
                time.sleep(wait)
        raise RuntimeError("OpenAI API request failed after retries.")


# ---- Local Transformers client (offline/ring-fenced) ----
class LocalTransformerClient:
    def __init__(self, model_path: str, device: str = "cpu"):
        """
        Uses Hugging Face transformers to run a local autoregressive model.
        model_path should point to a directory containing the model files (config, pytorch_model.bin, tokenizer, etc.)
        This implementation uses the `transformers` pipeline for text-generation.
        """
        try:
            from transformers import AutoTokenizer, AutoModelForCausalLM, pipeline, AutoConfig
            import torch
        except Exception as e:
            raise ImportError("transformers/torch not installed. pip install transformers torch accelerate") from e

        self.device = device
        self.model_path = model_path
        # Load tokenizer and model from local path (no internet if files exist locally)
        self.tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
        self.model = AutoModelForCausalLM.from_pretrained(model_path, local_files_only=True)
        self.pipeline = pipeline("text-generation", model=self.model, tokenizer=self.tokenizer, device_map="auto" if device!="cpu" else None)

    def chat(self, prompt: str, max_new_tokens: int = 256, temperature: float = 0.2):
        """
        Very simple chat wrapper — local models don't have multi-turn system/user roles by default.
        For multi-turn, you must format the conversation into the prompt.
        """
        # defensive checks
        if len(prompt) > 20000:
            raise ValueError("Prompt too long. Reduce message size.")

        outputs = self.pipeline(prompt, max_new_tokens=max_new_tokens, do_sample=temperature>0, temperature=temperature)
        return outputs[0]["generated_text"]

# ---- Simple CLI demo ----
def demo_openai():
    client = OpenAIClient()
    messages = [
        {"role":"system","content":"You are a concise assistant that answers in plain text."},
        {"role":"user","content":"Summarise the differences between DNS A records and CNAME records in 3 bullet points."}
    ]
    print("Requesting OpenAI...")
    print(client.chat(messages))

def demo_local(model_path="./models/local-llm"):
    client = LocalTransformerClient(model_path=model_path, device="cpu")
    prompt = "You are a helpful assistant. Explain epoch in machine learning in 2 sentences."
    print("Running local model... (ensure model files are present at model_path)")
    print(client.chat(prompt))

# ---- If run as script, show usage ----
if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description="LLM client runner (OpenAI cloud and local offline options).")
    parser.add_argument("--mode", choices=["openai","local"], default="openai", help="Which backend to run")
    parser.add_argument("--model-path", default="./models/local-llm", help="Local model path (for --mode local)")
    args = parser.parse_args()

    if args.mode == "openai":
        demo_openai()
    else:
        demo_local(model_path=args.model_path)
