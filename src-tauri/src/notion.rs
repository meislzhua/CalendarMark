use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{multipart, Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const NOTION_API_BASE: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2026-03-11";
const USER_AGENT: &str = "CalendarMark/0.1.0";
const PAGE_SIZE: u64 = 100;
const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
/// 设置库中属于 CalendarMark 的唯一设置记录标题。
/// 标签等设置全部保存在这一条记录里：读取只查这一条，
/// 不会加载设置库中其他项目/工具的内容。
const NOTION_SETTINGS_PAGE_TITLE: &str = "CalendarMark 标签";
// Android 移动网络下 DNS / 建连失败比桌面更常见（切换基站、IPv6 抖动、运营商网络拦截）。
// 客户端必须显式设置超时，否则被丢弃的 SYN 包会让“发现数据集”永远停在加载状态。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionPropertyInfo {
    pub name: String,
    pub id: String,
    pub property_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionDataSourceOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionDatasetOption {
    pub database_id: String,
    pub database_title: String,
    pub data_source_id: String,
    pub data_source_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionDiscoveryResult {
    pub datasets: Vec<NotionDatasetOption>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionMappingInfo {
    pub ready: bool,
    pub title_property: Option<String>,
    pub date_property: Option<String>,
    pub content_property: Option<String>,
    pub tags_property: Option<String>,
    pub files_property: Option<String>,
    pub mood_property: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionConnectionInfo {
    pub database_id: String,
    pub database_title: String,
    pub data_source_id: String,
    pub data_source_name: String,
    pub data_sources: Vec<NotionDataSourceOption>,
    pub properties: Vec<NotionPropertyInfo>,
    pub mapping: NotionMappingInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionRemoteFile {
    pub kind: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionAttachmentRecord {
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub source_url: Option<String>,
    pub remote_id: Option<String>,
    pub remote_file: Option<NotionRemoteFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionEntryRecord {
    pub remote_id: String,
    pub data_source_id: String,
    pub date: String,
    pub title: String,
    pub content: String,
    pub tag_names: Vec<String>,
    pub mood: Option<String>,
    pub attachments: Vec<NotionAttachmentRecord>,
    pub updated_at: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionPullResult {
    pub connection: NotionConnectionInfo,
    pub entries: Vec<NotionEntryRecord>,
    pub warnings: Vec<String>,
}

/// 数据源查询条件：按日期区间和/或标签筛选（日期为 YYYY-MM-DD）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionPullQuery {
    pub date_start: Option<String>,
    pub date_end: Option<String>,
    pub tag: Option<String>,
}

fn build_query_filter(
    mapping: &NotionMappingInfo,
    query: Option<&NotionPullQuery>,
) -> Option<Value> {
    let query = query?;
    let mut conditions = Vec::new();

    if let Some(date_property) = mapping.date_property.as_deref() {
        let mut date_condition = Map::new();
        if let Some(start) = query.date_start.as_deref().filter(|v| !v.trim().is_empty()) {
            date_condition.insert("on_or_after".to_string(), json!(start));
        }
        if let Some(end) = query.date_end.as_deref().filter(|v| !v.trim().is_empty()) {
            date_condition.insert("before".to_string(), json!(end));
        }
        if !date_condition.is_empty() {
            conditions.push(json!({
                "property": date_property,
                "date": date_condition
            }));
        }
    }

    if let (Some(tags_property), Some(tag)) = (
        mapping.tags_property.as_deref(),
        query.tag.as_deref().filter(|v| !v.trim().is_empty()),
    ) {
        conditions.push(json!({
            "property": tags_property,
            "multi_select": { "contains": tag }
        }));
    }

    match conditions.len() {
        0 => None,
        1 => Some(conditions.into_iter().next()?),
        _ => Some(json!({ "and": conditions })),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionAttachmentInput {
    pub name: String,
    pub mime_type: String,
    pub data_url: String,
    pub source_url: Option<String>,
    pub remote_id: Option<String>,
    pub remote_file: Option<NotionRemoteFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionEntryInput {
    pub local_id: String,
    pub remote_id: Option<String>,
    pub date: String,
    pub title: String,
    pub content: String,
    pub tag_names: Vec<String>,
    pub mood: Option<String>,
    pub attachments: Vec<NotionAttachmentInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionPushRecord {
    pub local_id: String,
    pub remote_id: String,
    pub data_source_id: String,
    pub updated_at: String,
    pub url: Option<String>,
    pub uploaded_attachments: usize,
    /// 回传每个附件在 Notion 侧的稳定引用，前端保存后再次编辑时可直接复用，避免重复上传。
    pub attachments: Vec<NotionAttachmentRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionPushResult {
    pub connection: NotionConnectionInfo,
    pub entries: Vec<NotionPushRecord>,
    pub warnings: Vec<String>,
}

/// 设置数据库（保存标签等应用设置）的字段映射。
/// 日期数据库负责“一天一条”的日历记录；设置数据库负责应用级配置，
/// CalendarMark 只维护一条自己的记录，避免读取/影响设置库中的其他项目内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionSettingsMappingInfo {
    pub ready: bool,
    pub name_property: Option<String>,
    /// 保存标签设置 JSON 的 rich_text 属性（例如“标签”/“内容”）
    pub data_property: Option<String>,
    /// 以下三个字段仅用于读取旧版“每个标签一行”的数据做迁移
    pub color_property: Option<String>,
    pub color_property_type: Option<String>,
    pub retired_property: Option<String>,
    pub id_property: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionSettingsConnectionInfo {
    pub database_id: String,
    pub database_title: String,
    pub data_source_id: String,
    pub data_source_name: String,
    pub properties: Vec<NotionPropertyInfo>,
    pub mapping: NotionSettingsMappingInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionTagRecord {
    pub remote_id: String,
    pub tag_id: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub retired: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionSettingsPullResult {
    pub connection: NotionSettingsConnectionInfo,
    pub tags: Vec<NotionTagRecord>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionTagInput {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub retired: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionSettingsPushResult {
    pub connection: NotionSettingsConnectionInfo,
    pub tags: Vec<NotionTagRecord>,
    pub warnings: Vec<String>,
}

/// Token 连通性测试结果（GET /users/me）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionTokenTestResult {
    pub bot_name: Option<String>,
    pub workspace_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionPageOption {
    pub page_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionPageSearchResult {
    pub pages: Vec<NotionPageOption>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct PropertyDescriptor {
    name: String,
    id: String,
    property_type: String,
}

#[derive(Debug, Clone)]
struct ConnectedNotion {
    info: NotionConnectionInfo,
}

#[tauri::command]
pub async fn notion_discover_datasets(token: String) -> Result<NotionDiscoveryResult, String> {
    let client = notion_client()?;
    let token = token.trim();
    if token.is_empty() {
        return Err("请先填写 Notion Integration Token。".to_string());
    }

    let mut datasets = Vec::new();
    let mut warnings = Vec::new();
    let mut database_titles = HashMap::<String, String>::new();
    let mut seen_datasets = HashSet::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor: Option<String> = None;
    let mut batches = 0usize;

    loop {
        batches += 1;
        if batches > 1_000 {
            warnings.push("Notion 返回了超过 100,000 个数据集，已停止继续分页。".to_string());
            break;
        }

        let mut body = Map::new();
        body.insert("page_size".to_string(), json!(PAGE_SIZE));
        body.insert(
            "filter".to_string(),
            json!({ "property": "object", "value": "data_source" }),
        );
        body.insert(
            "sort".to_string(),
            json!({ "direction": "descending", "timestamp": "last_edited_time" }),
        );
        if let Some(start_cursor) = cursor.as_ref() {
            body.insert("start_cursor".to_string(), json!(start_cursor));
        }

        let response = request_json(
            &client,
            token,
            Method::POST,
            "/search",
            Some(Value::Object(body)),
        )
        .await?;

        let results = response
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        for result in results {
            if result.get("object").and_then(Value::as_str) != Some("data_source") {
                continue;
            }

            let Some(raw_data_source_id) = result.get("id").and_then(Value::as_str) else {
                warnings.push("Notion 返回了没有 ID 的数据集，已跳过。".to_string());
                continue;
            };
            let data_source_id = match normalize_uuid(raw_data_source_id, "Notion data source ID") {
                Ok(value) => value,
                Err(error) => {
                    warnings.push(error);
                    continue;
                }
            };
            let Some(raw_database_id) = parent_database_id(&result) else {
                warnings.push(format!(
                    "数据集「{}」没有返回所属 Database，已跳过。",
                    display_value(result.get("title").or_else(|| result.get("name")))
                        .unwrap_or_else(|| "未命名数据集".to_string())
                ));
                continue;
            };
            let database_id = match normalize_uuid(raw_database_id, "Notion Database ID") {
                Ok(value) => value,
                Err(error) => {
                    warnings.push(error);
                    continue;
                }
            };
            let dataset_key = format!("{database_id}:{data_source_id}");
            if !seen_datasets.insert(dataset_key) {
                continue;
            }

            let data_source_name =
                display_value(result.get("title").or_else(|| result.get("name")))
                    .unwrap_or_else(|| "未命名数据集".to_string());
            let database_title = if let Some(title) = database_titles.get(&database_id) {
                title.clone()
            } else {
                let title = match request_json(
                    &client,
                    token,
                    Method::GET,
                    &format!("/databases/{database_id}"),
                    None,
                )
                .await
                {
                    Ok(database) => display_value(database.get("title"))
                        .unwrap_or_else(|| "未命名数据库".to_string()),
                    Err(error) => {
                        warnings.push(format!(
                            "无法读取数据集「{data_source_name}」所属数据库：{error}"
                        ));
                        "未命名数据库".to_string()
                    }
                };
                database_titles.insert(database_id.clone(), title.clone());
                title
            };

            datasets.push(NotionDatasetOption {
                database_id,
                database_title,
                data_source_id,
                data_source_name,
            });
        }

        let has_more = response
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next_cursor = response
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if !has_more {
            break;
        }
        let Some(next_cursor) = next_cursor else {
            warnings.push("Notion 返回了 has_more，但没有提供下一页游标。".to_string());
            break;
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            warnings.push("Notion 返回了重复的数据集分页游标，已停止继续读取。".to_string());
            break;
        }
        cursor = Some(next_cursor);
    }

    datasets.sort_by(|left, right| {
        left.database_title
            .to_lowercase()
            .cmp(&right.database_title.to_lowercase())
            .then_with(|| {
                left.data_source_name
                    .to_lowercase()
                    .cmp(&right.data_source_name.to_lowercase())
            })
    });

    Ok(NotionDiscoveryResult { datasets, warnings })
}

#[tauri::command]
pub async fn notion_check_connection(
    token: String,
    database_id: String,
    data_source_id: Option<String>,
) -> Result<NotionConnectionInfo, String> {
    let client = notion_client()?;
    Ok(
        connect_notion(&client, &token, &database_id, data_source_id.as_deref())
            .await?
            .info,
    )
}

#[tauri::command]
pub async fn notion_pull_entries(
    token: String,
    database_id: String,
    data_source_id: Option<String>,
    query: Option<NotionPullQuery>,
) -> Result<NotionPullResult, String> {
    let client = notion_client()?;
    let connected =
        connect_notion(&client, &token, &database_id, data_source_id.as_deref()).await?;
    ensure_mapping_ready(&connected.info.mapping)?;

    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut page_batches = 0usize;

    loop {
        page_batches += 1;
        if page_batches > 1_000 {
            warnings.push("Notion 返回了超过 100,000 条记录，已停止继续分页。".to_string());
            break;
        }

        let mut body = Map::new();
        body.insert("page_size".to_string(), json!(PAGE_SIZE));
        // 数据源接口按月/按标签筛选，避免每次切换年月都全量分页拉取
        if let Some(filter) = build_query_filter(&connected.info.mapping, query.as_ref()) {
            body.insert("filter".to_string(), filter);
        }
        if let Some(value) = cursor.as_deref() {
            body.insert("start_cursor".to_string(), json!(value));
        }

        let response = request_json(
            &client,
            &token,
            Method::POST,
            &format!("/data_sources/{}/query", connected.info.data_source_id),
            Some(Value::Object(body)),
        )
        .await?;

        if let Some(results) = response.get("results").and_then(Value::as_array) {
            for page in results {
                match parse_page(page, &connected) {
                    Ok(record) => entries.push(record),
                    Err(message) => warnings.push(message),
                }
            }
        }

        let has_more = response
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next_cursor = response
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        if !has_more {
            break;
        }

        let Some(next_cursor_value) = next_cursor else {
            warnings
                .push("Notion 返回 has_more=true，但没有 next_cursor，已停止分页。".to_string());
            break;
        };
        if !seen_cursors.insert(next_cursor_value.clone()) {
            warnings.push("Notion 分页游标重复，已停止分页以避免重复读取。".to_string());
            break;
        }
        cursor = Some(next_cursor_value);
    }

    Ok(NotionPullResult {
        connection: connected.info,
        entries,
        warnings,
    })
}

#[tauri::command]
pub async fn notion_push_entries(
    token: String,
    database_id: String,
    data_source_id: Option<String>,
    entries: Vec<NotionEntryInput>,
) -> Result<NotionPushResult, String> {
    let client = notion_client()?;
    let connected =
        connect_notion(&client, &token, &database_id, data_source_id.as_deref()).await?;
    ensure_mapping_ready(&connected.info.mapping)?;

    let mut pushed = Vec::with_capacity(entries.len());
    let mut warnings = Vec::new();
    append_mapping_warnings(&connected.info.mapping, &mut warnings);

    // CalendarMark 的 Notion 语义是“每个日期只有一条记录”。
    // 远程引用可能因为本地重建、切换数据集或旧版本写入而丢失/过期，
    // 因此推送时一律先按日期查询远端页面：有则更新，无则创建；
    // 同一天已存在多条旧数据时保留最新一条并归档其余重复页。
    let mut page_id_by_date: HashMap<String, String> = HashMap::new();

    for entry in entries {
        let (properties, uploaded_attachments, attachment_refs) =
            build_page_properties(&client, &token, &connected, &entry, &mut warnings).await?;

        let cached_id = page_id_by_date
            .get(entry.date.trim())
            .cloned()
            .unwrap_or_default();
        let existing_pages = query_pages_by_date(&client, &token, &connected, &entry.date).await?;
        let requested_remote_id = entry
            .remote_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .and_then(|value| normalize_uuid(value, "Notion page ID").ok());
        let (target_page_id, duplicate_ids, reference_mismatch) =
            resolve_target_page(requested_remote_id.as_deref(), &existing_pages, &cached_id);
        if reference_mismatch {
            warnings.push(format!(
                "记录 {} 引用的 Notion 页面不属于日期 {}，已忽略该引用并按日期写入。",
                entry.local_id, entry.date
            ));
        }

        // 归档同一天的多余页面，保证“一天一条”。
        for duplicate_id in duplicate_ids {
            match archive_page_quietly(&client, &token, &duplicate_id).await {
                Ok(()) => warnings.push(format!(
                    "日期 {} 存在重复记录，已归档多余 Notion 页面 {duplicate_id}。",
                    entry.date
                )),
                Err(message) => warnings.push(format!(
                    "日期 {} 存在重复记录，但归档页面 {duplicate_id} 失败：{message}",
                    entry.date
                )),
            }
        }

        let response = if let Some(page_id) = target_page_id.as_deref() {
            page_id_by_date.insert(entry.date.trim().to_string(), page_id.to_string());
            request_json(
                &client,
                &token,
                Method::PATCH,
                &format!("/pages/{page_id}"),
                Some(json!({ "properties": properties })),
            )
            .await?
        } else {
            request_json(
                &client,
                &token,
                Method::POST,
                "/pages",
                Some(json!({
                    "parent": { "data_source_id": connected.info.data_source_id },
                    "properties": properties
                })),
            )
            .await?
        };

        let remote_id = response
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Notion 创建或更新页面成功，但响应中缺少页面 ID。".to_string())?
            .to_string();
        page_id_by_date.insert(entry.date.trim().to_string(), remote_id.clone());
        pushed.push(NotionPushRecord {
            local_id: entry.local_id,
            remote_id,
            data_source_id: connected.info.data_source_id.clone(),
            updated_at: response
                .get("last_edited_time")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            url: response
                .get("url")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            uploaded_attachments,
            attachments: attachment_refs,
        });
    }

    Ok(NotionPushResult {
        connection: connected.info,
        entries: pushed,
        warnings,
    })
}

#[tauri::command]
pub async fn notion_archive_page(token: String, page_id: String) -> Result<(), String> {
    let client = notion_client()?;
    let page_id = normalize_uuid(&page_id, "Notion page ID")?;
    request_json(
        &client,
        &token,
        Method::PATCH,
        &format!("/pages/{page_id}"),
        Some(json!({ "in_trash": true })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn notion_archive_pages_by_date(
    token: String,
    database_id: String,
    data_source_id: Option<String>,
    date: String,
) -> Result<usize, String> {
    let client = notion_client()?;
    let connected =
        connect_notion(&client, &token, &database_id, data_source_id.as_deref()).await?;
    let pages = query_pages_by_date(&client, &token, &connected, &date).await?;
    let mut archived = 0usize;
    for page in pages {
        let Some(raw_id) = page.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Ok(page_id) = normalize_uuid(raw_id, "Notion page ID") else {
            continue;
        };
        archive_page_quietly(&client, &token, &page_id).await?;
        archived += 1;
    }
    Ok(archived)
}

async fn archive_page_quietly(client: &Client, token: &str, page_id: &str) -> Result<(), String> {
    let page_id = normalize_uuid(page_id, "Notion page ID")?;
    request_json(
        client,
        token,
        Method::PATCH,
        &format!("/pages/{page_id}"),
        Some(json!({ "in_trash": true })),
    )
    .await?;
    Ok(())
}

/// “一天一条”的核心选择规则：
/// 1. 本地引用的页面如果确实属于这个日期，优先更新它；
/// 2. 否则更新该日期最近编辑的页面；
/// 3. 查询结果可能因 Notion 最终一致性缺失，回退到同批推送缓存；
/// 4. 其余同日期页面视为重复，调用方负责归档。
/// 返回 (目标页面, 需归档的重复页面, 本地引用是否与日期不匹配)。
fn resolve_target_page(
    requested_remote_id: Option<&str>,
    existing_pages: &[Value],
    cached_id: &str,
) -> (Option<String>, Vec<String>, bool) {
    let mut candidate_ids = Vec::new();
    for page in existing_pages {
        if let Some(id) = page.get("id").and_then(Value::as_str) {
            if let Ok(id) = normalize_uuid(id, "Notion page ID") {
                if !candidate_ids.contains(&id) {
                    candidate_ids.push(id);
                }
            }
        }
    }
    let cached_trimmed = cached_id.trim();
    let cached = if cached_trimmed.is_empty() {
        None
    } else {
        normalize_uuid(cached_trimmed, "Notion page ID").ok()
    };
    if let Some(cached) = cached.as_ref() {
        if !candidate_ids.contains(cached) {
            candidate_ids.push(cached.clone());
        }
    }

    let requested = requested_remote_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| normalize_uuid(value, "Notion page ID").ok());
    let mismatch = requested
        .as_ref()
        .is_some_and(|id| !candidate_ids.contains(id));

    let newest_page_id = existing_pages
        .first()
        .and_then(|page| page.get("id"))
        .and_then(Value::as_str)
        .and_then(|id| normalize_uuid(id, "Notion page ID").ok());

    let target = requested
        .filter(|id| candidate_ids.contains(id))
        .or(newest_page_id)
        .or(cached);

    let duplicates = candidate_ids
        .into_iter()
        .filter(|id| target.as_ref() != Some(id))
        .collect();
    (target, duplicates, mismatch)
}

/// 查询某个日期在 Notion 中已有的页面（最近编辑的排最前）。
/// 推送记录时先调用它，实现“修改 = 更新该日期那一条，而不是新增”。
async fn query_pages_by_date(
    client: &Client,
    token: &str,
    connected: &ConnectedNotion,
    date: &str,
) -> Result<Vec<Value>, String> {
    let date_property = connected
        .info
        .mapping
        .date_property
        .clone()
        .ok_or_else(|| "Notion 日期字段未识别，无法按日期更新记录。".to_string())?;
    if !is_date_key(date) {
        return Err(format!("日期格式无效：{date}，应为 YYYY-MM-DD。"));
    }

    let mut pages = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut batches = 0usize;

    loop {
        batches += 1;
        if batches > 1_000 {
            return Err("按日期查询 Notion 记录时分页超过限制，已停止。".to_string());
        }

        let mut body = Map::new();
        body.insert("page_size".to_string(), json!(PAGE_SIZE));
        body.insert(
            "filter".to_string(),
            json!({
                "property": date_property,
                "date": { "equals": date }
            }),
        );
        body.insert(
            "sorts".to_string(),
            json!([{
                "direction": "descending",
                "timestamp": "last_edited_time"
            }]),
        );
        if let Some(start_cursor) = cursor.as_deref() {
            body.insert("start_cursor".to_string(), json!(start_cursor));
        }

        let response = request_json(
            client,
            token,
            Method::POST,
            &format!("/data_sources/{}/query", connected.info.data_source_id),
            Some(Value::Object(body)),
        )
        .await?;

        if let Some(results) = response.get("results").and_then(Value::as_array) {
            pages.extend(results.iter().cloned());
        }
        let has_more = response
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next_cursor = response
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if !has_more {
            break;
        }
        let Some(next_cursor) = next_cursor else {
            return Err("Notion 按日期查询返回 has_more=true，但没有 next_cursor。".to_string());
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err("Notion 按日期查询的分页游标重复，已停止。".to_string());
        }
        cursor = Some(next_cursor);
    }

    Ok(pages)
}

fn page_title(page: &Value) -> String {
    if let Some(properties) = page.get("properties").and_then(Value::as_object) {
        for property in properties.values() {
            if property.get("type").and_then(Value::as_str) != Some("title") {
                continue;
            }
            if let Some(title) = property.get("title").and_then(Value::as_array) {
                let text = title
                    .iter()
                    .filter_map(|item| {
                        item.get("plain_text")
                            .or_else(|| item.get("text").and_then(|text| text.get("content")))
                            .and_then(Value::as_str)
                    })
                    .collect::<Vec<_>>()
                    .join("");
                if !text.trim().is_empty() {
                    return text;
                }
            }
        }
    }
    "未命名页面".to_string()
}

#[tauri::command]
pub async fn notion_search_pages(token: String) -> Result<NotionPageSearchResult, String> {
    let client = notion_client()?;
    let token = token.trim();
    if token.is_empty() {
        return Err("请先填写 Notion Integration Token。".to_string());
    }

    let mut pages = Vec::new();
    let mut warnings = Vec::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor: Option<String> = None;
    let mut batches = 0usize;

    loop {
        batches += 1;
        if batches > 100 {
            warnings.push("Notion 返回了超过 10,000 个页面，已停止继续分页。".to_string());
            break;
        }

        let mut body = Map::new();
        body.insert("page_size".to_string(), json!(PAGE_SIZE));
        body.insert(
            "filter".to_string(),
            json!({ "property": "object", "value": "page" }),
        );
        body.insert(
            "sort".to_string(),
            json!({ "direction": "descending", "timestamp": "last_edited_time" }),
        );
        if let Some(start_cursor) = cursor.as_ref() {
            body.insert("start_cursor".to_string(), json!(start_cursor));
        }

        let response = request_json(
            &client,
            token,
            Method::POST,
            "/search",
            Some(Value::Object(body)),
        )
        .await?;

        if let Some(results) = response.get("results").and_then(Value::as_array) {
            for page in results {
                if page.get("object").and_then(Value::as_str) != Some("page") {
                    continue;
                }
                let Some(raw_id) = page.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let page_id = match normalize_uuid(raw_id, "Notion page ID") {
                    Ok(value) => value,
                    Err(error) => {
                        warnings.push(error);
                        continue;
                    }
                };
                if pages
                    .iter()
                    .any(|item: &NotionPageOption| item.page_id == page_id)
                {
                    continue;
                }
                pages.push(NotionPageOption {
                    page_id,
                    title: page_title(page),
                });
            }
        }

        let has_more = response
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next_cursor = response
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if !has_more {
            break;
        }
        let Some(next_cursor_value) = next_cursor else {
            warnings
                .push("Notion 返回 has_more=true，但没有 next_cursor，已停止分页。".to_string());
            break;
        };
        if !seen_cursors.insert(next_cursor_value.clone()) {
            warnings.push("Notion 分页游标重复，已停止分页以避免重复读取。".to_string());
            break;
        }
        cursor = Some(next_cursor_value);
    }

    Ok(NotionPageSearchResult { pages, warnings })
}

#[tauri::command]
pub async fn notion_create_database(
    token: String,
    parent_page_id: String,
    title: String,
) -> Result<NotionConnectionInfo, String> {
    let client = notion_client()?;
    let token = token.trim();
    if token.is_empty() {
        return Err("请先填写 Notion Integration Token。".to_string());
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("请填写新数据库的名称。".to_string());
    }
    let parent_page_id = normalize_uuid(&parent_page_id, "Notion parent page ID")?;

    // Notion API 允许创建数据库，但父级必须是连接可访问的页面；
    // 这里一次性创建 CalendarMark 需要的标准 schema。
    let database = request_json(
        &client,
        token,
        Method::POST,
        "/databases",
        Some(json!({
            "parent": { "type": "page_id", "page_id": parent_page_id },
            "title": [{ "type": "text", "text": { "content": title } }],
            "properties": {
                "名称": { "title": {} },
                "日期": { "date": {} },
                "内容": { "rich_text": {} },
                "标签": { "multi_select": { "options": [] } },
                "附件": { "files": {} }
            }
        })),
    )
    .await?;

    let database_id = database
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Notion 创建数据库成功，但响应中缺少 Database ID。".to_string())?
        .to_string();

    let connected = connect_notion(&client, token, &database_id, None).await?;
    Ok(connected.info)
}

#[tauri::command]
pub async fn notion_check_settings_connection(
    token: String,
    database_id: String,
    data_source_id: Option<String>,
) -> Result<NotionSettingsConnectionInfo, String> {
    let client = notion_client()?;
    let connected =
        connect_notion(&client, &token, &database_id, data_source_id.as_deref()).await?;
    Ok(settings_connection_from(connected.info))
}

/// 测试 Integration Token：只调用一次轻量的 /users/me，
/// 成功返回机器人/工作区名称，失败（含超时、网络、无效 Token）返回可展示的错误信息。
#[tauri::command]
pub async fn notion_test_token(token: String) -> Result<NotionTokenTestResult, String> {
    let client = notion_client()?;
    let token = token.trim();
    if token.is_empty() {
        return Err("请先填写 Integration Token。".to_string());
    }
    let response = request_json(&client, token, Method::GET, "/users/me", None).await?;
    Ok(NotionTokenTestResult {
        bot_name: response
            .get("name")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        workspace_name: response
            .get("workspace_name")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

/// 测试当前数据集：完整走一遍 Database / data source 读取和 schema 映射，
/// 用于确认 Token、数据库分享、属性结构是否都可用。
#[tauri::command]
pub async fn notion_test_dataset(
    token: String,
    database_id: String,
    data_source_id: Option<String>,
) -> Result<NotionConnectionInfo, String> {
    let client = notion_client()?;
    let connected =
        connect_notion(&client, &token, &database_id, data_source_id.as_deref()).await?;
    Ok(connected.info)
}

#[tauri::command]
pub async fn notion_pull_settings(
    token: String,
    database_id: String,
    data_source_id: Option<String>,
) -> Result<NotionSettingsPullResult, String> {
    let client = notion_client()?;
    let connection =
        connect_notion_settings(&client, &token, &database_id, data_source_id.as_deref()).await?;
    ensure_settings_mapping_ready(&connection.mapping)?;

    let mut warnings = Vec::new();
    let mut tags = Vec::new();
    let records = query_settings_record_pages(&client, &token, &connection).await?;

    if let Some((page_id, page)) = records.first() {
        if records.len() > 1 {
            warnings.push(format!(
                "设置数据库中存在 {} 条「{NOTION_SETTINGS_PAGE_TITLE}」记录，已使用最近编辑的一条，其余不会被修改。",
                records.len()
            ));
        }
        let text = page
            .get("properties")
            .and_then(Value::as_object)
            .and_then(|properties| {
                property_text(
                    properties,
                    connection.mapping.data_property.as_deref(),
                    "rich_text",
                )
            })
            .unwrap_or_default();
        let updated_at = page
            .get("last_edited_time")
            .or_else(|| page.get("created_time"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match parse_settings_tags_json(&text) {
            Ok(items) => {
                tags = items
                    .into_iter()
                    .map(|item| NotionTagRecord {
                        remote_id: page_id.clone(),
                        tag_id: Some(item.id),
                        name: item.name,
                        color: item.color,
                        retired: item.retired,
                        updated_at: updated_at.clone(),
                    })
                    .collect();
            }
            Err(message) => warnings.push(format!(
                "「{NOTION_SETTINGS_PAGE_TITLE}」记录内容无法解析（{message}），本次按无标签处理。"
            )),
        }
    } else {
        // 旧版数据迁移：首次升级时读取一次“每个标签一行”的旧数据；
        // 下次保存会写入单条设置记录，旧页面不会被修改。
        let legacy = read_legacy_tag_pages(&client, &token, &connection).await?;
        if !legacy.is_empty() {
            warnings.push(format!(
                "已读取 {} 个旧版逐行标签；下次保存时会合并为一条「{NOTION_SETTINGS_PAGE_TITLE}」记录，旧页面保持不变。",
                legacy.len()
            ));
        }
        tags = legacy;
    }

    Ok(NotionSettingsPullResult {
        connection,
        tags,
        warnings,
    })
}

#[tauri::command]
pub async fn notion_push_settings(
    token: String,
    database_id: String,
    data_source_id: Option<String>,
    tags: Vec<NotionTagInput>,
) -> Result<NotionSettingsPushResult, String> {
    let client = notion_client()?;
    let connection =
        connect_notion_settings(&client, &token, &database_id, data_source_id.as_deref()).await?;
    ensure_settings_mapping_ready(&connection.mapping)?;

    let mut warnings = Vec::new();
    let clean_tags: Vec<&NotionTagInput> = tags
        .iter()
        .filter(|tag| !tag.name.trim().is_empty())
        .collect();
    let payload = settings_tags_json(&clean_tags);

    let mut properties = Map::new();
    if let Some(property_name) = connection.mapping.name_property.as_deref() {
        properties.insert(
            property_name.to_string(),
            json!({ "title": rich_text_items(NOTION_SETTINGS_PAGE_TITLE) }),
        );
    }
    if let Some(property_name) = connection.mapping.data_property.as_deref() {
        properties.insert(
            property_name.to_string(),
            json!({ "rich_text": rich_text_items(&payload) }),
        );
    }

    let records = query_settings_record_pages(&client, &token, &connection).await?;
    if records.len() > 1 {
        warnings.push(format!(
            "设置数据库中存在 {} 条「{NOTION_SETTINGS_PAGE_TITLE}」记录，已更新最近编辑的一条，其余保持不变。",
            records.len()
        ));
    }
    let response = if let Some((page_id, _)) = records.first() {
        request_json(
            &client,
            &token,
            Method::PATCH,
            &format!("/pages/{page_id}"),
            Some(json!({ "properties": properties })),
        )
        .await?
    } else {
        request_json(
            &client,
            &token,
            Method::POST,
            "/pages",
            Some(json!({
                "parent": { "data_source_id": connection.data_source_id },
                "properties": properties
            })),
        )
        .await?
    };

    let remote_id = response
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Notion 保存标签设置成功，但响应中缺少页面 ID。".to_string())?
        .to_string();
    let updated_at = response
        .get("last_edited_time")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let saved = parse_settings_tags_json(&payload)
        .unwrap_or_default()
        .into_iter()
        .map(|item| NotionTagRecord {
            remote_id: remote_id.clone(),
            tag_id: Some(item.id),
            name: item.name,
            color: item.color,
            retired: item.retired,
            updated_at: updated_at.clone(),
        })
        .collect();

    // 单条记录方案：只读写自己的「CalendarMark 标签」页面。
    // 设置库中的其他内容（其他项目/工具的行）既不会被读取，也不会被归档。

    Ok(NotionSettingsPushResult {
        connection,
        tags: saved,
        warnings,
    })
}

#[tauri::command]
pub async fn notion_create_settings_database(
    token: String,
    parent_page_id: String,
    title: String,
) -> Result<NotionSettingsConnectionInfo, String> {
    let client = notion_client()?;
    let token = token.trim();
    if token.is_empty() {
        return Err("请先填写 Notion Integration Token。".to_string());
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("请填写新数据库的名称。".to_string());
    }
    let parent_page_id = normalize_uuid(&parent_page_id, "Notion parent page ID")?;

    let database = request_json(
        &client,
        token,
        Method::POST,
        "/databases",
        Some(json!({
            "parent": { "type": "page_id", "page_id": parent_page_id },
            "title": [{ "type": "text", "text": { "content": title } }],
            "properties": {
                "名称": { "title": {} },
                "标签": { "rich_text": {} }
            }
        })),
    )
    .await?;

    let database_id = database
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Notion 创建数据库成功，但响应中缺少 Database ID。".to_string())?
        .to_string();

    let connected = connect_notion(&client, token, &database_id, None).await?;
    Ok(settings_connection_from(connected.info))
}

fn notion_client() -> Result<Client, String> {
    // `mut` 仅在 Android 分支里重新赋值，桌面端会触发 unused_mut。
    #[allow(unused_mut)]
    let mut builder = Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT);

    // Android 专属：reqwest 0.13 的 `rustls` 特性用 rustls-platform-verifier
    // 验证服务器证书。桌面平台它直接读取系统证书库，无需额外步骤；但在
    // Android 上它必须先用 Application Context 通过 JNI 初始化，并且 APK
    // 里要打包配套的 Kotlin CertificateVerifier 组件——Tauri 生成的工程
    // 两者都没有。结果是第一次 TLS 握手就在连接器里 panic，表现为所有
    // 远程 API 请求直接失败（浏览器访问正常，桌面端也正常）。
    // 这里改用内置的 Mozilla 根证书（webpki-roots）构建 TLS 配置，完全
    // 绕开平台验证器，不再依赖 JNI / Kotlin 组件。
    #[cfg(target_os = "android")]
    {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        builder = builder.tls_backend_preconfigured(tls);
    }

    builder
        .build()
        .map_err(|error| format!("无法初始化 Notion 网络客户端：{error}"))
}

/// 展开 `std::error::Error` 的底层原因；reqwest 顶层的 Display 只显示
/// "error sending request for url (...)"，真正的 DNS/连接错误藏在 source 链里。
fn root_cause(error: &(dyn std::error::Error + '_)) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(error) = source {
        message = error.to_string();
        source = error.source();
    }
    message
}

/// 把网络层失败翻译成用户能定位的提示，并写入日志（Android 上经 tauri-plugin-log 进入 logcat）。
fn request_error_message(action: &str, error: &reqwest::Error) -> String {
    let detail = root_cause(error);
    let mut message = if detail.is_empty() || detail == error.to_string() {
        format!("{action}：{error}")
    } else {
        format!("{action}：{error}（原因：{detail}）")
    };
    if error.is_connect() {
        message.push_str(
            "。无法建立到 api.notion.com 的连接：请确认设备网络可用；部分网络环境（如中国大陆直连）需要开启代理 / VPN 才能访问 Notion。",
        );
    } else if error.is_timeout() {
        message.push_str("。连接 Notion 超时：请切换 Wi-Fi / 移动数据，或开启代理后重试。");
    }
    log::warn!(target: "calendarmark::notion", "{message}");
    message
}

async fn connect_notion(
    client: &Client,
    token: &str,
    database_id: &str,
    requested_data_source_id: Option<&str>,
) -> Result<ConnectedNotion, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("请先填写 Notion Integration Token。".to_string());
    }
    let database_id = normalize_uuid(database_id, "Notion Database ID")?;
    let database = request_json(
        client,
        token,
        Method::GET,
        &format!("/databases/{database_id}"),
        None,
    )
    .await?;

    let source_values = database
        .get("data_sources")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Notion 没有返回 data_sources。请确认数据库已分享给该 connection，并检查 Integration 的读取内容能力。"
                .to_string()
        })?;
    if source_values.is_empty() {
        return Err("这个 Notion 数据库没有可用的 data source。".to_string());
    }

    let mut data_sources = Vec::new();
    for source in source_values {
        let Some(id) = source.get("id").and_then(Value::as_str) else {
            continue;
        };
        data_sources.push(NotionDataSourceOption {
            id: normalize_uuid(id, "Notion data source ID")?,
            name: display_value(source.get("name").or_else(|| source.get("title")))
                .unwrap_or_else(|| "未命名数据源".to_string()),
        });
    }
    if data_sources.is_empty() {
        return Err("Notion 返回的 data_sources 缺少有效 ID。".to_string());
    }

    let selected_id = if let Some(requested_id) =
        requested_data_source_id.filter(|value| !value.trim().is_empty())
    {
        let requested_id = normalize_uuid(requested_id, "Notion data source ID")?;
        if !data_sources.iter().any(|source| source.id == requested_id) {
            return Err("指定的 Notion data source 不属于这个 Database ID。".to_string());
        }
        requested_id
    } else {
        data_sources[0].id.clone()
    };

    let data_source = request_json(
        client,
        token,
        Method::GET,
        &format!("/data_sources/{selected_id}"),
        None,
    )
    .await?;
    let properties = parse_properties(&data_source)?;
    let public_properties = properties
        .iter()
        .map(|property| NotionPropertyInfo {
            name: property.name.clone(),
            id: property.id.clone(),
            property_type: property.property_type.clone(),
        })
        .collect::<Vec<_>>();
    let mapping = build_mapping(&properties);
    let selected_name = data_sources
        .iter()
        .find(|source| source.id == selected_id)
        .map(|source| source.name.clone())
        .unwrap_or_else(|| "未命名数据源".to_string());

    Ok(ConnectedNotion {
        info: NotionConnectionInfo {
            database_id,
            database_title: display_value(database.get("title"))
                .unwrap_or_else(|| "未命名数据库".to_string()),
            data_source_id: selected_id,
            data_source_name: selected_name,
            data_sources,
            properties: public_properties,
            mapping,
        },
    })
}

fn parse_properties(data_source: &Value) -> Result<Vec<PropertyDescriptor>, String> {
    let properties = data_source
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| "Notion data source 没有返回 properties schema。".to_string())?;
    Ok(properties
        .iter()
        .filter_map(|(name, value)| {
            let property_type = value.get("type")?.as_str()?.to_string();
            let id = value
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(name)
                .to_string();
            Some(PropertyDescriptor {
                name: name.clone(),
                id,
                property_type,
            })
        })
        .collect())
}

fn build_mapping(properties: &[PropertyDescriptor]) -> NotionMappingInfo {
    let title_property = choose_property(properties, "title", &["title", "标题", "name", "名称"]);
    let date_property = choose_property(properties, "date", &["date", "日期", "day", "时间"]);
    let content_property = choose_property(
        properties,
        "rich_text",
        &["content", "内容", "body", "正文", "note", "notes"],
    );
    let tags_property = choose_property(
        properties,
        "multi_select",
        &["tags", "tag", "标签", "label", "labels"],
    );
    let files_property = choose_property(
        properties,
        "files",
        &["attachments", "attachment", "files", "file", "附件", "图片"],
    );
    let mood_property = choose_property(properties, "select", &["mood", "心情", "emotion", "情绪"]);
    let ready = title_property.is_some() && date_property.is_some();
    let message = if ready {
        None
    } else {
        Some("请在 Notion data source 中至少配置一个 title 类型属性和一个 date 类型属性。Content、Tags、Files 为可选映射。".to_string())
    };

    NotionMappingInfo {
        ready,
        title_property,
        date_property,
        content_property,
        tags_property,
        files_property,
        mood_property,
        message,
    }
}

async fn connect_notion_settings(
    client: &Client,
    token: &str,
    database_id: &str,
    requested_data_source_id: Option<&str>,
) -> Result<NotionSettingsConnectionInfo, String> {
    let connected = connect_notion(client, token, database_id, requested_data_source_id).await?;
    Ok(settings_connection_from(connected.info))
}

fn settings_connection_from(info: NotionConnectionInfo) -> NotionSettingsConnectionInfo {
    let mapping = build_settings_mapping(&info.properties);
    NotionSettingsConnectionInfo {
        database_id: info.database_id,
        database_title: info.database_title,
        data_source_id: info.data_source_id,
        data_source_name: info.data_source_name,
        properties: info.properties,
        mapping,
    }
}

fn build_settings_mapping(properties: &[NotionPropertyInfo]) -> NotionSettingsMappingInfo {
    let descriptors = properties
        .iter()
        .map(|property| PropertyDescriptor {
            name: property.name.clone(),
            id: property.id.clone(),
            property_type: property.property_type.clone(),
        })
        .collect::<Vec<_>>();
    let name_property = choose_property(
        &descriptors,
        "title",
        &["name", "名称", "title", "标题", "tag", "标签"],
    );
    // 单条设置记录的 JSON 载体：优先“标签/内容/设置”，否则用第一个 rich_text 兜底
    let data_property = choose_property(
        &descriptors,
        "rich_text",
        &[
            "tags", "标签", "content", "内容", "settings", "设置", "data", "值",
        ],
    );
    // 以下三个字段仅用于读取旧版逐行标签数据
    let color_property = choose_property(&descriptors, "select", &["color", "颜色", "色彩"])
        .or_else(|| choose_property(&descriptors, "rich_text", &["color", "颜色", "色彩"]));
    let color_property_type = color_property.as_ref().map(|name| {
        properties
            .iter()
            .find(|property| &property.name == name)
            .map(|property| property.property_type.clone())
            .unwrap_or_else(|| "select".to_string())
    });
    let retired_property = choose_property(
        &descriptors,
        "checkbox",
        &["retired", "停用", "已停用", "disabled"],
    );
    let id_property = choose_property(
        &descriptors,
        "rich_text",
        &["id", "标识", "tag id", "标签id"],
    );
    let ready = name_property.is_some() && data_property.is_some();
    let message = if ready {
        None
    } else {
        Some(
            "设置数据库需要一个 title 属性（例如“名称”）和一个 rich_text 属性（例如“标签”）保存 CalendarMark 的标签设置。"
                .to_string(),
        )
    };

    NotionSettingsMappingInfo {
        ready,
        name_property,
        data_property,
        color_property,
        color_property_type,
        retired_property,
        id_property,
        message,
    }
}

fn ensure_settings_mapping_ready(mapping: &NotionSettingsMappingInfo) -> Result<(), String> {
    if mapping.ready {
        return Ok(());
    }
    Err(mapping
        .message
        .clone()
        .unwrap_or_else(|| "Notion 设置数据库字段映射不完整。".to_string()))
}

async fn query_all_data_source_pages(
    client: &Client,
    token: &str,
    data_source_id: &str,
) -> Result<Vec<Value>, String> {
    let mut pages = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut batches = 0usize;

    loop {
        batches += 1;
        if batches > 1_000 {
            return Err("读取 Notion 设置时分页超过限制，已停止。".to_string());
        }

        let mut body = Map::new();
        body.insert("page_size".to_string(), json!(PAGE_SIZE));
        body.insert(
            "sorts".to_string(),
            json!([{ "direction": "descending", "timestamp": "last_edited_time" }]),
        );
        if let Some(start_cursor) = cursor.as_deref() {
            body.insert("start_cursor".to_string(), json!(start_cursor));
        }

        let response = request_json(
            client,
            token,
            Method::POST,
            &format!("/data_sources/{data_source_id}/query"),
            Some(Value::Object(body)),
        )
        .await?;

        if let Some(results) = response.get("results").and_then(Value::as_array) {
            pages.extend(results.iter().cloned());
        }
        let has_more = response
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next_cursor = response
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if !has_more {
            break;
        }
        let Some(next_cursor) = next_cursor else {
            return Err("Notion 设置分页返回 has_more=true，但没有 next_cursor。".to_string());
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err("Notion 设置分页游标重复，已停止。".to_string());
        }
        cursor = Some(next_cursor);
    }

    Ok(pages)
}

fn parse_tag_page(
    page: &Value,
    mapping: &NotionSettingsMappingInfo,
) -> Result<NotionTagRecord, String> {
    let remote_id = page
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Notion 设置页面缺少 ID，已跳过。".to_string())?
        .to_string();
    let properties = page
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Notion 设置页面 {remote_id} 缺少 properties，已跳过。"))?;
    let name = property_text(properties, mapping.name_property.as_deref(), "title")
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        return Err(format!(
            "Notion 设置页面 {remote_id} 没有标签名称，已跳过。"
        ));
    }

    let color = mapping.color_property.as_deref().and_then(|property_name| {
        let property = properties.get(property_name)?;
        match mapping.color_property_type.as_deref() {
            Some("rich_text") => property_text(properties, Some(property_name), "rich_text"),
            _ => property
                .get("select")
                .and_then(|select| select.get("name"))
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .map(ToOwned::to_owned),
        }
    });
    let retired = mapping
        .retired_property
        .as_deref()
        .and_then(|property_name| properties.get(property_name))
        .and_then(|property| property.get("checkbox"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tag_id = mapping
        .id_property
        .as_deref()
        .and_then(|property_name| property_text(properties, Some(property_name), "rich_text"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    Ok(NotionTagRecord {
        remote_id,
        tag_id,
        name,
        color,
        retired,
        updated_at: page
            .get("last_edited_time")
            .or_else(|| page.get("created_time"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// 单条设置记录中保存的标签定义（JSON 字段）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct NotionSettingsTagItem {
    id: String,
    name: String,
    color: Option<String>,
    retired: bool,
}

/// 生成设置记录中的 JSON：只记录 CalendarMark 当前实际的标签
fn settings_tags_json(tags: &[&NotionTagInput]) -> String {
    json!({
        "version": 1,
        "tags": tags
            .iter()
            .map(|tag| {
                json!({
                    "id": tag.id,
                    "name": tag.name.trim(),
                    "color": tag.color,
                    "retired": tag.retired.unwrap_or(false),
                })
            })
            .collect::<Vec<_>>(),
    })
    .to_string()
}

fn parse_settings_tags_json(text: &str) -> Result<Vec<NotionSettingsTagItem>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SettingsDocument {
        #[serde(default)]
        tags: Vec<NotionSettingsTagItem>,
    }
    let document: SettingsDocument =
        serde_json::from_str(trimmed).map_err(|error| error.to_string())?;
    Ok(document
        .tags
        .into_iter()
        .map(|mut item| {
            item.name = item.name.trim().to_string();
            item
        })
        .filter(|item| !item.name.is_empty())
        .collect())
}

/// 按标题精确查找设置库中属于 CalendarMark 的唯一设置记录（最近编辑在前）
async fn query_settings_record_pages(
    client: &Client,
    token: &str,
    connection: &NotionSettingsConnectionInfo,
) -> Result<Vec<(String, Value)>, String> {
    let name_property =
        connection.mapping.name_property.clone().ok_or_else(|| {
            "设置数据库缺少 title 属性，无法定位 CalendarMark 设置记录。".to_string()
        })?;

    let mut records = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut batches = 0usize;

    loop {
        batches += 1;
        if batches > 100 {
            return Err("读取 CalendarMark 设置记录时分页超过限制，已停止。".to_string());
        }

        let mut body = Map::new();
        body.insert("page_size".to_string(), json!(PAGE_SIZE));
        body.insert(
            "filter".to_string(),
            json!({
                "property": name_property,
                "title": { "equals": NOTION_SETTINGS_PAGE_TITLE }
            }),
        );
        body.insert(
            "sorts".to_string(),
            json!([{ "direction": "descending", "timestamp": "last_edited_time" }]),
        );
        if let Some(start_cursor) = cursor.as_deref() {
            body.insert("start_cursor".to_string(), json!(start_cursor));
        }

        let response = request_json(
            client,
            token,
            Method::POST,
            &format!("/data_sources/{}/query", connection.data_source_id),
            Some(Value::Object(body)),
        )
        .await?;

        if let Some(results) = response.get("results").and_then(Value::as_array) {
            for page in results {
                let Some(raw_id) = page.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let Ok(id) = normalize_uuid(raw_id, "Notion page ID") else {
                    continue;
                };
                records.push((id, page.clone()));
            }
        }

        let has_more = response
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next_cursor = response
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if !has_more {
            break;
        }
        let Some(next_cursor) = next_cursor else {
            return Err(
                "CalendarMark 设置记录分页返回 has_more=true，但没有 next_cursor。".to_string(),
            );
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err("CalendarMark 设置记录分页游标重复，已停止。".to_string());
        }
        cursor = Some(next_cursor);
    }

    Ok(records)
}

/// 旧版迁移：读取“每个标签一行”的旧数据。仅在还没有单条设置记录时调用一次，
/// 用于把旧标签带回应用；之后保存会写入单条记录，旧页面保持不变。
async fn read_legacy_tag_pages(
    client: &Client,
    token: &str,
    connection: &NotionSettingsConnectionInfo,
) -> Result<Vec<NotionTagRecord>, String> {
    let pages = query_all_data_source_pages(client, token, &connection.data_source_id).await?;
    let mut records = Vec::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    for page in pages {
        if let Ok(record) = parse_tag_page(&page, &connection.mapping) {
            if seen_names.insert(normalize_property_name(&record.name)) {
                records.push(record);
            }
        }
    }
    Ok(records)
}

fn choose_property(
    properties: &[PropertyDescriptor],
    property_type: &str,
    aliases: &[&str],
) -> Option<String> {
    let typed = properties
        .iter()
        .filter(|property| property.property_type == property_type)
        .collect::<Vec<_>>();
    for alias in aliases {
        let alias = normalize_property_name(alias);
        if let Some(property) = typed
            .iter()
            .find(|property| normalize_property_name(&property.name) == alias)
        {
            return Some(property.name.clone());
        }
    }
    typed.first().map(|property| property.name.clone())
}

fn append_mapping_warnings(mapping: &NotionMappingInfo, warnings: &mut Vec<String>) {
    if mapping.content_property.is_none() {
        warnings.push("Notion data source 没有 rich_text 类型属性，记录正文不会写入。".to_string());
    }
    if mapping.tags_property.is_none() {
        warnings
            .push("Notion data source 没有 multi_select 类型属性，快捷标签不会写入。".to_string());
    }
    if mapping.files_property.is_none() {
        warnings.push(
            "Notion data source 没有 files 类型属性，附件会保留在 CalendarMark 本地。".to_string(),
        );
    }
}

fn ensure_mapping_ready(mapping: &NotionMappingInfo) -> Result<(), String> {
    if mapping.ready {
        return Ok(());
    }
    Err(mapping
        .message
        .clone()
        .unwrap_or_else(|| "Notion 字段映射不完整。".to_string()))
}

fn parse_page(page: &Value, connected: &ConnectedNotion) -> Result<NotionEntryRecord, String> {
    let remote_id = page
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Notion 返回了一条没有 ID 的页面，已跳过。".to_string())?
        .to_string();
    let properties = page
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Notion 页面 {remote_id} 没有 properties，已跳过。"))?;
    let mapping = &connected.info.mapping;
    let date = property_date(properties, mapping.date_property.as_deref())
        .ok_or_else(|| format!("Notion 页面 {remote_id} 没有有效日期，已跳过。"))?;
    let title = property_text(properties, mapping.title_property.as_deref(), "title")
        .unwrap_or_else(|| "未命名记录".to_string());
    let content = property_text(properties, mapping.content_property.as_deref(), "rich_text")
        .unwrap_or_default();
    let tag_names = property_multi_select(properties, mapping.tags_property.as_deref());
    let attachments = property_files(properties, mapping.files_property.as_deref());
    let mood = mapping
        .mood_property
        .as_deref()
        .and_then(|name| properties.get(name))
        .and_then(|property| property.get("select"))
        .and_then(|select| select.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .map(ToOwned::to_owned);

    Ok(NotionEntryRecord {
        remote_id,
        data_source_id: connected.info.data_source_id.clone(),
        date,
        title,
        content,
        tag_names,
        mood,
        attachments,
        updated_at: page
            .get("last_edited_time")
            .or_else(|| page.get("created_time"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        url: page
            .get("url")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

fn property_text(
    properties: &Map<String, Value>,
    property_name: Option<&str>,
    field: &str,
) -> Option<String> {
    let property = property_name.and_then(|name| properties.get(name))?;
    let values = property.get(field)?.as_array()?;
    let text = values
        .iter()
        .filter_map(|value| {
            value
                .get("plain_text")
                .and_then(Value::as_str)
                .or_else(|| value.get("text")?.get("content")?.as_str())
        })
        .collect::<String>();
    Some(text)
}

fn property_date(properties: &Map<String, Value>, property_name: Option<&str>) -> Option<String> {
    let property = property_name.and_then(|name| properties.get(name))?;
    let date = property.get("date")?.get("start")?.as_str()?;
    let date = date.get(..10).unwrap_or(date);
    if is_date_key(date) {
        Some(date.to_string())
    } else {
        None
    }
}

fn property_multi_select(
    properties: &Map<String, Value>,
    property_name: Option<&str>,
) -> Vec<String> {
    property_name
        .and_then(|name| properties.get(name))
        .and_then(|property| property.get("multi_select"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.get("name").and_then(Value::as_str))
                .filter(|name| !name.trim().is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn property_files(
    properties: &Map<String, Value>,
    property_name: Option<&str>,
) -> Vec<NotionAttachmentRecord> {
    property_name
        .and_then(|name| properties.get(name))
        .and_then(|property| property.get("files"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    let name = value
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("Notion 附件")
                        .to_string();
                    let file_type = value
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let source_url = match file_type {
                        "file" => value.get("file")?.get("url")?.as_str(),
                        "external" => value.get("external")?.get("url")?.as_str(),
                        _ => None,
                    }
                    .map(ToOwned::to_owned);
                    let remote_id = value
                        .get("file_upload")
                        .and_then(|file| file.get("id"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    let remote_file = match file_type {
                        "file" => value.get("file").cloned(),
                        "external" => value.get("external").cloned(),
                        _ => None,
                    }
                    .map(|value| NotionRemoteFile {
                        kind: file_type.to_string(),
                        value,
                    });
                    Some(NotionAttachmentRecord {
                        mime_type: mime_from_filename(&name),
                        name,
                        size: 0,
                        source_url,
                        remote_id,
                        remote_file,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn build_page_properties(
    client: &Client,
    token: &str,
    connected: &ConnectedNotion,
    entry: &NotionEntryInput,
    warnings: &mut Vec<String>,
) -> Result<(Map<String, Value>, usize, Vec<NotionAttachmentRecord>), String> {
    let mapping = &connected.info.mapping;
    let mut properties = Map::new();
    let title = if entry.title.trim().is_empty() {
        entry.date.clone()
    } else {
        entry.title.trim().to_string()
    };
    if let Some(property_name) = mapping.title_property.as_deref() {
        properties.insert(
            property_name.to_string(),
            json!({ "title": rich_text_items(&title) }),
        );
    }
    if let Some(property_name) = mapping.date_property.as_deref() {
        if !is_date_key(&entry.date) {
            return Err(format!(
                "记录 {} 的日期不是 YYYY-MM-DD，无法同步到 Notion。",
                entry.local_id
            ));
        }
        properties.insert(
            property_name.to_string(),
            json!({ "date": { "start": entry.date } }),
        );
    }
    if let Some(property_name) = mapping.content_property.as_deref() {
        properties.insert(
            property_name.to_string(),
            json!({ "rich_text": rich_text_items(&entry.content) }),
        );
    }
    if let Some(property_name) = mapping.tags_property.as_deref() {
        let mut names = HashSet::new();
        let values = entry
            .tag_names
            .iter()
            .filter_map(|name| {
                let name = name.trim();
                if name.is_empty() || !names.insert(name.to_string()) {
                    return None;
                }
                Some(json!({ "name": truncate_chars(name, 100) }))
            })
            .collect::<Vec<_>>();
        properties.insert(property_name.to_string(), json!({ "multi_select": values }));
    }

    if let Some(property_name) = mapping.mood_property.as_deref() {
        // None 写 null 用于清除远端心情
        let mood = entry
            .mood
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|mood| json!({ "name": mood }));
        properties.insert(property_name.to_string(), json!({ "select": mood }));
    }

    let mut uploaded_attachments = 0;
    let mut attachment_refs = Vec::new();
    if let Some(property_name) = mapping.files_property.as_deref() {
        let mut files = Vec::new();
        for attachment in &entry.attachments {
            let mut reference = NotionAttachmentRecord {
                name: attachment.name.clone(),
                mime_type: attachment.mime_type.clone(),
                size: 0,
                source_url: None,
                remote_id: None,
                remote_file: None,
            };

            // 优先复用 file_upload ID：它是稳定引用，不受签名 URL 过期影响。
            if let Some(remote_id) = attachment
                .remote_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if let Ok(remote_id) = normalize_uuid(remote_id, "Notion file upload ID") {
                    files.push(json!({
                        "type": "file_upload",
                        "file_upload": { "id": remote_id },
                        "name": attachment.name
                    }));
                    reference.remote_id = Some(remote_id);
                    attachment_refs.push(reference);
                    continue;
                }
            }

            if let Some(remote_file) = attachment.remote_file.as_ref() {
                let property_key = match remote_file.kind.as_str() {
                    "file" => "file",
                    "external" => "external",
                    _ => "",
                };
                if !property_key.is_empty() {
                    let mut file = Map::new();
                    file.insert("name".to_string(), json!(attachment.name));
                    file.insert(property_key.to_string(), remote_file.value.clone());
                    files.push(Value::Object(file));
                    reference.remote_file = Some(remote_file.clone());
                    attachment_refs.push(reference);
                    continue;
                }
            }

            if attachment.data_url.trim().is_empty() {
                if let Some(source_url) = attachment
                    .source_url
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    files.push(json!({
                        "name": attachment.name,
                        "external": { "url": source_url }
                    }));
                    reference.source_url = Some(source_url.to_string());
                } else {
                    warnings.push(format!(
                        "记录 {} 的附件 {} 没有可用的本地或远程文件内容。",
                        entry.local_id, attachment.name
                    ));
                }
                attachment_refs.push(reference);
                continue;
            }
            match upload_attachment(client, token, attachment).await {
                Ok(file_upload_id) => {
                    files.push(json!({
                        "type": "file_upload",
                        "file_upload": { "id": file_upload_id },
                        "name": attachment.name
                    }));
                    uploaded_attachments += 1;
                    reference.remote_id = Some(file_upload_id);
                }
                Err(message) => warnings.push(format!(
                    "记录 {} 的附件 {} 未上传：{}",
                    entry.local_id, attachment.name, message
                )),
            }
            attachment_refs.push(reference);
        }
        properties.insert(property_name.to_string(), json!({ "files": files }));
    } else if entry
        .attachments
        .iter()
        .any(|attachment| !attachment.data_url.trim().is_empty())
    {
        warnings.push(format!(
            "记录 {} 的附件未同步：Notion 数据源缺少 files 类型属性。",
            entry.local_id
        ));
    }

    Ok((properties, uploaded_attachments, attachment_refs))
}

async fn upload_attachment(
    client: &Client,
    token: &str,
    attachment: &NotionAttachmentInput,
) -> Result<String, String> {
    let (mime_type, bytes) = decode_data_url(&attachment.data_url, &attachment.mime_type)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("文件超过 5 MB 限制。".to_string());
    }
    let filename = if attachment.name.trim().is_empty() {
        "calendarmark-attachment.bin".to_string()
    } else {
        attachment.name.clone()
    };
    let created = request_json(
        client,
        token,
        Method::POST,
        "/file_uploads",
        Some(json!({
            "mode": "single_part",
            "filename": filename,
            "content_type": mime_type
        })),
    )
    .await?;
    let upload_id = created
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Notion 文件上传初始化响应缺少 ID。".to_string())?;
    let upload_url = created
        .get("upload_url")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("https://"))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{NOTION_API_BASE}/file_uploads/{upload_id}/send"));
    let part = multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(&mime_type)
        .map_err(|error| format!("文件 MIME 类型无效：{error}"))?;
    let send_result = client
        .post(upload_url)
        .bearer_auth(token.trim())
        .header("Notion-Version", NOTION_VERSION)
        .header("User-Agent", USER_AGENT)
        .multipart(multipart::Form::new().part("file", part))
        .timeout(UPLOAD_TIMEOUT)
        .send()
        .await;
    let response = match send_result {
        Ok(response) => response,
        Err(error) => return Err(request_error_message("上传文件失败", &error)),
    };
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| request_error_message("读取文件上传响应失败", &error))?;
    if !status.is_success() {
        return Err(format_notion_error(status, &body));
    }
    Ok(serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| upload_id.to_string()))
}

fn decode_data_url(data_url: &str, fallback_mime_type: &str) -> Result<(String, Vec<u8>), String> {
    let Some((header, encoded)) = data_url.split_once(',') else {
        return Err("附件不是有效的 data URL。".to_string());
    };
    if !header.starts_with("data:") || !header.contains(";base64") {
        return Err("只支持 base64 格式的本地附件。".to_string());
    }
    let mime_type = header
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_mime_type)
        .to_string();
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| format!("附件 base64 解码失败：{error}"))?;
    Ok((mime_type, bytes))
}

fn rich_text_items(value: &str) -> Vec<Value> {
    let chunks = if value.is_empty() {
        vec![String::new()]
    } else {
        value
            .chars()
            .collect::<Vec<_>>()
            .chunks(1_900)
            .map(|chunk| chunk.iter().collect::<String>())
            .collect()
    };
    chunks
        .into_iter()
        .map(|content| json!({ "type": "text", "text": { "content": content } }))
        .collect()
}

async fn request_json(
    client: &Client,
    token: &str,
    method: Method,
    path: &str,
    payload: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{NOTION_API_BASE}{path}");
    for attempt in 0..3u64 {
        let mut request = client
            .request(method.clone(), &url)
            .bearer_auth(token.trim())
            .header("Notion-Version", NOTION_VERSION)
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/json");
        if let Some(body) = payload.clone() {
            request = request.json(&body);
        }
        let response = match request.timeout(REQUEST_TIMEOUT).send().await {
            Ok(response) => response,
            Err(error) => {
                let message = request_error_message("请求 Notion 失败", &error);
                // 只重试“连接没有建立起来”的失败（DNS 抖动、建连被重置 / 超时），
                // 请求已经发出的失败不重试，避免创建、更新这类非幂等请求重复执行。
                if error.is_connect() && attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(350 * 2_u64.pow(attempt as u32)))
                        .await;
                    continue;
                }
                return Err(message);
            }
        };
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| request_error_message("读取 Notion 响应失败", &error))?;
        if (status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()) && attempt < 2 {
            tokio::time::sleep(Duration::from_millis(350 * 2_u64.pow(attempt as u32))).await;
            continue;
        }
        if !status.is_success() {
            return Err(format_notion_error(status, &body));
        }
        if body.trim().is_empty() {
            return Ok(json!({}));
        }
        return serde_json::from_str(&body)
            .map_err(|error| format!("Notion 返回了无法解析的 JSON：{error}"));
    }
    Err("请求 Notion 失败，重试次数已用尽。".to_string())
}

fn format_notion_error(status: StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "请检查 Token、数据库分享权限和 Integration 能力。".to_string());
    format!("Notion API {}：{}", status.as_u16(), message)
}

fn normalize_uuid(value: &str, label: &str) -> Result<String, String> {
    let compact = value.trim().replace('-', "");
    if compact.len() != 32
        || !compact
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(format!("{label} 应为 Notion 链接中的 32 位 ID。"));
    }
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &compact[0..8],
        &compact[8..12],
        &compact[12..16],
        &compact[16..20],
        &compact[20..32]
    ))
}

fn parent_database_id(value: &Value) -> Option<&str> {
    value
        .get("parent")
        .and_then(|parent| parent.get("database_id"))
        .and_then(Value::as_str)
}

fn normalize_property_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn display_value(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(values) = value.as_array() {
        let text = values
            .iter()
            .filter_map(|item| {
                item.get("plain_text")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("text")?.get("content")?.as_str())
            })
            .collect::<String>();
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn is_date_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn mime_from_filename(filename: &str) -> String {
    match filename
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain",
        Some("md") => "text/markdown",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_cause_walks_to_deepest_error_source() {
        #[derive(Debug)]
        struct DeepError(String);
        impl std::fmt::Display for DeepError {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "{}", self.0)
            }
        }
        impl std::error::Error for DeepError {}

        #[derive(Debug)]
        struct ShallowError(DeepError);
        impl std::fmt::Display for ShallowError {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "shallow failure")
            }
        }
        impl std::error::Error for ShallowError {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        let error = ShallowError(DeepError("dns lookup failed".to_string()));
        assert_eq!(root_cause(&error), "dns lookup failed");
        // 没有底层来源时，应回退到错误自身的描述。
        let error = DeepError("only failure".to_string());
        assert_eq!(root_cause(&error), "only failure");
    }

    #[test]
    fn normalizes_notion_ids() {
        assert_eq!(
            normalize_uuid("0123456789abcdef0123456789abcdef", "id").unwrap(),
            "01234567-89ab-cdef-0123-456789abcdef"
        );
        assert!(normalize_uuid("not-an-id", "id").is_err());
    }

    #[test]
    fn maps_properties_by_type_and_name() {
        let properties = vec![
            PropertyDescriptor {
                name: "Name".to_string(),
                id: "title".to_string(),
                property_type: "title".to_string(),
            },
            PropertyDescriptor {
                name: "日期".to_string(),
                id: "date".to_string(),
                property_type: "date".to_string(),
            },
            PropertyDescriptor {
                name: "内容".to_string(),
                id: "text".to_string(),
                property_type: "rich_text".to_string(),
            },
        ];
        let mapping = build_mapping(&properties);
        assert!(mapping.ready);
        assert_eq!(mapping.title_property.as_deref(), Some("Name"));
        assert_eq!(mapping.date_property.as_deref(), Some("日期"));
        assert_eq!(mapping.content_property.as_deref(), Some("内容"));
    }

    #[test]
    fn chunks_long_rich_text() {
        let items = rich_text_items(&"a".repeat(4_000));
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn reads_database_id_from_data_source_parent() {
        let value = json!({
            "parent": {
                "type": "database_id",
                "database_id": "0123456789abcdef0123456789abcdef"
            }
        });
        assert_eq!(
            parent_database_id(&value),
            Some("0123456789abcdef0123456789abcdef")
        );
    }

    fn page(id: &str) -> Value {
        json!({ "id": id })
    }

    #[test]
    fn creates_new_page_when_date_has_no_page() {
        let (target, duplicates, mismatch) = resolve_target_page(None, &[], "");
        assert_eq!(target, None);
        assert!(duplicates.is_empty());
        assert!(!mismatch);
    }

    #[test]
    fn updates_existing_page_for_same_date_without_reference() {
        let pages = vec![page("0123456789abcdef0123456789abcdef")];
        let (target, duplicates, mismatch) = resolve_target_page(None, &pages, "");
        assert_eq!(
            target.as_deref(),
            Some("01234567-89ab-cdef-0123-456789abcdef")
        );
        assert!(duplicates.is_empty());
        assert!(!mismatch);
    }

    #[test]
    fn prefers_matching_reference_and_archives_duplicates() {
        let newest = "0123456789abcdef0123456789abcdef";
        let stale = "fedcba9876543210fedcba9876543210";
        let pages = vec![page(newest), page(stale)];
        let (target, duplicates, mismatch) = resolve_target_page(Some(stale), &pages, "");
        assert_eq!(
            target.as_deref(),
            Some("fedcba98-7654-3210-fedc-ba9876543210")
        );
        assert_eq!(duplicates, vec!["01234567-89ab-cdef-0123-456789abcdef"]);
        assert!(!mismatch);
    }

    #[test]
    fn ignores_reference_pointing_to_another_date() {
        let pages = vec![page("0123456789abcdef0123456789abcdef")];
        let other = "fedcba9876543210fedcba9876543210";
        let (target, duplicates, mismatch) = resolve_target_page(Some(other), &pages, "");
        assert_eq!(
            target.as_deref(),
            Some("01234567-89ab-cdef-0123-456789abcdef")
        );
        assert!(duplicates.is_empty());
        assert!(mismatch);
    }

    #[test]
    fn falls_back_to_batch_cache_when_query_is_eventually_consistent() {
        let cached = "0123456789abcdef0123456789abcdef";
        let (target, duplicates, mismatch) = resolve_target_page(None, &[], cached);
        assert_eq!(
            target.as_deref(),
            Some("01234567-89ab-cdef-0123-456789abcdef")
        );
        assert!(duplicates.is_empty());
        assert!(!mismatch);
    }

    #[test]
    fn maps_settings_database_properties() {
        let properties = vec![
            NotionPropertyInfo {
                name: "名称".to_string(),
                id: "title".to_string(),
                property_type: "title".to_string(),
            },
            NotionPropertyInfo {
                name: "标签".to_string(),
                id: "tags".to_string(),
                property_type: "rich_text".to_string(),
            },
        ];
        let mapping = build_settings_mapping(&properties);
        assert!(mapping.ready);
        assert_eq!(mapping.name_property.as_deref(), Some("名称"));
        assert_eq!(mapping.data_property.as_deref(), Some("标签"));
    }

    #[test]
    fn settings_tags_json_roundtrip() {
        let tags = vec![
            NotionTagInput {
                id: "tag-1".to_string(),
                name: "专注".to_string(),
                color: Some("mint".to_string()),
                retired: Some(false),
            },
            NotionTagInput {
                id: "tag-2".to_string(),
                name: "会议".to_string(),
                color: Some("lavender".to_string()),
                retired: Some(true),
            },
        ];
        let references: Vec<&NotionTagInput> = tags.iter().collect();
        let payload = settings_tags_json(&references);
        let parsed = parse_settings_tags_json(&payload).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "tag-1");
        assert_eq!(parsed[0].name, "专注");
        assert_eq!(parsed[0].color.as_deref(), Some("mint"));
        assert!(!parsed[0].retired);
        assert!(parsed[1].retired);

        // 空内容 / 空名称都按“无标签”或跳过处理，不报错
        assert!(parse_settings_tags_json("").unwrap().is_empty());
        let with_empty = r#"{"tags":[{"id":"x","name":"  ","color":null,"retired":false}]}"#;
        assert!(parse_settings_tags_json(with_empty).unwrap().is_empty());
    }
}
