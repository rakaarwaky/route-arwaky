# BACKLOG — gateway

## Progress Overview

Wire VOs were moved to taxonomy prefixes and the transport, caching, and bridging modules carry their surface prefixes; the crate compiles clean and the proxy drives it through the bridge and upstream controllers. Remaining work tracks the workspace-wide quality sweep and the relocation of the two misplaced taxonomy files.

## Backlog Status

### DS-GATEWAY-001: Define wire taxonomy

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Layer prefixes applied and the lint gate reports no naming or import findings for this crate |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-GATEWAY-002: Pool upstream connections

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Module references updated and the workspace compile passes |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-GATEWAY-003: Terminate TLS upstream

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-GATEWAY-004: Cache DNS and URLs

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-GATEWAY-005: Retry transient failures

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-GATEWAY-006: Bridge streams

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
