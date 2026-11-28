//! aisix-gateway — the Hub-and-Bridge core.
//!
//! This crate holds the provider-agnostic primitives shared by every
//! `aisix-provider-*` crate and by the proxy router:
//!
//! - [`chat`] — normalised `ChatFormat`, `ChatMessage`, `ChatResponse`,
//!   streaming `ChatChunk`, and the usage/finish-reason taxonomy.
//! - [`bridge`] — the `Bridge` trait every provider implements, plus
//!   `BridgeContext` and typed `BridgeError` with stable HTTP status
//!   mapping.
//! - [`hub`] — a small registry keyed on [`aisix_core::models::Provider`]
//!   that dispatches `ChatFormat` to the right `Bridge`.
//! - [`sse`] — a provider-agnostic SSE line decoder. Bridges that stream
//!   over SSE feed it raw bytes and pull typed events back out.
//! - [`structured_output`] — the `response_format` translation pieces
//!   every bridge shares: the synthetic JSON tool and its reverse
//!   translation, the fake stream that carries it, and the two schema
//!   normalisations.
//! - [`credential`] — cache keys for credential-derived upstream tokens.
//! - [`upstream_http`] — connection-layer settings every provider client
//!   shares (connect timeout, TCP keepalive, pool expiry) plus the
//!   cause-chain rendering for transport errors.
//!
//! Request/response translation lives in the provider crates; this crate
//! owns only what all of them must agree on.

#![forbid(unsafe_code)]
#![deny(rust_2018_idioms)]

pub mod surface_bridge_controller;
pub use aisix_core::taxonomy_chat_vo;
pub use aisix_core::taxonomy_content_part_vo;
pub use aisix_core::utility_credential_fingerprint;
pub mod surface_dns_cache_store;
pub mod surface_hub_router;
pub mod surface_media_fetch_action;
pub mod surface_response_tap_view;
pub mod surface_sse_view;
pub mod surface_ssrf_guard_action;
pub mod surface_structured_output_action;
pub mod surface_tool_calls_action;
pub mod surface_upstream_dial_action;
pub mod surface_upstream_headers_action;
pub mod surface_upstream_http_controller;
pub mod surface_upstream_tls_component;
pub mod surface_url_cache_store;

pub use surface_bridge_controller::{
    capture_in_band_error, capture_in_band_error_value, capture_upstream_error_http,
    content_type_is_json, decode_success_body, in_band_error_body, in_band_error_in_body,
    in_band_error_reported, parse_retry_after, read_body_capped, response_is_json, truncate_lossy,
    upstream_error_message, upstream_error_within, upstream_status_of_body,
    upstream_status_parsed_from_response, Bridge, BridgeCapability, BridgeContext, BridgeError,
    ChatChunkStream, UpstreamErrorBody, UpstreamErrorView, UpstreamWire,
    MAX_UPSTREAM_ERROR_BODY_BYTES, MAX_UPSTREAM_ERROR_MESSAGE_BYTES,
};
pub use taxonomy_chat_vo::{
    CacheCreationTtl, ChatChunk, ChatDelta, ChatFormat, ChatMessage, ChatResponse, EmbeddingObject,
    EmbeddingRequest, EmbeddingResponse, EmbeddingUsage, EmbeddingUsageSource, EmbeddingVector,
    FinishReason, ModalityTokens, OpenAiUsageDetails, ReportedCounts, Role, ServiceTier,
    UsageStats,
};
pub use utility_credential_fingerprint::credential_fingerprint;
pub use surface_hub_router::{upstream_protocol, Hub, UPSTREAM_PROTOCOL_UNKNOWN};
pub use surface_response_tap_view::{
    capture_header_values, note_upstream_error_body, note_upstream_response, provider_request_id,
    wants_upstream_error_body, warn_error_body_unread, ResponseHeaderTap, UpstreamResponseCapture,
    PROVIDER_REQUEST_ID_HEADERS,
};
pub use surface_sse_view::{SseDecoder, SseEvent, SseFrameTooLarge};
pub use surface_structured_output_action::{
    apply_schema_limits, close_object_schemas, json_schema_from_response_format,
    response_into_fake_stream_chunks, seal_object_schemas, unwrap_json_tool_call, SchemaLimits,
    JSON_TOOL_DESCRIPTION, JSON_TOOL_NAME,
};
pub use surface_upstream_headers_action::{
    apply_request_headers, client_header_forwardable, header_forward_blocked,
    resolve_default_headers, resolve_extra_headers, CallerIdentity, ForwardedClientHeaders,
    UpstreamHeaderContext,
};
pub use surface_upstream_http_controller::{
    client_builder, error_with_causes, json_body, log_body_read_causes, send_error,
    transport_error_message, upstream_body_read_error, UpstreamHttpConfig,
};
pub use surface_upstream_tls_component::TlsSettings;
