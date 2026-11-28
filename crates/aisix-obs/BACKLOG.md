# BACKLOG — obs

## Progress Overview

External-crate references were untangled from the layer rename and the metric, log, sink, and usage modules carry their surface prefixes; the crate compiles clean and both the proxy and the server consume it. Remaining work tracks the workspace-wide quality sweep and the relocation of the sink helper files.

## Backlog Status

### DS-OBS-001: Register Prometheus metrics

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Layer prefixes applied and the lint gate reports no naming or import findings for this crate |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-OBS-002: Shape access logs

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Module references updated and the workspace compile passes |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-OBS-003: Shape GenAI views

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-OBS-004: Export sinks

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-OBS-005: Account usage

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-OBS-006: Export tracing

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

## Reference

| Artifact     | Purpose                                    | Link |
|--------------|--------------------------------------------|------|
| PRD          | Business goals and scope                   | [PRD.md](PRD.md) |
| FRD          | Functional requirements specification      | [FRD.md](FRD.md) |
| Design       | Design requirements and decisions          | [DESIGN.md](DESIGN.md) |
| Roadmap      | Timeline, phasing, and dependencies        | [ROADMAP.md](ROADMAP.md) |
| Architecture | System boundaries, tech stack, and infra   | [ARCHITECTURE.md](ARCHITECTURE.md) |
