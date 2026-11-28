# BACKLOG — proxy

## Progress Overview

The layer rename was fully applied across the pipeline including the realtime ASR component path wiring and the cross-crate taxonomy imports; the crate compiles clean against core, gateway, guardrails, cache, and obs. Remaining work tracks the workspace-wide quality sweep and the relocation of the misplaced taxonomy and utility files.

## Backlog Status

### DS-PROXY-001: Route provider requests

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Layer prefixes applied and the lint gate reports no naming or import findings for this crate |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-PROXY-002: Authenticate callers

| Aspect       | Detail |
|--------------|--------|
| State        | Done |
| Done         | Module references updated and the workspace compile passes |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-PROXY-003: Enforce budget and quota

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-PROXY-004: Integrate guardrails

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-PROXY-005: Stream responses

| Aspect       | Detail |
|--------------|--------|
| State        | Ready |
| Done         | None |
| In Progress  | None |
| Risk         | None |
| Updated      | 2026-11-28 |

### DS-PROXY-006: Map proxy errors

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
