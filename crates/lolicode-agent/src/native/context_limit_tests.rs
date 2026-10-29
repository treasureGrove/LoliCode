use super::*;

fn metadata() -> (Value, AgentModelRef) {
    (
        json!({"revision":1,"models":[{"id":"local/model","providerId":"local","modelId":"model","name":"Model","channelName":"Fixture"}]}),
        AgentModelRef {
            provider_id: "local".into(),
            model_id: "model".into(),
        },
    )
}

#[test]
fn default_local_budget_is_one_million_without_claiming_upstream_windows() {
    let (catalog, model) = metadata();
    let clean = catalog_value(catalog).unwrap();
    assert!(clean["models"][0].get("contextLimits").is_none());
    assert_eq!(
        model_context(&clean, &model, None).unwrap(),
        Some(1_000_000)
    );
    assert_eq!(
        context_choice(&clean, &model, Some(&json!(1_000_000))).unwrap(),
        Some(1_000_000)
    );
    for value in [
        json!(999999),
        json!(0),
        json!(-1),
        json!("1000000"),
        json!(1.5),
    ] {
        assert!(context_choice(&clean, &model, Some(&value)).is_err());
    }
}

#[test]
fn transport_budget_cannot_be_overridden_by_default_or_selected_windows() {
    let (mut catalog, model) = metadata();
    catalog["models"][0]["contextLimit"] = json!(1_000_000);
    catalog["models"][0]["contextLimits"] = json!([32768, 1_000_000, 2_000_000]);
    catalog["models"][0]["maxRequestBytes"] = json!(131072);
    let clean = catalog_value(catalog).unwrap();
    for choice in [None, Some(1_000_000), Some(2_000_000)] {
        assert_eq!(model_context(&clean, &model, choice).unwrap(), Some(61440));
    }
    assert_eq!(
        model_context(&clean, &model, Some(32768)).unwrap(),
        Some(32768)
    );
    assert!(model_context(&clean, &model, Some(999999)).is_err());
    for bytes in [1, 8192, 8193] {
        let mut tiny = clean.clone();
        tiny["models"][0]["maxRequestBytes"] = json!(bytes);
        assert_eq!(
            model_context(&tiny, &model, Some(1_000_000)).unwrap(),
            Some(1)
        );
    }
}

#[test]
fn optional_request_byte_limit_is_bounded_and_survives_sanitization() {
    let (catalog, _) = metadata();
    assert!(catalog_value(catalog.clone()).is_ok());
    for value in [
        Value::Null,
        json!(1),
        json!(131072),
        json!(128 * 1024 * 1024),
    ] {
        let mut input = catalog.clone();
        input["models"][0]["maxRequestBytes"] = value.clone();
        assert_eq!(
            catalog_value(input).unwrap()["models"][0]["maxRequestBytes"],
            value
        );
    }
    for value in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!("131072"),
        json!(134217729u64),
        json!(u64::MAX),
    ] {
        let mut input = catalog.clone();
        input["models"][0]["maxRequestBytes"] = value;
        assert!(catalog_value(input).is_err());
    }
}

#[test]
fn array_only_metadata_defaults_to_its_smallest_valid_window() {
    let (mut catalog, model) = metadata();
    catalog["models"][0]["contextLimits"] = json!([256000, 0, null, 128000, -1]);
    assert_eq!(model_context(&catalog, &model, None).unwrap(), Some(128000));
    assert!(context_choice(&catalog, &model, Some(&json!(1_000_000))).is_err());
    assert!(context_choice(&catalog, &model, Some(&json!(64000))).is_err());
    assert_eq!(
        context_choice(&catalog, &model, Some(&json!(256000))).unwrap(),
        Some(256000)
    );
    catalog["models"][0]["contextLimit"] = json!(32000);
    assert_eq!(model_context(&catalog, &model, None).unwrap(), Some(32000));
    assert_eq!(
        context_choice(&catalog, &model, Some(&json!(32000))).unwrap(),
        Some(32000)
    );
    assert!(context_choice(&catalog, &model, Some(&json!(64000))).is_err());
    catalog["models"][0]["contextLimit"] = json!(0);
    assert_eq!(model_context(&catalog, &model, None).unwrap(), Some(128000));
}

#[test]
fn local_budget_presets_do_not_expand_small_models_or_explicit_enums() {
    let (mut catalog, model) = metadata();
    for scalar in [Value::Null, json!(1_000_000)] {
        catalog["models"][0]["contextLimit"] = scalar;
        for limit in LOCAL_CONTEXT_BUDGETS {
            assert_eq!(
                context_choice(&catalog, &model, Some(&json!(limit))).unwrap(),
                Some(*limit)
            );
        }
        assert!(context_choice(&catalog, &model, Some(&json!(777777))).is_err());
        assert!(context_choice(&catalog, &model, Some(&json!(2_000_000))).is_err());
    }
    catalog["models"][0]["contextLimit"] = json!(32768);
    assert!(context_choice(&catalog, &model, Some(&json!(32000))).is_ok());
    assert!(context_choice(&catalog, &model, Some(&json!(32768))).is_ok());
    assert!(context_choice(&catalog, &model, Some(&json!(64000))).is_err());
    catalog["models"][0]["contextLimit"] = json!(1_000_000);
    catalog["models"][0]["contextLimits"] = json!([128000, 256000]);
    assert!(context_choice(&catalog, &model, Some(&json!(1_000_000))).is_ok());
    assert!(context_choice(&catalog, &model, Some(&json!(256000))).is_ok());
    assert!(context_choice(&catalog, &model, Some(&json!(512000))).is_err());
}

#[test]
fn generation_output_adapts_to_total_context_without_using_transport_as_model_window() {
    let (mut catalog, model) = metadata();
    catalog["models"][0]["contextLimit"] = json!(1_000_000);
    catalog["models"][0]["maxRequestBytes"] = json!(131072);
    catalog["models"][0]["outputLimit"] = json!(128000);
    let budget = model_output_budget(&catalog, &model, None).unwrap();
    assert_eq!(model_context(&catalog, &model, None).unwrap(), Some(61440));
    let messages = vec![json!({"role":"user","content":"short input"})];
    assert_eq!(
        budget.output_tokens(&messages, &[], u64::MAX).unwrap(),
        128000
    );
    assert_eq!(budget.output_tokens(&messages, &[], 2048).unwrap(), 2048);

    catalog["models"][0]["contextLimit"] = json!(32000);
    let budget = model_output_budget(&catalog, &model, None).unwrap();
    let tools = vec![
        json!({"type":"function","function":{"name":"fixture","description":"schema ".repeat(1000)}}),
    ];
    let input = context::estimated_input_tokens(&messages, &tools).unwrap();
    assert_eq!(
        budget.output_tokens(&messages, &tools, u64::MAX).unwrap(),
        32000 - input - 1000
    );
    assert!(ModelOutputBudget {
        context_limit: input + 1000,
        output_limit: 128000
    }
    .output_tokens(&messages, &tools, u64::MAX)
    .is_err());
}

#[test]
fn output_baseline_uses_declared_limit_or_32000_and_keeps_local_context_choices() {
    let (mut catalog, model) = metadata();
    for value in [Value::Null, json!(0), json!("128000"), json!(1.5)] {
        catalog["models"][0]["outputLimit"] = value;
        assert_eq!(
            model_output_budget(&catalog, &model, None)
                .unwrap()
                .output_limit,
            32000
        );
    }
    catalog["models"][0]["outputLimit"] = json!(128000);
    let budget = model_output_budget(&catalog, &model, Some(256000)).unwrap();
    assert_eq!(budget.context_limit, 256000);
    assert_eq!(budget.output_limit, 128000);
}

#[test]
fn generation_budget_requires_sixteen_tokens_without_exceeding_a_small_model_cap() {
    let messages = vec![json!({"role":"user","content":"fixture"})];
    let input = context::estimated_input_tokens(&messages, &[]).unwrap();
    for available in 0..16 {
        let budget = ModelOutputBudget {
            context_limit: input + 1000 + available,
            output_limit: 128000,
        };
        assert!(budget.output_tokens(&messages, &[], u64::MAX).is_err());
    }
    let budget = ModelOutputBudget {
        context_limit: input + 1016,
        output_limit: 128000,
    };
    assert_eq!(budget.output_tokens(&messages, &[], u64::MAX).unwrap(), 16);
    let budget = ModelOutputBudget {
        context_limit: 1_000_000,
        output_limit: 15,
    };
    assert!(budget.output_tokens(&messages, &[], u64::MAX).is_err());
}
