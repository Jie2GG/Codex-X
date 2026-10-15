use crate::error::{CodexxError, Result};
use serde::{Deserialize, Serialize};
use toml_edit::{value, DocumentMut};

const CONTEXT_WINDOW: &str = "model_context_window";
const COMPACT_TOKEN_LIMIT: &str = "model_auto_compact_token_limit";
const ONE_MILLION: i64 = 1_000_000;
const DEFAULT_COMPACT_LIMIT: i64 = 900_000;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextWindowValues {
    pub(crate) context_window: Option<i64>,
    pub(crate) compact_token_limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextWindowConfig {
    pub(crate) config_text: String,
    pub(crate) enabled: bool,
    #[serde(flatten)]
    pub(crate) values: ContextWindowValues,
}

fn read_integer(doc: &DocumentMut, key: &str) -> Result<Option<i64>> {
    doc.get(key)
        .map(|item| {
            item.as_integer()
                .ok_or_else(|| CodexxError::Config(format!("{key} 必须为整数")))
        })
        .transpose()
}

fn write_integer(doc: &mut DocumentMut, key: &str, number: i64) {
    // Keep existing inline comments and spacing when replacing a setting.
    let decor = doc
        .get(key)
        .and_then(|item| item.as_value())
        .map(|value| value.decor().clone());
    doc[key] = value(number);
    if let Some(decor) = decor {
        *doc[key].as_value_mut().expect("integer value").decor_mut() = decor;
    }
}

fn restore_integer(doc: &mut DocumentMut, key: &str, number: Option<i64>) {
    if let Some(number) = number {
        write_integer(doc, key, number);
    } else {
        doc.as_table_mut().remove(key);
    }
}

#[cfg(test)]
fn update_codex_context_window_inner(
    config_text: String,
    enabled: Option<bool>,
    previous_values: Option<ContextWindowValues>,
) -> Result<ContextWindowConfig> {
    update_codex_context_window_with_override(config_text, enabled, previous_values, None)
}

/// Edits a supplied draft only; this never reads or writes the live configuration.
/// `enabled = None` parses the checkbox state after a manual TOML edit, and
/// `context_window_override` writes an exact window discovered upstream without
/// touching the compact-token limit the 1M preset owns.
pub(crate) fn update_codex_context_window_with_override(
    config_text: String,
    enabled: Option<bool>,
    previous_values: Option<ContextWindowValues>,
    context_window_override: Option<i64>,
) -> Result<ContextWindowConfig> {
    let mut doc = config_text
        .parse::<DocumentMut>()
        .map_err(|error| CodexxError::Toml {
            path: "config.toml".to_string(),
            message: error.to_string(),
        })?;
    let context_window = read_integer(&doc, CONTEXT_WINDOW)?;
    let compact_token_limit = read_integer(&doc, COMPACT_TOKEN_LIMIT)?;

    match enabled {
        Some(true) => {
            write_integer(&mut doc, CONTEXT_WINDOW, ONE_MILLION);
            if compact_token_limit.is_none() {
                write_integer(&mut doc, COMPACT_TOKEN_LIMIT, DEFAULT_COMPACT_LIMIT);
            }
        }
        Some(false) => {
            // Only undo the 1M preset. A manual edit to either value wins.
            if context_window == Some(ONE_MILLION) {
                restore_integer(
                    &mut doc,
                    CONTEXT_WINDOW,
                    previous_values
                        .as_ref()
                        .and_then(|values| values.context_window),
                );
            }
            let expected_compact_limit = previous_values
                .as_ref()
                .and_then(|values| values.compact_token_limit)
                .unwrap_or(DEFAULT_COMPACT_LIMIT);
            if compact_token_limit == Some(expected_compact_limit) {
                restore_integer(
                    &mut doc,
                    COMPACT_TOKEN_LIMIT,
                    previous_values
                        .as_ref()
                        .and_then(|values| values.compact_token_limit),
                );
            }
        }
        None => {
            if let Some(window) = context_window_override {
                if !(1..=crate::providers::model_catalog::MAX_CONTEXT_WINDOW).contains(&window) {
                    return Err(CodexxError::Config(format!(
                        "模型上下文窗口须为 1 至 {} 之间的整数",
                        crate::providers::model_catalog::MAX_CONTEXT_WINDOW
                    )));
                }
                write_integer(&mut doc, CONTEXT_WINDOW, window);
            }
        }
    }

    let context_window = read_integer(&doc, CONTEXT_WINDOW)?;
    let compact_token_limit = read_integer(&doc, COMPACT_TOKEN_LIMIT)?;
    Ok(ContextWindowConfig {
        config_text: if enabled.is_some() || context_window_override.is_some() {
            doc.to_string()
        } else {
            config_text
        },
        enabled: context_window == Some(ONE_MILLION),
        values: ContextWindowValues {
            context_window,
            compact_token_limit,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upstream_window_writes_the_exact_value_and_keeps_everything_else() {
        let original = "# My Codex settings\nmodel = \"gpt-5.5\" # keep model\n\n[mcp_servers.notes]\ncommand = \"notes\"\n\n[model_providers.custom]\nbase_url = \"https://api.example.test/v1\"\n";
        let result =
            update_codex_context_window_with_override(original.into(), None, None, Some(200_000))
                .unwrap();
        let doc = result.config_text.parse::<DocumentMut>().unwrap();
        assert_eq!(doc[CONTEXT_WINDOW].as_integer(), Some(200_000));
        assert!(doc.get(COMPACT_TOKEN_LIMIT).is_none());
        assert_eq!(
            doc["mcp_servers"]["notes"]["command"].as_str(),
            Some("notes")
        );
        assert!(result.config_text.contains("# My Codex settings"));
        assert!(!result.enabled);

        // Re-reading a draft must never shrink or grow what is already there, and
        // an out-of-range probe result is refused instead of quietly guessed.
        let kept = update_codex_context_window_with_override(
            result.config_text.clone(),
            None,
            None,
            Some(200_000),
        )
        .unwrap();
        assert_eq!(kept.values.context_window, Some(200_000));
        for invalid in [0, -1, 10_000_001] {
            assert!(
                update_codex_context_window_with_override(
                    original.into(),
                    None,
                    None,
                    Some(invalid)
                )
                .is_err(),
                "{invalid}"
            );
        }
        let parsed =
            update_codex_context_window_with_override(original.into(), None, None, None).unwrap();
        assert_eq!(parsed.config_text, original);
        assert_eq!(parsed.values.context_window, None);
    }

    #[test]
    fn enables_at_top_level_and_preserves_unrelated_tables_and_comments() {
        let original = "# My Codex settings\nmodel = \"gpt-5.5\" # keep model\n\n[mcp_servers.notes]\ncommand = \"notes\"\nmodel_context_window = 120000\n\n[model_providers.custom]\nbase_url = \"https://api.example.test/v1\"\n";
        let result = update_codex_context_window_inner(original.into(), Some(true), None).unwrap();
        let doc = result.config_text.parse::<DocumentMut>().unwrap();
        assert_eq!(doc[CONTEXT_WINDOW].as_integer(), Some(ONE_MILLION));
        assert_eq!(
            doc[COMPACT_TOKEN_LIMIT].as_integer(),
            Some(DEFAULT_COMPACT_LIMIT)
        );
        assert_eq!(
            doc["mcp_servers"]["notes"][CONTEXT_WINDOW].as_integer(),
            Some(120000)
        );
        assert!(result.config_text.contains("# My Codex settings"));
        assert!(result
            .config_text
            .contains("model = \"gpt-5.5\" # keep model"));
        assert!(result
            .config_text
            .contains("base_url = \"https://api.example.test/v1\""));
    }

    #[test]
    fn parses_underscores_and_quoted_keys_without_reformatting_the_draft() {
        let original = "\"model_context_window\" = 1_000_000 # large\nmodel_auto_compact_token_limit = 850_000\n";
        let result = update_codex_context_window_inner(original.into(), None, None).unwrap();
        assert!(result.enabled);
        assert_eq!(result.values.compact_token_limit, Some(850000));
        assert_eq!(result.config_text, original);
    }

    #[test]
    fn ignores_context_values_in_tables_or_multiline_strings() {
        let original = "instructions = '''\nmodel_context_window = 1000000\n'''\n[profiles.large]\nmodel_context_window = 1000000\n";
        let result = update_codex_context_window_inner(original.into(), None, None).unwrap();
        assert!(!result.enabled);
        assert_eq!(result.values.context_window, None);
    }

    #[test]
    fn preserves_custom_compaction_when_enabling_and_disabling() {
        let original = "model_auto_compact_token_limit = 850000 # custom\n";
        let enabled = update_codex_context_window_inner(original.into(), Some(true), None).unwrap();
        assert_eq!(enabled.values.compact_token_limit, Some(850000));
        let disabled =
            update_codex_context_window_inner(enabled.config_text, Some(false), None).unwrap();
        assert_eq!(disabled.values.context_window, None);
        assert_eq!(disabled.config_text, original);
    }

    #[test]
    fn restores_custom_context_and_existing_default_compaction_in_same_edit() {
        let original = "model_context_window = 256000 # original\nmodel_auto_compact_token_limit = 900000 # intentional\n";
        let parsed = update_codex_context_window_inner(original.into(), None, None).unwrap();
        let enabled = update_codex_context_window_inner(original.into(), Some(true), None).unwrap();
        let disabled = update_codex_context_window_inner(
            enabled.config_text,
            Some(false),
            Some(parsed.values),
        )
        .unwrap();
        assert_eq!(disabled.config_text, original);
    }

    #[test]
    fn disabling_a_saved_preset_removes_both_default_values() {
        let original = "model = \"gpt-5.5\"\n";
        let enabled = update_codex_context_window_inner(original.into(), Some(true), None).unwrap();
        let disabled =
            update_codex_context_window_inner(enabled.config_text, Some(false), None).unwrap();
        assert_eq!(disabled.config_text, original);
        assert!(!disabled.enabled);
    }

    #[test]
    fn disabling_does_not_undo_new_manual_values() {
        let manual = "model_context_window = 500000\nmodel_auto_compact_token_limit = 420000\n";
        let result = update_codex_context_window_inner(
            manual.into(),
            Some(false),
            Some(ContextWindowValues {
                context_window: Some(256000),
                compact_token_limit: Some(200000),
            }),
        )
        .unwrap();
        assert_eq!(result.config_text, manual);
    }

    #[test]
    fn rejects_invalid_toml_and_invalid_top_level_field_types() {
        for original in [
            "[unfinished",
            "model_context_window = '1000000'",
            "model_auto_compact_token_limit = 'automatic'",
        ] {
            assert!(update_codex_context_window_inner(original.into(), Some(true), None).is_err());
        }
    }

    #[test]
    fn a_blank_draft_can_be_enabled_and_returned_to_blank() {
        let enabled = update_codex_context_window_inner(String::new(), Some(true), None).unwrap();
        assert!(enabled.enabled);
        let disabled =
            update_codex_context_window_inner(enabled.config_text, Some(false), None).unwrap();
        assert!(disabled.config_text.is_empty());
    }
}
