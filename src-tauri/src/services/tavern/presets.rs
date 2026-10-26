//! Compiled-in, locally authored cards. Adding is explicit and idempotent.
//! A read-time dialogue refresh replaces only verified, unchanged bundled
//! defaults; user edits, imported cards and existing story messages are kept.
use super::*;

#[derive(Deserialize)]
struct Definition {
    id: String,
    work: String,
    tagline: String,
    kind: String,
    card: Value,
}

#[derive(Deserialize)]
struct DialogueBaseline {
    id: String,
    fields: HashMap<String, Value>,
    world_info: Vec<Value>,
}

struct DialogueUpdate {
    previous: DialogueBaseline,
    current: Value,
}

fn dialogue_updates() -> &'static [DialogueUpdate] {
    static UPDATES: OnceLock<Vec<DialogueUpdate>> = OnceLock::new();
    UPDATES.get_or_init(|| {
        let Ok(previous) =
            serde_json::from_str::<Vec<DialogueBaseline>>(include_str!("presets-style-v1.json"))
        else {
            return Vec::new();
        };
        let Ok(current) = definitions() else {
            return Vec::new();
        };
        previous
            .into_iter()
            .filter_map(|previous| {
                let definition = current.iter().find(|item| item.id == previous.id)?;
                Some(DialogueUpdate {
                    previous,
                    current: definition.card.clone(),
                })
            })
            .collect()
    })
}

fn dialogue_field<'a>(card: &'a TavernCharacter, field: &str) -> Option<&'a str> {
    Some(match field {
        "scenario" => &card.scenario,
        "first_mes" => &card.first_mes,
        "mes_example" => &card.mes_example,
        "system_prompt" => &card.system_prompt,
        "post_history_instructions" => &card.post_history_instructions,
        "character_version" => &card.character_version,
        _ => return None,
    })
}

fn dialogue_field_mut<'a>(card: &'a mut TavernCharacter, field: &str) -> Option<&'a mut String> {
    Some(match field {
        "scenario" => &mut card.scenario,
        "first_mes" => &mut card.first_mes,
        "mes_example" => &mut card.mes_example,
        "system_prompt" => &mut card.system_prompt,
        "post_history_instructions" => &mut card.post_history_instructions,
        "character_version" => &mut card.character_version,
        _ => return None,
    })
}

fn has_default_field(character: &StoredCharacter, field: &str, previous: &Value) -> bool {
    previous.as_str().is_some_and(|text| {
        dialogue_field(&character.card, field) == Some(text)
            && character
                .raw_data
                .get("data")
                .and_then(|data| data.get(field))
                .and_then(Value::as_str)
                == Some(text)
    })
}

// Require a unique entry with the original identity. Reordered entries and
// unknown properties survive; renamed or duplicated entries are left alone.
fn world_entry_index(data: &Value, previous: &Value) -> Option<usize> {
    let entries = data.pointer("/data/character_book/entries")?.as_array()?;
    let mut matches = entries.iter().enumerate().filter(|(_, entry)| {
        entry.get("id") == previous.get("id") && entry.get("comment") == previous.get("comment")
    });
    let index = matches.next()?.0;
    matches.next().is_none().then_some(index)
}

fn has_default_world_entry(data: &Value, previous: &Value) -> bool {
    world_entry_index(data, previous).is_some_and(|index| {
        data["data"]["character_book"]["entries"][index].get("content") == previous.get("content")
    })
}

/// Overlay revised dialogue on a known bundled v1 card without persisting or
/// rebuilding it. Both representations must still match the shipped default,
/// so an edit to either the visible card or preserved source takes precedence.
pub(super) fn refresh_bundled_dialogue(character: &mut StoredCharacter) {
    if character.card.source_format != "builtin" {
        return;
    }
    let Some(preset_id) = character
        .raw_data
        .pointer("/data/extensions/lolicode/presetId")
        .and_then(Value::as_str)
    else {
        return;
    };
    if character.card.id != format!("builtin:{preset_id}") {
        return;
    }
    let Some(update) = dialogue_updates()
        .iter()
        .find(|update| update.previous.id == preset_id)
    else {
        return;
    };
    // Mark a card as v1.1 only when every field in this revision was pristine.
    // Partly customized cards still receive untouched default improvements,
    // while retaining the user's original version metadata.
    let all_defaults = update
        .previous
        .fields
        .iter()
        .all(|(field, previous)| has_default_field(character, field, previous))
        && update
            .previous
            .world_info
            .iter()
            .all(|previous| has_default_world_entry(&character.raw_data, previous));
    for (field, previous) in &update.previous.fields {
        if (field == "character_version" && !all_defaults)
            || !has_default_field(character, field, previous)
        {
            continue;
        }
        let Some(current) = update.current["data"].get(field).and_then(Value::as_str) else {
            continue;
        };
        if let Some(value) = dialogue_field_mut(&mut character.card, field) {
            *value = current.to_string();
            character.raw_data["data"][field] = json!(current);
        }
    }
    for previous in &update.previous.world_info {
        if !has_default_world_entry(&character.raw_data, previous) {
            continue;
        }
        let Some(index) = world_entry_index(&character.raw_data, previous) else {
            continue;
        };
        let Some(current_index) = world_entry_index(&update.current, previous) else {
            continue;
        };
        if let Some(current) = update.current["data"]["character_book"]["entries"][current_index]
            .get("content")
            .and_then(Value::as_str)
        {
            character.raw_data["data"]["character_book"]["entries"][index]["content"] =
                json!(current);
        }
    }
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

    fn bundled_v1(id: &str) -> StoredCharacter {
        let update = dialogue_updates()
            .iter()
            .find(|update| update.previous.id == id)
            .unwrap();
        let mut raw_data = update.current.clone();
        for (field, value) in &update.previous.fields {
            raw_data["data"][field] = value.clone();
        }
        for previous in &update.previous.world_info {
            let index = world_entry_index(&raw_data, previous).unwrap();
            raw_data["data"]["character_book"]["entries"][index]["content"] =
                previous["content"].clone();
        }
        raw_data["data"]["extensions"]["lolicode"]["presetId"] = json!(id);
        StoredCharacter {
            card: character_from_data(
                format!("builtin:{id}"),
                &raw_data["data"],
                "builtin".into(),
                false,
            )
            .unwrap(),
            raw_data,
            avatar_relative_path: None,
        }
    }

    #[test]
    fn unchanged_bundled_v1_dialogue_refreshes_once_without_rebuilding_identity() {
        let definitions = definitions().unwrap();
        assert_eq!(dialogue_updates().len(), definitions.len());
        for definition in definitions {
            let mut character = bundled_v1(&definition.id);
            character.card.imported_at = 123;
            character.card.has_avatar = true;
            character.avatar_relative_path = Some("tavern/avatars/original.png".into());
            character.raw_data["data"]["custom_extension"] = json!({"keep":[1,2,3]});
            refresh_bundled_dialogue(&mut character);
            assert_eq!(character.card.id, format!("builtin:{}", definition.id));
            assert_eq!(character.card.imported_at, 123);
            assert!(character.card.has_avatar);
            assert_eq!(
                character.avatar_relative_path.as_deref(),
                Some("tavern/avatars/original.png")
            );
            assert_eq!(
                character.raw_data["data"]["custom_extension"],
                json!({"keep":[1,2,3]})
            );
            assert_eq!(
                character.card.first_mes,
                definition.card["data"]["first_mes"]
            );
            assert_eq!(
                character.card.mes_example,
                definition.card["data"]["mes_example"]
            );
            assert_eq!(character.card.scenario, definition.card["data"]["scenario"]);
            assert_eq!(
                character.card.system_prompt,
                definition.card["data"]["system_prompt"]
            );
            assert_eq!(
                character.card.post_history_instructions,
                definition.card["data"]["post_history_instructions"]
            );
            assert_eq!(character.card.character_version, "1.1");
            let refreshed = serde_json::to_value(&character).unwrap();
            refresh_bundled_dialogue(&mut character);
            assert_eq!(serde_json::to_value(&character).unwrap(), refreshed);
        }
    }

    #[test]
    fn edits_to_either_card_representation_and_custom_versions_are_preserved() {
        for update in dialogue_updates() {
            for (field, previous) in &update.previous.fields {
                if field == "character_version" {
                    continue;
                }
                let mut visible_edit = bundled_v1(&update.previous.id);
                *dialogue_field_mut(&mut visible_edit.card, field).unwrap() = "user edit".into();
                refresh_bundled_dialogue(&mut visible_edit);
                assert_eq!(dialogue_field(&visible_edit.card, field), Some("user edit"));
                assert_eq!(visible_edit.raw_data["data"][field], *previous);
                assert_eq!(visible_edit.card.character_version, "1.0");

                let mut source_edit = bundled_v1(&update.previous.id);
                source_edit.raw_data["data"][field] = json!("source edit");
                refresh_bundled_dialogue(&mut source_edit);
                assert_eq!(dialogue_field(&source_edit.card, field), previous.as_str());
                assert_eq!(source_edit.raw_data["data"][field], "source edit");
                assert_eq!(source_edit.card.character_version, "1.0");
            }
        }
        let mut character = bundled_v1("hatsune-miku");
        character.card.character_version = "custom-2".into();
        character.raw_data["data"]["character_version"] = json!("custom-2");
        refresh_bundled_dialogue(&mut character);
        assert_eq!(character.card.character_version, "custom-2");
        assert_eq!(character.raw_data["data"]["character_version"], "custom-2");
        assert!(!character.card.system_prompt.contains("对话与简短动作交替"));
    }

    #[test]
    fn worldbook_refresh_preserves_reordering_custom_entries_and_user_edits() {
        let mut character = bundled_v1("furina");
        let entries = character.raw_data["data"]["character_book"]["entries"]
            .as_array_mut()
            .unwrap();
        entries[0]["custom"] = json!({"keep":true});
        entries[1]["content"] = json!("用户已经修改了台本设定");
        entries.push(json!({"id":99,"comment":"custom","content":"my world"}));
        entries.reverse();
        refresh_bundled_dialogue(&mut character);
        let entries = character.raw_data["data"]["character_book"]["entries"]
            .as_array()
            .unwrap();
        assert_eq!(
            entries[0],
            json!({"id":99,"comment":"custom","content":"my world"})
        );
        assert_eq!(entries[1]["content"], "用户已经修改了台本设定");
        assert_eq!(entries[2]["custom"], json!({"keep":true}));
        assert!(entries[2]["content"]
            .as_str()
            .unwrap()
            .contains("随已发生的对话发展"));
        assert_eq!(character.card.character_version, "1.0");

        let mut renamed = bundled_v1("furina");
        renamed.raw_data["data"]["character_book"]["entries"][0]["comment"] = json!("用户的条目名");
        let old_entry = renamed.raw_data["data"]["character_book"]["entries"][0].clone();
        refresh_bundled_dialogue(&mut renamed);
        assert_eq!(
            renamed.raw_data["data"]["character_book"]["entries"][0],
            old_entry
        );

        let mut duplicated = bundled_v1("furina");
        let duplicate = duplicated.raw_data["data"]["character_book"]["entries"][0].clone();
        duplicated.raw_data["data"]["character_book"]["entries"]
            .as_array_mut()
            .unwrap()
            .push(duplicate.clone());
        refresh_bundled_dialogue(&mut duplicated);
        assert_eq!(
            duplicated.raw_data["data"]["character_book"]["entries"][0],
            duplicate
        );
        assert_eq!(
            duplicated.raw_data["data"]["character_book"]["entries"][2],
            duplicate
        );
    }

    #[test]
    fn imported_unmarked_and_mismatched_characters_never_receive_bundled_updates() {
        for variant in 0..4 {
            let mut character = bundled_v1("sillyloli");
            match variant {
                0 => character.card.id = "user-import".into(),
                1 => character.card.source_format = "SillyTavern V2".into(),
                2 => character.raw_data["data"]["extensions"]["lolicode"]["presetId"] = Value::Null,
                _ => {
                    character.raw_data["data"]["extensions"]["lolicode"]["presetId"] =
                        json!("furina")
                }
            }
            let original = serde_json::to_value(&character).unwrap();
            refresh_bundled_dialogue(&mut character);
            assert_eq!(serde_json::to_value(&character).unwrap(), original);
        }
    }

    #[test]
    fn reading_old_presets_keeps_database_and_story_text_until_a_normal_write() {
        let state = AppState::new(Arc::new(crate::database::Database::memory().unwrap()));
        let character = bundled_v1("sillyloli");
        let existing = TavernStory {
            id: "existing-story".into(),
            character_id: character.card.id.clone(),
            title: "已有故事".into(),
            created_at: 1,
            updated_at: 2,
            model_id: Some("saved-model".into()),
            messages: vec![
                TavernMessage {
                    id: "old-greeting".into(),
                    role: "assistant".into(),
                    text: character.card.first_mes.clone(),
                    created_at: 1,
                    failed: false,
                },
                TavernMessage {
                    id: "user-choice".into(),
                    role: "user".into(),
                    text: "我们已经离开工坊了。".into(),
                    created_at: 2,
                    failed: false,
                },
            ],
            is_generating: false,
        };
        write_store(
            &state,
            &TavernStore {
                characters: vec![character.clone()],
                stories: vec![existing.clone()],
            },
        )
        .unwrap();
        let original_database = state.db.get_setting(STORE_KEY).unwrap();
        let read = read_store(&state).unwrap();
        assert_ne!(read.characters[0].card.first_mes, character.card.first_mes);
        assert_eq!(
            serde_json::to_value(&read.stories[0]).unwrap(),
            serde_json::to_value(&existing).unwrap()
        );
        assert_eq!(state.db.get_setting(STORE_KEY).unwrap(), original_database);
        let new_story = create_story(&state, &character.card.id, Some("新故事")).unwrap();
        assert_eq!(
            new_story.messages[0].text,
            read.characters[0].card.first_mes
        );
        let saved = read_store(&state).unwrap();
        assert_eq!(
            serde_json::to_value(&saved.stories[0]).unwrap(),
            serde_json::to_value(&existing).unwrap()
        );
        assert_eq!(saved.characters[0].card.character_version, "1.1");
    }

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
