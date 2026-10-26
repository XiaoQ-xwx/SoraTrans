use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::pojo::ai_result_info::AiResultInfo;

/// 单个 pattern 的送审数据：结构路径 + 样本文本 + 该组整体规模。
///
/// total / jp_count 必须一起送审：模型只看十几条样本时无法知道
/// "这组其实是两万行标识符里夹着十几行日文"，会把混合组判成纯文本或纯噪声。
#[derive(Debug, Clone, Serialize)]
pub struct AiPatternInput {
    pub id: i64,
    pub semantic: String,
    /// 该组在库中的文本行总数
    pub total: i64,
    /// 其中含日文假名/汉字等非 ASCII 字符的行数（0 表示整组都是 ASCII）
    pub jp_count: i64,
    pub samples: Vec<String>,
}

/// AI 服务配置。
/// provider: "llm"（OpenAI 兼容 chat/completions，默认）/ "jev"（TypeSafe System One 决策模型）
#[derive(Debug, Clone)]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub provider: String,
}

impl AiConfig {
    pub fn is_jev(&self) -> bool {
        self.provider.eq_ignore_ascii_case("jev")
    }
}

/// JEV 的 noul 问题返回"该陈述为真的概率"，这里以 0.5 作为可本地化的判定阈值
const JEV_LOCALIZABLE_THRESHOLD: f64 = 0.5;

/// JEV 分类题的可选类别（key 即落库的 ai_label）
const JEV_CATEGORIES: [(&str, &str); 8] = [
    ("剧情对话", "角色对白、旁白、剧情叙述等玩家阅读的语句"),
    ("角色名·专有名词", "角色名、地名、组织名等专有名词"),
    ("UI 文本", "按钮、菜单、选项、状态栏等界面文字"),
    ("系统消息", "保存/读取提示、错误提示、确认对话框等系统反馈"),
    ("数字·占位符", "纯数字、编号、占位符模板，无可翻译内容"),
    ("内部标识·哈希", "程序内部 ID、哈希、资源键名"),
    ("调试信息", "日志、断言、开发者调试输出"),
    ("资源名·其他", "文件名、字体名、着色器名、配置表结构等其余非玩家可见文本"),
];

/// 分类提示词：类别固定为枚举，localizable 表示是否为玩家可见、可安全翻译修改的文本
const SYSTEM_PROMPT: &str = r#"你是 Unity 日文游戏本地化工具中的文本分类器。用户会提供若干文本分组，每组包含：id、结构路径 semantic、该组总行数 total、其中含日文假名或汉字的行数 jp_count、若干样本 samples。请对每组判断：
1. label：语义类别，只能取以下之一："剧情对话"、"角色名·专有名词"、"UI 文本"、"系统消息"、"数字·占位符"、"内部标识·哈希"、"调试信息"、"资源名·其他"。
2. localizable：是否可本地化。该组文本是玩家可见的自然语言文本（对话、界面文字、提示信息、名称等）为 true；内部标识、哈希、调试日志、纯数字、占位符、文件名/资源名、字体名等为 false。
判断规则：样本只代表一小部分，必须结合 total 与 jp_count —— 若 jp_count 占 total 的一成以上，或样本多数是可读语句/名称，判为 true；若绝大多数行是标识符、数字、路径（jp_count 占比极低），即使个别样本是日文也判为 false。结构路径可作辅助（如路径含 m_Text 的通常是文本字段）。每组 id 必须原样返回用户提供的 id。
只输出 JSON 数组，不要输出任何其他内容，格式：[{"id":1,"label":"剧情对话","localizable":true}]"#;

/// Markdown 代码围栏（三个反引号），运行时构造以避免在源码中书写该字符
fn fence() -> String {
    char::from_u32(0x60).unwrap().to_string().repeat(3)
}

/// 单次请求的输出上限：推理型模型会先消耗大量 reasoning token，
/// 不给足预算会得到空 content（finish_reason=length）
const MAX_TOKENS: u32 = 6000;

/// 部分网关（Cloudflare 前置）会按 User-Agent 判定为爬虫并返回 error 1010，
/// 这里使用常见浏览器 UA 以避免被拦
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 创建 HTTP 客户端；一次识别任务复用同一个客户端以保留连接池（keep-alive）
pub fn new_client() -> Result<tauri_plugin_http::reqwest::Client, String> {
    tauri_plugin_http::reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

fn api_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// 构造 POST 请求；api_key 为空时（如 Ollama 本地服务）不带认证头。
/// 手工序列化 JSON 而不用 RequestBuilder::json——tauri-plugin-http 依赖的 reqwest
/// 未启用 json feature，直接调用会编译失败。
fn post_json(
    client: &tauri_plugin_http::reqwest::Client,
    url: &str,
    api_key: &str,
    body: &Value,
) -> Result<tauri_plugin_http::reqwest::RequestBuilder, String> {
    use tauri_plugin_http::reqwest::header::CONTENT_TYPE;

    let payload = serde_json::to_string(body).map_err(|e| format!("序列化请求体失败: {e}"))?;
    let mut req = client
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .body(payload);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    Ok(req)
}

/// 读取响应体：读取失败不能静默当空串，否则会掩盖真实原因
async fn read_body(resp: tauri_plugin_http::reqwest::Response) -> String {
    match resp.text().await {
        Ok(text) => text,
        Err(e) => format!("<读取响应体失败: {e}>"),
    }
}

/// 探活：发送一条极小请求，验证 base_url / api_key / model 可用
pub async fn test_connection(config: &AiConfig) -> Result<(), String> {
    if config.is_jev() {
        return test_connection_jev(config).await;
    }

    let client = new_client()?;
    let body = serde_json::json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 5,
        "temperature": 0
    });

    let resp = post_json(&client, &api_url(&config.base_url), &config.api_key, &body)?
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = resp.status();
    let text = read_body(resp).await;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), truncate(&text, 300)));
    }

    // 仅凭 2xx 不足以保证可用：还要确认返回体是 OpenAI 兼容结构
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON: {e}"))?;
    if v["choices"][0]["message"].is_null() {
        return Err(format!(
            "接口返回结构异常（缺少 choices[0].message）: {}",
            truncate(&text, 300)
        ));
    }

    Ok(())
}

/// JEV 探活：问一个 noul 问题，确认返回里带 answers.<key>.noul
async fn test_connection_jev(config: &AiConfig) -> Result<(), String> {
    let client = new_client()?;
    let body = serde_json::json!({
        "model": config.model,
        "state": "こんにちは",
        "questions": {
            "smoke": { "type": "noul", "instructions": "这段文本是日语吗？" }
        }
    });

    let resp = post_json(&client, &systemone_url(&config.base_url), &config.api_key, &body)?
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = resp.status();
    let text = read_body(resp).await;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), truncate(&text, 300)));
    }

    let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON: {e}"))?;
    if v["answers"]["smoke"]["noul"].as_f64().is_none() {
        return Err(format!(
            "接口返回结构异常（缺少 answers.smoke.noul）: {}",
            truncate(&text, 300)
        ));
    }
    Ok(())
}

/// 识别一批 pattern：返回模型给出的分类与可本地化判定
pub async fn recognize_batch(
    client: &tauri_plugin_http::reqwest::Client,
    config: &AiConfig,
    items: &[AiPatternInput],
) -> Result<Vec<AiResultInfo>, String> {
    let user_prompt =
        serde_json::to_string(items).map_err(|e| format!("序列化送审数据失败: {e}"))?;
    // 指令同时写进 system 与 user：部分 OpenAI 兼容网关（自建代理）会丢弃 system 消息，
    // 此时模型只看到数据没看到指令，会反问"要我做什么"，导致整批解析失败。
    let user_content = format!(
        "{SYSTEM_PROMPT}\n\n待判定的文本分组（JSON 数组）：\n{user_prompt}\n\n现在直接输出 JSON 数组，不要输出任何解释或 Markdown。"
    );
    let body = serde_json::json!({
        "model": config.model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_content }
        ],
        "temperature": 0,
        "max_tokens": MAX_TOKENS
    });

    let resp = post_json(client, &api_url(&config.base_url), &config.api_key, &body)?
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = resp.status();
    let text = read_body(resp).await;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), truncate(&text, 300)));
    }

    let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON: {e}"))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| format!("响应缺少 choices[0].message.content: {}", truncate(&text, 300)))?;

    if content.trim().is_empty() {
        let finish = v["choices"][0]["finish_reason"].as_str().unwrap_or("未知");
        return Err(format!(
            "模型返回了空内容（finish_reason={finish}）。若为 length 说明输出被截断，可在设置中换用非推理模型或减少每批数量"
        ));
    }

    parse_results(content)
}

fn systemone_url(base_url: &str) -> String {
    format!("{}/systemone", base_url.trim_end_matches('/'))
}

/// JEV（TypeSafe System One）批量识别。
/// 一次请求把整批 pattern 作为 state，对每组问两个问题：
///   noul   —— 是否为玩家可见、需要翻译的游戏文本（返回 0~1 概率）
///   choice —— 属于哪一类（返回选中的类别）
/// 决策模型不生成文本，因此可以一次塞进整批，延时很低。
pub async fn recognize_batch_jev(
    client: &tauri_plugin_http::reqwest::Client,
    config: &AiConfig,
    items: &[AiPatternInput],
) -> Result<Vec<AiResultInfo>, String> {
    let state = serde_json::to_value(items).map_err(|e| format!("序列化 state 失败: {e}"))?;

    let mut criteria = serde_json::Map::new();
    for (key, desc) in JEV_CATEGORIES.iter() {
        criteria.insert((*key).to_string(), Value::String((*desc).to_string()));
    }

    let mut questions = serde_json::Map::new();
    for it in items {
        // 关键：Jev 是对整个 state 做判定，问题里必须点名是哪一组（id + semantic），
        // 否则多个内容相同的问题会得到同一个答案（实测全部落在 0.44/同一类别）。
        questions.insert(
            format!("p{}_localizable", it.id),
            serde_json::json!({
                "type": "noul",
                "instructions": format!(
                    "state 中 id 为 {}、semantic 为 {} 的那一组，共 {} 行文本，其中 {} 行含日文假名或汉字；samples 是其中若干条样本。这一组是玩家可见、需要翻译修改的游戏文本（剧情对白、界面文字、提示信息、角色或物品名称等）。判定规则：若含日文的行数占比不低于一成，或样本多数是可读的语句、名称，则本陈述为真；若绝大多数行是内部标识、哈希、调试日志、纯数字、占位符、文件名、资源名、字体名、着色器名或配置表字段（即使个别样本恰好是日文），则本陈述为假。",
                    it.id, it.semantic, it.total, it.jp_count
                )
            }),
        );
        questions.insert(
            format!("p{}_label", it.id),
            serde_json::json!({
                "type": "choice",
                "instructions": format!(
                    "state 中 id 为 {}、semantic 为 {} 的那一组 samples 属于哪一类？",
                    it.id, it.semantic
                ),
                "criteria": Value::Object(criteria.clone())
            }),
        );
    }

    let body = serde_json::json!({
        "model": config.model,
        "state": state,
        "questions": Value::Object(questions)
    });

    let resp = post_json(client, &systemone_url(&config.base_url), &config.api_key, &body)?
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = resp.status();
    let text = read_body(resp).await;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), truncate(&text, 300)));
    }

    let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON: {e}"))?;
    let answers = v["answers"]
        .as_object()
        .ok_or_else(|| format!("响应缺少 answers 字段: {}", truncate(&text, 300)))?;

    let mut out = Vec::new();
    for it in items {
        let lkey = format!("p{}_localizable", it.id);
        let ckey = format!("p{}_label", it.id);
        let prob = answers.get(&lkey).and_then(|a| a["noul"].as_f64());
        let label = answers
            .get(&ckey)
            .and_then(|a| a["choice"].as_str())
            .unwrap_or("")
            .to_string();
        if let Some(pr) = prob {
            out.push(AiResultInfo {
                id: it.id,
                label,
                localizable: pr >= JEV_LOCALIZABLE_THRESHOLD,
            });
        }
    }

    if out.is_empty() {
        return Err(format!(
            "未能解析 JEV 答案（键名可能不符）: {}",
            truncate(&text, 300)
        ));
    }

    Ok(out)
}

/// 解析模型输出为 JSON 数组；容忍 Markdown 代码围栏、前后多余文本与 results 包裹对象
fn parse_results(content: &str) -> Result<Vec<AiResultInfo>, String> {
    let trimmed = content.trim();

    if let Ok(list) = serde_json::from_str::<Vec<AiResultInfo>>(trimmed) {
        return Ok(list);
    }

    let stripped = strip_code_fence(trimmed);
    if let Ok(list) = serde_json::from_str::<Vec<AiResultInfo>>(stripped) {
        return Ok(list);
    }

    if let (Some(start), Some(end)) = (trimmed.find('['), trimmed.rfind(']')) {
        if start < end {
            if let Ok(list) = serde_json::from_str::<Vec<AiResultInfo>>(&trimmed[start..=end]) {
                return Ok(list);
            }
        }
    }

    if let Ok(v) = serde_json::from_str::<Value>(stripped) {
        for key in ["results", "data", "items", "list"] {
            if let Some(Value::Array(arr)) = v.get(key) {
                if let Ok(list) =
                    serde_json::from_value::<Vec<AiResultInfo>>(Value::Array(arr.clone()))
                {
                    return Ok(list);
                }
            }
        }
    }

    Err(format!(
        "无法从模型输出解析出 JSON 数组: {}",
        truncate(trimmed, 300)
    ))
}

/// 剥离 Markdown 代码围栏（围栏 + 语言标识 ... 围栏）
fn strip_code_fence(s: &str) -> &str {
    let trimmed = s.trim();
    let fence = fence();
    if let Some(rest) = trimmed.strip_prefix(&fence) {
        let rest = rest.trim_start_matches(|c: char| c.is_ascii_alphanumeric());
        let rest = rest.trim_start();
        if let Some(stripped) = rest.strip_suffix(&fence) {
            return stripped.trim();
        }
    }
    trimmed
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}...")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_json_array() {
        let list = parse_results(r#"[{"id":1,"label":"剧情对话","localizable":true}]"#).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, 1);
        assert!(list[0].localizable);
    }

    #[test]
    fn parses_fenced_json() {
        let f = fence();
        let content = format!(
            "{f}json\n{}\n{f}",
            r#"[{"id":2,"label":"UI 文本","localizable":true}]"#
        );
        let list = parse_results(&content).unwrap();
        assert_eq!(list[0].id, 2);
        assert_eq!(list[0].label, "UI 文本");
    }

    #[test]
    fn parses_wrapped_object() {
        let list =
            parse_results(r#"{"results":[{"id":3,"label":"内部标识·哈希","localizable":false}]}"#)
                .unwrap();
        assert_eq!(list[0].id, 3);
        assert!(!list[0].localizable);
    }

    #[test]
    fn parses_with_surrounding_prose() {
        let content = format!(
            "好的，结果如下：{} 以上。",
            r#"[{"id":4,"label":"调试信息","localizable":false}]"#
        );
        let list = parse_results(&content).unwrap();
        assert_eq!(list[0].id, 4);
    }

    #[test]
    fn rejects_invalid_output() {
        assert!(parse_results("模型返回了无法解析的内容").is_err());
    }

    #[test]
    fn accepts_string_id_and_missing_fields() {
        // id 写成字符串、缺 label/localizable 时仍应解析成功（默认值兜底）
        let list = parse_results(r#"[{"id":"7"}]"#).unwrap();
        assert_eq!(list[0].id, 7);
        assert_eq!(list[0].label, "");
        assert!(!list[0].localizable);
    }
}
