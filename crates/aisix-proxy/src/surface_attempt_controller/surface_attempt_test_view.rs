#![cfg(test)]
    use super::*;
    use aisix_gateway::{BridgeCapability, UpstreamWire, MAX_UPSTREAM_ERROR_MESSAGE_BYTES};

    /// 0 is the "not measured" sentinel on every latency field, so a
    /// measured wait under a millisecond must not collapse into it — and
    /// an unmeasured one must not leave it.
    #[test]
    fn a_measured_latency_is_at_least_one_millisecond() {
        use std::time::Duration;
        assert_eq!(measured_ms(Duration::ZERO), 0, "nothing measured");
        assert_eq!(measured_ms(Duration::from_nanos(1)), 1);
        assert_eq!(measured_ms(Duration::from_micros(400)), 1);
        assert_eq!(measured_ms(Duration::from_micros(2_700)), 2);
        assert_eq!(measured_ms(Duration::from_secs(u64::MAX)), u32::MAX);
    }

    /// One sample of every `BridgeError` variant.
    ///
    /// Hand-written, because the enum carries no reflection — but the
    /// classification below is an EXHAUSTIVE match, so a variant added to
    /// `BridgeError` stops this file compiling until someone decides which
    /// side of the network boundary it sits on and which telemetry class it
    /// reports. That is the decision this test exists to force. It does not
    /// force the sample to be added here as well; the compile error is what
    /// brings a reader to this function.
    fn bridge_error_samples() -> Vec<BridgeError> {
        vec![
            BridgeError::Timeout {
                elapsed_ms: 7167,
                cause: String::new(),
            },
            BridgeError::upstream_status(502, "bad gateway"),
            BridgeError::UpstreamDecode("unparseable body".into()),
            BridgeError::TokenExchangeDecode("unparseable token".into()),
            BridgeError::UpstreamInBand {
                status: Some(500),
                message: "overloaded".into(),
                parsed: None,
                wire: UpstreamWire::Unknown,
            },
            BridgeError::Transport("connection refused".into()),
            BridgeError::StreamAborted,
            BridgeError::Config("serialize request body: eof".into()),
            BridgeError::UnsupportedCapability(BridgeCapability::Embeddings),
            BridgeError::InvalidUpstreamConfig("model.model_name missing".into()),
            BridgeError::InvalidRequest("`functions` is not supported for this model".into()),
            BridgeError::RequestTooLarge {
                limit_bytes: 1024,
                inbound_bytes: 1000,
                downloaded_bytes: 100,
            },
            BridgeError::InvalidUpstreamCredentials("provider_key.api_key is empty".into()),
        ]
    }

    /// One vocabulary for a failure's records: the access log's and the
    /// usage event's `error_class` both name an upstream failure by
    /// its routing class, while the client's envelope keeps its own public
    /// `error.type`. The two used to differ for the same failure — the
    /// non-streamed line said `upstream_error` where the row said
    /// `upstream_status`.
    #[test]
    fn every_record_of_a_failure_names_it_with_one_class() {
        let expected = [
            ("timeout", "timeout"),
            ("upstream_status", "upstream_error"),
            ("upstream_decode", "upstream_decode_error"),
            ("upstream_decode", "upstream_decode_error"),
            ("upstream_in_band", "upstream_in_band_error"),
            ("transport", "transport_error"),
            ("stream_aborted", "stream_aborted"),
            ("config", "config_error"),
            ("config", "config_error"),
            ("invalid_config", "invalid_request_error"),
            ("invalid_request_error", "invalid_request_error"),
            ("invalid_request_error", "invalid_request_error"),
            ("invalid_credentials", "authentication_error"),
        ];
        let samples = bridge_error_samples();
        assert_eq!(samples.len(), expected.len());
        for (be, (class, envelope)) in samples.into_iter().zip(expected) {
            let routing = routing_error_class(&be);
            let err = ProxyError::Bridge(be);
            assert_eq!(error_class(&err), class, "{err:?}");
            assert_eq!(routing, class, "the attempt record: {err:?}");
            assert_eq!(access_log_error(&err).0, class, "the access log: {err:?}");
            assert_eq!(attempt_error_from_proxy(&err).0, class, "{err:?}");
            assert_eq!(
                err.kind(),
                envelope,
                "the client envelope is public API: {err:?}"
            );
        }
        // A failure only one vocabulary ever named keeps its name.
        let not_found = ProxyError::ModelNotFound("m".into());
        assert_eq!(error_class(&not_found), "model_not_found");
        assert_eq!(access_log_error(&not_found).0, "model_not_found");
    }

    /// The `aisix_deployment_*` families read as upstream health, so an
    /// error raised while the request was still being assembled has to stay
    /// out of them — and `error_class` is a telemetry label, so a variant
    /// silently minting a new series retires the one dashboards read.
    #[test]
    fn every_bridge_error_declares_its_side_of_the_network_and_its_class() {
        for err in bridge_error_samples() {
            let (reached, class) = match &err {
                // A timeout or a refused connection IS upstream health: we
                // tried to reach the provider and could not. Excluding these
                // would hide the outage the family exists to show.
                BridgeError::Timeout { .. } => (true, "timeout"),
                BridgeError::UpstreamStatus { .. } => (true, "upstream_status"),
                BridgeError::UpstreamDecode(_)
                | BridgeError::UpstreamBodyUnread { .. }
                | BridgeError::TokenExchangeDecode(_) => (true, "upstream_decode"),
                BridgeError::UpstreamInBand { .. } => (true, "upstream_in_band"),
                BridgeError::Transport(_) => (true, "transport"),
                BridgeError::StreamAborted => (true, "stream_aborted"),
                BridgeError::Config(_) => (false, "config"),
                // Raised by the `Bridge` default impl itself, so no request
                // was ever assembled — and it keeps the class `Config`
                // reports, because until #1093 it WAS a `Config`. A class of
                // its own would retire a series nothing else feeds.
                BridgeError::UnsupportedCapability(_) => (false, "config"),
                BridgeError::InvalidUpstreamConfig(_) => (false, "invalid_config"),
                BridgeError::InvalidRequest(_) => (false, "invalid_request_error"),
                BridgeError::RequestTooLarge { .. } => (false, "invalid_request_error"),
                BridgeError::InvalidUpstreamCredentials(_) => (false, "invalid_credentials"),
            };
            assert_eq!(
                routing_error_class(&err),
                class,
                "{err} reports the wrong attempt error_class"
            );
            assert_eq!(
                err.reached_upstream(),
                reached,
                "{err} is on the wrong side of the network boundary"
            );
            assert_eq!(attempt_reached_upstream(&ProxyError::Bridge(err)), reached);
        }
    }

    #[test]
    fn only_errors_that_reached_the_provider_count_as_upstream_attempts() {
        // Only the output hook can fire inside a dispatch call, so the
        // provider had already answered — the attempt did reach it.
        assert!(attempt_reached_upstream(&ProxyError::ContentFiltered {
            message: "blocked by response guardrail".into(),
            unavailable: None,
        }));
        // Gateway-side refusals never contacted anyone.
        assert!(!attempt_reached_upstream(&ProxyError::ModelNotFound(
            "nope".into()
        )));
    }

    /// Every failure names itself on its usage event, whoever wrote the text,
    /// and a guardrail refusal stays policy wording and the guardrail's name.
    #[test]
    fn gateway_error_message_carries_every_failures_text() {
        let semantic = ProxyError::SemanticDecisionFailed {
            router: "router-a".into(),
            reason: crate::surface_semantic_router::DecisionFailure::Timeout,
        };
        assert_eq!(
            gateway_error_message(&semantic),
            "semantic router 'router-a' could not pick a route (embedding_timeout)"
        );
        assert_eq!(
            gateway_error_message(&ProxyError::ModelNotFound("ghost".into())),
            "model \"ghost\" not found"
        );
        for (quoting, text) in [
            (
                ProxyError::InvalidRequest("invalid type: string \"my prompt\"".into()),
                "my prompt",
            ),
            (ProxyError::VideoNotFound("caller-id".into()), "caller-id"),
            (
                ProxyError::Bridge(BridgeError::upstream_status(502, "upstream said x")),
                "upstream said x",
            ),
        ] {
            assert!(
                gateway_error_message(&quoting).contains(text),
                "{quoting:?}"
            );
            assert_eq!(
                attempt_error_from_proxy(&quoting).1,
                gateway_error_message(&quoting),
                "an attempt row and a terminal row read the same"
            );
        }
        let refusal = crate::surface_proxy_error_view::guardrail_block_error("response", Some("g"), None);
        assert_eq!(error_class(&refusal), GUARDRAIL_BLOCK_CLASS);
        assert_eq!(
            gateway_error_message(&refusal),
            "response blocked by content policy (guardrail 'g')"
        );
    }

    /// One mapping behind every `error_source` label: an upstream failure is
    /// exactly a bridge error that reached the upstream, and no gateway
    /// refusal shares a class with one. A status decides none of it.
    #[test]
    fn error_source_follows_the_failure_and_never_its_status() {
        for err in bridge_error_samples() {
            let expected = if err.reached_upstream() {
                ErrorSource::Upstream
            } else {
                ErrorSource::Aisix
            };
            assert_eq!(error_source(&ProxyError::Bridge(err)), expected);
        }
        let upstream_429 = ProxyError::Bridge(BridgeError::upstream_status(429, "slow down"));
        let budget = ProxyError::BudgetUnverified;
        let refusal = crate::surface_proxy_error_view::guardrail_block_error("response", None, None);
        assert_eq!(error_source(&upstream_429), ErrorSource::Upstream);
        for gateway in [
            budget,
            refusal,
            ProxyError::InvalidApiKey,
            ProxyError::ModelForbidden("m".into()),
            ProxyError::ModelNotFound("m".into()),
            ProxyError::InvalidRequest("bad".into()),
            ProxyError::RequestTooLarge { limit_bytes: 1 },
            ProxyError::ProviderUnavailable,
            ProxyError::JwksUnavailable,
        ] {
            assert_eq!(error_source(&gateway), ErrorSource::Aisix, "{gateway:?}");
        }
        assert_eq!(
            error_source_of_class(crate::CLIENT_DISCONNECTED_KIND),
            ErrorSource::None
        );
        assert_eq!(error_source_of_class(""), ErrorSource::None);
        assert_eq!(error_source_of_class("tool_error"), ErrorSource::Upstream);
        for gateway_own in ["credential_error", "permission_denied", "tool_not_found"] {
            assert_eq!(error_source_of_class(gateway_own), ErrorSource::Aisix);
        }
        assert_eq!(
            error_source_of_class("rate_limit_lease_lost"),
            ErrorSource::Aisix
        );
    }

    /// A relayed failure reads like any route's upstream failure, in the three
    /// forms an upstream's answer can take.
    #[test]
    fn a_relayed_failure_reports_what_the_upstream_said() {
        assert_eq!(
            relayed_failure(500, br#"{"error":{"message":"boom"}}"#),
            ("upstream_status", "upstream returned HTTP 500: boom".into())
        );
        assert_eq!(
            relayed_failure(503, b"plain text").1,
            "upstream returned HTTP 503: plain text"
        );
        assert_eq!(
            relayed_failure(404, b"").1,
            "upstream returned HTTP 404 with no error detail in the response"
        );
        assert!(!relayed_response_failed(204));
        assert!(!relayed_response_failed(302));
        assert!(relayed_response_failed(499));
    }

    /// AISIX-Cloud#1093: the access log is the one line an operator gets
    /// per request, so EVERY failure has to name itself there.
    #[test]
    fn access_log_error_names_every_variant_not_just_bridge_ones() {
        // The cause added for #1093 has to survive into the access log —
        // it is what separates "the upstream is slow" from "we never
        // reached it", which render identically without it.
        let (kind, msg) = access_log_error(&ProxyError::Bridge(BridgeError::Timeout {
            elapsed_ms: 7167,
            cause: "tcp connect error: Connection timed out (os error 110)".into(),
        }));
        assert_eq!(kind, "timeout");
        assert_eq!(
            msg,
            "upstream request timed out after 7167ms: \
             tcp connect error: Connection timed out (os error 110)"
        );

        let not_found = ProxyError::ModelNotFound("ghost".into());
        let (kind, msg) = access_log_error(&not_found);
        assert_eq!(kind, "model_not_found");
        assert!(msg.contains("ghost"), "{msg}");
    }

    /// Control chars would break the one-line-per-request shape that makes
    /// the access log greppable.
    #[test]
    fn access_log_error_strips_control_chars_and_caps_length() {
        // U+2028/U+2029 are Zl/Zp rather than Cc, so `is_control()` alone
        // would forward them and a log viewer would break the record.
        let (_, msg) = access_log_error(&ProxyError::InvalidRequest(
            "bad\nrequest\tbody\u{2028}split\u{2029}again\r\n".into(),
        ));
        assert!(
            !msg.contains(['\n', '\r', '\t', '\u{2028}', '\u{2029}']),
            "{msg:?}"
        );
        assert!(msg.ends_with("badrequestbodysplitagain"), "{msg}");

        let long = ProxyError::InvalidRequest("x".repeat(MAX_ATTEMPT_ERROR_MESSAGE_CHARS * 2));
        let (_, msg) = access_log_error(&long);
        assert_eq!(msg.chars().count(), MAX_ATTEMPT_ERROR_MESSAGE_CHARS);
    }

    fn upstream_status(message: &str) -> BridgeError {
        BridgeError::UpstreamStatus {
            status: 400,
            message: message.to_string(),
            parsed: None,
            wire: UpstreamWire::OpenAI,
            retry_after: None,
            diagnostic: None,
        }
    }

    /// AISIX-Cloud#1065: an upstream error long enough to matter must
    /// survive into telemetry whole. A content-filter refusal — the
    /// shape that provoked the issue — runs past 256 chars, and the old
    /// cap clipped its tail, which is exactly where the actionable part
    /// (the link explaining the policy) sits. Hence a fixture that is
    /// prose ending in a URL, not a run of filler: what has to survive
    /// is the END of a realistically long message.
    #[test]
    fn long_upstream_message_is_not_clipped() {
        let upstream = "The response was filtered because the prompt triggered \
             the provider's content management policy. Please modify your prompt \
             and retry. To learn more about the content filtering policies that \
             apply here, read the documentation at \
             https://upstream.example/docs/content-filtering";
        assert!(
            upstream.len() > 256,
            "fixture must exceed the old cap to be a regression test"
        );

        let got = attempt_error_message(&upstream_status(upstream));

        assert!(
            got.ends_with("https://upstream.example/docs/content-filtering"),
            "message tail was clipped: {got}"
        );
        assert!(got.contains(upstream), "message body was altered: {got}");
    }

    /// The cap sits above the bridge's own byte bound, so anything the
    /// bridge already truncated passes through untouched — the bridge
    /// stays the single limit that fires.
    #[test]
    fn cap_clears_the_bridge_message_bound() {
        let bridge_capped = "x".repeat(MAX_UPSTREAM_ERROR_MESSAGE_BYTES);
        let got = attempt_error_message(&upstream_status(&bridge_capped));
        assert!(
            got.contains(&bridge_capped),
            "a bridge-bounded message must reach telemetry whole"
        );
    }

    /// The cap is still a backstop: a bridge variant carrying an
    /// unbounded string (`Config`, here) can't write unbounded telemetry.
    #[test]
    fn pathological_message_still_hits_the_backstop() {
        let got = attempt_error_message(&BridgeError::Config("y".repeat(9000)));
        assert_eq!(got.chars().count(), MAX_ATTEMPT_ERROR_MESSAGE_CHARS);
    }

    /// Control characters stay stripped — a multi-line upstream body
    /// must not break the single-string telemetry field.
    #[test]
    fn control_chars_are_stripped() {
        let got = attempt_error_message(&upstream_status("line one\nline\ttwo"));
        assert!(got.ends_with("line onelinetwo"), "got: {got}");
    }

    /// An upstream failure outranks a lost caller: a relay that passes a
    /// transport error on aborts the connection, which is indistinguishable
    /// from the caller leaving. Without one, a stream that did not reach its
    /// end is the caller's `499`.
    #[test]
    fn stream_status_prefers_the_upstream_failure_to_the_disconnect() {
        let failure = StreamFailure::from_bridge(&BridgeError::Timeout {
            elapsed_ms: 10,
            cause: String::new(),
        });
        assert_eq!(stream_status(false, Some(&failure)), 504);
        assert_eq!(stream_status(true, Some(&failure)), 504);
        assert_eq!(stream_status(false, None), crate::CLIENT_CLOSED_REQUEST);
        assert_eq!(stream_status(true, None), 200);
        assert_eq!(failure.error_class, "timeout");
    }

    /// The first failure is the cause; what the relay reports after it does
    /// not replace it.
    #[test]
    fn the_first_stream_failure_is_kept() {
        let mut slot = None;
        StreamFailure::record(&mut slot, &upstream_status("first"));
        StreamFailure::record(&mut slot, &BridgeError::Transport("second".into()));
        let kept = slot.unwrap();
        assert_eq!(kept.error_class, "upstream_status");
        assert!(kept.error_message.contains("first"), "{kept:?}");
    }
