import os
import httpx
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
API_KEY = os.getenv("API_KEY", "")

app = FastAPI(title="Secure LLM Gateway")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def check_key(key: Optional[str]) -> None:
    if API_KEY and key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "llama3:8b"
    messages: List[Message]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/models")
async def models(x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{OLLAMA_URL}/api/tags")
        return r.json()


@app.post("/chat")
async def chat(req: ChatRequest, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    async with httpx.AsyncClient(timeout=120.0) as c:
        r = await c.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": req.model,
                "messages": [m.model_dump() for m in req.messages],
                "stream": False,
            },
        )
        r.raise_for_status()
        return r.json()
