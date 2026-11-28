# DESIGN — server

## Design Overview

aisix-server is the binary entry point of the gateway: it boots configuration, the etcd supervisor, the proxy, the admin API, and telemetry into one process, provisions managed TLS certificates, and owns the `aisix export` subcommand pipeline.

## Design Requirements

### DS-SERVER-001: Load configuration

| Variant | Use case | Token | Value|
|---------|----------|-------|-------|
| Serve   | Boot the full gateway process            | `aisix serve` | default mode |
| Export  | Emit recorded traffic offline            | `aisix export` | subcommand |

### DS-SERVER-002: Supervise etcd

Start and supervise the etcd-backed store so admin and proxy share one configuration source.

### DS-SERVER-003: Wire the process

Compose proxy, admin, and telemetry into one process with `main.rs` holding wiring only.

### DS-SERVER-004: Provision certificates

Provision and refresh managed TLS certificate bundles through `surface_cert_bundle_store` and the managed bundle filesystem.

### DS-SERVER-005: Export traffic

Provide the `aisix export` subcommand pipeline for offline traffic export.

### DS-SERVER-006: Report liveness

Emit heartbeat and telemetry control-plane links so the process reports liveness to the operator.

## Reference

| Artifact     | Purpose                                          | Link|
|--------------|--------------------------------------------------|------|
| PRD          | Business goals, user stories, and scope          | [PRD.md](PRD.md)|
| Backlog      | Task tracking, epics, and implementation status  | [BACKLOG.md](BACKLOG.md)|
| Roadmap      | Timeline, phasing, and dependencies              | [ROADMAP.md](ROADMAP.md)|
| Architecture | System boundaries, tech stack, and infra         | [ARCHITECTURE.md](ARCHITECTURE.md)|
