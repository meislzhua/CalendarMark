use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as URLSAFE};
use base64::Engine as _;
use futures::future::join_all;
use hmac::{Hmac, Mac};
use reqwest::{multipart, Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const UC_HOST: &str = "https://uc.qiniuapi.com";
const API_HOST: &str = "https://api.qiniuapi.com";
const DEFAULT_REGION: &str = "z0";
const USER_AGENT: &str = "CalendarMark/0.2.2";
const LIST_PAGE_SIZE: u32 = 1000;
const UPLOAD_DEADLINE_SECONDS: u64 = 3600;
const DOWNLOAD_TTL_SECONDS: u64 = 3600;

pub const REGIONS: &[(&str, &str, &str, &str, &str)] = &[
    // (region id, label, 源站上传 host, 对象管理 rs host, 对象列举 rsf host)
    (
        "z0",
        "华东-浙江",
        "up-z0.qiniup.com",
        "rs-z0.qiniuapi.com",
        "rsf-z0.qiniuapi.com",
    ),
    (
        "cn-east-2",
        "华东-浙江2",
        "up-cn-east-2.qiniup.com",
        "rs-cn-east-2.qiniuapi.com",
        "rsf-cn-east-2.qiniuapi.com",
    ),
    (
        "z1",
        "华北-河北",
        "up-z1.qiniup.com",
        "rs-z1.qiniuapi.com",
        "rsf-z1.qiniuapi.com",
    ),
    (
        "z2",
        "华南-广东",
        "up-z2.qiniup.com",
        "rs-z2.qiniuapi.com",
        "rsf-z2.qiniuapi.com",
    ),
    (
        "na0",
        "北美-洛杉矶",
        "up-na0.qiniup.com",
        "rs-na0.qiniuapi.com",
        "rsf-na0.qiniuapi.com",
    ),
    (
        "as0",
        "亚太-新加坡",
        "up-as0.qiniup.com",
        "rs-as0.qiniuapi.com",
        "rsf-as0.qiniuapi.com",
    ),
];

type HmacSha1 = Hmac<Sha1>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QiniuUsage {
    pub storage_bytes: u64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QiniuRegionOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QiniuRawCredential {
    pub access_key: String,
    pub secret_key: String,
}

#[derive(Debug, Clone)]
struct QiniuCredential {
    access_key: String,
    secret_key: String,
}

impl QiniuCredential {
    fn from_pair(access_key: &str, secret_key: &str) -> Result<Self, String> {
        let access_key = access_key.trim();
        let secret_key = secret_key.trim();
        if access_key.is_empty() || secret_key.is_empty() {
            return Err("请完整填写七牛 AccessKey 和 SecretKey。".to_string());
        }
        if !valid_key(access_key) {
            return Err("AccessKey 格式不正确：请复制个人中心「密钥管理」中的 AccessKey。".to_string());
        }
        if !valid_key(secret_key) {
            return Err("SecretKey 格式不正确：请复制个人中心「密钥管理」中的 SecretKey。".to_string());
        }
        Ok(Self {
            access_key: access_key.to_string(),
            secret_key: secret_key.to_string(),
        })
    }
}

fn valid_key(value: &str) -> bool {
    (32..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn parse_credential(raw: &QiniuRawCredential) -> Result<QiniuCredential, String> {
    QiniuCredential::from_pair(&raw.access_key, &raw.secret_key)
}

fn hmac_sha1_urlsafe(secret_key: &str, data: &str) -> String {
    let mut mac = HmacSha1::new_from_slice(secret_key.as_bytes())
        .expect("HMAC-SHA1 accepts any key length");
    mac.update(data.as_bytes());
    URLSAFE.encode(mac.finalize().into_bytes())
}

/// 七牛管理凭证签名串。对应官方《管理凭证》算法：
/// Method Path?Query\nHost: host\n[Content-Type: ct]\n\n[body]
fn build_management_signing_string(
    method: &str,
    path_with_query: &str,
    host: &str,
    content_type: Option<&str>,
    body: Option<&str>,
) -> String {
    let mut signing = format!("{method} {path_with_query}\nHost: {host}");
    if let Some(content_type) = content_type {
        signing.push_str("\nContent-Type: ");
        signing.push_str(content_type);
    }
    // 官方 Go SDK collectDataV2：每个头信息行后带 \n，最后再补一个空行；
    // body 仅在 Content-Type 为 form/json 且非空时参与签名。
    // 官方文档与官方 Go SDK（collectDataV2）一致的格式：
    // Host/Content-Type 各占一行（行尾 \n），最后再补一个空行。
    signing.push_str("\n\n");
    if let Some(body) = body {
        // body 仅在 form/json 且非空时参与签名（与官方 SDK incBodyV2 一致）
        let includes_body = matches!(
            content_type,
            Some("application/x-www-form-urlencoded") | Some("application/json")
        ) && !body.is_empty();
        if includes_body {
            signing.push_str(body);
        }
    }
    signing
}

fn management_authorization(
    credential: &QiniuCredential,
    method: &str,
    path_with_query: &str,
    host: &str,
    content_type: Option<&str>,
    body: Option<&str>,
) -> String {
    let signing = build_management_signing_string(
        method,
        path_with_query,
        host,
        content_type,
        body,
    );
    let encoded_sign = hmac_sha1_urlsafe(&credential.secret_key, &signing);
    format!(
        "Qiniu {}:{encoded_sign}",
        credential.access_key
    )
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default()
}

/// 构造表单上传凭证（Qiniu UploadToken）：
/// AccessKey:urlsafe(HMAC-SHA1(encodedPolicy)):urlsafe(policy JSON)
fn build_upload_token(
    credential: &QiniuCredential,
    bucket: &str,
    key: &str,
    deadline: u64,
) -> String {
    let policy = json!({
        "scope": format!("{bucket}:{key}"),
        "deadline": deadline,
    })
    .to_string();
    let encoded_policy = URLSAFE.encode(policy);
    let sign = hmac_sha1_urlsafe(&credential.secret_key, &encoded_policy);
    format!("{}:{sign}:{encoded_policy}", credential.access_key)
}

/// 私有空间下载链接：在 URL 后附加 e（过期时间）与下载凭证。
fn build_private_download_url(
    credential: &QiniuCredential,
    domain: &str,
    key: &str,
    ttl_seconds: u64,
) -> String {
    let base = normalize_download_domain(domain);
    let deadline = now_unix() + ttl_seconds.max(60);
    let to_sign = format!("{base}/{key}?e={deadline}");
    let token = hmac_sha1_urlsafe(&credential.secret_key, &to_sign);
    format!("{to_sign}&token={}:{}", credential.access_key, token)
}

fn normalize_download_domain(domain: &str) -> String {
    let domain = domain.trim().trim_end_matches('/');
    if domain.starts_with("http://") || domain.starts_with("https://") {
        domain.to_string()
    } else {
        format!("http://{domain}")
    }
}

fn region_config(region: &str) -> (&'static str, &'static str, &'static str, &'static str, &'static str) {
    // 兼容旧文档中出现过的 cn-east-2a 写法
    let normalized = if region.trim() == "cn-east-2a" {
        "cn-east-2"
    } else {
        region.trim()
    };
    REGIONS
        .iter()
        .find(|(id, _, _, _, _)| *id == normalized)
        .copied()
        .unwrap_or(REGIONS[0])
}

fn url_encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn encoded_entry(bucket: &str, key: &str) -> String {
    URLSAFE.encode(format!("{bucket}:{key}"))
}

fn validate_bucket_name(bucket: &str) -> Result<(), String> {
    let invalid = bucket.len() < 3
        || bucket.len() > 63
        || !bucket
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || bucket.starts_with('-')
        || bucket.ends_with('-');
    if invalid {
        return Err(
            "空间名称需为 3-63 位小写字母、数字或短划线，并以字母或数字开头结尾。".to_string(),
        );
    }
    Ok(())
}

fn qiniu_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("无法初始化七牛网络客户端：{error}"))
}

async fn management_request(
    client: &Client,
    credential: &QiniuCredential,
    host: &str,
    method: Method,
    path_with_query: &str,
    body: Option<&str>,
) -> Result<(StatusCode, String), String> {
    let url = format!("{host}{path_with_query}");
    let authorization = management_authorization(
        credential,
        method.as_str(),
        path_with_query,
        host
            .trim_start_matches("https://")
            .trim_start_matches("http://"),
        Some("application/x-www-form-urlencoded"),
        body,
    );
    let mut request = client
        .request(method, &url)
        .header("Authorization", authorization)
        .header("Content-Type", "application/x-www-form-urlencoded");
    if let Some(body) = body {
        request = request.body(body.to_string());
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("请求七牛服务失败：{error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取七牛响应失败：{error}"))?;
    Ok((status, text))
}

fn format_qiniu_error(context: &str, status: StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| body.trim().to_string());
    match status.as_u16() {
        401 => format!(
            "{context}：七牛返回 401，AccessKey/SecretKey 不正确。请到七牛控制台「个人中心 → 密钥管理」重新复制（AK/SK 是一对密钥，不是账号密码），并确认两者没有填反。"
        ),
        403 => format!("{context}：七牛返回 403，当前密钥没有对应权限（或账号欠费）。"),
        614 => format!("{context}：同名空间已存在，可直接选择该空间。"),
        631 => format!("{context}：空间不存在，请确认空间名称和区域。"),
        _ => format!("{context}：七牛 API {} {}", status.as_u16(), detail),
    }
}

#[tauri::command]
pub async fn qiniu_list_buckets(raw: QiniuRawCredential) -> Result<Vec<String>, String> {
    let credential = parse_credential(&raw)?;
    let client = qiniu_client()?;
    let (status, body) = management_request(
        &client,
        &credential,
        UC_HOST,
        Method::GET,
        "/buckets",
        None,
    )
    .await?;
    if !status.is_success() {
        return Err(format_qiniu_error("获取空间列表失败", status, &body));
    }
    serde_json::from_str::<Vec<String>>(&body)
        .map_err(|error| format!("解析七牛空间列表失败：{error}"))
}

#[tauri::command]
pub async fn qiniu_regions() -> Result<Vec<QiniuRegionOption>, String> {
    Ok(REGIONS
        .iter()
        .map(|(id, label, _, _, _)| QiniuRegionOption {
            id: id.to_string(),
            label: label.to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn qiniu_create_bucket(
    raw: QiniuRawCredential,
    bucket: String,
    region: String,
) -> Result<(), String> {
    let credential = parse_credential(&raw)?;
    let bucket = bucket.trim().to_string();
    validate_bucket_name(&bucket)?;
    let region = if region.trim().is_empty() {
        DEFAULT_REGION.to_string()
    } else {
        region.trim().to_string()
    };
    let client = qiniu_client()?;

    let (status, body) = management_request(
        &client,
        &credential,
        UC_HOST,
        Method::POST,
        &format!("/mkbucketv3/{}/region/{}", bucket, region),
        None,
    )
    .await?;
    if !status.is_success() {
        return Err(format_qiniu_error("创建空间失败", status, &body));
    }

    // mkbucketv3 默认创建公开空间；CalendarMark 数据必须私有，立即改为私有。
    let query = format!("/private?bucket={}&private=1", url_encode_component(&bucket));
    let (status, body) = management_request(
        &client,
        &credential,
        UC_HOST,
        Method::POST,
        &query,
        None,
    )
    .await?;
    if !status.is_success() {
        return Err(format_qiniu_error(
            "空间已创建，但设置为私有失败，请在七牛控制台手动改为私有",
            status,
            &body,
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn qiniu_bucket_domains(raw: QiniuRawCredential, bucket: String) -> Result<Vec<String>, String> {
    let credential = parse_credential(&raw)?;
    let client = qiniu_client()?;
    let query = format!("/v2/domains?tbl={}", url_encode_component(bucket.trim()));
    let (status, body) = management_request(&client, &credential, UC_HOST, Method::GET, &query, None)
        .await?;
    if !status.is_success() {
        return Err(format_qiniu_error("获取空间域名失败", status, &body));
    }
    serde_json::from_str::<Vec<String>>(&body)
        .map_err(|error| format!("解析七牛空间域名失败：{error}"))
}

fn format_stats_time(timestamp: u64) -> String {
    // 简化的 UTC 时间格式化（YYYYMMDDHHMMSS），统计接口按此粒度聚合。
    let days = timestamp / 86400;
    let seconds = timestamp % 86400;
    let mut year = 1970u64;
    let mut remaining_days = days;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let year_days = if leap { 366 } else { 365 };
        if remaining_days >= year_days {
            remaining_days -= year_days;
            year += 1;
        } else {
            break;
        }
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u64;
    for days_in_month in month_days {
        if remaining_days >= days_in_month {
            remaining_days -= days_in_month;
            month += 1;
        } else {
            break;
        }
    }
    format!(
        "{year:04}{month:02}{:02}{:02}{:02}{:02}",
        remaining_days + 1,
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

#[tauri::command]
pub async fn qiniu_get_usage(
    raw: QiniuRawCredential,
    bucket: String,
    region: String,
) -> Result<QiniuUsage, String> {
    let credential = parse_credential(&raw)?;
    let bucket = bucket.trim().to_string();
    if bucket.is_empty() {
        return Err("请先选择七牛空间。".to_string());
    }
    let now = now_unix();
    let begin = format_stats_time(now.saturating_sub(2 * 86400));
    let end = format_stats_time(now + 600);
    let query = format!(
        "/v6/space?bucket={}&region={}&begin={}&end={}&g=day",
        url_encode_component(&bucket),
        url_encode_component(region.trim()),
        begin,
        end
    );
    let client = qiniu_client()?;
    let (status, body) =
        management_request(&client, &credential, API_HOST, Method::GET, &query, None).await?;
    if !status.is_success() {
        return Err(format_qiniu_error("读取七牛用量失败", status, &body));
    }
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|error| format!("解析七牛用量失败：{error}"))?;
    let times: Vec<i64> = parsed
        .get("times")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_i64)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let datas: Vec<u64> = parsed
        .get("datas")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_u64)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if datas.is_empty() {
        return Err("七牛还没有这个空间的存储统计数据（统计延迟约 5 分钟），请稍后再试。".to_string());
    }
    let storage_bytes = datas[datas.len() - 1];
    let updated_at = times.last().copied().unwrap_or(now as i64);
    Ok(QiniuUsage {
        storage_bytes,
        updated_at,
    })
}

async fn list_object_keys(
    client: &Client,
    credential: &QiniuCredential,
    bucket: &str,
    region: &str,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let (_, _, _, _, rsf_host) = region_config(region);
    let mut keys = Vec::new();
    let mut marker = String::new();
    loop {
        let query = format!(
            "/list/2?bucket={}&prefix={}&limit={}&marker={}",
            url_encode_component(bucket),
            url_encode_component(prefix),
            LIST_PAGE_SIZE,
            url_encode_component(&marker)
        );
        let (status, body) =
            management_request(client, credential, &format!("https://{rsf_host}"), Method::GET, &query, None)
                .await?;
        if !status.is_success() {
            return Err(format_qiniu_error("读取对象列表失败", status, &body));
        }
        let parsed: Value = serde_json::from_str(&body)
            .map_err(|error| format!("解析七牛对象列表失败：{error}"))?;
        if let Some(items) = parsed.get("items").and_then(Value::as_array) {
            for item in items {
                if let Some(key) = item.get("key").and_then(Value::as_str) {
                    if key.starts_with(prefix) {
                        keys.push(key.to_string());
                    }
                }
            }
        }
        marker = parsed
            .get("marker")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if marker.is_empty() || keys.len() >= 5000 {
            break;
        }
    }
    Ok(keys)
}

#[tauri::command]
pub async fn qiniu_list_keys(
    raw: QiniuRawCredential,
    bucket: String,
    region: String,
    prefix: String,
) -> Result<Vec<String>, String> {
    let credential = parse_credential(&raw)?;
    let client = qiniu_client()?;
    list_object_keys(&client, &credential, bucket.trim(), region.trim(), &prefix).await
}

async fn fetch_object_bytes(
    client: &Client,
    credential: &QiniuCredential,
    domain: &str,
    key: &str,
) -> Result<Option<Vec<u8>>, String> {
    let url = build_private_download_url(credential, domain, key, DOWNLOAD_TTL_SECONDS);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("下载七牛对象失败：{error}"))?;
    if response.status() == StatusCode::NOT_FOUND || response.status().as_u16() == 612 {
        return Ok(None);
    }
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(format!("下载 {key} 失败：下载凭证被拒绝，请检查密钥与空间域名。"));
    }
    if !response.status().is_success() {
        return Err(format!(
            "下载 {key} 失败：七牛返回 {}",
            response.status().as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取 {key} 内容失败：{error}"))?;
    Ok(Some(bytes.to_vec()))
}

#[tauri::command]
pub async fn qiniu_get_object(
    raw: QiniuRawCredential,
    bucket: String,
    region: String,
    domain: String,
    key: String,
) -> Result<Option<String>, String> {
    let credential = parse_credential(&raw)?;
    let _ = region;
    let client = qiniu_client()?;
    let domain = if domain.trim().is_empty() {
        let domains = qiniu_bucket_domains_inner(&client, &credential, &bucket).await?;
        domains
            .into_iter()
            .next()
            .ok_or_else(|| "空间还没有可用域名，请先在七牛控制台绑定域名。".to_string())?
    } else {
        domain
    };
    let bytes = fetch_object_bytes(&client, &credential, &domain, &key).await?;
    Ok(bytes.map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
}

async fn qiniu_bucket_domains_inner(
    client: &Client,
    credential: &QiniuCredential,
    bucket: &str,
) -> Result<Vec<String>, String> {
    let query = format!("/v2/domains?tbl={}", url_encode_component(bucket.trim()));
    let (status, body) =
        management_request(client, credential, UC_HOST, Method::GET, &query, None).await?;
    if !status.is_success() {
        return Err(format_qiniu_error("获取空间域名失败", status, &body));
    }
    serde_json::from_str::<Vec<String>>(&body)
        .map_err(|error| format!("解析七牛空间域名失败：{error}"))
}

#[tauri::command]
pub async fn qiniu_get_attachment_data_url(
    raw: QiniuRawCredential,
    bucket: String,
    region: String,
    domain: String,
    key: String,
    mime_type: String,
) -> Result<Option<String>, String> {
    let credential = parse_credential(&raw)?;
    let _ = region;
    let client = qiniu_client()?;
    let domain = if domain.trim().is_empty() {
        let domains = qiniu_bucket_domains_inner(&client, &credential, &bucket).await?;
        domains
            .into_iter()
            .next()
            .ok_or_else(|| "空间还没有可用域名，请先在七牛控制台绑定域名。".to_string())?
    } else {
        domain
    };
    let bytes = fetch_object_bytes(&client, &credential, &domain, &key).await?;
    Ok(bytes.map(|bytes| {
        format!(
            "data:{};base64,{}",
            if mime_type.is_empty() { "application/octet-stream".to_string() } else { mime_type },
            BASE64.encode(bytes)
        )
    }))
}

#[tauri::command]
pub async fn qiniu_sign_download_urls(
    raw: QiniuRawCredential,
    domain: String,
    keys: Vec<String>,
) -> Result<Vec<String>, String> {
    let credential = parse_credential(&raw)?;
    if domain.trim().is_empty() {
        return Err("空间还没有可用域名，无法生成下载链接。".to_string());
    }
    Ok(keys
        .iter()
        .map(|key| build_private_download_url(&credential, &domain, key, DOWNLOAD_TTL_SECONDS))
        .collect())
}

#[tauri::command]
pub async fn qiniu_put_object(
    raw: QiniuRawCredential,
    bucket: String,
    region: String,
    key: String,
    data_base64: String,
    content_type: String,
) -> Result<(), String> {
    let credential = parse_credential(&raw)?;
    let data = BASE64
        .decode(data_base64.trim())
        .map_err(|error| format!("附件数据无法解码：{error}"))?;
    if data.is_empty() {
        return Err("附件内容为空，无法上传。".to_string());
    }
    let (upload_host, _, _, _, _) = region_config(&region);
    let upload_token = build_upload_token(
        &credential,
        bucket.trim(),
        &key,
        now_unix() + UPLOAD_DEADLINE_SECONDS,
    );
    let mime = if content_type.trim().is_empty() {
        "application/octet-stream"
    } else {
        content_type.trim()
    };
    let file_name = key.rsplit('/').next().unwrap_or("attachment");
    let form = multipart::Form::new()
        .text("key", key.clone())
        .text("token", upload_token)
        .part(
            "file",
            multipart::Part::bytes(data)
                .file_name(file_name.to_string())
                .mime_str(mime)
                .map_err(|error| format!("附件类型不合法：{error}"))?,
        );
    let client = qiniu_client()?;
    let response = client
        .post(format!("https://{upload_host}"))
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("上传到七牛失败：{error}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format_qiniu_error(&format!("上传 {key} 失败"), status, &body));
    }
    Ok(())
}

#[tauri::command]
pub async fn qiniu_delete_object(
    raw: QiniuRawCredential,
    bucket: String,
    region: String,
    key: String,
) -> Result<(), String> {
    let credential = parse_credential(&raw)?;
    let (_, _, _, rs_host, _) = region_config(&region);
    let path = format!("/delete/{}", encoded_entry(bucket.trim(), &key));
    let client = qiniu_client()?;
    let (status, body) = management_request(
        &client,
        &credential,
        &format!("https://{rs_host}"),
        Method::POST,
        &path,
        None,
    )
    .await?;
    // 612 = 文件不存在；删除幂等处理
    if status.is_success() || status.as_u16() == 612 {
        return Ok(());
    }
    Err(format_qiniu_error(&format!("删除 {key} 失败"), status, &body))
}

/// 并发读取一组小 JSON 对象（日期文档/标签索引），不存在的键返回 None。
#[tauri::command]
pub async fn qiniu_get_objects(
    raw: QiniuRawCredential,
    bucket: String,
    region: String,
    domain: String,
    keys: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    let credential = parse_credential(&raw)?;
    let _ = region;
    let client = qiniu_client()?;
    let domain = if domain.trim().is_empty() {
        let domains = qiniu_bucket_domains_inner(&client, &credential, &bucket).await?;
        domains
            .into_iter()
            .next()
            .ok_or_else(|| "空间还没有可用域名，请先在七牛控制台绑定域名。".to_string())?
    } else {
        domain
    };
    let client_ref = &client;
    let credential_ref = &credential;
    let domain_ref = domain.as_str();
    let futures = keys.into_iter().map(|key| async move {
        fetch_object_bytes(client_ref, credential_ref, domain_ref, &key)
            .await
            .map(|bytes| bytes.map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
    });
    let results = join_all(futures)
        .await
        .into_iter()
        .collect::<Result<Vec<_>, String>>()?;
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_raw() -> QiniuRawCredential {
        QiniuRawCredential {
            access_key: "AKTEST0000000000000000000000000000000000".to_string(),
            secret_key: "SKTEST0000000000000000000000000000000000000".to_string(),
        }
    }

    #[test]
    fn parses_paired_credential_with_trimming() {
        let mut raw = test_raw();
        raw.access_key = format!(" {} ", raw.access_key);
        raw.secret_key = format!("\n{}\n", raw.secret_key);
        let credential = parse_credential(&raw).unwrap();
        assert_eq!(credential.access_key, "AKTEST0000000000000000000000000000000000");
        assert_eq!(credential.secret_key, "SKTEST0000000000000000000000000000000000000");
    }

    #[test]
    fn rejects_incomplete_credential() {
        let mut raw = test_raw();
        raw.secret_key = String::new();
        let error = parse_credential(&raw).unwrap_err();
        assert!(error.contains("完整填写"));
    }

    #[test]
    fn rejects_malformed_credential() {
        let mut raw = test_raw();
        raw.access_key = "not a valid access key".to_string();
        assert!(parse_credential(&raw).is_err());
    }

    #[test]
    fn builds_management_signing_string() {
        let signing = build_management_signing_string(
            "GET",
            "/v6/space?bucket=demo&g=day",
            "api.qiniuapi.com",
            Some("application/x-www-form-urlencoded"),
            None,
        );
        assert_eq!(
            signing,
            "GET /v6/space?bucket=demo&g=day\nHost: api.qiniuapi.com\nContent-Type: application/x-www-form-urlencoded\n\n"
        );
    }

    #[test]
    fn management_authorization_includes_qiniu_prefix() {
        let credential = QiniuCredential {
            access_key: "ak".repeat(20),
            secret_key: "sk".repeat(20),
        };
        let authorization = management_authorization(
            &credential,
            "GET",
            "/buckets",
            "uc.qiniuapi.com",
            Some("application/x-www-form-urlencoded"),
            None,
        );
        assert!(authorization.starts_with("Qiniu "));
        assert!(authorization.contains(':'));
        let parts: Vec<&str> = authorization[6..].splitn(3, ':').collect();
        assert_eq!(parts[0], "ak".repeat(20));
        assert_eq!(parts[1].len(), 27); // HMAC-SHA1 的 URL-safe Base64
    }

    #[test]
    fn builds_upload_token_with_policy() {
        let credential = QiniuCredential {
            access_key: "ak".repeat(20),
            secret_key: "sk".repeat(20),
        };
        let token = build_upload_token(&credential, "calendarmark", "date/2026-09-17.json", 1900000000);
        let parts: Vec<&str> = token.splitn(3, ':').collect();
        assert_eq!(parts[0], "ak".repeat(20));
        assert_eq!(parts[1].len(), 27);
        let policy = String::from_utf8(
            URLSAFE
                .decode(parts[2])
                .expect("policy 应为 URL-safe Base64"),
        )
        .unwrap();
        let policy: Value = serde_json::from_str(&policy).unwrap();
        assert_eq!(policy["scope"], "calendarmark:date/2026-09-17.json");
        assert_eq!(policy["deadline"], 1900000000);
    }

    #[test]
    fn builds_private_download_url_with_expiry() {
        let credential = QiniuCredential {
            access_key: "ak".repeat(20),
            secret_key: "sk".repeat(20),
        };
        let url = build_private_download_url(&credential, "cdn.example.com", "files/demo.png", 120);
        assert!(url.starts_with("http://cdn.example.com/files/demo.png?e="));
        assert!(url.contains("&token="));
    }

    #[test]
    fn encodes_bucket_entry_and_validates_names() {
        assert_eq!(encoded_entry("b", "k"), "Yjpr");
        assert!(validate_bucket_name("calendarmark").is_ok());
        assert!(validate_bucket_name("calendarMark").is_err());
        assert!(validate_bucket_name("-bad").is_err());
        assert!(validate_bucket_name("ab").is_err());
    }

    #[test]
    fn formats_stats_time_as_compact_utc() {
        assert_eq!(format_stats_time(0), "19700101000000");
        assert_eq!(format_stats_time(1_771_200_000), "20260216000000");
    }
}
