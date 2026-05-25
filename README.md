# SecureLLM

**[Architecture diagram →](https://grahamveitch.com/securellm/)**

AI access gateway that routes between cloud LLMs (OpenAI) and local models (Ollama), with centralised auth, logging, and vendor-agnostic clients. Built for scenarios where sensitive data must stay on-premise while general queries use cloud inference.

**Status: in progress**

---

## Problem

- Sensitive data leaking to external APIs
- No audit trail over prompts and responses
- Vendor lock-in — clients tied to a specific provider
- No single control point for prompt policy or cost

---

## Architecture

```
Client (n8n / React UI / API consumer)
              ↓
     FastAPI Gateway (/chat, /health, /models)
              ↓
       Routing layer
      ↙             ↘
OpenAI            Ollama (local)
(general)         (sensitive / offline)
```

**AWS infra (CDK — eu-west-2):**

```
CloudFront → S3 (React frontend)
     ↓
API Gateway → Lambda proxy
     ↓
EC2 (g4dn.xlarge Spot, Deep Learning AMI)
     └── Ollama + local model weights (S3 bucket)
```

---

## Stack

| Layer | Tech |
|---|---|
| Gateway API | FastAPI (Python) |
| Local LLM | Ollama |
| Cloud LLM | OpenAI |
| Frontend | React + Vite |
| Infra | AWS CDK (TypeScript) |
| Compute | EC2 g4dn.xlarge Spot |
| Storage | S3 (model weights) |
| Networking | VPC, security groups, Lambda proxy |
| Hosting | CloudFront + S3 |

---

## Components

### `backend/main.py` — FastAPI gateway
- `POST /chat` — proxies chat requests to Ollama
- `GET /models` — lists available local models
- `GET /health` — liveness check
- API key auth via `X-API-Key` header

### `llm_clients.py` — vendor-agnostic Python clients
- `OpenAIClient` — cloud inference, exponential backoff, input validation
- `LocalTransformerClient` — offline Hugging Face models, no internet required
- Same `.chat()` interface — swap provider without changing calling code

### `infra/` — AWS CDK stacks
- **NetworkStack** — VPC, subnets, security groups
- **StorageStack** — S3 bucket for model weights
- **ComputeStack** — EC2 launch template (g4dn.xlarge Spot, DLAMI)
- **GatewayStack** — API Gateway + Lambda proxy
- **HostingStack** — CloudFront + S3 (React frontend, cert in us-east-1)

---

## Quick start (local)

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload

# Frontend
cd frontend
npm install
npm run dev
```

Set `OLLAMA_URL` (default `http://localhost:11434`) and optionally `API_KEY` as env vars.

---

## Roadmap

- [x] FastAPI gateway with Ollama routing
- [x] Vendor-agnostic Python clients (OpenAI + local Transformers)
- [x] CDK infra (VPC, EC2 Spot, API Gateway, CloudFront)
- [ ] Rule-based routing (keyword/flag → local vs cloud)
- [ ] Prompt filtering / redaction layer
- [ ] Full audit logging to Databricks
- [ ] JWT auth
- [ ] Cost tracking per request
