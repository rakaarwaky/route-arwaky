# DESIGN — obs

## Design Overview

aisix-obs is the observability crate of the gateway: it hosts the Prometheus metric registry, access logs and GenAI views, tracing export, the OTLP, Datadog, and SLS sinks, and the usage accounting events shared by the proxy and server processes.

## Design Requirements

### DS-OBS-001: Register Prometheus metrics

| Variant | Use case | Token | Value|
|---------|----------|-------|-------|
| Prometheus | Scrape runtime metrics per process        | `AISIX_OBS_METRICS_PATH` | `/metrics` |
| OTLP       | Export traces and spans to an OTLP sink   | `AISIX_OBS_OTLP_ENDPOINT` | collector URL |

### DS-OBS-002: Shape access logs

Render request access logs through `surface_access_log_view` with stable field ordering.

### DS-OBS-003: Shape GenAI views

Map provider interactions onto GenAI semantic conventions in `surface_genai_view`.

### DS-OBS-004: Export sinks

Ship telemetry to the object-store, OTLP, Datadog, and SLS sinks with truncation applied before export.

### DS-OBS-005: Account usage

Emit usage accounting events through `surface_usage_controller` and `surface_usage_delivery_action`.

### DS-OBS-006: Export tracing

Propagate tracing spans alongside metrics so a request is traceable end to end.

## Reference

| Artifact     | Purpose                                          | Link|
|--------------|--------------------------------------------------|------|
| PRD          | Business goals, user stories, and scope          | [PRD.md](PRD.md)|
| Backlog      | Task tracking, epics, and implementation status  | [BACKLOG.md](BACKLOG.md)|
| Roadmap      | Timeline, phasing, and dependencies              | [ROADMAP.md](ROADMAP.md)|
| Architecture | System boundaries, tech stack, and infra         | [ARCHITECTURE.md](ARCHITECTURE.md)|
