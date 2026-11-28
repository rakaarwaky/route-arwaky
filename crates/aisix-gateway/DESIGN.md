# DESIGN — gateway

## Design Overview

aisix-gateway owns upstream I/O for the LLM proxy: connection pooling, TLS, DNS and URL caching, retry policy, and stream bridging between the proxy pipeline and provider HTTP APIs, with the chat and content-part wire VOs in the taxonomy layer.

## Design Requirements

### DS-GATEWAY-001: Define wire taxonomy

| Variant | Use case | Token | Value|
|---------|----------|-------|-------|
| Pooled  | Reuse upstream HTTP connections per provider | `AISIX_GW_POOL_SIZE` | pool cap |
| Cached  | Resolve provider hosts through the DNS cache  | `AISIX_GW_DNS_TTL`   | TTL seconds |

### DS-GATEWAY-002: Pool upstream connections

Reuse pooled HTTP connections per provider through `surface_upstream_http_controller` to cut handshake cost.

### DS-GATEWAY-003: Terminate TLS upstream

Establish provider TLS through `surface_upstream_tls_component` with certificate handling isolated from routing.

### DS-GATEWAY-004: Cache DNS and URLs

Resolve provider hosts and endpoints through `surface_dns_cache_store` and `surface_url_cache_store` with bounded TTLs.

### DS-GATEWAY-005: Retry transient failures

Apply retry policy for transient upstream failures before surfacing errors to the proxy pipeline.

### DS-GATEWAY-006: Bridge streams

Bridge request and response streams through `surface_bridge_controller`, shaping tool calls and structured output on the way through.

## Reference

| Artifact     | Purpose                                          | Link|
|--------------|--------------------------------------------------|------|
| PRD          | Business goals, user stories, and scope          | [PRD.md](PRD.md)|
| Backlog      | Task tracking, epics, and implementation status  | [BACKLOG.md](BACKLOG.md)|
| Roadmap      | Timeline, phasing, and dependencies              | [ROADMAP.md](ROADMAP.md)|
| Architecture | System boundaries, tech stack, and infra         | [ARCHITECTURE.md](ARCHITECTURE.md)|
