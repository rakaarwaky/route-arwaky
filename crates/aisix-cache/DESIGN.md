# DESIGN — cache

## Design Overview

aisix-cache provides response and semantic caching for the proxy: memory and Redis backends sit behind the `Cache` and `SemanticCacheStore` traits, and the cache key and response value objects are defined as taxonomy types shared with the pipeline.

## Design Requirements

### DS-CACHE-001: Define cache taxonomy

| Variant | Use case | Token | Value|
|---------|----------|-------|-------|
| Memory  | Fast per-process response reuse       | `AISIX_CACHE_MEMORY_MAX` | entry cap |
| Redis   | Shared cache across proxy replicas    | `AISIX_CACHE_REDIS_URL` | connection URL |

### DS-CACHE-002: Provide memory backend

Offer a per-process in-memory backend implementing the `Cache` trait for low-latency response reuse.

### DS-CACHE-003: Provide Redis backend

Offer a shared Redis backend implementing the `Cache` trait for cross-replica response reuse.

### DS-CACHE-004: Provide semantic cache

Serve embedding-based semantic cache hits through `surface_semantic_cache_store` for prompt-level reuse.

### DS-CACHE-005: Provide semantic Redis backend

Persist semantic cache embeddings in Redis through `surface_semantic_redis_store` for shared semantic hits.

### DS-CACHE-006: Keep backends behind traits

Expose only the `Cache` and `SemanticCacheStore` trait seams to consumers so backends stay swappable.

## Reference

| Artifact     | Purpose                                          | Link|
|--------------|--------------------------------------------------|------|
| PRD          | Business goals, user stories, and scope          | [PRD.md](PRD.md)|
| Backlog      | Task tracking, epics, and implementation status  | [BACKLOG.md](BACKLOG.md)|
| Roadmap      | Timeline, phasing, and dependencies              | [ROADMAP.md](ROADMAP.md)|
| Architecture | System boundaries, tech stack, and infra         | [ARCHITECTURE.md](ARCHITECTURE.md)|
