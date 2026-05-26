import logging, os, sys, uuid, asyncio, time, subprocess, urllib.request
import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
API_KEY = os.getenv("API_KEY", "")
IDLE_TIMEOUT = int(os.getenv("IDLE_TIMEOUT_SECS", "120"))
MAX_SESSION = int(os.getenv("MAX_SESSION_SECS", "1800"))  # 30 min hard cap regardless of activity

BOOT_TIME = time.time()

app = FastAPI(title="Secure LLM Gateway")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

jobs = {}
last_activity = time.time()


@app.middleware("http")
async def track_activity(request: Request, call_next):
    global last_activity
    last_activity = time.time()
    return await call_next(request)


def check_key(key: Optional[str]) -> None:
    if API_KEY and key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "llama3.2:1b"
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


async def run_inference(job_id: str, req: ChatRequest):
    try:
        async with httpx.AsyncClient(timeout=300.0) as c:
            r = await c.post(f"{OLLAMA_URL}/api/chat", json={
                "model": req.model,
                "messages": [m.model_dump() for m in req.messages],
                "stream": False,
            })
            r.raise_for_status()
            jobs[job_id] = {"status": "done", "result": r.json()}
    except Exception as e:
        jobs[job_id] = {"status": "error", "error": str(e)}


@app.post("/chat")
async def chat(req: ChatRequest, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending"}
    asyncio.create_task(run_inference(job_id, req))
    return {"jobId": job_id}


@app.get("/result/{job_id}")
async def result(job_id: str, x_api_key: Optional[str] = Header(default=None)):
    check_key(x_api_key)
    return jobs.get(job_id, {"status": "not_found"})


def _terminate():
    try:
        token_req = urllib.request.Request(
            "http://169.254.169.254/latest/api/token",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
            method="PUT",
        )
        token = urllib.request.urlopen(token_req, timeout=2).read().decode()
        iid_req = urllib.request.Request(
            "http://169.254.169.254/latest/meta-data/instance-id",
            headers={"X-aws-ec2-metadata-token": token},
        )
        instance_id = urllib.request.urlopen(iid_req, timeout=2).read().decode()
        logging.info("watchdog: terminating %s", instance_id)
        result = subprocess.run(
            ["aws", "ec2", "terminate-instances", "--instance-ids", instance_id, "--region", "eu-west-2"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            logging.error("watchdog: terminate-instances failed: %s", result.stderr)
            sys.exit(1)  # fallback: kill the process so the instance shuts down via shutdown behavior
    except Exception as e:
        logging.error("watchdog: _terminate error: %s", e)
        sys.exit(1)


async def idle_watchdog():
    await asyncio.sleep(30)  # startup grace period
    while True:
        await asyncio.sleep(10)
        idle = time.time() - last_activity
        age = time.time() - BOOT_TIME
        if idle > IDLE_TIMEOUT or age > MAX_SESSION:
            reason = "max_session" if age > MAX_SESSION else "idle"
            logging.info("watchdog: triggering shutdown (reason=%s idle=%.0fs age=%.0fs)", reason, idle, age)
            _terminate()


@app.on_event("startup")
async def startup():
    asyncio.create_task(idle_watchdog())
