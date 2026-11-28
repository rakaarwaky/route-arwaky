# CONTRIBUTING — AISIX OSS

## Contribution Overview

Contribute to AISIX OSS — the open-source, Rust-native AI gateway — through bug reports,
feature requests, docs fixes, and code. "Ready to merge" means: all local gates pass
(`cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`,
generated-artifact checks), every change is covered by tests that assert observable
gateway behavior, commits follow Conventional Commits, and the PR description names what
changed and any behavior shift.

## Contribution Guidelines

- **Report bugs and request features** through a
  [GitHub issue](https://github.com/api7/aisix/issues). For bugs, include the gateway
  version (`aisix --version`), your config shape (redact secrets), and a minimal
  reproduction.
- **Ask questions and float ideas** on
  [Discord](https://discord.gg/dUmRZ7Rvf); rough ideas are welcome there before they
  harden into an issue. See [ROADMAP.md](ROADMAP.md) for where the project is headed.
- **Prerequisites**: the Rust toolchain pinned in `rust-toolchain.toml`, plus Docker (for
  etcd).

  ```bash
  cargo check --workspace
  cargo fmt --check
  cargo clippy --workspace -- -D warnings
  cargo test --workspace

  # Run locally (needs a reachable etcd + a config.yaml — see the docs quickstart)
  cargo run -p aisix-server --bin aisix -- --config config.yaml
  ```

  CI enforces `fmt`, `clippy -D warnings`, unit tests with a coverage gate, the E2E suite,
  and two generated-artifact checks: the resource JSON Schemas in `schemas/` must be
  regenerated (`cargo run -p aisix-core --bin dump-schema`) and committed when the
  resource structs change — CI fails on drift — and the Admin API OpenAPI document
  (generated at build time, not committed) must still build and pass its structural checks
  (`cargo run -p aisix-admin --bin dump-openapi`).
- **Making changes**: fork and create a topic branch from `main`; keep PRs small and
  focused — one logical change per PR; add or update tests for what you change (E2E tests
  live in `tests/` and assert observable gateway behavior — wire-level requests and
  responses — not implementation details); make sure the checks above pass locally before
  pushing.

### Changing resource models: unknown fields vs. new enum values

The gateway reads its resources leniently from etcd and strictly on write (issue #871).
That split makes two kinds of schema change behave very differently on a gateway older
than the one you are changing, and each needs a different discipline:

- **Adding a field** is the safe, expected change, at any depth of any resource — as long
  as the Rust field is optional or carries a serde default, since a field the current
  build requires kills every stored row written before it
  ([docs/AGENT_GUIDELINES.md](docs/AGENT_GUIDELINES.md)). An older gateway loads the
  document with the new field ignored and reports it as partially compatible
  (`GET /status/config` `partially_compatible[]`, the heartbeat, and the
  `aisix_config_partially_compatible_resources` metric). Never assume a new field is
  enforced fleet-wide until every data plane runs a version that knows it — this matters
  most for restriction-type fields (an old gateway keeps allowing what the new field would
  forbid).
- **Adding an enum value** (a routing strategy, an adapter, a guardrail `kind`, …) is NOT
  forward compatible, by design: a value the gateway cannot interpret has no old behavior
  to fall back to, so the whole document stays rejected on older versions. Do not "fix"
  that by opening the enum, and do not add a `#[serde(other)]` fallback for a value that
  selects serving behavior — silently running a different routing strategy than configured
  is worse than rejecting the document. Behind a control plane the rollout decision is not
  made here — it refuses to save a projection the gateways registered against it cannot
  load, using the versions the heartbeat already reports. Nothing checks it on the paths
  that bypass a control plane (a resources file, a direct etcd put) or in an environment
  with no gateway registered yet: there an older gateway simply rejects the row into
  `rejected[]`, which for a genuinely new capability is the correct outcome.

Which releases a change has to stay loadable on is set by the support floor — see the
projection rule in [docs/AGENT_GUIDELINES.md](docs/AGENT_GUIDELINES.md).

## Workflow

| Step | Action | Detail |
|------|--------|--------|
| 1 | Fork / Branch | topic branch cut from `main`, one logical change per PR |
| 2 | Implement | Follow the spec, write tests first in `tests/` |
| 3 | Self-review | Check the acceptance criteria in [PRD.md](PRD.md) and run the local gates |
| 4 | Submit PR | Describe what changed, name any behavior change explicitly |
| 5 | Review | Independent audit of correctness, reliability, security, and E2E coverage; CI green |
| 6 | Merge | Squash-merge the PR into `main`; the PR title becomes the commit subject |

## Commit Convention

Commit subjects follow Conventional Commits, matching the existing history:

```
<type>(<scope>): <imperative summary>
```

with scopes like `routing`, `guardrails`, `mcp`, `obs`. Mark breaking changes with a `!`
after the scope (e.g. `refactor(routing)!: ...`). PRs are squash-merged, so the PR title
should follow the same convention — it becomes the commit subject on `main`.

| Type | Usage | Example |
|------|-------|---------|
| `feat` | New feature | `feat(routing): add least-busy strategy` |
| `fix` | Bug fix | `fix(guardrails): handle expired policy` |
| `docs` | Documentation only | `docs(roadmap): update provider parity` |
| `test` | Adding/updating tests | `test(proxy): add streaming edge case` |
| `refactor` | Code refactor, no behaviour change | `refactor(routing): extract middleware` |
| `chore` | Maintenance, deps, config | `chore: bump dependencies` |

## Reference

| Artifact | Purpose | Link |
|----------|---------|------|
| PRD | Business goals, user stories, and scope | [PRD.md](PRD.md) |
| Architecture | System boundaries, tech stack, and infra | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Agent guidelines | Extended behavioral rules for agents and reviewers | [docs/AGENT_GUIDELINES.md](docs/AGENT_GUIDELINES.md) |

### License

AISIX is licensed under [Apache 2.0](LICENSE). By contributing, you agree that your
contributions are licensed under the same terms.
