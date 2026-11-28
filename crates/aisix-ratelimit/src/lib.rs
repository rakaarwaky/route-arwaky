//! aisix-ratelimit — two-phase RPM/TPM/concurrency limiter.
//!
//! The proxy middleware calls [`Limiter::pre_commit`] before dispatching
//! a chat request; the returned [`Reservation`] is finalised with
//! [`Reservation::commit_tokens`] after the upstream response completes.
//!
//! Limits come from [`aisix_core::RateLimit`] — currently attached to
//! `ApiKey` entries. RPM/RPD are checked-and-incremented up front so
//! burst traffic fails fast; TPM/TPD are checked-only up front and
//! incremented on commit because the token cost is only known after
//! the upstream response lands.

#![forbid(unsafe_code)]
#![deny(rust_2018_idioms)]

pub mod taxonomy_clock_vo;
mod taxonomy_rate_limit_error_vo;
mod surface_rate_limiter_controller;
pub mod store;
mod surface_window_counter_action;

pub use taxonomy_clock_vo::{Clock, SystemClock, TestClock};
pub use taxonomy_rate_limit_error_vo::{LimitDetail, RateLimitError, CONCURRENCY_DIMENSION, CONCURRENCY_RETRY_AFTER_SECS};
pub use surface_rate_limiter_controller::{
    BucketKey, Limiter, MultiReservation, RateLimitStatus, Reservation, StreamConcurrencyGuard,
    TokenCharge,
};
pub use store::surface_local_store::LocalStore;
pub use store::surface_redis_store::RedisStore;
pub use store::{AcquireStamp, RateStore, StreamLeaseRefresh};
pub use surface_window_counter_action::{FixedWindowCounter, SlidingWindowCounter, WindowCheck};
