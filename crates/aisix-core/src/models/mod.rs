//! Typed entities persisted in etcd and loaded into the gateway snapshot.
//!
//! Each entity is paired with a JSON Schema (spec §3): a strict one
//! published as the write contract, and a lenient one the loader compiles
//! once and runs on every configuration source and on watch events.
//!
//! Entities landing across the live PR series:
//! - [`Model`] — routing target (§3)
//! - [`ApiKey`] — caller credential (§3)
//! - [`RateLimit`] — shared rate-limit config (§3.4 / §8)
//! - [`Routing`] — virtual-router strategy + targets (§3.5, PR #17)
//! - [`ProviderKey`] — managed upstream secret (§3.6)
//!
//! [`Team`] and [`User`] carry only the display names telemetry labels
//! resolve from an API key's `team_id` / `user_id`; team membership and
//! limits stay owned by the control plane.

pub mod taxonomy_apikey_vo;
pub mod taxonomy_budget_vo;
pub mod taxonomy_cache_policy_vo;
pub mod taxonomy_claim_mapping_vo;
pub mod taxonomy_embedding_vo;
pub mod taxonomy_ensemble_vo;
pub mod taxonomy_guardrail_vo;
pub mod taxonomy_model_vo;
pub mod taxonomy_model_ref_vo;
pub mod taxonomy_observability_exporter_vo;
pub mod taxonomy_oidc_provider_vo;
pub mod taxonomy_passthrough_route_vo;
pub mod taxonomy_policy_conditions_vo;
pub mod taxonomy_pricing_vo;
pub mod taxonomy_provider_key_vo;
pub mod taxonomy_rate_limit_vo;
pub mod taxonomy_rate_limit_policy_vo;
pub mod taxonomy_routing_vo;
pub mod taxonomy_schema_vo;
pub mod taxonomy_semantic_vo;
pub mod taxonomy_model_snapshot_vo;
pub mod taxonomy_tags_vo;
pub mod taxonomy_team_vo;
pub mod taxonomy_usage_accounting_vo;
pub mod taxonomy_user_vo;

pub use taxonomy_apikey_vo::ApiKey;
pub use taxonomy_budget_vo::{
    budget_next_period_start, budget_period_start, parse_budget_timezone, Budget, BudgetExhausted,
    BudgetFailMode, BudgetMemberExhausted, BudgetPeriod, BudgetPolicy, BudgetReason, BudgetScope,
    BudgetTag,
};
pub use taxonomy_cache_policy_vo::{AppliesTo, CacheBackend, CachePolicy, CacheScope, SemanticCacheConfig};
pub use taxonomy_claim_mapping_vo::{ClaimMapping, ClaimMatch, ClaimMatchOp, ClaimResolve};
pub use taxonomy_embedding_vo::EmbeddingConfig;
pub use taxonomy_ensemble_vo::{EnsembleConfig, Judge, PanelMember};
pub use taxonomy_guardrail_vo::{
    AppliedGuardrail, CustomConfig, Guardrail, GuardrailAttachment, GuardrailEnforcedHit,
    GuardrailExecution, GuardrailHookPoint, GuardrailInputMessages, GuardrailKind,
    GuardrailMetricsSink, GuardrailMonitorHit, GuardrailScopeType, GuardrailScore, KeywordConfig,
    KeywordPattern, LakeraConfig, OpenaiModerationConfig, PiiConfig, PiiCustomPattern,
    PiiDetectorConfig, PresidioConfig, PresidioEntityConfig, SemanticConfig,
};
pub use taxonomy_model_vo::{
    Adapter, BackgroundModelCheck, CooldownConfig, EffortAction, MappedEffort, Model,
    DEFAULT_COOLDOWN_TRIGGER_STATUSES,
};
pub use taxonomy_model_ref_vo::resolve_model_ref;
pub use taxonomy_observability_exporter_vo::{
    AliyunSlsConfig, DatadogConfig, ExporterKind, ObjectStoreCompression, ObjectStoreConfig,
    ObjectStoreProvider, ObservabilityExporter, OtlpHttpConfig, SlsContentMode,
};
pub use taxonomy_oidc_provider_vo::{BoundClaimExpect, HmacSecret, OidcProvider, HMAC_SECRET_MIN_BYTES};
pub use taxonomy_passthrough_route_vo::{PassthroughAuthMode, PassthroughCredentialMode, PassthroughRoute};
pub use taxonomy_policy_conditions_vo::{
    eval_condition_nodes, eval_condition_nodes_for_any_member, validate_condition_nodes,
    ConditionGroup, ConditionInput, ConditionLogic, ConditionNode, ConditionOperator,
    ConditionValue, GroupByDimension, PolicyAction, PolicyCondition, PolicyDimension,
};
pub use taxonomy_pricing_vo::{LivePricingIndex, Pricing, PricingIndex};
pub use taxonomy_provider_key_vo::{
    ApiEndpoint, ApiSurface, ParamConstraints, ProviderApis, ProviderKey, RequestOverrides,
    ResponseOverrides, StreamDoneMarker, TelemetryKind, TelemetryTags,
};
pub use taxonomy_rate_limit_vo::{RateLimit, RateLimitWindowType};
pub use taxonomy_rate_limit_policy_vo::{PolicyScope, PolicyWindow, RateLimitPolicy};
pub use taxonomy_routing_vo::{
    default_hash_on, HashOnSource, HashOnType, Routing, RoutingStrategy, RoutingTarget,
    WhenAllUnavailablePolicy,
};
pub use taxonomy_schema_vo::{
    unknown_field_paths, validate_apikey, validate_apikey_lenient, validate_budget,
    validate_budget_lenient, validate_budget_policy, validate_budget_policy_lenient,
    validate_cache_policy, validate_cache_policy_lenient, validate_claim_mapping,
    validate_claim_mapping_lenient, validate_guardrail, validate_guardrail_attachment,
    validate_guardrail_attachment_lenient, validate_guardrail_lenient, validate_model,
    validate_model_lenient, validate_observability_exporter,
    validate_observability_exporter_lenient, validate_oidc_provider,
    validate_oidc_provider_lenient, validate_passthrough_route, validate_passthrough_route_lenient,
    validate_pricing, validate_pricing_lenient, validate_provider_key,
    validate_provider_key_lenient, validate_rate_limit_policy, validate_rate_limit_policy_lenient,
    validate_team, validate_team_lenient, validate_usage_accounting,
    validate_usage_accounting_lenient, validate_user, validate_user_lenient, SchemaError,
};
pub use taxonomy_semantic_vo::{
    Aggregation, DistanceMetric, EmbeddingFailureMode, OnEmbeddingFailure, Semantic, SemanticMatch,
    SemanticRoute, SemanticSessionAffinity,
};
pub use taxonomy_model_snapshot_vo::{AisixSnapshot, KeyOwnerNames};
pub use taxonomy_tags_vo::{effective_tags, is_valid_tag_key, tag_value_from_claim, Tags, TAG_KEY_PATTERN};
pub use taxonomy_team_vo::Team;
pub use taxonomy_usage_accounting_vo::UsageAccounting;
pub use taxonomy_user_vo::User;
