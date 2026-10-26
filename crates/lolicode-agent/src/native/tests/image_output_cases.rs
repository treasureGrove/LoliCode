use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

#[tokio::test]
async fn image_output_stream_preserves_mixed_content_and_deduplicates_repeated_images() {
    let fake = Fake::start(|input| {
        let system = input["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("![说明](project-relative-path)"));
        assert!(system.contains("does not imply access to an image-generation API"));
        Reply {
            frames: vec![
                json!({"choices":[{"delta":{"content":[
                    {"type":"text","text":"第一张图片："},
                    {"type":"image_url","image_url":{"url":"https://example.com/a.png"},"alt":"结果 A"},
                    {"type":"output_text","text":"然后是本地图片："},
                    {"type":"image","path":"generated/result (2).svg","alt":"结果 B"}
                ]},"finish_reason":null}]}),
                json!({"choices":[{"delta":{"images":[
                    {"image_url":{"url":"https://example.com/a.png"}},
                    {"url":"https://example.com/c.png"}
                ]},"finish_reason":null}]}),
                json!({"choices":[{"delta":{"images":[
                    {"url":"https://example.com/c.png"}
                ]},"finish_reason":"stop"}]}),
            ],
            pause: false,
            status: 200,
            json_response: false,
        }
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    send(&engine, &id, "mixed-image-output", "Show the images").await;
    let result = wait(&engine, &id, |value| {
        matches!(value["status"].as_str(), Some("idle" | "error"))
    })
    .await;
    assert_eq!(result["status"], "idle", "{}", result["error"]);
    let message = result["messages"].as_array().unwrap().last().unwrap();
    let text = message["parts"][0]["text"].as_str().unwrap();
    assert!(text.starts_with("第一张图片：\n\n![结果 A](<https://example.com/a.png>)"));
    assert!(text.contains("然后是本地图片：\n\n![结果 B](<generated/result (2).svg>)"));
    assert_eq!(text.matches("https://example.com/a.png").count(), 1);
    assert_eq!(text.matches("https://example.com/c.png").count(), 1);
    assert_eq!(fake.count(), 1);
    engine.shutdown().await.unwrap();
}

#[tokio::test]
async fn image_output_only_json_reply_finishes_and_survives_history_and_restart() {
    let mut pixels = b"\x89PNG\r\n\x1a\nfixture".to_vec();
    pixels.resize(96 * 1024, 0);
    let encoded = STANDARD.encode(pixels);
    let image = format!("data:image/png;base64,{encoded}");
    let returned_image = image.clone();
    let fake = Fake::start(move |input| {
        if input["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "assistant")
        {
            assert!(input["messages"].as_array().unwrap().iter().any(|message| {
                message["role"] == "assistant"
                    && message["content"]
                        .as_str()
                        .is_some_and(|text| text.contains("[image retained in conversation]"))
            }));
            assert!(!input["messages"].to_string().contains(&returned_image));
            assert!(!input["messages"].to_string().contains("iVBORw0KGg"));
            return text("IMAGE_HISTORY_PRESERVED");
        }
        Reply {
            frames: vec![
                json!({"choices":[{"delta":null,"message":{"role":"assistant","content":null,"images":[
                {"type":"image_url","image_url":{"url":returned_image},"alt":"生成结果"}
            ]},"finish_reason":"stop"}]}),
            ],
            pause: false,
            status: 200,
            json_response: true,
        }
    })
    .await;
    let (data, project, engine, id) = setup(&fake).await;
    send(&engine, &id, "image-only-json", "Show the generated image").await;
    let result = wait(&engine, &id, |value| {
        matches!(value["status"].as_str(), Some("idle" | "error"))
    })
    .await;
    assert_eq!(result["status"], "idle", "{}", result["error"]);
    let message = result["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(
        message["parts"][0]["text"],
        format!("\n\n![生成结果](<{image}>)\n\n")
    );
    assert_eq!(
        fake.count(),
        1,
        "an image-only reply is already a complete answer"
    );
    engine.shutdown().await.unwrap();
    let reopened = NativeEngine::open(data.path().into()).await.unwrap();
    reopened
        .bind(project.path().into(), catalog(), fake.gateway())
        .await
        .unwrap();
    assert_eq!(
        snapshot(&reopened, &id).await["messages"],
        result["messages"]
    );
    send(&reopened, &id, "image-history-followup", "Continue").await;
    let followup = wait(&reopened, &id, |value| value["status"] == "idle").await;
    assert!(followup.to_string().contains("IMAGE_HISTORY_PRESERVED"));
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn image_output_rejects_active_payloads_without_losing_valid_text() {
    let fake = Fake::start(|_| Reply {
        frames: vec![json!({"choices":[{"delta":{"content":[
            {"type":"output_text","text":"Safe answer"},
            {"type":"image_url","image_url":{"url":"javascript:alert(1)"}},
            {"type":"image","dataUrl":"data:image/svg+xml;base64,PHN2Zy8+"}
        ],"images":[{"url":"data:image/png;base64,PHNjcmlwdD4="}]},"finish_reason":"stop"}]})],
        pause: false,
        status: 200,
        json_response: false,
    })
    .await;
    let (_data, _project, engine, id) = setup(&fake).await;
    send(&engine, &id, "unsafe-image-output", "Answer").await;
    let result = wait(&engine, &id, |value| value["status"] == "idle").await;
    let message = result["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(
        message["parts"],
        json!([{"type":"text","text":"Safe answer"}])
    );
    engine.shutdown().await.unwrap();
}
