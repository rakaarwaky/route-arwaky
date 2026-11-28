# DESIGN — proxy

## Design Overview

aisix-proxy is the request pipeline of the gateway: it routes `/v1/*` requests to provider adapters, authenticates callers, enforces budget and quota, integrates the guardrail chain, streams responses, and maps every failure onto the proxy error taxonomy.

## Design Requirements

### DS-PROXY-001: Route provider requests

| Variant | Use case | Token | Value|
|---------|----------|-------|-------|
| Chat    | Proxy chat completions to a provider     | `AISIX_PROXY_ROUTE_/v1/chat/completions` | adapter |
| Realtime| Bridge realtime ASR sessions             | `AISIX_PROXY_ROUTE_/v1/realtime` | component |

### DS-PROXY-002: Authenticate callers

Authenticate every inbound request before routing so unauthenticated traffic never reaches a provider.

### DS-PROXY-003: Enforce budget and quota

Apply budget and quota checks per caller and short-circuit requests that exceed them.

### DS-PROXY-004: Integrate guardrails

Invoke the guardrail chain per request and treat guardrail outcomes as pipeline decisions.

### DS-PROXY-005: Stream responses

Stream provider responses back to callers, preserving tool calls and structured output shaping.

### DS-PROXY-006: Map proxy errors

Map every pipeline failure onto `taxonomy_proxy_error_vo` and attempt tracking so callers see one error shape.

## Reference

| Artifact     | Purpose                                          | Link|
|--------------|--------------------------------------------------|------|
| PRD          | Business goals, user stories, and scope          | [PRD.md](PRD.md)|
| Backlog      | Task tracking, epics, and implementation status  | [BACKLOG.md](BACKLOG.md)|
| Roadmap      | Timeline, phasing, and dependencies              | [ROADMAP.md](ROADMAP.md)|
| Architecture | System boundaries, tech stack, and infra         | [ARCHITECTURE.md](ARCHITECTURE.md)|
