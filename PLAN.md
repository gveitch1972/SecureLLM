# Secure LLM / localLLM — Plan

## What it is

Secure AI access gateway. Single entry point routing between external LLM (OpenAI/Azure) and local LLM (Ollama). Centralised logging, prompt control, vendor-agnostic clients.

Should have been named **localLLM** — that better describes the core value (local model routing for sensitive data).

## Problem it solves

- Sensitive data leakage to external APIs
- No centralised control over prompts/responses
- No audit trail
- Vendor lock-in

## Architecture

```
Client layer (n8n / Telegram / UI)
        ↓
Gateway API (FastAPI)
        ↓
Routing layer (rule-based → policy engine)
   ↙               ↘
External LLM      Local LLM (Ollama)
(OpenAI/Azure)    (sensitive data / offline)
        ↓
Memory/storage (Databricks tables)
```

## Core components

| Component | Purpose |
|-----------|---------|
| Gateway API | Single entry point — `/chat`, `/completion`. Validation, auth, logging, routing. |
| Routing layer | Rule-based initially (keywords/flags). Future: policy engine, cost-aware, sensitivity classification. |
| External provider | OpenAI / Azure OpenAI — general queries, high-quality responses. |
| Local model | Ollama — sensitive data, offline, private processing. |
| Memory layer | Databricks tables — prompts, responses, metadata (timestamp, provider, user). |
| Integration layer | n8n workflows, Telegram bot, future dashboards. |

## Tech stack

| Layer | Tech |
|-------|------|
| API Gateway | FastAPI |
| Orchestration | n8n |
| External LLM | OpenAI / Azure OpenAI |
| Local LLM | Ollama |
| Data layer | Databricks |
| Hosting (future) | Azure Container Apps |

## Phase 1 — MVP

- [ ] Gateway API running locally
- [ ] Basic rule-based routing
- [ ] External LLM connected (OpenAI or Azure)
- [ ] Local LLM connected (Ollama)
- [ ] All interactions logged
- [ ] n8n connected via HTTP

Out of scope for MVP: embeddings, RAG, fine-tuning, complex auth.

## Phase 2 — Enhancements

- [ ] API key / JWT auth
- [ ] Prompt filtering / redaction
- [ ] RAG context from Databricks
- [ ] Cost tracking per request
- [ ] Observability dashboard

## Phase 3 — Enterprise

- Private deployment (Azure VNet / Container Apps)
- Full audit logging + compliance
- RBAC
- Model performance monitoring
- Multi-tenant

## Strategic positioning

Treat as **enabler layered on Tier 1 projects** — not a standalone product. Wire financial-signals-lakehouse and Personal Janitor through the gateway to demonstrate real usage. That's the portfolio story: "all AI calls go through a governed, auditable layer I built."

## Success criteria

- All AI calls routable through gateway
- Provider switch without changing clients
- Full visibility: inputs, outputs, usage
- Demonstrable "secure AI" pattern for portfolio / commercial use

## Status

Planned. Existing code in folder: `llm_clients.py`, `README.md`. Previous thinking in `openAIProject.txt` and PDFs.
