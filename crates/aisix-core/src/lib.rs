//! aisix-core — primitives shared across every other aisix crate.
//!
//! Four responsibilities:
//! 1. **Config** ([`config::Config`]) — bootstrap YAML/TOML/JSON loader.
//! 2. **Resources** ([`taxonomy_resource_vo::Resource`], [`taxonomy_resource_vo::ResourceEntry`]) — trait
//!    and wrapper for every entity stored in etcd.
//! 3. **Snapshot** ([`taxonomy_snapshot_vo::ResourceTable`], [`taxonomy_snapshot_vo::SnapshotHandle`]) —
//!    lock-free read path via `ArcSwap`, O(1) lookup by id or name.
//! 4. **Errors** ([`taxonomy_core_error_vo::ProxyError`], [`taxonomy_core_error_vo::AdminError`],
//!    [`taxonomy_core_error_vo::BootstrapError`]) — the three error envelopes that show up at
//!    the two HTTP surfaces plus startup.
//!
//! This crate is intentionally framework-agnostic — no axum, no reqwest.
//! `IntoResponse` impls live in `aisix-proxy` / `aisix-admin`.

#![forbid(unsafe_code)]
#![deny(rust_2018_idioms)]

pub mod taxonomy_config_vo;
pub mod taxonomy_config_status_vo;
pub mod taxonomy_core_error_vo;
pub mod surface_forwarded_headers_controller;
pub mod taxonomy_header_template_vo;
pub mod utility_host_match;
pub mod utility_json_helper;
pub mod models;
pub mod taxonomy_resource_vo;
pub mod utility_sched_demotion;
pub mod utility_similarity_math;
mod taxonomy_snapshot_reclaim_vo;
pub mod taxonomy_snapshot_vo;
pub mod utility_build_version;
pub mod utility_wildcard_match;
pub mod utility_session_id;
pub mod utility_sink_truncate;
pub mod utility_credential_fingerprint;
pub mod taxonomy_chat_vo;
pub mod taxonomy_content_part_vo;

pub use taxonomy_config_vo::{
    AdminConfig, AutoDumpConfig, CacheBackend, CacheConfig, ClientTypeRule, Config,
    DebugListenerConfig, EtcdConfig, EtcdTlsConfig, HeapProfilingConfig, HistogramBucketsConfig,
    ManagedConfig, ObservabilityConfig, ProxyConfig, ProxyListener, RateLimitBackend,
    RateLimitConfig, RealIpConfig, RedisConnConfig, RedisMode, RequestIdConfig, TlsConfig,
    UrlRewriteRule, CREDENTIAL_HEADERS,
};
pub use taxonomy_config_status_vo::{
    hash_entries, AppliedSnapshot, ConfigMetricsView, ConfigRejectionSnapshot, ConfigState,
    ConfigStatus, ConfigStatusView, IncomingRejection, LazyHash, LoadObservation, RejectedResource,
    SourceKind, UnknownKindResource,
};
pub use taxonomy_core_error_vo::{
    AdminError, AdminErrorEnvelope, BootstrapError, ProxyError, ProxyErrorEnvelope, RateLimitScope,
};
pub use surface_forwarded_headers_controller::{
    client_header_forwardable, displaces_a_gateway_header, exact_match_only, exact_match_only_with,
    forward_pattern_admits, forward_pattern_admits_with, header_forward_blocked,
    resolve_forwarded_client_headers, CREDENTIAL_SLOT_HEADERS, GATEWAY_HEADER_PREFIX,
    NEVER_FORWARD_FROM_CLIENT, NEVER_FORWARD_FROM_CLIENT_PREFIXES, NON_FORWARDABLE_HEADERS,
};
pub use taxonomy_header_template_vo::{render_header_template, HeaderVars, HEADER_TEMPLATE_VARS};
pub use models::{
    validate_apikey, validate_cache_policy, validate_guardrail, validate_model,
    validate_observability_exporter, validate_provider_key, validate_rate_limit_policy, Adapter,
    AisixSnapshot, ApiEndpoint, ApiKey, ApiSurface, AppliedGuardrail, CachePolicy, CooldownConfig,
    EffortAction, ExporterKind, Guardrail, GuardrailEnforcedHit, GuardrailExecution,
    GuardrailHookPoint, GuardrailInputMessages, GuardrailKind, GuardrailMetricsSink,
    GuardrailMonitorHit, GuardrailScore, HashOnSource, HashOnType, KeyOwnerNames, KeywordConfig,
    KeywordPattern, MappedEffort, Model, ObservabilityExporter, ParamConstraints,
    PassthroughAuthMode, PassthroughCredentialMode, PassthroughRoute, PolicyScope, PolicyWindow,
    ProviderApis, ProviderKey, RateLimit, RateLimitPolicy, RateLimitWindowType, RequestOverrides,
    ResponseOverrides, Routing, RoutingStrategy, RoutingTarget, SchemaError, StreamDoneMarker,
    Tags, Team, TelemetryKind, TelemetryTags, User, WhenAllUnavailablePolicy,
    DEFAULT_COOLDOWN_TRIGGER_STATUSES,
};
pub use taxonomy_resource_vo::{Resource, ResourceEntry};
pub use utility_sched_demotion::{demote_current_thread, run_demoted};
pub use utility_similarity_math::{best_similarity, best_similarity_by, cosine_similarity};
pub use taxonomy_snapshot_vo::{ResourceTable, SnapshotHandle};
pub use utility_build_version::{BUILD_VERSION, HEARTBEAT_VERSION};
