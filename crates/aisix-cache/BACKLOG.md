# BACKLOG — cache

## Progress Overview

Cache keys and response VOs moved into the taxonomy layer and the memory, Redis, and semantic backends were renamed to their surface prefixes; the crate compiles clean and the proxy consumes it through the trait seams. Remaining work tracks the workspace-wide quality sweep only.

## Backlog Status

### DS-CACHE-001: Define cache taxonomy

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Layer prefixes applied and the lint gate reports no naming or import findings for this crate |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-CACHE-002: Provide memory backend

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Module references updated and the workspace compile passes |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-CACHE-003: Provide Redis backend

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-CACHE-004: Provide semantic cache

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-CACHE-005: Provide semantic Redis backend

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-CACHE-006: Keep backends behind traits

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
