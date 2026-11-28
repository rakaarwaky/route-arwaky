//! Trust material for every TLS connection the gateway *opens*.
//!
//! One module, because the same operator setting has to reach clients
//! built on four different stacks, and a setting that reaches only some
//! of them fails silently — the request just keeps working against the
//! public providers and keeps failing against the private one:
//!
//! - the workspace `reqwest` (provider bridges, guardrails, passthrough,
//!   JWKS/OIDC discovery, OTLP export)
//!   via [`reqwest_material`], applied inside
//!   [`crate::surface_upstream_http_controller::client_builder`];
//! - raw rustls (the Realtime WebSocket) via [`rustls_client_config`];
//!
//! Everything here is *additive to* the platform trust store, which
//! stays whatever `SSL_CERT_FILE` / `SSL_CERT_DIR` and the system bundle
//! make it. Trusting a private CA never removes trust in a public one.

use std::sync::{Arc, OnceLock};

use aisix_core::taxonomy_config_vo::OutboundTlsConfig;
use aisix_core::models::taxonomy_provider_key_vo::UpstreamConnection;

use crate::surface_upstream_http_controller::error_with_causes;

/// PEM material and verification policy shared by every outbound client.
///
/// Holds PEM *bytes* rather than parsed certificates because the
/// consumers above parse into incompatible types. The bytes are
/// validated once at load time so a malformed bundle fails the boot
/// rather than the first request that needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsSettings {
    /// Extra trust roots, PEM-encoded, added to the built-in root set.
    pub extra_ca_pem: Option<Arc<Vec<u8>>>,
    /// Client certificate and private key presented to peers that
    /// require mutual TLS.
    pub client_identity: Option<Arc<ClientIdentityPem>>,
    /// Whether the peer's certificate is verified.
    ///
    /// `false` accepts any certificate from any peer, which is the
    /// whole of what TLS was protecting on a link that carries prompts,
    /// responses, and upstream API keys.
    pub verify: bool,
}

impl Default for TlsSettings {
    fn default() -> Self {
        Self {
            extra_ca_pem: None,
            client_identity: None,
            verify: true,
        }
    }
}

impl TlsSettings {
    /// Whether this leaves every client exactly as it was built before
    /// the `upstream.tls` block existed.
    pub fn is_default(&self) -> bool {
        self.extra_ca_pem.is_none() && self.client_identity.is_none() && self.verify
    }

    /// Read the configured PEM files off disk and validate them.
    ///
    /// Reading here rather than at first use means an unreadable or
    /// malformed bundle stops the boot with the path in the message,
    /// instead of surfacing later as a generic upstream transport error.
    ///
    /// `block` labels the config section in every error, so an operator
    /// reading the failure knows whether to look at `upstream.tls` or at
    /// one of the `redis` blocks.
    pub fn load(block: &str, cfg: &OutboundTlsConfig) -> Result<Self, String> {
        let extra_ca_pem = match &cfg.ca_file {
            None => None,
            Some(path) => {
                let pem = std::fs::read(path)
                    .map_err(|e| format!("{block}.ca_file: read {path}: {e}"))?;
                let count = rustls_pemfile::certs(&mut pem.as_slice())
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("{block}.ca_file: parse {path}: {e}"))?
                    .len();
                // An empty-but-readable file is the shape a bad
                // ConfigMap key or a failed `kubectl cp` leaves behind,
                // and it would otherwise look like a configured CA.
                if count == 0 {
                    return Err(format!(
                        "{block}.ca_file: {path} contains no CERTIFICATE block"
                    ));
                }
                Some(Arc::new(pem))
            }
        };

        let client_identity = match (&cfg.client_cert_file, &cfg.client_key_file) {
            (Some(cert_path), Some(key_path)) => {
                let cert = std::fs::read(cert_path)
                    .map_err(|e| format!("{block}.client_cert_file: read {cert_path}: {e}"))?;
                let key = std::fs::read(key_path)
                    .map_err(|e| format!("{block}.client_key_file: read {key_path}: {e}"))?;
                Some(Arc::new(ClientIdentityPem { key, cert }))
            }
            // The mismatched pairs are rejected by `Config::validate`.
            _ => None,
        };

        Ok(Self {
            extra_ca_pem,
            client_identity,
            verify: cfg.verify,
        })
    }
}

/// A client certificate and the private key that goes with it, both PEM.
///
/// Kept as two halves because the consumers disagree about the shape:
/// reqwest wants one concatenated blob ([`ClientIdentityPem::joined`]),
/// redis-rs wants the two fields separately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientIdentityPem {
    pub key: Vec<u8>,
    pub cert: Vec<u8>,
}

impl ClientIdentityPem {
    /// Key then certificate in one PEM blob, the form
    /// `reqwest::Identity::from_pem` expects.
    ///
    /// The separator matters: PEM written by a deploy script or dumped
    /// out of an env var often has no trailing newline, which would glue
    /// the key's END line onto the certificate's BEGIN line and make the
    /// whole blob unparseable.
    pub fn joined(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.key.len() + self.cert.len() + 1);
        out.extend_from_slice(&self.key);
        if !self.key.ends_with(b"\n") {
            out.push(b'\n');
        }
        out.extend_from_slice(&self.cert);
        out
    }
}

/// The extra trust roots as raw PEM, for the stacks that parse PEM
/// themselves (the AWS SDK's `TrustStore`).
pub fn extra_ca_pem() -> Option<Arc<Vec<u8>>> {
    crate::surface_upstream_http_controller::config().tls.extra_ca_pem.clone()
}

// ─── reqwest (workspace line) ────────────────────────────────────────

/// Parsed-once reqwest trust material. `reqwest::Certificate` and
/// `Identity` are both `Clone`, so parsing at boot and cloning per
/// client keeps PEM parsing off every client construction.
#[derive(Default)]
pub struct ReqwestTlsMaterial {
    pub roots: Vec<reqwest::Certificate>,
    pub identity: Option<reqwest::Identity>,
}

static REQWEST_TLS: OnceLock<ReqwestTlsMaterial> = OnceLock::new();

/// Parse `settings` into reqwest's types and install them process-wide.
/// Called from [`crate::surface_upstream_http_controller::init`] during boot; the error is
/// what turns a malformed bundle into a failed boot.
pub(crate) fn init_reqwest_material(settings: &TlsSettings) -> Result<(), String> {
    let roots = match &settings.extra_ca_pem {
        Some(pem) => reqwest::Certificate::from_pem_bundle(pem)
            .map_err(|e| format!("upstream.tls.ca_file: {}", error_with_causes(&e)))?,
        None => Vec::new(),
    };
    let identity = match &settings.client_identity {
        Some(id) => Some(reqwest::Identity::from_pem(&id.joined()).map_err(|e| {
            format!(
                "upstream.tls.client_cert_file/client_key_file: {}",
                error_with_causes(&e)
            )
        })?),
        None => None,
    };
    let _ = REQWEST_TLS.set(ReqwestTlsMaterial { roots, identity });
    Ok(())
}

/// The installed reqwest trust material, empty when nothing was
/// configured (or in tests, which never call `init`).
pub fn reqwest_material() -> &'static ReqwestTlsMaterial {
    REQWEST_TLS.get_or_init(ReqwestTlsMaterial::default)
}

// ─── per-ProviderKey overrides ───────────────────────────────────────

/// Clients built for a Provider Key's connection overrides, keyed by the
/// overrides themselves so every key configured the same way shares one
/// connection pool.
///
/// A client is the unit reqwest attaches trust and name resolution to, so
/// an override cannot be applied per request — it needs its own client,
/// and therefore its own pool. Building one per dispatch would pay a TLS
/// handshake on every call, which is precisely what the shared pool
/// exists to avoid; the cache keeps it to one per distinct override.
///
/// Unbounded on purpose. The key space is the set of distinct override
/// combinations across the Provider Keys an operator has configured — a
/// handful in the deployments this exists for, and each entry is one
/// idle connection pool.
static PK_CLIENTS: OnceLock<dashmap::DashMap<UpstreamConnection, reqwest::Client>> =
    OnceLock::new();

/// The raw-relay counterpart to [`PK_CLIENTS`]. Reqwest's content decoders
/// are client settings, so a passthrough relay that promises provider bytes
/// needs a separate pool even when it has the same TLS/resolve override.
static RAW_PK_CLIENTS: OnceLock<dashmap::DashMap<UpstreamConnection, reqwest::Client>> =
    OnceLock::new();

/// Clients built for Provider Key connection overrides so far.
pub fn provider_key_client_count() -> u64 {
    PK_CLIENTS.get().map_or(0, |clients| clients.len() as u64)
}

// ─── per-worker pools ────────────────────────────────────────────────

thread_local! {
    /// Whether this thread serves proxy traffic on its own runtime.
    static IS_WORKER_THREAD: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };

    /// This worker's upstream pool, built on first dispatch. `None` once
    /// a build failure has been reported for this thread.
    static WORKER_CLIENT: std::cell::OnceCell<Option<reqwest::Client>> =
        const { std::cell::OnceCell::new() };

    /// The worker-owned raw-relay pool. It has the same TLS and connection
    /// settings as `WORKER_CLIENT`, but no automatic content decoding.
    static RAW_WORKER_CLIENT: std::cell::OnceCell<Option<reqwest::Client>> =
        const { std::cell::OnceCell::new() };
}

/// Declares the calling thread a proxy worker with its own runtime, so
/// its dispatches use a pool this thread alone polls.
///
/// Called once per worker in thread-per-core serving. Left unset
/// everywhere else — the shared runtime's threads, the blocking pool,
/// background tasks — so those keep dispatching on the process-wide
/// pools exactly as before.
pub fn mark_worker_thread() {
    IS_WORKER_THREAD.set(true);
}

/// This worker's pool, or `None` when the thread is not a worker or the
/// pool could not be built.
///
/// One pool per worker rather than per client: the dispatch clients are
/// all built from the same recipe, so merging them costs nothing but the
/// per-owner split of `pool_max_idle_per_host`, and keeping them split
/// would multiply idle connections by the worker count for no gain.
///
/// A build failure falls back to the shared pool — which carries the
/// deployment's trust settings — and is cached so one broken
/// configuration cannot log per request.
fn worker_client() -> Option<reqwest::Client> {
    if !IS_WORKER_THREAD.get() {
        return None;
    }
    WORKER_CLIENT.with(|cell| {
        cell.get_or_init(|| match crate::surface_upstream_http_controller::client_builder().build() {
            Ok(client) => Some(client),
            Err(e) => {
                tracing::error!(
                    error = %error_with_causes(&e),
                    "per-worker upstream pool could not be built; this worker \
                     dispatches on the shared pool"
                );
                None
            }
        })
        .clone()
    })
}

/// Build a client that relays response bytes exactly as received. In
/// particular, reqwest otherwise transparently decodes `gzip`, `br`,
/// `deflate`, and `zstd`, while removing the matching response headers.
fn raw_client_builder() -> reqwest::ClientBuilder {
    // This workspace enables only reqwest's `gzip` decoder (see the
    // workspace dependency declaration). The remaining decoder features are
    // not compiled in, so disabling gzip is sufficient to preserve every
    // representation this binary could otherwise transform.
    crate::surface_upstream_http_controller::client_builder()
        .no_gzip()
        // The passthrough target is validated before dispatch. Following an
        // upstream Location would make a second, unchecked request and could
        // carry the injected provider credential beyond that boundary.
        .redirect(reqwest::redirect::Policy::none())
}

fn raw_client() -> &'static reqwest::Client {
    static RAW_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    // The same builder's TLS material is validated at boot. Do not fall back
    // to a bare client here: that could make a raw relay silently trust less
    // than the deployment configured.
    RAW_CLIENT.get_or_init(|| {
        raw_client_builder()
            .build()
            .expect("configured raw passthrough HTTP client builds")
    })
}

fn raw_worker_client() -> Option<reqwest::Client> {
    if !IS_WORKER_THREAD.get() {
        return None;
    }
    RAW_WORKER_CLIENT.with(|cell| {
        cell.get_or_init(|| match raw_client_builder().build() {
            Ok(client) => Some(client),
            Err(e) => {
                tracing::error!(
                    error = %error_with_causes(&e),
                    "per-worker raw passthrough upstream pool could not be built; this worker \
                     dispatches on the shared raw pool"
                );
                None
            }
        })
        .clone()
    })
}

/// The client to dispatch this Provider Key's request on.
///
/// Returns `shared` unchanged whenever the key sets no override, which
/// is the overwhelmingly common case and the one that must keep sharing
/// the bridge's pool.
///
/// A malformed `ca_cert` falls back with a logged error rather than to a
/// client that trusts less than the operator asked for — the request then
/// fails against the private endpoint, which is the same visible outcome
/// as not having configured anything, and is preferable to quietly
/// proceeding. What it falls back TO depends on whether the key also
/// names addresses: see the error arms below.
pub fn client_for_provider_key(
    shared: &reqwest::Client,
    conn: Option<&UpstreamConnection>,
) -> reqwest::Client {
    let Some(conn) = conn.filter(|c| !c.is_noop()) else {
        // On a thread-per-core worker, dispatch on that worker's own
        // pool: the upstream connection is then read by the same runtime
        // that is waiting for the response, instead of waking a thread
        // that has to hand it back. Everywhere else this is `None` and
        // the shared pool is used, as it always was.
        return worker_client().unwrap_or_else(|| shared.clone());
    };
    client_for_provider_key_override(shared, conn, &PK_CLIENTS, build_provider_key_client)
}

/// The byte-preserving client for a passthrough raw relay. It applies the
/// same deployment TLS, per-ProviderKey CA, certificate-verification, and
/// address-resolution rules as [`client_for_provider_key`], but opts out of
/// every reqwest content decoder so a relay may retain both encoded bytes and
/// `Content-Encoding` / `Content-Length` headers.
pub fn raw_client_for_provider_key(conn: Option<&UpstreamConnection>) -> reqwest::Client {
    let shared = raw_client();
    let Some(conn) = conn.filter(|c| !c.is_noop()) else {
        return raw_worker_client().unwrap_or_else(|| shared.clone());
    };
    client_for_provider_key_override(shared, conn, &RAW_PK_CLIENTS, build_raw_provider_key_client)
}

fn client_for_provider_key_override(
    shared: &reqwest::Client,
    conn: &UpstreamConnection,
    cache: &OnceLock<dashmap::DashMap<UpstreamConnection, reqwest::Client>>,
    build: fn(&UpstreamConnection) -> Result<reqwest::Client, String>,
) -> reqwest::Client {
    let cache = cache.get_or_init(dashmap::DashMap::new);
    if let Some(existing) = cache.get(conn) {
        return existing.clone();
    }
    match build(conn) {
        Ok(client) => cache.entry(conn.clone()).or_insert(client).clone(),
        Err(e) if conn.resolve.is_empty() => {
            tracing::error!(
                error = %e,
                "provider_key.tls could not be applied; falling back to the \
                 deployment's trust settings"
            );
            shared.clone()
        }
        Err(e) => {
            // With an address override configured, the shared client is
            // NOT a safe fallback: it resolves the hostname through DNS,
            // so a key whose trust material failed to load would carry
            // its credential to whatever public DNS answers instead of to
            // the private endpoint the operator named — reaching a
            // different server, and succeeding while doing it.
            //
            // Keep the resolution and drop only the part that failed. The
            // request then reaches the configured address and fails its
            // certificate check there, which is the same visible outcome
            // as not having configured any trust material.
            tracing::error!(
                error = %e,
                "provider_key.tls could not be applied; dispatching to \
                 resolve_addresses on the deployment's trust settings, \
                 where this endpoint is expected to fail verification"
            );
            let resolution_only = UpstreamConnection {
                tls: None,
                resolve: conn.resolve.clone(),
            };
            // `resolve_to_addrs` cannot fail, so the only way this second
            // build fails is a TLS backend that would not initialise —
            // which `shared` could not have been built over either.
            build(&resolution_only)
                .map(|client| cache.entry(resolution_only).or_insert(client).clone())
                .unwrap_or_else(|_| shared.clone())
        }
    }
}

fn build_provider_key_client(conn: &UpstreamConnection) -> Result<reqwest::Client, String> {
    build_provider_key_client_with(conn, crate::surface_upstream_http_controller::client_builder())
}

fn build_raw_provider_key_client(conn: &UpstreamConnection) -> Result<reqwest::Client, String> {
    build_provider_key_client_with(conn, raw_client_builder())
}

fn build_provider_key_client_with(
    conn: &UpstreamConnection,
    mut builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, String> {
    // Layer the key's override ON TOP of the deployment settings rather
    // than replacing them: a deployment CA and a per-key CA are both
    // trust roots, and a client presenting the deployment's mTLS
    // identity must keep presenting it.
    if let Some(tls) = conn.tls.as_ref() {
        if let Some(pem) = tls.ca_cert.as_ref().filter(|p| !p.trim().is_empty()) {
            let roots = reqwest::Certificate::from_pem_bundle(pem.as_bytes())
                .map_err(|e| format!("provider_key.tls.ca_cert: {}", error_with_causes(&e)))?;
            if roots.is_empty() {
                return Err("provider_key.tls.ca_cert contains no certificate".into());
            }
            for root in roots {
                builder = builder.add_root_certificate(root);
            }
        }
        if !tls.verify {
            builder = builder.danger_accept_invalid_certs(true);
        }
    }
    for (host, addrs) in &conn.resolve {
        // Port 0: reqwest keeps the port from the request URL and takes
        // only the address from here. The hostname stays the one the URL
        // names, so `Host`, `:authority`, the TLS server name and the
        // certificate check are all unaffected — this replaces name
        // resolution and nothing else.
        //
        // The whole list goes in at once, in the operator's order, so the
        // connector walks it the way it walks a resolver's answer and
        // moves to the next address when one will not connect.
        let socket_addrs: Vec<std::net::SocketAddr> = addrs
            .iter()
            .map(|addr| std::net::SocketAddr::new(*addr, 0))
            .collect();
        builder = builder.resolve_to_addrs(host, &socket_addrs);
    }
    builder.build().map_err(|e| error_with_causes(&e))
}

// ─── raw rustls (Realtime WebSocket) ─────────────────────────────────

/// A `rustls::ClientConfig` carrying the same trust decision the reqwest
/// clients get, for the outbound paths that speak rustls directly.
///
/// Built once: assembling the root store re-reads the system trust
/// store, which costs hundreds of milliseconds on some platforms.
pub fn rustls_client_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            Arc::new(build_rustls_client_config(
                &crate::surface_upstream_http_controller::config().tls,
            ))
        })
        .clone()
}

fn build_rustls_client_config(tls: &TlsSettings) -> rustls::ClientConfig {
    // `ClientConfig::builder()` picks the crypto provider implicitly and
    // **panics** when it cannot: more than one provider is compiled into
    // the workspace (redis-rs's rustls feature pulls in ring alongside
    // the aws-lc-rs everything else uses). `main` installs a default
    // before anything touches TLS, but this module must not depend on
    // having been reached after that — a panic here would take down a
    // request path over a configuration detail.
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()));
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the crypto provider supports the default protocol versions");
    let mut config = if tls.verify {
        builder
            .with_root_certificates(root_store(tls))
            .with_no_client_auth()
    } else {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(danger::AcceptAnyServerCert(provider)))
            .with_no_client_auth()
    };
    // The WebSocket upstream is HTTP/1.1; advertising anything else
    // would let a peer negotiate a protocol the transport can't speak.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    config
}

/// Built-in roots (platform store + the compiled-in Mozilla set, which
/// is what reqwest trusts) plus whatever `ca_file` added.
fn root_store(tls: &TlsSettings) -> rustls::RootCertStore {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let native = rustls_native_certs::load_native_certs();
    if !native.errors.is_empty() {
        tracing::warn!(errors = ?native.errors, "some native root certificates failed to load");
    }
    let (_added, _ignored) = roots.add_parsable_certificates(native.certs);
    if let Some(pem) = &tls.extra_ca_pem {
        // Validated in `TlsSettings::load`, so a parse failure here is
        // not reachable from a booted process.
        match rustls_pemfile::certs(&mut pem.as_slice()).collect::<Result<Vec<_>, _>>() {
            Ok(certs) => {
                let (_added, ignored) = roots.add_parsable_certificates(certs);
                if ignored > 0 {
                    tracing::warn!(
                        ignored,
                        "upstream.tls.ca_file: some certificates were not usable as trust anchors"
                    );
                }
            }
            Err(e) => tracing::error!(error = %e, "upstream.tls.ca_file: parse failed"),
        }
    }
    roots
}

mod danger {
    use std::sync::Arc;

    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{DigitallySignedStruct, Error, SignatureScheme};

    /// Accepts every server certificate. Installed only when the
    /// operator set `upstream.tls.verify: false`.
    ///
    /// Signature *validation* is still delegated to the crypto provider:
    /// the handshake must still be internally consistent, we just stop
    /// asking who signed the certificate. That keeps the failure mode to
    /// "we cannot tell who the peer is" rather than "the transport is
    /// arbitrary".
    #[derive(Debug)]
    pub struct AcceptAnyServerCert(pub Arc<CryptoProvider>);

    impl ServerCertVerifier for AcceptAnyServerCert {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            verify_tls12_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            verify_tls13_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aisix_core::models::taxonomy_provider_key_vo::ProviderKeyTls;

    fn ca_pem() -> Vec<u8> {
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        params.self_signed(&kp).unwrap().pem().into_bytes()
    }

    #[test]
    fn ca_file_is_read_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ca.pem");
        std::fs::write(&path, ca_pem()).unwrap();

        let settings = TlsSettings::load(
            "upstream.tls",
            &OutboundTlsConfig {
                ca_file: Some(path.to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(settings.extra_ca_pem.is_some());
        assert!(!settings.is_default());
    }

    /// A readable-but-not-a-certificate file is the shape a mis-keyed
    /// ConfigMap mount leaves behind. It must fail the boot rather than
    /// look like a configured CA that silently trusts nothing extra.
    #[test]
    fn ca_file_that_holds_no_certificate_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ca.pem");
        std::fs::write(&path, b"not a certificate\n").unwrap();

        let err = TlsSettings::load(
            "upstream.tls",
            &OutboundTlsConfig {
                ca_file: Some(path.to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("no CERTIFICATE block"), "{err}");
    }

    #[test]
    fn missing_ca_file_names_the_path() {
        let err = TlsSettings::load(
            "upstream.tls",
            &OutboundTlsConfig {
                ca_file: Some("/nonexistent/private-ca.pem".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("/nonexistent/private-ca.pem"), "{err}");
    }

    /// PEM emitted by a deploy script often lacks the trailing newline;
    /// concatenating naively would fuse the key's END line onto the
    /// cert's BEGIN line and make the identity unparseable.
    #[test]
    fn identity_pem_separates_blocks_without_a_trailing_newline() {
        let identity = ClientIdentityPem {
            key: b"-----END PRIVATE KEY-----".to_vec(),
            cert: b"-----BEGIN CERTIFICATE-----".to_vec(),
        };
        assert_eq!(
            String::from_utf8(identity.joined()).unwrap(),
            "-----END PRIVATE KEY-----\n-----BEGIN CERTIFICATE-----"
        );
    }

    #[test]
    fn reqwest_material_parses_a_real_ca_bundle() {
        let settings = TlsSettings {
            extra_ca_pem: Some(Arc::new(ca_pem())),
            ..Default::default()
        };
        let roots =
            reqwest::Certificate::from_pem_bundle(settings.extra_ca_pem.as_ref().unwrap()).unwrap();
        assert_eq!(roots.len(), 1);
    }

    /// Two certificates in one file is the ordinary shape of an
    /// enterprise bundle (root + intermediate); loading only the first
    /// would leave a chain unverifiable.
    #[test]
    fn a_multi_certificate_bundle_loads_every_entry() {
        let mut bundle = ca_pem();
        bundle.extend_from_slice(&ca_pem());
        let roots = reqwest::Certificate::from_pem_bundle(&bundle).unwrap();
        assert_eq!(roots.len(), 2);
    }

    /// More than one crypto provider is compiled in (redis-rs's rustls
    /// feature adds ring next to the aws-lc-rs everything else uses), so
    /// `ClientConfig::builder()` cannot pick one and panics. These two
    /// deliberately do NOT install a default first: the module has to
    /// stand on its own, or the Realtime WebSocket path panics whenever
    /// it is reached before `main` gets to `install_default`.
    #[test]
    fn verify_false_builds_a_config_that_accepts_any_certificate() {
        let cfg = build_rustls_client_config(&TlsSettings {
            verify: false,
            ..Default::default()
        });
        assert_eq!(cfg.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn verify_true_builds_a_config_over_the_built_in_roots() {
        let cfg = build_rustls_client_config(&TlsSettings::default());
        assert_eq!(cfg.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    fn shared_client() -> reqwest::Client {
        reqwest::Client::builder()
            .user_agent("aisix-test-shared")
            .build()
            .unwrap()
    }

    /// `reqwest::Client` exposes no identity, so "did this get its own
    /// client (and therefore its own connection pool)?" is asserted
    /// through the cache: an entry exists exactly when a dedicated client
    /// was built.
    fn cached(conn: &UpstreamConnection) -> bool {
        PK_CLIENTS
            .get()
            .is_some_and(|cache| cache.contains_key(conn))
    }

    fn raw_cached(conn: &UpstreamConnection) -> bool {
        RAW_PK_CLIENTS
            .get()
            .is_some_and(|cache| cache.contains_key(conn))
    }

    /// A key carrying only `tls`, in the shape the dispatch sites derive.
    fn tls_conn(tls: ProviderKeyTls) -> UpstreamConnection {
        UpstreamConnection {
            tls: Some(tls),
            resolve: Vec::new(),
        }
    }

    /// A key carrying only `resolve_addresses`, for one hostname.
    fn resolve_conn(host: &str, addrs: &[&str]) -> UpstreamConnection {
        UpstreamConnection {
            tls: None,
            resolve: vec![(
                host.to_string(),
                addrs.iter().map(|a| a.parse().unwrap()).collect(),
            )],
        }
    }

    /// `tls: {}` — every field left at its default — is not an override,
    /// and treating it as one would split the connection pool for
    /// nothing.
    #[test]
    fn an_empty_override_is_treated_as_no_override() {
        assert!(ProviderKeyTls::default().is_noop());
        assert!(ProviderKeyTls {
            ca_cert: Some("   ".into()),
            verify: true,
        }
        .is_noop());
        assert!(!ProviderKeyTls {
            ca_cert: None,
            verify: false,
        }
        .is_noop());
    }

    /// The overwhelmingly common case: a key with no override keeps
    /// dispatching on the bridge's own client, so nothing is cached.
    #[test]
    fn a_key_without_an_override_builds_no_dedicated_client() {
        let noop = tls_conn(ProviderKeyTls::default());
        let _ = client_for_provider_key(&shared_client(), None);
        // Passed a profile that configures nothing — the shape a caller
        // assembling `UpstreamConnection` by hand can produce — this must
        // still land on the shared pool rather than build a client and
        // split it.
        let _ = client_for_provider_key(&shared_client(), Some(&noop));
        assert!(!cached(&noop));
    }

    /// `resolve_addresses` is an override in its own right: a key that
    /// sets it while leaving TLS at the deployment defaults still needs
    /// its own client, because reqwest attaches name resolution to the
    /// client and not to the request.
    #[test]
    fn resolve_addresses_alone_build_a_dedicated_client() {
        let key: aisix_core::models::ProviderKey = serde_json::from_value(serde_json::json!({
            "display_name": "pk-alone",
            "api_key": "sk-x",
            "api_base": "https://vendor-alone.invalid/v1",
            "resolve_addresses": ["192.0.2.10", "192.0.2.11"],
        }))
        .unwrap();
        let conn = key.upstream_connection().expect("an override is set");
        assert_eq!(conn.tls, None);
        assert_eq!(
            conn.resolve,
            resolve_conn("vendor-alone.invalid", &["192.0.2.10", "192.0.2.11"]).resolve
        );
        let _ = client_for_provider_key(&shared_client(), Some(&conn));
        assert!(cached(&conn));
    }

    #[test]
    fn raw_relay_keeps_provider_key_connection_overrides() {
        let conn = resolve_conn("vendor-raw-relay.invalid", &["192.0.2.12"]);
        let _ = raw_client_for_provider_key(Some(&conn));
        assert!(
            raw_cached(&conn),
            "the raw relay must not discard a ProviderKey's address override"
        );
    }

    /// Two keys pointing the same hostname at different addresses must not
    /// share a client: the resolution lives on the client, so one pool
    /// could only ever dial one of the two.
    #[test]
    fn different_addresses_for_one_hostname_get_different_clients() {
        let first = resolve_conn("vendor-split.invalid", &["192.0.2.21"]);
        let second = resolve_conn("vendor-split.invalid", &["192.0.2.22"]);
        assert_ne!(first, second);
        let _ = client_for_provider_key(&shared_client(), Some(&first));
        let _ = client_for_provider_key(&shared_client(), Some(&second));
        assert!(cached(&first));
        assert!(cached(&second));
        let for_this_host = PK_CLIENTS
            .get()
            .unwrap()
            .iter()
            .filter(|e| {
                e.key()
                    .resolve
                    .iter()
                    .any(|(h, _)| h == "vendor-split.invalid")
            })
            .count();
        assert_eq!(for_this_host, 2);
    }

    /// Two keys configured identically land on one client, so a
    /// deployment with several keys behind the same private CA keeps one
    /// connection pool rather than one per key.
    #[test]
    fn identical_overrides_share_one_client() {
        let tls = ProviderKeyTls {
            ca_cert: Some(String::from_utf8(ca_pem()).unwrap()),
            verify: true,
        };
        assert!(!cached(&tls_conn(tls.clone())));
        let _ = client_for_provider_key(&shared_client(), Some(&tls_conn(tls.clone())));
        let _ = client_for_provider_key(&shared_client(), Some(&tls_conn(tls.clone())));

        // Counted per-CA rather than over the whole map: the tests in
        // this module share the static and run concurrently, so a total
        // is not a stable number. Each test generates its own CA, which
        // makes this count exactly "clients built for these settings".
        let for_this_ca = PK_CLIENTS
            .get()
            .unwrap()
            .iter()
            .filter(|e| e.key().tls.as_ref().map(|t| &t.ca_cert) == Some(&tls.ca_cert))
            .count();
        assert_eq!(
            for_this_ca, 1,
            "two keys with equal TLS settings must share one client, and one pool"
        );
    }

    /// A `ca_cert` that is not a certificate must not silently become a
    /// client that trusts *less* than was asked for. Falling back to the
    /// shared client makes the request fail exactly as it would have
    /// without any configuration, which is the honest outcome.
    #[test]
    fn a_malformed_ca_cert_falls_back_instead_of_caching_a_weaker_client() {
        let tls = ProviderKeyTls {
            ca_cert: Some("-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n".into()),
            verify: true,
        };
        let _ = client_for_provider_key(&shared_client(), Some(&tls_conn(tls.clone())));
        assert!(!cached(&tls_conn(tls)));
    }

    /// The same failure, on a key that also names addresses, must NOT
    /// land on the shared client: that one resolves the hostname through
    /// DNS, so the key's credential would go to whatever public DNS
    /// answers rather than to the private endpoint — and would very
    /// likely get there. The resolution survives; only the trust material
    /// that failed to load is dropped.
    #[test]
    fn a_malformed_ca_cert_beside_an_address_override_keeps_the_addresses() {
        let tls = ProviderKeyTls {
            ca_cert: Some("-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----\n".into()),
            verify: true,
        };
        let addresses = resolve_conn("vendor-failclosed.invalid", &["192.0.2.31"]);
        let conn = UpstreamConnection {
            tls: Some(tls),
            resolve: addresses.resolve.clone(),
        };
        let _ = client_for_provider_key(&shared_client(), Some(&conn));
        assert!(!cached(&conn), "the unbuildable profile must not be cached");
        assert!(
            cached(&addresses),
            "the request must still be dispatched to the configured addresses"
        );
    }

    /// `verify: false` alone is a real override — no CA, but a different
    /// trust decision — so it must get its own client.
    #[test]
    fn verify_false_alone_builds_a_dedicated_client() {
        let tls = ProviderKeyTls {
            ca_cert: None,
            verify: false,
        };
        let _ = client_for_provider_key(&shared_client(), Some(&tls_conn(tls.clone())));
        assert!(cached(&tls_conn(tls)));
    }
}
