---
trigger: always
description: "AISIX OSS operational guide."
---
# AGENTS — AISIX OSS

## Agent Overview

AI agents working in this workspace must know the AES 7-layer architecture contract, the pinned Rust toolchain (edition 2024 via `rust-toolchain.toml`), the handler-family lockstep rule, and the exact CI gates before generating code, docs, or suggestions. ARCHITECTURE.md wins on ambiguity, and the extended behavioral guidelines live in [docs/AGENT_GUIDELINES.md](docs/AGENT_GUIDELINES.md).

## Runtime

| Aspect          | Detail                                          |
|-----------------|-------------------------------------------------|
| Language        | Rust edition 2024 via rust-toolchain.toml       |
| Environment     | cargo workspace under crates/                   |
| Artifacts       | target/ and the aisix static binary             |
| Package Manager | cargo, with Cargo.lock                          |
| Version Probe   | `rustc --version`                               |
| Setup           | `CARGO_INCREMENTAL=0 cargo build --release`     |
| Activation      | None                                            |

## Project Structure

```text
.
├── crates/                            # Rust workspace crates
│   ├── aisix-admin/                   # admin API surface: handlers, OpenAPI, stores
│   ├── aisix-cache/                   # response + semantic caching backends
│   ├── aisix-core/                    # resource models, schemas, config status
│   ├── aisix-etcd/                    # etcd client, config source, supervisor
│   ├── aisix-gateway/                 # gateway assembly and serving bootstrap
│   ├── aisix-guardrails/              # request/response guardrail plugins
│   ├── aisix-obs/                     # metrics, tracing, telemetry export
│   ├── aisix-provider-openai/         # upstream OpenAI-compatible provider adapter
│   ├── aisix-proxy/                   # endpoint handler families (chat, responses, ...)
│   ├── aisix-ratelimit/               # rate and token limiting
│   ├── aisix-redis/                   # redis-backed distributed state
│   ├── aisix-server/                  # binary entry: config, listeners, export
│   └── shared/                        # shared layer: contracts, VO, utility, templates
├── docs/                              # supporting documents (agent guidelines, notes)
├── schemas/                           # generated JSON Schemas for resources
├── tests/                             # E2E suite asserting wire-level behavior
└── AGENTS.md                          # this file
```

## Commands

| Category    | Command                                    | Scope      | CI Gate                    |
|-------------|--------------------------------------------|------------|----------------------------|
| Test (all)  | `cargo test --workspace`                   | All        | ci.yml: rust-unit          |
| Test (unit) | `cargo test -p <crate>`                    | One unit   | ci.yml: rust-unit          |
| Test (file) | `cargo test -p <crate> <test_name>`        | One file   | ci.yml: rust-unit          |
| Lint        | `cargo clippy --workspace -- -D warnings`  | All        | ci.yml: lint               |
| Type Check  | `cargo check --workspace --all-targets`    | All        | ci.yml: build-bin          |
| Arch Scan   | `lint-arwaky-cli scan .`                   | All        | ci.yml: lint               |

## Reference

| Artifact     | Purpose                                    | Link                        |
|--------------|--------------------------------------------|-----------------------------|
| README       | What the tool does, every command, install | [README.md](README.md)      |
| CONTRIBUTING | Branch, commit, and PR conventions         | [CONTRIBUTING.md](CONTRIBUTING.md) |
| ARCHITECTURE | Layer contract for every crate             | [ARCHITECTURE.md](ARCHITECTURE.md) |
| ROADMAP      | What ships next, in order                  | [ROADMAP.md](ROADMAP.md)    |
| PRD          | What the product does and why              | [PRD.md](PRD.md)            |
