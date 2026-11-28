# DESIGN — guardrails

## Design Overview

aisix-guardrails is the safety layer of the gateway: keyword, PII, presidio, moderation, and custom guardrails compose into a chain that `surface_guardrail_chain_router` routes per request, with guardrail call failures expressed through the taxonomy error VO.

## Design Requirements

### DS-GUARDRAILS-001: Compose the chain

| Variant | Use case | Token | Value|
|---------|----------|-------|-------|
| Keyword    | Block or flag requests by keyword match        | `AISIX_GR_KEYWORD` | rule set |
| Presidio   | Detect personal data in request payloads       | `AISIX_GR_PRESIDIO` | analyzer endpoint |

### DS-GUARDRAILS-002: Run keyword guard

Match request payloads against configured keyword rules and flag or block on hit.

### DS-GUARDRAILS-003: Detect personal data

Detect personal data through the PII and presidio guards before a request reaches a provider.

### DS-GUARDRAILS-004: Apply moderation

Route request content through the moderation guard and surface its verdicts as guardrail outcomes.

### DS-GUARDRAILS-005: Support custom guards

Let operators register custom guardrail actions that slot into the same chain without special-casing.

### DS-GUARDRAILS-006: Express call failures

Express guardrail call failures through `taxonomy_guardrail_call_error_vo` so callers see one error shape.

## Reference

| Artifact     | Purpose                                          | Link|
|--------------|--------------------------------------------------|------|
| PRD          | Business goals, user stories, and scope          | [PRD.md](PRD.md)|
| Backlog      | Task tracking, epics, and implementation status  | [BACKLOG.md](BACKLOG.md)|
| Roadmap      | Timeline, phasing, and dependencies              | [ROADMAP.md](ROADMAP.md)|
| Architecture | System boundaries, tech stack, and infra         | [ARCHITECTURE.md](ARCHITECTURE.md)|
