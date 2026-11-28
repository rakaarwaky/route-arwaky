//! aisix-etcd — etcd-backed [`ConfigProvider`] + watch supervisor.
//!
//! The gateway's hot read path talks to a `SnapshotHandle<AisixSnapshot>`
//! (see `aisix-core`). This crate is what *populates* that handle, running
//! a single supervisor task that:
//!
//! 1. Connects to etcd — an etcd that cannot be reached is left to this
//!    loop rather than failing the boot; credentials it refuses are fatal
//! 2. Performs a full range read under the configured prefix
//! 3. Opens a watch stream from the next revision
//! 4. Applies Put / Delete events by copy-on-write replacing the snapshot
//! 5. Triggers a full resync on compaction
//! 6. Reconnects with exponential backoff (1→60s) on transport failure
//!
//! The [`ConfigProvider`] trait is the seam tests use to plug in an
//! in-memory provider and avoid a container dependency for unit testing.
//!
//! Spec references: §2 (config system), §3 (data models).

#![forbid(unsafe_code)]
#![deny(rust_2018_idioms)]

pub mod taxonomy_backoff_vo;
pub mod surface_etcd_client_component;
pub mod surface_etcd_provider_controller;
pub mod file_source;
pub mod taxonomy_etcd_key_vo;
pub mod surface_config_loader_action;
pub mod taxonomy_provider_vo;
pub mod surface_snapshot_cache_store;
pub mod surface_supervisor_controller;

pub use taxonomy_backoff_vo::{ExpBackoff, BASE_MS, MAX_MS};
pub use surface_etcd_client_component::{
    kv_client, watch_client, CallError, ConnectError, LazyEtcdClient, MAX_DECODING_MESSAGE_SIZE,
};
pub use surface_etcd_provider_controller::{
    ConnectPolicy, EtcdConfigProvider, EtcdWatchStream, CONNECT_MAX_ATTEMPTS,
    CONNECT_RETRY_INTERVAL,
};
pub use file_source::FileConfigProvider;
pub use taxonomy_etcd_key_vo::{
    parse as parse_key, KeyError, PrefixScope, PrefixSet, ResourceKey, ScopedKey, WatchedPrefix,
};
pub use surface_config_loader_action::{build_snapshot, BuildStats};
pub use taxonomy_provider_vo::{ConfigProvider, ProviderError, RawEntry, WatchEvent};
pub use surface_snapshot_cache_store::SnapshotCache;
pub use surface_supervisor_controller::{Supervisor, WatchStatus, WatchStatusSnapshot};
