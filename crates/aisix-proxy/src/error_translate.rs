//! Upstream-error passthrough for the OpenAI wire.
//!
//! The only remaining upstream speaks OpenAI's error taxonomy, so the
//! envelope renderer passes the upstream's own `code` through verbatim.
//!
//! Per issue #327, `error.type` itself is **not** derived per-upstream
//! — the DP renders the stable token `"upstream_error"` for any
//! upstream-originated error. The DP acts as a normalising gateway:
//! `error.type` is its closed taxonomy; the upstream's private
//! taxonomy (`upstream_test_fixture`, `ValidationException`, etc.)
//! never reaches the customer. SDKs branch on `error.type ==
//! "upstream_error"` for upstream-class detection and on
//! `error.code` for granular retry routing.

use aisix_gateway::UpstreamErrorView;

use crate::error::ErrorBody;

/// Customer-visible OpenAI-shape envelope body for an upstream error.
///
/// Caller is responsible for gating on a 4xx status — 5xx and non-4xx
/// upstream errors stay in the generic `upstream_error` envelope.
pub(crate) fn render_openai_envelope(
    view: Option<&UpstreamErrorView>,
    fallback_message: &str,
) -> ErrorBody {
    let Some(view) = view else {
        return generic(fallback_message);
    };
    let message = view
        .message
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| fallback_message.to_string());
    ErrorBody {
        message,
        // Issue #327: `error.type` is the DP's stable taxonomy, NOT
        // the upstream's. Customers branch on
        // `error.type == "upstream_error"` for upstream-class
        // detection; SDK retry granularity comes from `error.code`.
        kind: UPSTREAM_ERROR_TYPE.to_string(),
        param: view.param.clone(),
        // Same-wire: the upstream is authoritative — `code` and
        // `param` flow through unchanged, including codes that aren't
        // in any table (forward-compat for OpenAI taxonomy additions).
        code: view.code.clone(),
        budget: None,
        policy: None,
    }
}

/// DP-stable `error.type` token surfaced for any upstream-originated
/// error. See module docstring + issue #327.
const UPSTREAM_ERROR_TYPE: &str = "upstream_error";

fn generic(message: &str) -> ErrorBody {
    ErrorBody {
        message: message.to_string(),
        kind: UPSTREAM_ERROR_TYPE.to_string(),
        param: None,
        code: None,
        budget: None,
        policy: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_wire_preserves_upstream_code_and_param() {
        // The same-wire path treats the upstream as authoritative —
        // `code` and `param` flow through unchanged, including codes
        // that aren't in any table (forward-compat for OpenAI taxonomy
        // additions). `kind` is the DP-stable token, not the upstream's
        // `error.type`.
        let v = UpstreamErrorView {
            kind: Some("rate_limit_exceeded".into()),
            message: Some("hi".into()),
            code: Some("custom_code_added_yesterday".into()),
            param: Some("model".into()),
            native_body: None,
        };
        let body = render_openai_envelope(Some(&v), "fb");
        assert_eq!(body.kind, "upstream_error");
        assert_eq!(body.code.as_deref(), Some("custom_code_added_yesterday"));
        assert_eq!(body.param.as_deref(), Some("model"));
    }

    #[test]
    fn missing_view_uses_fallback_message_and_upstream_error_kind() {
        let body = render_openai_envelope(None, "raw upstream text");
        assert_eq!(body.kind, "upstream_error");
        assert_eq!(body.message, "raw upstream text");
        assert!(body.code.is_none());
    }

    #[test]
    fn missing_parsed_message_falls_back_to_raw_message() {
        let v = UpstreamErrorView {
            kind: Some("rate_limit_exceeded".into()),
            message: None,
            code: Some("rate_limit_exceeded".into()),
            param: None,
            native_body: None,
        };
        let body = render_openai_envelope(Some(&v), "raw fallback");
        assert_eq!(body.kind, "upstream_error");
        assert_eq!(body.code.as_deref(), Some("rate_limit_exceeded"));
        assert_eq!(body.message, "raw fallback");
    }
}
