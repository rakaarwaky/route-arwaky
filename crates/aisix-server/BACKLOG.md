# BACKLOG — server

## Progress Overview

The entry point and its wired modules were renamed to their layer prefixes and the `dump-schema` binary entry was registered for CI; the crate compiles clean. Remaining work tracks the workspace-wide quality sweep and the relocation of the export helper files.

## Backlog Status

### DS-SERVER-001: Load configuration

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Layer prefixes applied and the lint gate reports no naming or import findings for this crate |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-SERVER-002: Supervise etcd

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Module references updated and the workspace compile passes |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-SERVER-003: Wire the process

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-SERVER-004: Provision certificates

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-SERVER-005: Export traffic

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-SERVER-006: Report liveness

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
