//! Compiled-in, locally authored cards. Adding is explicit, idempotent, and
//! never updates an existing card or story when the bundled catalog changes.
use super::*;

#[derive(Deserialize)]
struct Definition {
    id: String,
    work: String,
    tagline: String,
    kind: String,
    card: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TavernPreset {
    pub id: String,
    pub name: String,
    pub work: String,
    pub tagline: String,
    pub kind: String,
    pub tags: Vec<String>,
    pub first_mes: String,
    pub added: bool,
}

fn definitions() -> Result<Vec<Definition>, String> {
    let definitions: Vec<Definition> = serde_json::from_str(include_str!("presets.json"))
        .map_err(|_| "内置人物卡目录无法读取".to_string())?;
    let mut ids = HashSet::new();
    for definition in &definitions {
        if definition.id.is_empty()
            || !definition
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || !ids.insert(&definition.id)
            || definition.card["spec"] != "chara_card_v2"
            || !definition.card["data"].is_object()
        {
            return Err("内置人物卡目录格式无效".into());
        }
        character_from_data(
            format!("builtin:{}", definition.id),
            &definition.card["data"],
            "builtin".into(),
            false,
        )?;
    }
    Ok(definitions)
}

pub fn preset_catalog(state: &AppState) -> Result<Vec<TavernPreset>, String> {
    let store = read_store(state)?;
    definitions()?
        .into_iter()
        .map(|definition| {
            let data = &definition.card["data"];
            Ok(TavernPreset {
                added: store
                    .characters
                    .iter()
                    .any(|item| item.card.id == format!("builtin:{}", definition.id)),
                name: string_field(data, "name"),
                tags: string_array(data, "tags"),
                first_mes: string_field(data, "first_mes"),
                id: definition.id,
                work: definition.work,
                tagline: definition.tagline,
                kind: definition.kind,
            })
        })
        .collect()
}

pub fn add_preset(state: &AppState, preset_id: &str) -> Result<TavernCharacter, String> {
    let definition = definitions()?
        .into_iter()
        .find(|item| item.id == preset_id)
        .ok_or("找不到这个预设人物")?;
    let id = format!("builtin:{preset_id}");
    let _write = store_gate().lock().map_err(|_| "酒馆存储繁忙，请重试")?;
    let mut store = read_store(state)?;
    if let Some(existing) = store.characters.iter().find(|item| item.card.id == id) {
        if existing
            .raw_data
            .pointer("/data/extensions/lolicode/presetId")
            .and_then(Value::as_str)
            != Some(preset_id)
        {
            return Err("人物卡标识已被其他角色使用，原角色未覆盖".into());
        }
        return Ok(existing.card.clone());
    }
    let mut raw_data = definition.card;
    raw_data["data"]["extensions"]["lolicode"]["presetId"] = json!(preset_id);
    let card = character_from_data(id, &raw_data["data"], "builtin".into(), false)?;
    store.characters.push(StoredCharacter {
        card: card.clone(),
        raw_data,
        avatar_relative_path: None,
    });
    write_store(state, &store)?;
    Ok(card)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn all_presets_create_complete_offline_stories_and_real_worldbook_context() {
        let state = AppState::new(Arc::new(crate::database::Database::memory().unwrap()));
        let presets = preset_catalog(&state).unwrap();
        assert!(presets.len() >= 8);
        assert!(snapshot(&state).unwrap().characters.is_empty());
        for preset in presets {
            assert!(!preset.added);
            let card = add_preset(&state, &preset.id).unwrap();
            for value in [
                &card.description,
                &card.personality,
                &card.scenario,
                &card.first_mes,
                &card.mes_example,
            ] {
                assert!(!value.trim().is_empty());
            }
            let story = create_story(&state, &card.id, None).unwrap();
            assert_eq!(story.messages[0].text, card.first_mes);
            let context = context_preview(&state, &story.id).unwrap();
            assert!(context.pre_history.contains(&card.name));
            assert!(!context.included_entries.is_empty());
            assert!(!context.post_history.is_empty());
        }
        assert!(preset_catalog(&state)
            .unwrap()
            .iter()
            .all(|item| item.added));
    }

    #[test]
    fn repeated_and_parallel_additions_preserve_user_edits_imports_and_stories() {
        let state = AppState::new(Arc::new(crate::database::Database::memory().unwrap()));
        let first = add_preset(&state, "sillyloli").unwrap();
        let story = create_story(&state, &first.id, None).unwrap();
        {
            let mut store = read_store(&state).unwrap();
            store.characters[0].card.first_mes = "user's edited greeting".into();
            store.characters[0].raw_data["data"]["custom_extension"] = json!({"keep":true});
            let mut imported = store.characters[0].clone();
            imported.card.id = "user-import".into();
            imported.card.source_format = "V2".into();
            store.characters.push(imported);
            write_store(&state, &store).unwrap();
        }
        std::thread::scope(|scope| {
            for _ in 0..12 {
                let state = &state;
                scope.spawn(move || {
                    assert_eq!(
                        add_preset(state, "sillyloli").unwrap().first_mes,
                        "user's edited greeting"
                    );
                });
            }
        });
        let stored = read_store(&state).unwrap();
        assert_eq!(stored.characters.len(), 2);
        assert_eq!(stored.stories[0].id, story.id);
        assert_eq!(stored.stories[0].messages[0].text, first.first_mes);
        assert_eq!(
            stored.characters[0].raw_data["data"]["custom_extension"]["keep"],
            true
        );
        assert!(add_preset(&state, "../../missing").is_err());
    }

    #[test]
    fn corrupt_store_and_foreign_id_collisions_are_not_replaced() {
        let state = AppState::new(Arc::new(crate::database::Database::memory().unwrap()));
        state
            .db
            .set_setting(STORE_KEY, "broken original data")
            .unwrap();
        assert!(add_preset(&state, "sillyloli").is_err());
        assert_eq!(
            state.db.get_setting(STORE_KEY).unwrap().unwrap(),
            "broken original data"
        );
        state.db.set_setting(STORE_KEY, "{}").unwrap();
        add_preset(&state, "sillyloli").unwrap();
        let mut store = read_store(&state).unwrap();
        store.characters[0].raw_data = json!({});
        write_store(&state, &store).unwrap();
        assert!(add_preset(&state, "sillyloli").is_err());
        assert_eq!(
            read_store(&state).unwrap().characters[0].raw_data,
            json!({})
        );
    }
}
