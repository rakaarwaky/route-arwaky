# DESIGN — admin

## Design Overview

aisix-admin is the control-plane admin HTTP API of the gateway: it serves the `/admin/*` surface with model, API key, provider key, guardrail, cache policy, and observability-exporter CRUD, backs those resources with etcd and file stores, and publishes the generated OpenAPI document for the whole admin surface.

## Design Requirements

### DS-ADMIN-001: Route admin CRUD

| Variant | Use case | Token | Value|
|---------|----------|-------|-------|
| HTTP    | Manage admin resources over the `/admin/*` API | `AISIX_ADMIN_BIND` | `0.0.0.0:9090` |
| File    | Dump the OpenAPI document to stdout            | `aisix dump-openapi` | CLI subcommand |

### DS-ADMIN-002: Store configuration

Back every admin resource with the etcd or file store seam so controllers never touch storage clients directly.

### DS-ADMIN-003: Publish OpenAPI

Emit the generated OpenAPI document from `surface_openapi_router` and keep the `dump-openapi` entry point in sync with it.

### DS-ADMIN-004: Validate payloads

Normalize and validate admin request payloads before they reach the store seam, mapping failures to the admin error view.

### DS-ADMIN-005: Expose health

Serve the health and playground endpoints from dedicated controller modules without importing the proxy pipeline.

### DS-ADMIN-006: Keep controllers thin

Hold routing and shaping only in `surface_*_controller` modules and push persistence into `surface_*_store` modules.

## Reference

| Artifact     | Purpose                                          | Link|
|--------------|--------------------------------------------------|------|
| PRD          | Business goals, user stories, and scope          | [PRD.md](PRD.md)|
| Backlog      | Task tracking, epics, and implementation status  | [BACKLOG.md](BACKLOG.md)|
| Roadmap      | Timeline, phasing, and dependencies              | [ROADMAP.md](ROADMAP.md)|
| Architecture | System boundaries, tech stack, and infra         | [ARCHITECTURE.md](ARCHITECTURE.md)|
