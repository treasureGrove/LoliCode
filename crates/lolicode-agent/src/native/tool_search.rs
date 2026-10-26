//! Read-only discovery over the exact tool schemas supplied by the engine.
//! This module neither loads capabilities nor executes a discovered tool.
use serde_json::{json, Value};
use std::io::{self, Write};

const MAX_QUERY_BYTES: usize = 512;
const MAX_NAME_BYTES: usize = 512;
const MAX_DESCRIPTION_BYTES: usize = 4096;
const MAX_TOOL_BYTES: usize = 12 * 1024;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 10;

pub(super) fn schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "tool_search",
            "description": "Search the currently enabled tool catalog by name or keywords; all keywords must match. Returns exact names and full parameter schemas. Returned deferred tools become available in this session for direct calls or deferred_tool_call. Search does not execute tools, grant permissions, or enable disabled capabilities.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MAX_QUERY_BYTES,
                        "description": "A tool name or keywords, at most 512 UTF-8 bytes."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_LIMIT,
                        "default": DEFAULT_LIMIT
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }
    })
}

struct Match<'a> {
    name: &'a str,
    lower_name: String,
    description: &'a str,
    parameters: &'a Value,
    rank: u8,
    name_hits: usize,
    deferred: bool,
}

/// The caller must pass only the capabilities visible in this model request.
/// A match is informational and grants no authority to invoke the returned name.
pub(super) fn search(schemas: &[Value], input: &Value) -> Result<String, String> {
    let input = input.as_object().ok_or("工具参数必须是对象")?;
    if input.keys().any(|key| key != "query" && key != "limit") {
        return Err("工具包含未知参数".into());
    }
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .filter(|query| {
            query.len() <= MAX_QUERY_BYTES && !query.contains('\0') && !query.trim().is_empty()
        })
        .ok_or("工具参数 query 必须是非空字符串，最多 512 个 UTF-8 字节，且不能包含 NUL")?
        .trim();
    let limit = match input.get("limit") {
        None => DEFAULT_LIMIT,
        Some(value) => value
            .as_u64()
            .filter(|value| (1..=MAX_LIMIT as u64).contains(value))
            .ok_or("工具参数 limit 必须是 1 到 10 的整数")? as usize,
    };
    let lower_query = query.to_lowercase();
    let mut tokens: Vec<_> = lower_query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();
    // A punctuation-only query must not match every schema by an empty all().
    if tokens.is_empty() {
        tokens.push(&lower_query);
    }
    tokens.sort_unstable();
    tokens.dedup();
    let mut matches = Vec::new();
    for schema in schemas {
        if schema.get("type").and_then(Value::as_str) != Some("function") {
            continue;
        }
        let Some(function) = schema.get("function").and_then(Value::as_object) else {
            continue;
        };
        let Some(name) = function
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty() && !name.contains('\0'))
        else {
            continue;
        };
        let description = match function.get("description") {
            None => "",
            Some(Value::String(description)) => description,
            _ => continue,
        };
        let Some(parameters) = function.get("parameters").filter(|value| value.is_object()) else {
            continue;
        };
        let lower_name = name.to_lowercase();
        let lower_description = description.to_lowercase();
        if !tokens
            .iter()
            .all(|token| lower_name.contains(*token) || lower_description.contains(*token))
        {
            continue;
        }
        let name_hits = tokens
            .iter()
            .filter(|token| lower_name.contains(**token))
            .count();
        let rank = if lower_name == lower_query {
            0
        } else if lower_name.contains(&lower_query) || name_hits == tokens.len() {
            1
        } else if name_hits > 0 {
            2
        } else {
            3
        };
        matches.push(Match {
            name,
            lower_name,
            description,
            parameters,
            rank,
            name_hits,
            deferred: schema["deferred"].as_bool() == Some(true),
        });
    }
    matches.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| right.name_hits.cmp(&left.name_hits))
            .then_with(|| left.lower_name.cmp(&right.lower_name))
            .then_with(|| left.name.cmp(right.name))
            .then_with(|| left.description.cmp(right.description))
    });
    let total_matches = matches.len();
    let mut tools = Vec::new();
    let mut omitted_oversized = 0;
    for matched in matches {
        if tools.len() >= limit {
            break;
        }
        // Check before cloning: a hostile or accidental oversized parameter
        // schema must not allocate an equally large result just to be rejected.
        if matched.name.len() > MAX_NAME_BYTES
            || bounded_json(matched.parameters, MAX_TOOL_BYTES).is_none()
        {
            omitted_oversized += 1;
            continue;
        }
        let description = prefix(matched.description, MAX_DESCRIPTION_BYTES);
        let mut tool = json!({
            "name": matched.name,
            "description": description,
            "parameters": matched.parameters
        });
        if description.len() < matched.description.len() {
            tool["descriptionTruncated"] = json!(true);
        }
        if matched.deferred {
            tool["deferred"] = json!(true);
        }
        if bounded_json(&tool, MAX_TOOL_BYTES).is_none() {
            omitted_oversized += 1;
            continue;
        }
        tools.push(tool);
    }
    let message = if total_matches == 0 {
        "No matching tools are present in the catalog supplied for this request. Try a tool name or fewer keywords. This search does not execute tools or enable disabled capabilities."
    } else if tools.is_empty() {
        "Matching tools were omitted because their catalog entries exceed the output size limit. This search does not execute tools or enable disabled capabilities."
    } else {
        "These entries describe tools in the catalog supplied for this request. Returned deferred tools are available for subsequent calls in this session. This search does not execute tools or grant permissions."
    };
    let output = json!({
        "query": query,
        "tools": tools,
        "totalMatches": total_matches,
        "truncated": tools.len() < total_matches,
        "omittedOversized": omitted_oversized,
        "message": message
    });
    // Ten entries of at most 12 KiB plus the bounded query and metadata fit
    // below 128 KiB. Enforce the envelope too, including JSON escape expansion.
    bounded_json(&output, MAX_OUTPUT_BYTES).ok_or_else(|| "工具目录输出超过 128 KiB 限制".into())
}

fn prefix(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn bounded_json(value: &Value, limit: usize) -> Option<String> {
    struct Writer {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "JSON size limit",
                ));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Writer {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut writer, value).ok()?;
    String::from_utf8(writer.bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, description: &str) -> Value {
        json!({"type":"function","function":{
            "name":name,
            "description":description,
            "parameters":{"type":"object","properties":{"path":{"type":"string"}},"additionalProperties":false}
        }})
    }

    fn result(schemas: &[Value], input: Value) -> Value {
        serde_json::from_str(&search(schemas, &input).unwrap()).unwrap()
    }

    fn names(output: &Value) -> Vec<&str> {
        output["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn schema_describes_the_real_strict_read_only_contract() {
        let schema = schema();
        assert_eq!(schema["function"]["name"], "tool_search");
        let parameters = &schema["function"]["parameters"];
        assert_eq!(parameters["required"], json!(["query"]));
        assert_eq!(parameters["additionalProperties"], false);
        assert_eq!(
            parameters["properties"]["query"]["maxLength"],
            MAX_QUERY_BYTES
        );
        assert_eq!(parameters["properties"]["limit"]["minimum"], 1);
        assert_eq!(parameters["properties"]["limit"]["maximum"], MAX_LIMIT);
        assert_eq!(parameters["properties"]["limit"]["default"], DEFAULT_LIMIT);
    }

    #[test]
    fn rejects_malformed_arguments_without_coercion() {
        for input in [
            Value::Null,
            json!([]),
            json!({}),
            json!({"query":null}),
            json!({"query":12}),
            json!({"query":""}),
            json!({"query":" \n\t "}),
            json!({"query":"read\0file"}),
            json!({"query":"x".repeat(MAX_QUERY_BYTES + 1)}),
            json!({"query":"字".repeat(MAX_QUERY_BYTES / 3 + 1)}),
            json!({"query":"read", "unexpected":true}),
            json!({"query":"read", "limit":null}),
            json!({"query":"read", "limit":"2"}),
            json!({"query":"read", "limit":0}),
            json!({"query":"read", "limit":-1}),
            json!({"query":"read", "limit":11}),
            json!({"query":"read", "limit":1.5}),
        ] {
            assert!(search(&[], &input).is_err(), "accepted {input}");
        }
        assert!(search(&[], &json!({"query":"x".repeat(MAX_QUERY_BYTES)})).is_ok());
        assert!(search(&[], &json!({"query":"read", "limit":MAX_LIMIT})).is_ok());
    }

    #[test]
    fn ranks_exact_names_before_name_matches_and_descriptions_and_obeys_limits() {
        let schemas = vec![
            tool("zebra", "Use READ_FILE for text"),
            tool("z_read_file", "Read related files"),
            tool("read_file", "Read one file"),
            tool("read_file_details", "Read details"),
        ];
        let output = result(&schemas, json!({"query":" READ_FILE ","limit":2}));
        assert_eq!(names(&output), ["read_file", "read_file_details"]);
        assert_eq!(output["query"], "READ_FILE");
        assert_eq!(output["totalMatches"], 4);
        assert_eq!(output["truncated"], true);
        assert_eq!(output["omittedOversized"], 0);
        assert_eq!(
            output["tools"][0]["parameters"],
            schemas[2]["function"]["parameters"]
        );
        let all = result(&schemas, json!({"query":"read_file","limit":10}));
        assert_eq!(
            names(&all),
            ["read_file", "read_file_details", "z_read_file", "zebra"]
        );
        assert_eq!(all["truncated"], false);
        let mut reversed = schemas.clone();
        reversed.reverse();
        assert_eq!(
            search(&schemas, &json!({"query":"read_file"})),
            search(&reversed, &json!({"query":"read_file"}))
        );
    }

    #[test]
    fn matches_unicode_and_all_case_insensitive_keywords_without_searching_parameters() {
        let mut ignored_parameter = tool("irrelevant", "Unrelated operation");
        ignored_parameter["function"]["parameters"]["description"] = json!("读取 图片 FILE");
        let schemas = vec![
            tool("read_file", "Read a file"),
            tool("inspect", "Read a FILE without editing"),
            tool("图像查看", "读取项目图片并显示预览"),
            tool("Überblick", "Show an overview"),
            ignored_parameter,
        ];
        assert_eq!(
            names(&result(&schemas, json!({"query":"读取 图片"}))),
            ["图像查看"]
        );
        assert_eq!(
            names(&result(&schemas, json!({"query":"rEaD FiLe"}))),
            ["read_file", "inspect"]
        );
        assert_eq!(
            names(&result(&schemas, json!({"query":"图像查看"}))),
            ["图像查看"]
        );
        assert_eq!(
            names(&result(&schemas, json!({"query":"ÜBERBLICK"}))),
            ["Überblick"]
        );
        assert!(names(&result(&schemas, json!({"query":"read absent"}))).is_empty());
        assert!(names(&result(&schemas, json!({"query":"???"}))).is_empty());
    }

    #[test]
    fn default_limit_is_five_and_ties_have_a_stable_name_order() {
        let schemas: Vec<_> = (0..8)
            .rev()
            .map(|index| tool(&format!("tool_{index}"), "Find documents"))
            .collect();
        let input = json!({"query":"documents"});
        let output = result(&schemas, input.clone());
        assert_eq!(
            names(&output),
            ["tool_0", "tool_1", "tool_2", "tool_3", "tool_4"]
        );
        assert_eq!(output["totalMatches"], 8);
        assert_eq!(output["truncated"], true);
        assert_eq!(search(&schemas, &input), search(&schemas, &input));
    }

    #[test]
    fn searches_only_the_passed_catalog_and_never_discovers_omitted_tools() {
        let enabled = vec![tool("read_file", "Read a project file")];
        let output = result(&enabled, json!({"query":"write_file"}));
        assert_eq!(output["tools"], json!([]));
        assert_eq!(output["totalMatches"], 0);
        assert_eq!(output["truncated"], false);
        let message = output["message"].as_str().unwrap();
        assert!(message.contains("fewer keywords"));
        assert!(message.contains("does not execute tools"));
        assert!(!message.contains("MCP"));
        assert_eq!(
            names(&result(&enabled, json!({"query":"file"}))),
            ["read_file"]
        );
    }

    #[test]
    fn ignores_malformed_catalog_schemas_instead_of_inventing_parameters() {
        let schemas = vec![
            Value::Null,
            json!({"type":"other","function":{"name":"read","parameters":{}}}),
            json!({"type":"function","function":{"name":"read"}}),
            json!({"type":"function","function":{"name":"read","parameters":[]}}),
            json!({"type":"function","function":{"name":"read","description":4,"parameters":{}}}),
            json!({"type":"function","function":{"name":"read\0hidden","parameters":{}}}),
            tool("read_file", "Read project text"),
        ];
        assert_eq!(
            names(&result(&schemas, json!({"query":"read"}))),
            ["read_file"]
        );
    }

    #[test]
    fn omits_oversized_schemas_and_preserves_utf8_description_boundaries() {
        let mut oversized = tool("read", "Read oversized schema");
        oversized["function"]["parameters"]["description"] =
            json!("x".repeat(MAX_OUTPUT_BYTES * 2));
        let long_description = format!("Read {}", "图片".repeat(MAX_DESCRIPTION_BYTES));
        let schemas = vec![oversized, tool("read_small", &long_description)];
        let output = result(&schemas, json!({"query":"read","limit":1}));
        assert_eq!(names(&output), ["read_small"]);
        assert_eq!(output["totalMatches"], 2);
        assert_eq!(output["omittedOversized"], 1);
        assert_eq!(output["truncated"], true);
        assert_eq!(output["tools"][0]["descriptionTruncated"], true);
        assert!(output["tools"][0]["description"].as_str().unwrap().len() <= MAX_DESCRIPTION_BYTES);
        let only_large = result(&schemas[..1], json!({"query":"read"}));
        assert!(names(&only_large).is_empty());
        assert!(only_large["message"]
            .as_str()
            .unwrap()
            .contains("size limit"));
    }

    #[test]
    fn hard_bounds_the_serialized_result_including_json_escaping() {
        let schemas: Vec<_> = (0..MAX_LIMIT)
            .map(|index| {
                let mut schema = tool(
                    &format!("read_{index:02}"),
                    &format!("Read {}", "\u{0001}".repeat(1000)),
                );
                schema["function"]["parameters"]["description"] = json!("x".repeat(5000));
                schema
            })
            .collect();
        let encoded = search(&schemas, &json!({"query":"read","limit":10})).unwrap();
        assert!(encoded.len() <= MAX_OUTPUT_BYTES);
        let decoded: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(names(&decoded).len(), MAX_LIMIT);
        assert_eq!(decoded["truncated"], false);
        let oversized_name = tool(&format!("read{}", "x".repeat(MAX_NAME_BYTES)), "Read");
        let output = result(&[oversized_name], json!({"query":"read"}));
        assert_eq!(output["omittedOversized"], 1);
        assert!(names(&output).is_empty());
    }
}
