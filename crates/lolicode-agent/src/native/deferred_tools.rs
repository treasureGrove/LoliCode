//! Provider-independent deferred tools. Schemas keep their real callable names;
//! discovery only changes what a session advertises, never its authority.
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub(super) fn schema() -> Value {
    json!({"type":"function","function":{
        "name":"deferred_tool_call",
        "description":"Call an enabled deferred tool previously returned by tool_search in this session, using its exact name and parameter schema. It follows the same approval and plan restrictions as a direct call. Search first; unavailable or undiscovered tools cannot be invoked.",
        "parameters":{"type":"object","properties":{
            "name":{"type":"string","minLength":1,"maxLength":512},
            "input":{"type":"object"}
        },"required":["name","input"],"additionalProperties":false}
    }})
}

pub(super) fn name(schema: &Value) -> Option<&str> {
    schema["function"]["name"].as_str()
}

pub(super) fn names(schemas: &[Value]) -> BTreeSet<String> {
    schemas.iter().filter_map(name).map(str::to_owned).collect()
}

pub(super) fn visible(
    schemas: &[Value],
    deferred: &BTreeSet<String>,
    discovered: &BTreeSet<String>,
) -> Vec<Value> {
    schemas
        .iter()
        .filter(|schema| {
            name(schema).is_some_and(|name| !deferred.contains(name) || discovered.contains(name))
        })
        .cloned()
        .collect()
}

pub(super) fn unpack(input: &Value) -> Result<(&str, &Value), String> {
    let object = input
        .as_object()
        .ok_or("deferred_tool_call 参数必须是对象")?;
    if object.keys().any(|key| key != "name" && key != "input") {
        return Err("deferred_tool_call 包含未知参数".into());
    }
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty() && name.len() <= 512 && !name.contains('\0'))
        .ok_or("deferred_tool_call name 必须是有效工具真名")?;
    if matches!(name, "deferred_tool_call" | "tool_search") {
        return Err("deferred_tool_call 不能递归调用工具分发器或搜索工具".into());
    }
    let input = object
        .get("input")
        .filter(|input| input.is_object())
        .ok_or("deferred_tool_call input 必须是工具参数对象")?;
    Ok((name, input))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_wrapper_rejects_recursion_missing_or_extra_fields() {
        for input in [
            json!(null),
            json!({}),
            json!({"name":"x","input":null}),
            json!({"name":"x","input":{},"other":true}),
            json!({"name":"deferred_tool_call","input":{}}),
            json!({"name":"tool_search","input":{}}),
            json!({"name":"x\0y","input":{}}),
        ] {
            assert!(unpack(&input).is_err());
        }
        let input = json!({"name":"mcp_image_view","input":{"path":"a.png"}});
        assert_eq!(unpack(&input).unwrap(), ("mcp_image_view", &input["input"]));
    }
    #[test]
    fn visible_catalog_keeps_residents_and_only_discovered_deferred_names() {
        let all = vec![
            json!({"function":{"name":"read_file"}}),
            json!({"function":{"name":"mcp_query"}}),
        ];
        let deferred = BTreeSet::from(["mcp_query".into()]);
        assert_eq!(
            names(&visible(&all, &deferred, &BTreeSet::new())),
            BTreeSet::from(["read_file".into()])
        );
        assert_eq!(visible(&all, &deferred, &deferred), all);
    }
}
