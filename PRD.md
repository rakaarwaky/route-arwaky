# PRD — AISIX OSS

> Product Requirements. Describes WHAT this project does and WHY. Real condition lives in ROADMAP.md.

## Project Overview

A platform team running LLM-backed products integrates every model vendor separately:
one SDK per provider, per-provider auth, rate limiting, caching, and telemetry, with no
single place to govern traffic or fail over between vendors.

AISIX OSS is the open-source, Rust-native AI gateway that puts one OpenAI-compatible API
in front of every model. Platform engineers, AI-agent builders, and API teams route,
govern, secure, cache, and observe all their LLM and AI-agent traffic from a single
control point, shipped as one static binary that runs in their own infrastructure for
free, forever. Without it, every new provider multiplies integration and governance work,
and a provider outage becomes an application incident instead of a routing decision.

## Goals

- One OpenAI-compatible API in front of every LLM provider, with native SSE streaming.
- One place to route, govern, secure, cache, and observe LLM and AI-agent traffic.
- Runs in the user's infrastructure as a single static binary, free forever (Apache-2.0).

## Non-Goals

- Hosting AI traffic: the gateway runs in the user's environment and calls providers directly.
- Redesigning individual language linters or provider SDKs — their native tools stay owned by each project.
- A hosted dashboard or control plane in this repo: AISIX Enterprise and AISIX Cloud ship those commercially; this repo is the open-source data plane.
- Persistent scan history or network services beyond the gateway's own listeners.

## Target Users

| Persona | Need | Current Pain | Desired Outcome |
|---------|------|--------------|-----------------|
| Platform engineer | One control point for routing, limits, guardrails, caching, and telemetry across providers | Per-provider integration and governance duplicated in every service | One gateway binary that centralizes controls without a control plane |
| Application developer | A stable OpenAI-shaped API to call any model | SDK and wire-format differences per vendor | Point an OpenAI SDK at one base URL and switch models without code changes |
| Security engineer | Content policies and inbound auth enforced before traffic reaches providers | Ad-hoc content filtering and key handling per application | Guardrails, caller keys, and OIDC/JWT auth enforced at the gateway |
| Operations engineer | Hot config reloads and multi-replica configuration sharing | Restarts to apply config; drift between replicas | Declarative resources reloaded on SIGHUP, or etcd for a cluster |

## Scope

### In Scope

- An OpenAI-compatible proxy surface covering chat, completions, responses, embeddings,
  rerank, images, audio, videos, files, batches, fine-tuning, and realtime endpoints.
- Routing and failover across upstream targets with weighted, hash-affinity, and
  metric-based strategies; ensemble and semantic (embedding-similarity) routing.
- Rate and token limiting with local or Redis-shared counters; exact-match response
  caching with memory and Redis backends.
- Guardrails: content policies on input and output, in-process or provider-backed.
- Inbound authentication: caller API keys and OIDC/JWT bearer tokens.
- Declarative configuration: one resources file reloaded on SIGHUP, or etcd for a
  multi-replica cluster; offline validation of a resources file.
- Observability: Prometheus metrics, access logs, usage events, OTLP/GenAI span export,
  dedicated log exporters, and object-storage telemetry.
- A read-only admin resource surface with OpenAPI 3, a Scalar UI, and a playground.

### Out of Scope

- A hosted control plane, dashboard, billing, budgets, RBAC, or organization management — commercial products carry those.
- Storing plaintext provider credentials at rest in this repo's surfaces.
- Model training, fine-tuning infrastructure, or inference serving.
- IDE plugins or editor integrations; hot-reloading configuration outside the declared reload paths.

---

## Project Requirements

### PR-ASX-001: aisix-admin

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Operations engineer | a read-only admin surface with OpenAPI 3 and a playground | I can inspect resources and try the gateway without write endpoints | P0 |

#### Proposed Solution

Serve a read-only admin listener with resource views, generated OpenAPI 3 plus a Scalar
UI, a playground, health/status endpoints, and the etcd/file stores that back them.

#### Main User Flow

1. The operator enables the admin listener and opens the UI.
2. The operator inspects resources, schema, and status without mutating state.
3. The operator tries a prompt in the playground against the live gateway.

### PR-ASX-002: aisix-cache

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Platform engineer | exact-match response caching with memory and Redis backends | repeated prompts stop paying provider cost and latency | P0 |

#### Proposed Solution

Cache responses with per-policy TTL and model/key scope matchers, memory or Redis
backends, and cost-saved telemetry on every hit.

#### Main User Flow

1. A cache policy declares TTL and scope matchers.
2. A repeated request matches the policy and is served from the backend.
3. Telemetry records the saved cost and the hit.

### PR-ASX-003: aisix-core

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Platform engineer | one resource model and schema definition for every configuration document | all surfaces read and validate the same resources identically | P0 |

#### Proposed Solution

Define resource models with generated JSON Schemas, snapshot/config-status projection,
lenient-read strict-write semantics, and shared errors used by every other capability.

#### Main User Flow

1. A resource document is read from a config source.
2. The model projects it into a validated snapshot and reports partial compatibility.
3. The serving surface reads the snapshot lock-free.

### PR-ASX-004: aisix-etcd

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Operations engineer | configuration from etcd or a resources file with watch and hot reload | a multi-replica cluster shares one configuration without restarts | P0 |

#### Proposed Solution

Provide etcd and resources-file config sources with a watch supervisor, SIGHUP reloads,
and heartbeat reporting of gateway versions and compatibility.

#### Main User Flow

1. The gateway starts against etcd or a resources file.
2. A configuration change is watched (or reloaded on SIGHUP) and applied live.
3. The heartbeat reports versions so a control plane can gate projections.

### PR-ASX-005: aisix-gateway

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Application developer | a single hub that bridges the OpenAI wire format to any upstream adapter | one client integration reaches every provider | P0 |

#### Proposed Solution

Implement the hub & bridge, the SSE parser, and the upstream provider trait that every
adapter implements, keeping the client-facing API OpenAI-shaped.

#### Main User Flow

1. A request arrives on the proxy surface in OpenAI shape.
2. The hub selects the target provider and bridges the wire format.
3. The response (or SSE stream) is translated back to OpenAI shape.

### PR-ASX-006: aisix-guardrails

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Security engineer | content policies enforced on input and output at the gateway | policy violations never reach the provider or the user | P0 |

#### Proposed Solution

Enforce pre-input and post-output policies in-process or through providers —
keyword/regex, PII detection and redaction, Presidio, Lakera, OpenAI Moderation, and
custom scripting hooks — returning a content-filter error on block, with a monitor mode.

#### Main User Flow

1. A guardrail policy is declared and bound to a model or route.
2. Each request (and response) is evaluated against the policy.
3. A violation blocks with a content-filter error, or is recorded in monitor mode.

### PR-ASX-007: aisix-obs

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Operations engineer | metrics, logs, usage events, and trace export from one place | gateway behavior is observable in the existing monitoring stack | P0 |

#### Proposed Solution

Expose Prometheus metrics, structured access logs, usage events, OTLP/GenAI span export,
dedicated Datadog and Aliyun SLS log exporters, and object-storage telemetry.

#### Main User Flow

1. The operator configures exporters in the observability section.
2. The gateway emits metrics, logs, and spans per request.
3. The operator's dashboards and alerts consume the exported signals.

### PR-ASX-008: aisix-provider-openai

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Application developer | one adapter family reaching OpenAI and every OpenAI-compatible vendor | new vendors need no new client code | P0 |

#### Proposed Solution

Implement the OpenAI wire-protocol bridge with bearer auth, vendor-quirk handling, and
dedicated rerank/embeddings vendor support.

#### Main User Flow

1. A provider key targets an OpenAI-compatible endpoint.
2. The adapter translates the gateway request to the vendor wire shape.
3. The vendor response is normalized back to the gateway contract.

### PR-ASX-009: aisix-proxy

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Application developer | the full OpenAI endpoint family served by one gateway | every client surface works through one base URL | P0 |

#### Proposed Solution

Implement the `/v1/*` handler families (chat, completions, responses, embeddings, rerank,
images, audio, videos, files, batches, fine-tuning, realtime), routing, middleware, and
per-request telemetry in lockstep across handler families.

#### Main User Flow

1. The client sends an OpenAI-shaped request to the proxy listener.
2. Routing, auth, limits, guardrails, and cache apply in order.
3. The handler family serves the request and emits telemetry.

### PR-ASX-010: aisix-ratelimit

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Platform engineer | request, token, and concurrency limits combined across callers and models | no single caller or model can exhaust capacity | P0 |

#### Proposed Solution

Enforce RPS/RPM/RPH/RPD, TPM/TPD, and concurrency caps AND-combined across caller keys,
models, and policy scopes, with per-process or Redis-shared counters.

#### Main User Flow

1. A rate-limit policy declares its limits and scope.
2. Each request is checked against every applicable counter.
3. Over-limit requests are rejected with a rate-limit error.

### PR-ASX-011: aisix-redis

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Operations engineer | a shared Redis connection for cache and rate limits | distributed backends share one pool without duplicated configuration | P0 |

#### Proposed Solution

Provide the shared Redis connection pool consumed by the cache and rate-limit backends.

#### Main User Flow

1. The operator configures the Redis endpoint once.
2. The cache and rate-limit backends share the pool.
3. Counters and cached responses stay consistent across replicas.

### PR-ASX-012: aisix-server

#### User Stories

| As a | I want | So that | Priority |
|------|--------|---------|----------|
| Operations engineer | one static binary that bootstraps listeners and wires every capability | deployment is a single artifact with no runtime dependencies | P0 |

#### Proposed Solution

Build the `aisix` binary: bootstrap, listeners, CLI, offline validation of a resources
file, and config export, wiring every other capability together.

#### Main User Flow

1. The operator starts the binary with a config file.
2. The server bootstraps listeners and loads configuration.
3. The gateway serves traffic and reports status.

## Reference

| Artifact     | Purpose                                          | Link                               |
|--------------|--------------------------------------------------|------------------------------------|
| PRD          | Business goals, user stories, and scope          | [PRD.md](PRD.md)                   |
| Roadmap      | Timeline, phasing, and dependencies              | [ROADMAP.md](ROADMAP.md)           |
| Architecture | System boundaries, tech stack, and infra         | [ARCHITECTURE.md](ARCHITECTURE.md) |
