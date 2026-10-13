use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLink {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    pub category: &'static str,
    pub description: &'static str,
    pub region: &'static str,
    pub free_note: &'static str,
}
pub fn provider_catalog() -> Vec<ProviderLink> {
    vec![
        ProviderLink {
            id: "zhipu-bigmodel",
            name: "智谱 BigModel",
            url: "https://open.bigmodel.cn/",
            category: "provider",
            description: "账户控制台、模型和价格",
            region: "cn",
            free_note: "免费模型与赠送额度以你的控制台及当前模型文档为准。",
        },
        ProviderLink {
            id: "groq",
            name: "Groq",
            url: "https://console.groq.com/",
            category: "provider",
            description: "快速推理与账户限额",
            region: "global",
            free_note: "Free tier 有请求与 Token 速率限制；升级 Developer 后按量收费。",
        },
        ProviderLink {
            id: "siliconflow",
            name: "硅基流动",
            url: "https://cloud.siliconflow.cn/",
            category: "provider",
            description: "模型广场与账户余额",
            region: "cn",
            free_note: "逐个确认模型价格和账户赠送余额；不把所有模型标记为免费。",
        },
        ProviderLink {
            id: "openrouter",
            name: "OpenRouter",
            url: "https://openrouter.ai/",
            category: "provider",
            description: "多提供商模型和账户用量",
            region: "global",
            free_note: "免费模型仍有账户限额；在控制台核对你的实际方案。",
        },
        ProviderLink {
            id: "deepseek",
            name: "DeepSeek",
            url: "https://platform.deepseek.com/",
            category: "provider",
            description: "账户余额、缓存价格与 API Key",
            region: "cn",
            free_note: "以账户赠送额度和官方价格为准，模型默认按量计费。",
        },
        ProviderLink {
            id: "openrouter-free",
            name: "OpenRouter 免费模型",
            url: "https://openrouter.ai/models?max_price=0",
            category: "directory",
            description: "按零价格筛选模型",
            region: "global",
            free_note: "模型是否免费、可用及限额会变化，配置前核对详情。",
        },
        ProviderLink {
            id: "groq-limits",
            name: "Groq 免费方案限额",
            url: "https://console.groq.com/docs/rate-limits",
            category: "directory",
            description: "官方速率与免费方案说明",
            region: "global",
            free_note: "速率限制与账单免费额度不同，账户实际限制优先。",
        },
        ProviderLink {
            id: "zhipu-docs",
            name: "智谱免费模型文档",
            url: "https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash",
            category: "directory",
            description: "GLM Flash 官方模型说明",
            region: "cn",
            free_note: "请核对当前模型和账户规则；长期免费可以选择免费模式。",
        },
    ]
}
