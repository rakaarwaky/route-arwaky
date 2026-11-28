//! Per-attempt routing telemetry shared by the Model-Group dispatch
//! endpoints (#655).
//!
//! Each upstream attempt — the initial try, a same-target retry, or a
//! fallback to a different target — becomes its own `UsageEvent`. Failed
//! attempts carry zero tokens + error info; the winning attempt carries
//! the real tokens/cost. All attempts of one request share `request_id`
//! (the trace/group key) and are ordered by `index` — each attempt
//! is its own per-call log event.
//!
//! The type lives in its own module so `/v1/chat/completions` and
//! `/v1/responses` cannot drift apart on how they
//! classify and emit attempts.
//!
//! [`RoutingTelemetry::record`] is the single place an attempt is
//! recorded, and therefore the single place the per-attempt METRICS are
//! emitted — the `aisix_deployment_*` and `aisix_routing_*_fallbacks_total`
//! families. Read them together with the request families rather than
//! against them: `aisix_proxy_requests_total` samples once per client
//! request with the status the caller saw, so a request whose first
//! target 502'd and whose fallback succeeded is one `status="200"` sample
//! there, one failure here, and two rows in the usage log.

use std::time::Instant;

use aisix_gateway::BridgeError;
use aisix_obs::{ErrorSource, RequestOutcome};

use crate::surface_proxy_error_view::ProxyError;

/// One recorded upstream attempt. See module docs.
#[derive(Clone)]
pub(crate) struct AttemptRecord {
    /// 0-based attempt index within the request.
    pub index: u32,
    /// `"initial"` (first try of the first target), `"retry"` (same
    /// target after a retryable failure), or `"fallback"` (a different
    /// target than the previous attempt).
    pub kind: &'static str,
    /// Routing target display name. Empty for direct (non-routing)
    /// models, where `model_id` already identifies the single model.
    pub target_model: String,
    /// UUID of the concrete Model row this attempt dispatched to. For a
    /// direct (non-routing) request this equals the requested entry's
    /// id. Feeds the emitted event's `model_id` so pricing resolves
    /// against the TARGET, not the group (AISIX-Cloud#790) — group ids
    /// have no pricing rows.
    pub target_model_id: String,
    /// Resolved ProviderKey UUID for this attempt's target — feeds the
    /// per-PK attribution tags on the emitted event. Empty when unknown.
    pub provider_key_id: String,
    /// This attempt's status (mapped upstream status / timeout on
    /// failure, 200 on success).
    pub status: u16,
    pub success: bool,
    /// Bounded error class (`routing_error_class`); empty on success.
    pub error_class: String,
    /// Short error message (length-capped); empty on success.
    pub error_message: String,
    /// This attempt's own wall-clock duration in ms.
    pub latency_ms: u32,
    /// Whether this attempt actually reached the upstream.
    ///
    /// False for an attempt the target's own rate-limit layers refused
    /// before dispatch, and equally for one the bridge rejected while still
    /// assembling the request — an unusable `api_key`, a missing
    /// `model_name`/`api_base`, a body that would not serialize (see
    /// [`BridgeError::reached_upstream`] and `attempt_reached_upstream`,
    /// which decide this per error variant). Neither produced an upstream
    /// response, so both stay out of the `aisix_deployment_*_responses_total`
    /// families an operator reads as upstream health; counting them there
    /// reports our own misconfiguration as provider degradation. Such an
    /// attempt is still real everywhere else — the per-attempt usage event,
    /// and the initial/retry/fallback classification the next attempt is
    /// measured against.
    pub dispatched: bool,
}

/// Per-attempt telemetry accumulated while serving one request. Direct
/// (non-routing) models record a single attempt with `target_model`
/// empty; routing groups record one entry per try.
#[derive(Clone, Default)]
pub(crate) struct RoutingTelemetry {
    pub attempts: Vec<AttemptRecord>,
    /// Display name of the most recently attempted target — drives the
    /// initial/retry/fallback classification in [`Self::begin_attempt`].
    last_target: Option<String>,
    /// What the CALLER asked for — the Model-Group name for a routed
    /// request. Labels the fallback counters, which answer "how often did
    /// THIS group have to fall back", so the group is the useful key and
    /// the target it moved to is the second label.
    requested_model: String,
    /// The request's trace bundle (AISIX-Cloud#1279). [`Self::begin_attempt`]
    /// and [`Self::record`] stamp each attempt's span start/end into it —
    /// the same chokepoints the per-attempt metrics use, so a dispatch
    /// path cannot record an attempt without its span boundaries.
    trace: Option<std::sync::Arc<aisix_obs::RequestTraceBundle>>,
}

/// The target of an attempt about to be dispatched, as
/// [`RoutingTelemetry::begin_attempt`] needs to describe it.
#[derive(Clone, Copy)]
pub(crate) struct AttemptTarget<'a> {
    /// The target Model's configured name. Drives the
    /// initial/retry/fallback classification, so it is the real name even
    /// for a direct model — unlike `target_model` below.
    pub display_name: &'a str,
    /// What [`AttemptRecord::target_model`] will carry: the routing target
    /// display name, or empty for a direct model, where `model_id` already
    /// identifies the single model.
    pub target_model: &'a str,
    /// What [`AttemptRecord::target_model_id`] will carry.
    pub model_id: &'a str,
}

impl RoutingTelemetry {
    /// Start a request's telemetry knowing what the caller asked for.
    /// Use in place of `default()` on the dispatch loops so the fallback
    /// counters have a group to file under.
    pub fn for_request(requested_model: &str) -> Self {
        Self {
            requested_model: requested_model.to_string(),
            ..Self::default()
        }
    }

    /// Attach the request's trace bundle so attempt boundaries land on it.
    pub fn with_trace(
        mut self,
        trace: Option<std::sync::Arc<aisix_obs::RequestTraceBundle>>,
    ) -> Self {
        self.trace = trace;
        self
    }

    /// Record one resolved attempt: emit its per-attempt metrics, then
    /// keep the record for the per-attempt usage events.
    ///
    /// THE chokepoint for everything counted per attempt. Handlers call
    /// this instead of pushing onto `attempts` directly, so a new dispatch
    /// path cannot land recording usage events but no metrics — which is
    /// exactly how `aisix_deployment_*` and `aisix_routing_*_fallbacks_total`
    /// shipped as never-emitted series (AISIX-Cloud#1299): the emit
    /// functions existed on `Metrics` from the start and simply had no
    /// caller.
    pub fn record(&mut self, state: &crate::surface_proxy_state_store::ProxyState, rec: AttemptRecord) {
        if rec.dispatched {
            Self::record_deployment(state, &rec.target_model_id, rec.status);
        }
        if rec.kind == "fallback" {
            state.metrics.record_routing_fallback(
                rec.success,
                &self.requested_model,
                &rec.target_model,
            );
        }
        // The attempt settled — stamp its span end (AISIX-Cloud#1279). For
        // a streaming winner this is commit time; the terminal emission
        // extends it to the measured stream end.
        if let Some(trace) = &self.trace {
            trace.end_attempt(rec.index);
        }
        // …and hand the settled record to the attribution cell, so a cancel
        // arriving later still emits the attempts that already failed
        // (AISIX-Cloud#1571). The handler's own `emit_failed_attempts` runs
        // only when the handler runs; exactly one of the two ever fires.
        crate::surface_attribution_view::note_attempt_settled(&rec);
        self.attempts.push(rec);
    }

    /// The `aisix_deployment_*` half of [`Self::record`], for the surfaces
    /// that call one direct model outside a routing loop and so keep no
    /// attempt list (`/v1/realtime`, the jobs routes, the video follow-up
    /// routes). Call it once per upstream call that was dispatched, with the
    /// status the upstream answered or the error's status.
    pub fn record_deployment(state: &crate::surface_proxy_state_store::ProxyState, model_id: &str, status: u16) {
        state
            .runtime_status
            .record_deployment_attempt(model_id, RequestOutcome::from_status(status));
    }

    /// Classify the next attempt against `target.display_name` and advance
    /// the last-target tracker. Returns `(index, kind)` to stamp onto the
    /// `AttemptRecord` the caller pushes once the attempt resolves. Call
    /// once per attempt, before dispatch.
    ///
    /// Takes the whole target rather than just its name because this is
    /// also where the attempt is published to the request's attribution
    /// cell (AISIX-Cloud#1571): a caller that hangs up mid-attempt is
    /// served entirely from `Drop`, and the guard can only name the target
    /// it was waiting on if the target was recorded BEFORE the dispatch it
    /// may never come back from.
    pub fn begin_attempt(&mut self, target: AttemptTarget<'_>) -> (u32, &'static str) {
        let index = self.attempts.len() as u32;
        let kind = if self.attempts.is_empty() {
            "initial"
        } else if self.last_target.as_deref() != Some(target.display_name) {
            "fallback"
        } else {
            "retry"
        };
        self.last_target = Some(target.display_name.to_string());
        // Mint the attempt's span id and stamp its start at the real
        // dispatch boundary (AISIX-Cloud#1279).
        if let Some(trace) = &self.trace {
            trace.start_attempt(index);
        }
        crate::surface_attribution_view::note_attempt_started(crate::surface_attribution_view::InFlightAttempt {
            index,
            kind,
            target_model: target.target_model.to_string(),
            model_id: target.model_id.to_string(),
        });
        (index, kind)
    }

    pub fn attempt_count(&self) -> u32 {
        self.attempts.len() as u32
    }

    /// Number of attempts that moved to a different target than the
    /// previous one. Drives the access log's `routing_fallback_count`.
    pub fn fallback_count(&self) -> u32 {
        self.attempts
            .iter()
            .filter(|a| a.kind == "fallback")
            .count() as u32
    }

    /// The winning (successful) attempt, if any. None for all-failed and
    /// pre-dispatch-error requests.
    pub fn winner(&self) -> Option<&AttemptRecord> {
        self.attempts.iter().rfind(|a| a.success)
    }

    /// The routing summary every family's access-log line carries (#655):
    /// the winning routing target, and the attempt and fallback counts,
    /// each absent when empty or zero.
    pub fn access_log_summary(&self) -> AccessLogRouting<'_> {
        AccessLogRouting {
            served_by_model: self
                .winner()
                .map(|w| w.target_model.as_str())
                .filter(|s| !s.is_empty()),
            attempt_count: Some(self.attempt_count()).filter(|&n| n > 0),
            fallback_count: Some(self.fallback_count()).filter(|&n| n > 0),
        }
    }
}

/// See [`RoutingTelemetry::access_log_summary`].
#[derive(Clone, Copy, Default)]
pub(crate) struct AccessLogRouting<'a> {
    pub served_by_model: Option<&'a str>,
    pub attempt_count: Option<u32>,
    pub fallback_count: Option<u32>,
}

/// Winning-attempt / failed-attempt classification stamped onto an
/// emitted `UsageEvent` (#655). Used by the `/v1/responses` emit helper, which (unlike chat's `UsageExtras`)
/// carry the attempt fields as a small standalone bundle.
#[derive(Default, Clone)]
pub(crate) struct AttemptInfo {
    pub index: u32,
    /// `"initial"` / `"retry"` / `"fallback"`. Empty → wire default
    /// `"initial"`.
    pub kind: String,
    /// Routing target display name; empty for direct models.
    pub model: String,
    /// Bounded error class for a failed attempt; empty on success.
    pub error_class: String,
    /// Short error message for a failed attempt; empty on success.
    pub error_message: String,
}

impl AttemptInfo {
    pub fn from_record(rec: &AttemptRecord) -> Self {
        Self {
            index: rec.index,
            kind: rec.kind.to_string(),
            model: rec.target_model.clone(),
            error_class: rec.error_class.clone(),
            error_message: rec.error_message.clone(),
        }
    }
}

/// The failure class a request's records carry: the access log's and the
/// usage event's `error_class`, on every path —
/// non-streamed, streamed, per attempt, and terminal.
///
/// Both read it from here so the two cannot drift into two vocabularies
/// again. An upstream failure reports its [`routing_error_class`], a
/// semantic router's failed decision `semantic_decision_failed`, and every
/// other failure its [`ProxyError::kind`].
///
/// NOT the client-facing envelope's `error.type`, which stays
/// [`ProxyError::kind`]: that one is public API, and for a bridge error it
/// keeps its own spelling (`upstream_error`, `transport_error`, …).
pub(crate) fn error_class(err: &ProxyError) -> &'static str {
    match err {
        ProxyError::Bridge(be) => routing_error_class(be),
        // Its `error.type` is the generic `api_error`, which would hide
        // the failure among every other gateway-side fault.
        ProxyError::SemanticDecisionFailed { .. } => "semantic_decision_failed",
        other => other.kind(),
    }
}

/// Bounded, low-sensitivity error class of an upstream failure — see
/// [`error_class`], which every record of a failed request goes through.
pub(crate) fn routing_error_class(err: &BridgeError) -> &'static str {
    match err {
        BridgeError::Timeout { .. } => "timeout",
        BridgeError::UpstreamStatus { .. } => "upstream_status",
        BridgeError::UpstreamDecode(_)
        | BridgeError::UpstreamBodyUnread { .. }
        | BridgeError::TokenExchangeDecode(_) => "upstream_decode",
        BridgeError::UpstreamInBand { .. } => "upstream_in_band",
        // Deliberately the same class `Config` reports: this variant was
        // spelled as a `Config` until #1093, and giving it a class of its
        // own would retire one series and create another for a failure that
        // did not change.
        BridgeError::Config(_) | BridgeError::UnsupportedCapability(_) => "config",
        BridgeError::InvalidUpstreamConfig(_) => "invalid_config",
        // A refusal of the caller's request, not of the target's
        // configuration: the class the gateway's own refusals of a request
        // (`ProxyError::InvalidRequest` / `RequestTooLarge`) record, and the
        // `error.type` the caller is sent, so one refusal reads the same
        // whichever layer raised it.
        BridgeError::InvalidRequest(_) | BridgeError::RequestTooLarge { .. } => {
            "invalid_request_error"
        }
        BridgeError::InvalidUpstreamCredentials(_) => "invalid_credentials",
        BridgeError::Transport(_) => "transport",
        BridgeError::StreamAborted => "stream_aborted",
    }
}

/// Upper bound on the per-attempt `error_message` telemetry field.
///
/// Sized as a backstop, not as the real limit: an `UpstreamStatus`
/// message is already bounded to [`aisix_gateway::MAX_UPSTREAM_ERROR_MESSAGE_BYTES`]
/// (1 KiB) by the bridge, so a cap above that byte budget leaves the
/// bridge's bound as the only one that ever fires and the operator sees
/// the whole message the bridge kept. A tighter cap silently clipped it
/// a second time (AISIX-Cloud#1065).
const MAX_ATTEMPT_ERROR_MESSAGE_CHARS: usize = 2048;

/// Control-char-stripped, capped rendering of an error's `Display`.
///
/// Anything that a log reader would treat as a line break is dropped, so a
/// multi-line upstream body can't split the one-line-per-record shape of
/// the telemetry field and the access log. U+2028/U+2029 are listed
/// explicitly: they are `Zl`/`Zp`, not `Cc`, so `is_control()` lets them
/// through even though plenty of viewers break lines on them.
pub(crate) fn sanitize_error_message(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}'))
        .take(MAX_ATTEMPT_ERROR_MESSAGE_CHARS)
        .collect()
}

/// Control-char-stripped error string for the per-attempt
/// `error_message` telemetry field (#655), capped at
/// [`MAX_ATTEMPT_ERROR_MESSAGE_CHARS`].
pub(crate) fn attempt_error_message(err: &BridgeError) -> String {
    sanitize_error_message(&err.to_string())
}

/// An upstream-side failure that ended a stream after its `200` headers
/// had gone out: a mid-stream upstream, transport, decode or timeout error,
/// an in-band upstream error, or a stream that carried no response.
///
/// The terminal usage event records the status the same error would have
/// produced had it arrived before the headers ([`BridgeError::http_status`]),
/// and the error itself as its `error_class` / `error_message` — not the
/// `200` the client's response line says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StreamFailure {
    pub status: u16,
    pub error_class: &'static str,
    pub error_message: String,
}

impl StreamFailure {
    pub fn from_bridge(err: &BridgeError) -> Self {
        Self {
            status: err.http_status(),
            error_class: routing_error_class(err),
            error_message: attempt_error_message(err),
        }
    }

    /// Record `err` unless an earlier failure already ended the stream: the
    /// first one is the cause, whatever the relay reported after it.
    pub fn record(slot: &mut Option<Self>, err: &BridgeError) {
        if slot.is_none() {
            *slot = Some(Self::from_bridge(err));
        }
    }

    /// Stamp this failure onto an attempt record bound for a usage event.
    pub fn apply_to(&self, attempt: &mut AttemptInfo) {
        attempt.error_class = self.error_class.to_string();
        attempt.error_message = self.error_message.clone();
    }
}

/// A guardrail refusal that ended a stream after its `200` head. The
/// stream keeps that status; its terminal usage event names the refusal
/// with the class and text a buffered refusal carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StreamRefusal {
    pub error_message: String,
}

impl StreamRefusal {
    /// The refusal whose error frame carries `guardrail_name` / `unavailable`.
    pub fn new(guardrail_name: Option<&str>, unavailable: Option<&str>) -> Self {
        let err = crate::surface_proxy_error_view::guardrail_block_error("response", guardrail_name, unavailable);
        Self {
            error_message: gateway_error_message(&err),
        }
    }

    /// Stamp this refusal onto an attempt record bound for a usage event.
    pub fn apply_to(&self, attempt: &mut AttemptInfo) {
        attempt.error_class = GUARDRAIL_BLOCK_CLASS.to_string();
        attempt.error_message = self.error_message.clone();
    }
}

/// A stream's completion record, which a guardrail refusal can end.
pub(crate) trait RecordsStreamRefusal {
    fn refusal_slots(&mut self) -> (&mut bool, &mut Option<StreamRefusal>);

    /// Mark the stream refused, with the text of the error frame it ends
    /// on. The first refusal is the one recorded.
    fn record_refusal(&mut self, guardrail_name: Option<&str>, unavailable: Option<&str>) {
        let (blocked, refusal) = self.refusal_slots();
        *blocked = true;
        refusal.get_or_insert_with(|| StreamRefusal::new(guardrail_name, unavailable));
    }
}

/// The class and message a stream's terminal event carries: its refusal's
/// if a guardrail ended it, otherwise its upstream failure's.
pub(crate) fn stream_error_fields(
    refusal: Option<&StreamRefusal>,
    failure: Option<&StreamFailure>,
) -> (String, String) {
    match (refusal, failure) {
        (Some(r), _) => (GUARDRAIL_BLOCK_CLASS.to_string(), r.error_message.clone()),
        (None, Some(f)) => (f.error_class.to_string(), f.error_message.clone()),
        (None, None) => (String::new(), String::new()),
    }
}

/// The usage-event status of a stream no guardrail refused: its upstream
/// failure's status if it had one, `499` if the caller went away first,
/// otherwise `200`. A failure outranks the disconnect: a relay that passes
/// a transport error on aborts the connection, which reads as the caller
/// leaving, and the failure is what ended the stream.
pub(crate) fn stream_status(reached_end: bool, failure: Option<&StreamFailure>) -> u16 {
    match failure {
        Some(f) => f.status,
        None if reached_end => 200,
        None => crate::CLIENT_CLOSED_REQUEST,
    }
}

/// Failure class + reason for the access log's `error_class` / `error`
/// fields: every variant contributes its `Display`.
pub(crate) fn access_log_error(err: &ProxyError) -> (&'static str, String) {
    (error_class(err), sanitize_error_message(&err.to_string()))
}

/// Bounded error class + short message for a per-attempt record, derived
/// from a `ProxyError`: its [`error_class`] and [`gateway_error_message`].
/// Shared by the `/v1/responses` dispatch loop.
pub(crate) fn attempt_error_from_proxy(err: &ProxyError) -> (String, String) {
    (error_class(err).to_string(), gateway_error_message(err))
}

/// The class of a guardrail refusal ([`ProxyError::ContentFiltered`]), for
/// the paths that answer an output refusal without carrying the error
/// itself to the usage event.
pub(crate) const GUARDRAIL_BLOCK_CLASS: &str = "content_filter";

/// The `error_message` a failure's usage event carries: the access log's
/// text, for every variant. The event travels further than the access log
/// (the control plane's store, OTLP, SLS), and this text can echo what the
/// caller sent or an upstream answered; a guardrail refusal alone is held to
/// policy wording and the guardrail's name (`guardrail_block_message`), so a
/// matched value never gets here through one.
pub(crate) fn gateway_error_message(err: &ProxyError) -> String {
    access_log_error(err).1
}

/// The classes an upstream's own failure reports, from
/// [`routing_error_class`]. Every other class is the gateway's.
const UPSTREAM_ERROR_CLASSES: &[&str] = &[
    "timeout",
    "upstream_status",
    "upstream_decode",
    "upstream_in_band",
    "transport",
    "stream_aborted",
    "tool_error",
];

/// What ended a request whose record names `class` ([`error_class`], or the
/// class a stream's terminal event was given). The one mapping behind every
/// `error_source` label, so a failed request cannot read as the gateway's on
/// one path and the upstream's on another.
pub(crate) fn error_source_of_class(class: &str) -> ErrorSource {
    if class.is_empty() || class == crate::CLIENT_DISCONNECTED_KIND {
        ErrorSource::None
    } else if UPSTREAM_ERROR_CLASSES.contains(&class) {
        ErrorSource::Upstream
    } else {
        ErrorSource::Aisix
    }
}

/// See [`error_source_of_class`].
pub(crate) fn error_source(err: &ProxyError) -> ErrorSource {
    error_source_of_class(error_class(err))
}

/// What ended a request a handler answered with a response rather than an
/// error: a guardrail's refusal of the upstream's answer, or the route's own
/// 501 for a provider lacking the capability (the last attempt, failed and
/// never dispatched), and otherwise nothing.
pub(crate) fn answered_error_source(
    guardrail_blocked: bool,
    routing: &RoutingTelemetry,
) -> ErrorSource {
    if guardrail_blocked || crate::surface_usage_attr_view::failed_attempts_are_terminal(routing) {
        ErrorSource::Aisix
    } else {
        ErrorSource::None
    }
}

/// What ended a request answered by relaying an upstream's response as sent:
/// the upstream when it answered with a failure, otherwise nothing.
pub(crate) fn relayed_error_source(status: u16) -> ErrorSource {
    if relayed_response_failed(status) {
        ErrorSource::Upstream
    } else {
        ErrorSource::None
    }
}

/// Whether a relayed upstream response is a failure: a redirect is a success
/// on every request family.
pub(crate) fn relayed_response_failed(status: u16) -> bool {
    !(200..400).contains(&status)
}

/// The longest prefix of a relayed error body a route keeps for its failure
/// row whatever the request's exporters are: the cap of `error_message`.
pub(crate) const MAX_RELAYED_ERROR_DETAIL_BYTES: usize = MAX_ATTEMPT_ERROR_MESSAGE_CHARS;

/// The class and message of an upstream's failure a route relays as sent, in
/// the wording `BridgeError::UpstreamStatus` gives every other route. `body`
/// is at most the [`MAX_RELAYED_ERROR_DETAIL_BYTES`] prefix.
pub(crate) fn relayed_failure(status: u16, body: &[u8]) -> (&'static str, String) {
    let err = BridgeError::upstream_status(status, aisix_gateway::upstream_error_message(body));
    (routing_error_class(&err), attempt_error_message(&err))
}

/// Whether a failed attempt actually reached its upstream — the
/// `AttemptRecord::dispatched` value for the `ProxyError`-typed dispatch
/// loop (`/v1/responses`), mirroring
/// [`BridgeError::reached_upstream`] for the `BridgeError`-typed one.
///
/// `ContentFiltered` is `true` because only the **output** hook can fire
/// inside a dispatch call — the input hook runs once, before the loop — so
/// the provider had already answered when we blocked it. (That attempt is
/// therefore counted as a deployment *failure* by
/// `RequestOutcome::from_status`, even though the upstream was healthy;
/// that is a defect in the outcome mapping, not in this predicate, and
/// fixing it needs the error to carry which hook fired.) Every remaining
/// variant is a gateway-side decision — auth, ACL, budget, rate limit,
/// unknown model — taken without contacting any provider. Exhaustive so a
/// new variant has to declare its side of the network boundary.
pub(crate) fn attempt_reached_upstream(err: &ProxyError) -> bool {
    match err {
        ProxyError::Bridge(be) => be.reached_upstream(),
        ProxyError::ContentFiltered { .. } => true,
        ProxyError::MissingAuth(_)
        | ProxyError::MissingRouteAuthHeader(_)
        | ProxyError::InvalidApiKey
        | ProxyError::ApiKeyExpired
        | ProxyError::ApiKeyDisabled
        | ProxyError::JwtInvalid
        | ProxyError::JwtExpired
        | ProxyError::JwtClaimsRejected
        | ProxyError::JwtInsufficientScope { .. }
        | ProxyError::JwtIdentityUnmapped
        | ProxyError::JwksUnavailable
        | ProxyError::ModelNotFound(_)
        | ProxyError::VideoNotFound(_)
        | ProxyError::ModelForbidden(_)
        | ProxyError::ModelIpRestricted(_)
        | ProxyError::RouteIpRestricted(_)
        | ProxyError::RouteForbidden(_)
        | ProxyError::InvalidRequest(_)
        | ProxyError::WebSocketUpgradeRequired { .. }
        | ProxyError::ProviderUnavailable
        | ProxyError::SemanticDecisionFailed { .. }
        | ProxyError::AllCandidatesUnavailable { .. }
        | ProxyError::BudgetExceeded(_)
        | ProxyError::BudgetUnverified
        | ProxyError::RequestTooLarge { .. }
        | ProxyError::RateLimit(_)
        | ProxyError::PolicyRateLimit { .. } => false,
    }
}

/// Milliseconds elapsed since `started`; see [`measured_ms`].
pub(crate) fn ms_since(started: Instant) -> u32 {
    measured_ms(started.elapsed())
}

/// A latency in whole milliseconds, for the telemetry fields where 0 means
/// "not measured": a measured duration reads as at least 1, so a
/// sub-millisecond wait (a cache hit's caller latency) is not reported as
/// missing.
/// `Duration::ZERO` is what callers pass for nothing measured (an attempt
/// refused before dispatch), and stays 0. Saturates at `u32::MAX`.
pub(crate) fn measured_ms(elapsed: std::time::Duration) -> u32 {
    if elapsed.is_zero() {
        return 0;
    }
    elapsed.as_millis().clamp(1, u128::from(u32::MAX)) as u32
}

mod surface_attempt_test_view;
