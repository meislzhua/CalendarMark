use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{multipart, Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::time::Duration;

const NOTION_API_BASE: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2026-03-11";
const USER_AGENT: &str = "CalendarMark/0.1.0";
const PAGE_SIZE: u64 = 100;
const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;

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
pub struct NotionMappingInfo {
    pub ready: bool,
    pub title_property: Option<String>,
    pub date_property: Option<String>,
    pub content_property: Option<String>,
    pub tags_property: Option<String>,
    pub files_property: Option<String>,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionPushResult {
    pub connection: NotionConnectionInfo,
    pub entries: Vec<NotionPushRecord>,
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

    for entry in entries {
        let (properties, uploaded_attachments) =
            build_page_properties(&client, &token, &connected, &entry, &mut warnings).await?;
        let response = if let Some(remote_id) = entry.remote_id.as_deref() {
            let page_id = normalize_uuid(remote_id, "Notion page ID")?;
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

fn notion_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("无法初始化 Notion 网络客户端：{error}"))
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
        message,
    }
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

    Ok(NotionEntryRecord {
        remote_id,
        data_source_id: connected.info.data_source_id.clone(),
        date,
        title,
        content,
        tag_names,
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
) -> Result<(Map<String, Value>, usize), String> {
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

    let mut uploaded_attachments = 0;
    if let Some(property_name) = mapping.files_property.as_deref() {
        let mut files = Vec::new();
        for attachment in &entry.attachments {
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
                    continue;
                }
            }
            if let Some(remote_id) = attachment.remote_id.as_deref() {
                if let Ok(remote_id) = normalize_uuid(remote_id, "Notion file upload ID") {
                    files.push(json!({
                        "type": "file_upload",
                        "file_upload": { "id": remote_id },
                        "name": attachment.name
                    }));
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
                } else {
                    warnings.push(format!(
                        "记录 {} 的附件 {} 没有可用的本地或远程文件内容。",
                        entry.local_id, attachment.name
                    ));
                }
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
                }
                Err(message) => warnings.push(format!(
                    "记录 {} 的附件 {} 未上传：{}",
                    entry.local_id, attachment.name, message
                )),
            }
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

    Ok((properties, uploaded_attachments))
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
    let response = client
        .post(upload_url)
        .bearer_auth(token.trim())
        .header("Notion-Version", NOTION_VERSION)
        .header("User-Agent", USER_AGENT)
        .multipart(multipart::Form::new().part("file", part))
        .send()
        .await
        .map_err(|error| format!("上传文件失败：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取文件上传响应失败：{error}"))?;
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
        let response = request
            .send()
            .await
            .map_err(|error| format!("请求 Notion 失败：{error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("读取 Notion 响应失败：{error}"))?;
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
}
