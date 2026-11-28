# ROADMAP — AISIX OSS

## Progress Overview

The AISIX OSS gateway is generally available as a single static Rust binary: one
OpenAI-compatible proxy API in front of every model, with routing & failover, ensemble and
semantic routing, rate limiting, guardrails, caching, inbound auth (caller API keys and
OIDC/JWT), declarative `resources.yaml` or etcd configuration, and observability export.
This page lists capabilities that are planned or in progress but not yet generally
available. It shows direction, not dates, and is not a delivery commitment. For what the
gateway does today — including semantic routing, ensemble models, caching, and guardrails
— see the [AISIX documentation](https://docs.api7.ai/ai-gateway/). Tracked live in
[issues](https://github.com/api7/aisix/issues).

### How to read this page

- **Now** — in active design or development.
- **Next** — planned after the current focus.
- **Later** — on the longer-term horizon.

The **Products** column identifies the products expected to expose the capability. A
shared gateway or control-plane implementation does not imply availability in every
product.

| Capability | What's planned | Products | Horizon |
| --- | --- | --- | --- |
| Additional SSO protocols | Single sign-on through SAML and generic OIDC, beyond today's social logins. | AISIX Enterprise · AISIX Cloud | Now |
| Service accounts | Login-less, first-class principals for automated callers. | AISIX Enterprise · AISIX Cloud | Now |
| Prompt management | Store, version, and reuse prompt templates with variables, resolved at the gateway. | AISIX OSS · AISIX Enterprise · AISIX Cloud | Next |
| Scheduled key rotation | Scheduled auto-rotation of caller keys with a grace overlap, on top of today's manual rotation. | AISIX Enterprise · AISIX Cloud | Next |
| Production-path playground | Run the dashboard playground through a connected AISIX gateway so it reflects real routing, caching, guardrails, and rate limiting. | AISIX Enterprise · AISIX Cloud | Next |
| Cross-provider endpoint parity | Consistent embeddings, image generation, and Responses behavior across more providers. | AISIX OSS · AISIX Enterprise · AISIX Cloud | Next |
| External secret management | Manage provider and API credentials through external KMS and secret stores such as Vault. | AISIX OSS · AISIX Enterprise · AISIX Cloud | Later |
| Expanded observability export | OTLP export for metrics and logs, and alerting integrations such as Slack and PagerDuty. | AISIX OSS · AISIX Enterprise · AISIX Cloud | Later |
| Metered usage billing | Usage-based billing in addition to subscription plans. | AISIX Cloud | Later |
| SDKs and agent-framework integrations | First-party SDKs and integrations with common agent frameworks. | AISIX OSS · AISIX Enterprise · AISIX Cloud | Later |

## Roadmap Status

### PR-ASX-001: aisix-admin

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

Read-only admin resource surface, OpenAPI 3 with a Scalar UI, playground, health and
status handlers, and the etcd/file stores that back them.

### PR-ASX-002: aisix-cache

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

Exact-match response cache with per-policy TTL and model/key scope matchers; memory and
Redis backends with cost-saved telemetry on every hit.

### PR-ASX-003: aisix-core

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

Resource models, JSON Schemas, snapshot/config status, lenient-read strict-write
projection, and shared errors.

### PR-ASX-004: aisix-etcd

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

Config providers (etcd and `resources.yaml`), watch supervisor, and heartbeat reporting.

### PR-ASX-005: aisix-gateway

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

Hub & bridge, SSE parser, and the upstream provider trait that every adapter implements.

### PR-ASX-006: aisix-guardrails

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

Pre-input and post-output content-policy enforcement: keyword/regex, PII detection and
redaction, Presidio, Lakera, OpenAI Moderation, and custom scripting hooks.

### PR-ASX-007: aisix-obs

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

Tracing, Prometheus metrics, access logs, usage events, OTLP/GenAI span export, Datadog
and Aliyun SLS log exporters, and object-storage telemetry.

### PR-ASX-008: aisix-provider-openai

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

The OpenAI wire-protocol bridge reaching OpenAI and every OpenAI-compatible vendor, plus
dedicated rerank/embeddings vendors.

### PR-ASX-009: aisix-proxy

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

The `/v1/*` handler families — chat, responses, embeddings, rerank, images, audio,
videos, files, batches, fine-tuning, realtime — plus routing, middleware, and telemetry.

### PR-ASX-010: aisix-ratelimit

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

RPS/RPM/RPH/RPD, TPM/TPD, and concurrency caps, AND-combined across caller keys, models,
and policy scopes; per-process or Redis-shared counters.

### PR-ASX-011: aisix-redis

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

Shared Redis connection pool for the cache and rate-limit backends.

### PR-ASX-012: aisix-server

| Aspect   | Detail                                              |
|----------|-----------------------------------------------------|
| Priority | P0                                                  |
| State    | Done                                                |
| Backlog  | —                                                   |

The `aisix` binary: bootstrap, listeners, CLI, validation, and config export.

## Reference

| Artifact     | Purpose                                    | Link                               |
|--------------|--------------------------------------------|------------------------------------|
| PRD          | Business goals, user stories, and scope    | [PRD.md](PRD.md)                   |
| Architecture | System boundaries, tech stack, and infra   | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Documentation | What the gateway does today               | [AISIX documentation](https://docs.api7.ai/ai-gateway/) |
| Issues       | Live tracking of planned capabilities      | [github.com/api7/aisix/issues](https://github.com/api7/aisix/issues) |
