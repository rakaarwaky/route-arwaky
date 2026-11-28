//! aisix-provider-openai — OpenAI provider [`OpenAiBridge`] impl.
//!
//! This crate is also the transport used by other OpenAI-compatible
//! upstreams (DeepSeek today, Gemini's OpenAI-compat endpoint later).
//! Those provider crates can wrap [`OpenAiBridge`] with their own
//! `api_base` and metrics label rather than duplicating the transport.
//!
//! See the `Bridge` trait in `aisix-gateway` for the contract this crate
//! implements against.

#![forbid(unsafe_code)]
#![deny(rust_2018_idioms)]

mod surface_bridge_controller;
pub mod surface_cohere_controller;
pub mod surface_overrides_action;
pub mod taxonomy_reasoning_family_vo;
pub mod taxonomy_wire_vo;

pub use surface_bridge_controller::{
    close_strict_response_format_schema, held_route_http_error, parse_openai_error_envelope,
    OpenAiBridge, OPENAI_DEFAULT_BASE,
};
