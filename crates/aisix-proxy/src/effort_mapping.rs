use std::borrow::Cow;

use aisix_core::{EffortAction, MappedEffort, Model};
use aisix_gateway::ChatFormat;
use serde_json::{json, Value};

/// How one request's effort carrier field reads to the mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Carrier<'a> {
    /// The request sets no effort: the field is absent, `null`, or empty.
    NotSet,
    /// A present, non-empty effort.
    Value(&'a str),
    /// An effort this mapping does not act on: a carrier value that is not
    /// a string, a carrier whose enclosing object is not one, or an effort
    /// the request stated some other way. Left exactly as it arrived.
    Foreign,
}

fn read_carrier(value: Option<&Value>) -> Carrier<'_> {
    match value {
        None | Some(Value::Null) => Carrier::NotSet,
        Some(Value::String(effort)) if effort.is_empty() => Carrier::NotSet,
        Some(Value::String(effort)) => Carrier::Value(effort),
        Some(_) => Carrier::Foreign,
    }
}

fn resolve<'m>(carrier: Carrier<'_>, model: &'m Model) -> EffortAction<'m> {
    match carrier {
        Carrier::Foreign => EffortAction::Keep,
        Carrier::NotSet => model.mapped_effort(None),
        Carrier::Value(effort) => model.mapped_effort(Some(effort)),
    }
}

/// Whether the mapped value is what the request already carries, so the
/// caller's request can go upstream untouched.
fn already_sends(carrier: Carrier<'_>, mapped: &str) -> bool {
    matches!(carrier, Carrier::Value(effort) if effort == mapped)
}

/// Apply the final direct target's mapping to an OpenAI Chat Completions
/// request. The caller-owned request stays untouched so retries against a
/// different target always start from the original effort.
pub(crate) fn chat_request<'a>(request: &'a ChatFormat, model: &Model) -> Cow<'a, ChatFormat> {
    let carrier = read_carrier(request.extra.get("reasoning_effort"));
    match resolve(carrier, model) {
        EffortAction::Keep => Cow::Borrowed(request),
        EffortAction::Set(mapped) if already_sends(carrier, mapped) => Cow::Borrowed(request),
        EffortAction::Set(mapped) => {
            let mut outbound = request.clone();
            outbound
                .extra
                .insert("reasoning_effort".to_string(), mapped.into());
            Cow::Owned(outbound)
        }
        EffortAction::Remove => {
            let mut outbound = request.clone();
            outbound.extra.remove("reasoning_effort");
            Cow::Owned(outbound)
        }
    }
}

/// Apply the final direct target's mapping to an OpenAI Responses request.
pub(crate) fn responses_request<'a>(body: &'a Value, model: &Model) -> Cow<'a, Value> {
    let carrier = json_carrier(body, "reasoning", "effort");
    json_request(body, model, "reasoning", "effort", carrier).0
}

/// Read the effort one nested carrier states. A body or an enclosing value
/// that is not an object is [`Carrier::Foreign`], which keeps the request
/// borrowed rather than rewritten.
fn json_carrier<'a>(body: &'a Value, parent: &str, leaf: &str) -> Carrier<'a> {
    let Some(fields) = body.as_object() else {
        return Carrier::Foreign;
    };
    match fields.get(parent) {
        None | Some(Value::Null) => Carrier::NotSet,
        Some(Value::Object(nested)) => read_carrier(nested.get(leaf)),
        Some(_) => Carrier::Foreign,
    }
}

/// The shared body rewrite for a carrier that nests its effort one level
/// down. The parent object is created when a mapping adds an effort the
/// request did not set, and dropped again when removing the effort empties
/// it — a bare `{"reasoning": {}}` is not what the caller sent. Sibling
/// keys (`reasoning.summary`) are never touched.
fn json_request<'a>(
    body: &'a Value,
    model: &Model,
    parent: &str,
    leaf: &str,
    carrier: Carrier<'_>,
) -> (Cow<'a, Value>, MappedEffort) {
    match resolve(carrier, model) {
        EffortAction::Keep => (Cow::Borrowed(body), MappedEffort::AsWritten),
        EffortAction::Set(mapped) if already_sends(carrier, mapped) => {
            (Cow::Borrowed(body), MappedEffort::AsWritten)
        }
        EffortAction::Set(mapped) => {
            let mut outbound = body.clone();
            let root = outbound
                .as_object_mut()
                .expect("a non-object body reads as Foreign, which never reaches here");
            match root.get_mut(parent) {
                Some(Value::Object(nested)) => {
                    nested.insert(leaf.to_string(), Value::String(mapped.to_string()));
                }
                _ => {
                    root.insert(parent.to_string(), json!({leaf: mapped}));
                }
            }
            (Cow::Owned(outbound), MappedEffort::AsWritten)
        }
        EffortAction::Remove => {
            let mut outbound = body.clone();
            let root = outbound
                .as_object_mut()
                .expect("a non-object body reads as Foreign, which never reaches here");
            if let Some(Value::Object(nested)) = root.get_mut(parent) {
                nested.remove(leaf);
                if nested.is_empty() {
                    root.remove(parent);
                }
            }
            (Cow::Owned(outbound), MappedEffort::Removed)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use aisix_gateway::{ChatFormat, ChatMessage};
    use serde_json::json;

    use super::*;

    fn model() -> Model {
        serde_json::from_value(json!({
            "display_name": "glm",
            "provider": "openai",
            "model_name": "glm-5.3",
            "provider_key_id": "pk-1",
            "effort_mapping": {
                "medium": "high",
                "high": "max"
            }
        }))
        .unwrap()
    }

    /// The three reserved tokens on one map: inject when the request sets
    /// no effort, remove `medium`, and catch everything else with `*`.
    fn token_model() -> Model {
        serde_json::from_value(json!({
            "display_name": "glm",
            "provider": "openai",
            "model_name": "glm-5.3",
            "provider_key_id": "pk-1",
            "effort_mapping": {
                "": "high",
                "medium": null,
                "*": "low"
            }
        }))
        .unwrap()
    }

    fn chat_with(effort: Option<Value>) -> ChatFormat {
        let mut chat = ChatFormat::new("glm", vec![ChatMessage::user("hi")]);
        if let Some(effort) = effort {
            chat.extra.insert("reasoning_effort".to_string(), effort);
        }
        chat
    }

    #[test]
    fn maps_each_supported_request_shape_once() {
        let model = model();

        let chat = chat_with(Some(json!("medium")));
        let mapped = chat_request(&chat, &model);
        assert_eq!(mapped.extra["reasoning_effort"], "high");
        assert_eq!(chat.extra["reasoning_effort"], "medium");

        let responses = json!({"reasoning": {"effort": "medium", "summary": "auto"}});
        let mapped = responses_request(&responses, &model);
        assert_eq!(mapped["reasoning"]["effort"], "high");
        assert_eq!(mapped["reasoning"]["summary"], "auto");
    }

    #[test]
    fn does_not_chain_or_clone_for_an_unmapped_value() {
        let model = model();
        let body = json!({"reasoning": {"effort": "low"}});
        assert!(matches!(responses_request(&body, &model), Cow::Borrowed(_)));

        let body = json!({"reasoning": {"effort": "medium"}});
        let mapped = responses_request(&body, &model);
        assert_eq!(mapped["reasoning"]["effort"], "high");
    }

    #[test]
    fn leaves_a_non_string_effort_untouched() {
        let model = token_model();
        let chat = chat_with(Some(json!(3)));
        assert!(matches!(chat_request(&chat, &model), Cow::Borrowed(_)));
    }

    /// A request sets no effort when the field is absent, `null`, or empty,
    /// and the `""` entry's value is injected in all three cases.
    #[test]
    fn injects_the_not_set_entry_on_every_carrier() {
        let model = token_model();

        for absent in [None, Some(json!(null)), Some(json!(""))] {
            let chat = chat_with(absent);
            assert_eq!(
                chat_request(&chat, &model).extra["reasoning_effort"],
                "high"
            );
        }

        for body in [
            json!({}),
            json!({"reasoning": null}),
            json!({"reasoning": {"effort": null}}),
            json!({"reasoning": {"effort": ""}}),
        ] {
            assert_eq!(
                responses_request(&body, &model)["reasoning"]["effort"],
                "high"
            );
        }

        // The parent is created, and an existing one keeps its siblings.
        let body = json!({"reasoning": {"summary": "auto"}});
        let mapped = responses_request(&body, &model);
        assert_eq!(
            mapped["reasoning"],
            json!({"effort": "high", "summary": "auto"})
        );
    }

    /// A `null` value drops the leaf, and the parent with it once empty.
    #[test]
    fn removes_the_effort_field_and_an_emptied_parent() {
        let model = token_model();

        let chat = chat_with(Some(json!("medium")));
        assert!(!chat_request(&chat, &model)
            .extra
            .contains_key("reasoning_effort"));

        let body = json!({"model": "glm", "reasoning": {"effort": "medium"}});
        assert_eq!(*responses_request(&body, &model), json!({"model": "glm"}));

        let body = json!({"reasoning": {"effort": "medium", "summary": "auto"}});
        assert_eq!(
            responses_request(&body, &model)["reasoning"],
            json!({"summary": "auto"})
        );
    }

    /// `*` catches a present value with no entry of its own, loses to one
    /// that has, and never stands in for a request setting no effort.
    #[test]
    fn wildcard_applies_only_to_a_present_unlisted_value() {
        let model = token_model();

        let body = json!({"reasoning": {"effort": "xl"}});
        assert_eq!(
            responses_request(&body, &model)["reasoning"]["effort"],
            "low"
        );

        let body = json!({"reasoning": {"effort": "medium"}});
        assert!(responses_request(&body, &model).get("reasoning").is_none());

        let star_only: Model = serde_json::from_value(json!({
            "display_name": "glm",
            "provider": "openai",
            "model_name": "glm-5.3",
            "provider_key_id": "pk-1",
            "effort_mapping": {"*": "low"}
        }))
        .unwrap();
        for body in [json!({}), json!({"reasoning": {"effort": null}})] {
            assert!(matches!(
                responses_request(&body, &star_only),
                Cow::Borrowed(_)
            ));
        }
        let chat = chat_with(Some(json!("")));
        assert_eq!(
            chat_request(&chat, &star_only).extra["reasoning_effort"],
            ""
        );
    }

    /// A body that is not an object reads as `Foreign`. That is the
    /// invariant the rewrite arms' `.expect` now stands on, since the
    /// carrier is computed one function up and its type carries no tie to
    /// the body it was read from.
    #[test]
    fn a_non_object_body_is_left_alone_even_with_a_not_set_entry() {
        let model = token_model();
        for body in [json!("hi"), json!([1, 2]), json!(null), json!(3)] {
            assert!(
                matches!(responses_request(&body, &model), Cow::Borrowed(_)),
                "{body}"
            );
        }
    }

    /// `*` mapped to `null` strips the effort from every request whose
    /// value has no entry of its own, and still leaves a not-set one alone.
    #[test]
    fn wildcard_mapped_to_null_removes_every_unlisted_value() {
        let model: Model = serde_json::from_value(json!({
            "display_name": "glm",
            "provider": "openai",
            "model_name": "glm-5.3",
            "provider_key_id": "pk-1",
            "effort_mapping": {"*": null, "medium": "high"}
        }))
        .unwrap();

        let body = json!({"reasoning": {"effort": "xl", "summary": "auto"}});
        assert_eq!(
            responses_request(&body, &model)["reasoning"],
            json!({"summary": "auto"})
        );
        let body = json!({"reasoning": {"effort": "medium"}});
        assert_eq!(
            responses_request(&body, &model)["reasoning"]["effort"],
            "high"
        );
        let body = json!({});
        assert!(matches!(responses_request(&body, &model), Cow::Borrowed(_)));
    }

    /// Without a `""` entry, a request that sets no effort is untouched —
    /// an explicit `null` or `""` reaches the upstream as the caller wrote
    /// it rather than being normalized away.
    #[test]
    fn passes_a_not_set_effort_through_without_a_matching_entry() {
        let model = model();

        for effort in [json!(null), json!("")] {
            let chat = chat_with(Some(effort.clone()));
            let mapped = chat_request(&chat, &model);
            assert!(matches!(mapped, Cow::Borrowed(_)));
            assert_eq!(mapped.extra["reasoning_effort"], effort);
        }

        for body in [json!({}), json!({"reasoning": {"effort": null}})] {
            assert!(matches!(responses_request(&body, &model), Cow::Borrowed(_)));
        }
    }
}
