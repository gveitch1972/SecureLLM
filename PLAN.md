# Secure LLM — Plan

## What it is

Enterprise-grade private AI inference. All queries processed inside your AWS VPC — no data ever reaches an external LLM. Single cold-start demo that proves the pattern.

**Core pitch:** "Your staff get an AI assistant. Your data never leaves your infrastructure."

## Problem it solves

| Problem | How we solve it |
|---------|----------------|
| Sensitive data leaking to OpenAI/Azure | All inference on local Ollama (EC2 inside VPC) |
| No audit trail on AI usage | Every query + response logged (CloudWatch) |
| No control over what staff can ask | Input guardrail blocks PII before it hits the model |
| Vendor lock-in to cloud LLMs | Swap model in one place — clients unchanged |

## Architecture

```
User (browser)
      ↓ HTTPS
CloudFront → S3 (React UI)
      ↓ API key
API Gateway (eu-west-2)
      ↓
orchestratorFn (Lambda, not in VPC)  ← RunInstances / session management
      ↓
proxyFn (Lambda, in VPC)
      ↓
  [INPUT GUARDRAIL]          ← PII scan — block + log if triggered
      ↓ (clean only)
FastAPI on EC2 (VPC, no inbound except Lambda SG on :8000)
      ↓
Ollama (llama3:8b, CPU or GPU)
      ↓
  [OUTPUT GUARDRAIL]         ← strip PII echoed in response, log audit trail
      ↓
User gets response
```

No NAT Gateway. EC2 egress = 443 only (S3 via VPC endpoint for model cache). No SSH — SSM only.

## What is built

- [x] CDK 5-stack deploy: Network, Storage, Compute, Gateway, Hosting
- [x] Cold-start flow: Start Session → EC2 launches → Ollama boots → FastAPI → Ready
- [x] Boot checklist UI: 5-stage live progress in the browser
- [x] S3 model cache: llama3:8b persists across boots (fast restart)
- [x] API key auth at API Gateway + FastAPI
- [x] Error handling: Launch failed state surfaced to UI (quota errors etc.)
- [x] Self-terminating instance (trap EXIT in boot script)

## What is next

### Phase 0 — Access control (TOP PRIORITY)
- [ ] **Per-user API key auth** — React shows passcode entry screen before chat UI. User enters their key, stored in `localStorage`, sent as `x-api-key`. API GW usage plan validates it. Individual keys can be revoked, rate-limited, monitored per user.
  - Create API GW usage plan + associate existing API
  - Generate keys via CLI: `aws apigateway create-api-key --name "user-name" --enabled`
  - Add passcode screen component to React (simple — one input, submit, store in localStorage)
  - Remove hardcoded `VITE_API_KEY` from env — key comes from user input instead
  - Send keys to trusted users by email/message

### Phase 1 — Smoke test (unblocked now)
- [x] Confirm t3.large boot completes end-to-end (20GB EBS now deployed)
- [x] Send a chat message, get a response (llama3.2:1b, ~1-5s on CPU)
- [ ] Verify S3 model cache populates (fast second boot)
- [ ] **FastAPI process supervisor** — uvicorn crashes silently after use; run under systemd so it auto-restarts. Add to user-data script in compute-stack.ts:
  ```
  cat > /etc/systemd/system/fastapi.service << EOF
  [Unit]
  After=network.target
  [Service]
  WorkingDirectory=/opt/secure-llm
  ExecStart=/usr/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
  Restart=always
  RestartSec=3
  [Install]
  WantedBy=multi-user.target
  EOF
  systemctl enable --now fastapi
  ```

### Phase 2 — GPU (blocked on AWS quota)
- [ ] Submit On-Demand G quota increase: `aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-DB2E81BA --desired-value 8 --region eu-west-2`
- [ ] Switch LaunchTemplate back to g4dn.xlarge + DLAMI + `--gpus all`
- [ ] Test response speed (GPU vs CPU — significant difference)

### Phase 3 — Guardrails (enterprise value add)
- [ ] **Input guardrail** in proxyFn: scan prompt with AWS Comprehend for PII (names, NI numbers, dates of birth, bank details, NHS numbers). Block + log if confidence > threshold. Return "Sensitive data detected" to user.
- [ ] **Output guardrail** in FastAPI: regex-strip common PII patterns from model response before returning. Log full audit record (timestamp, user session, matched patterns if any).
- [ ] CloudWatch log group `/secure-llm/audit` — structured JSON per request
- [ ] UI: show "Guardrail active" badge so demo audience can see it

### Phase 4 — Portfolio / commercial
- [ ] Add to grahamveitch.com project page (copy already written)
- [ ] Demo walkthrough video: Start → boot checklist → chat → guardrail trigger
- [ ] Pricing model: per-seat SaaS or on-prem deployment fee

## Tech stack

| Layer | Tech |
|-------|------|
| Infra | AWS CDK (TypeScript), 5 stacks, eu-west-2 |
| Compute | EC2 t3.large (CPU smoke test) → g4dn.xlarge (GPU, pending quota) |
| Model runtime | Ollama (llama3:8b) |
| Gateway | FastAPI + uvicorn on EC2 |
| Orchestration | Two Lambdas (orchestrator outside VPC, proxy inside VPC) |
| Frontend | React + Vite → CloudFront + S3 |
| Model cache | S3 (gv-ml-assets-313753089884, prefix secure-llm/ollama/) |
| PII detection | AWS Comprehend (Phase 3) |
| Audit logging | CloudWatch Logs (Phase 3) |

## Live endpoints

- Frontend: https://securellm.grahamveitch.com
- API: https://yktpme09qf.execute-api.eu-west-2.amazonaws.com/prod
- API key: in SSM `/secure-llm/api-key`

## Security story (for demo/pitch)

1. EC2 SG: inbound only from Lambda SG on :8000. No internet inbound.
2. EC2 egress: 443 only. S3 via VPC gateway endpoint (free, no internet).
3. No SSH. SSM only (auditable, no key management).
4. API key at API Gateway + FastAPI.
5. (Phase 3) Input guardrail blocks PII before it reaches the model.
6. (Phase 3) Full audit trail in CloudWatch.

**One-liner:** "The model runs in your VPC. The guardrail stops sensitive data reaching it. You get an audit log of everything."
