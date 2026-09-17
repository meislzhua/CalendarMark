use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE as URLSAFE};
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
/// 中心域名会自动路由到空间真实区域，避免用户选错区域导致 incorrect zone / 静默返回 0
const RS_CENTRAL_HOST: &str = "https://rs.qiniu.com";
const RSF_CENTRAL_HOST: &str = "https://rsf.qiniu.com";
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
    pub get_calls: u64,
    pub put_delete_calls: u64,
    pub cdn_origin_flow_bytes: u64,
    pub outbound_flow_bytes: u64,
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
            return Err(
                "AccessKey 格式不正确：请复制个人中心「密钥管理」中的 AccessKey。".to_string(),
            );
        }
        if !valid_key(secret_key) {
            return Err(
                "SecretKey 格式不正确：请复制个人中心「密钥管理」中的 SecretKey。".to_string(),
            );
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
    let mut mac =
        HmacSha1::new_from_slice(secret_key.as_bytes()).expect("HMAC-SHA1 accepts any key length");
    mac.update(data.as_bytes());
    // 官方 SDK 使用带 padding 的 URL-safe Base64（URLEncoding）。
    // HMAC-SHA1 签名编码后是 28 字符、以 "=" 结尾；去掉 padding 会被七牛判定为 bad token（401）。
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
    let signing =
        build_management_signing_string(method, path_with_query, host, content_type, body);
    let encoded_sign = hmac_sha1_urlsafe(&credential.secret_key, &signing);
    format!("Qiniu {}:{encoded_sign}", credential.access_key)
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

fn region_config(
    region: &str,
) -> (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
) {
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
        host.trim_start_matches("https://")
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
        _ if detail.contains("incorrect zone") => format!(
            "{context}：空间不在所选区域。选择空间时会自动识别真实区域，请重新点击该空间。"
        ),
        _ => format!("{context}：七牛 API {} {}", status.as_u16(), detail),
    }
}

#[tauri::command]
pub async fn qiniu_list_buckets(raw: QiniuRawCredential) -> Result<Vec<String>, String> {
    let credential = parse_credential(&raw)?;
    let client = qiniu_client()?;
    let (status, body) =
        management_request(&client, &credential, UC_HOST, Method::GET, "/buckets", None).await?;
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
    let query = format!(
        "/private?bucket={}&private=1",
        url_encode_component(&bucket)
    );
    let (status, body) =
        management_request(&client, &credential, UC_HOST, Method::POST, &query, None).await?;
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
pub async fn qiniu_bucket_domains(
    raw: QiniuRawCredential,
    bucket: String,
) -> Result<Vec<String>, String> {
    let credential = parse_credential(&raw)?;
    let client = qiniu_client()?;
    let query = format!("/v2/domains?tbl={}", url_encode_component(bucket.trim()));
    let (status, body) =
        management_request(&client, &credential, UC_HOST, Method::GET, &query, None).await?;
    if !status.is_success() {
        return Err(format_qiniu_error("获取空间域名失败", status, &body));
    }
    serde_json::from_str::<Vec<String>>(&body)
        .map_err(|error| format!("解析七牛空间域名失败：{error}"))
}

/// 通过 UC /v2/query 自动识别空间所在区域（如 z0/z2），
/// 用于上传域名选择和用量统计，避免用户手选区域出错。
#[tauri::command]
pub async fn qiniu_query_region(raw: QiniuRawCredential, bucket: String) -> Result<String, String> {
    let credential = parse_credential(&raw)?;
    let bucket = bucket.trim().to_string();
    if bucket.is_empty() {
        return Err("请先选择空间。".to_string());
    }
    let client = qiniu_client()?;
    let query = format!(
        "/v2/query?ak={}&bucket={}",
        url_encode_component(&credential.access_key),
        url_encode_component(&bucket)
    );
    let (status, body) =
        management_request(&client, &credential, UC_HOST, Method::GET, &query, None).await?;
    if !status.is_success() {
        return Err(format_qiniu_error("识别空间区域失败", status, &body));
    }
    let parsed: Value =
        serde_json::from_str(&body).map_err(|error| format!("解析空间区域失败：{error}"))?;
    let region = parsed
        .get("region")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if region.is_empty() {
        return Err("七牛没有返回空间区域，请确认空间存在。".to_string());
    }
    Ok(region)
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

fn days_from_civil(year: u64, month: u64, day: u64) -> u64 {
    let year = year as i64;
    let month = month as i64;
    let day = day as i64;
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = ((month + 9) % 12) as u64;
    let doy = (153 * mp + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era as i64 * 146097 + doe as i64 - 719468) as u64
}

/// 七牛按 UTC 时间查询，但账号免费额度按中国时区自然月重置。
fn current_billing_month_start(now: u64) -> u64 {
    const CHINA_OFFSET_SECONDS: u64 = 8 * 60 * 60;
    let local_now = format_stats_time(now + CHINA_OFFSET_SECONDS);
    let year = local_now[..4].parse::<u64>().unwrap_or(1970);
    let month = local_now[4..6].parse::<u64>().unwrap_or(1);
    (days_from_civil(year, month, 1) * 86400).saturating_sub(CHINA_OFFSET_SECONDS)
}

fn parse_space_usage(body: &str, now: u64) -> Result<(u64, i64), String> {
    let parsed: Value =
        serde_json::from_str(body).map_err(|error| format!("解析七牛存储用量失败：{error}"))?;
    let times = parsed
        .get("times")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_i64).collect::<Vec<_>>())
        .unwrap_or_default();
    let datas = parsed
        .get("datas")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
        .unwrap_or_default();
    let storage_bytes = datas.last().copied().unwrap_or(0);
    Ok((storage_bytes, times.last().copied().unwrap_or(now as i64)))
}

fn parse_metric_total(body: &str, field: &str) -> Result<u64, String> {
    let parsed: Value =
        serde_json::from_str(body).map_err(|error| format!("解析七牛统计用量失败：{error}"))?;
    let items = parsed
        .as_array()
        .ok_or_else(|| "七牛统计接口返回格式不正确。".to_string())?;
    Ok(items
        .iter()
        .filter_map(|item| {
            item.get("values")
                .and_then(|values| values.get(field))
                .and_then(Value::as_u64)
        })
        .fold(0_u64, u64::saturating_add))
}

#[tauri::command]
pub async fn qiniu_get_usage(raw: QiniuRawCredential) -> Result<QiniuUsage, String> {
    let credential = parse_credential(&raw)?;
    let now = now_unix();
    let begin = format_stats_time(current_billing_month_start(now));
    let end = format_stats_time(now + 600);
    let client = qiniu_client()?;

    // 不传 $bucket/$region 时，统计接口返回整个账号的汇总数据。
    let queries = [
        (
            "标准存储",
            format!("/v6/space?begin={begin}&end={end}&g=day"),
        ),
        (
            "GET 请求",
            format!("/v6/blob_io?begin={begin}&end={end}&g=day&select=hits&$metric=hits"),
        ),
        (
            "PUT/DELETE 请求",
            format!("/v6/rs_put?begin={begin}&end={end}&g=day&select=hits"),
        ),
        (
            "CDN 回源流量",
            format!("/v6/blob_io?begin={begin}&end={end}&g=day&select=flow&$metric=cdn_flow_out"),
        ),
        (
            "外网流出流量",
            format!("/v6/blob_io?begin={begin}&end={end}&g=day&select=flow&$metric=flow_out"),
        ),
    ];

    let client_ref = &client;
    let credential_ref = &credential;
    let futures = queries.iter().map(|(name, query)| async move {
        let (status, body) = management_request(
            client_ref,
            credential_ref,
            API_HOST,
            Method::GET,
            query,
            None,
        )
        .await?;
        if !status.is_success() {
            return Err(format_qiniu_error(
                &format!("读取七牛{name}用量失败"),
                status,
                &body,
            ));
        }
        Ok(body)
    });
    let results = join_all(futures).await;
    let mut errors = Vec::new();
    let bodies = results
        .into_iter()
        .map(|result| {
            result.unwrap_or_else(|error| {
                errors.push(error);
                String::new()
            })
        })
        .collect::<Vec<_>>();

    if bodies.iter().all(|body| body.is_empty()) {
        return Err(errors
            .into_iter()
            .next()
            .unwrap_or_else(|| "七牛没有返回任何账号用量数据。".to_string()));
    }

    // 单个指标暂不可用时不阻塞其它指标；实际错误仍在所有指标均失败时返回。
    let (storage_bytes, updated_at) = parse_space_usage(&bodies[0], now).unwrap_or((0, now as i64));
    let get_calls = parse_metric_total(&bodies[1], "hits").unwrap_or(0);
    let put_delete_calls = parse_metric_total(&bodies[2], "hits").unwrap_or(0);
    let cdn_origin_flow_bytes = parse_metric_total(&bodies[3], "flow").unwrap_or(0);
    let outbound_flow_bytes = parse_metric_total(&bodies[4], "flow").unwrap_or(0);

    Ok(QiniuUsage {
        storage_bytes,
        get_calls,
        put_delete_calls,
        cdn_origin_flow_bytes,
        outbound_flow_bytes,
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
    let _ = region;
    let mut keys = Vec::new();
    let mut marker = String::new();
    loop {
        // 官方 v1 资源列举：POST {rsf}/list?bucket=&prefix=&limit=&marker=
        let query = format!(
            "/list?bucket={}&prefix={}&limit={}&marker={}",
            url_encode_component(bucket),
            url_encode_component(prefix),
            LIST_PAGE_SIZE,
            url_encode_component(&marker)
        );
        let (status, body) = management_request(
            client,
            credential,
            RSF_CENTRAL_HOST,
            Method::POST,
            &query,
            None,
        )
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
        return Err(format!(
            "下载 {key} 失败：下载凭证被拒绝，请检查密钥与空间域名。"
        ));
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
            if mime_type.is_empty() {
                "application/octet-stream".to_string()
            } else {
                mime_type
            },
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
        return Err(format_qiniu_error(
            &format!("上传 {key} 失败"),
            status,
            &body,
        ));
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
    let _ = region;
    let path = format!("/delete/{}", encoded_entry(bucket.trim(), &key));
    let client = qiniu_client()?;
    let (status, body) = management_request(
        &client,
        &credential,
        RS_CENTRAL_HOST,
        Method::POST,
        &path,
        None,
    )
    .await?;
    // 612 = 文件不存在；删除幂等处理
    if status.is_success() || status.as_u16() == 612 {
        return Ok(());
    }
    Err(format_qiniu_error(
        &format!("删除 {key} 失败"),
        status,
        &body,
    ))
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
        assert_eq!(
            credential.access_key,
            "AKTEST0000000000000000000000000000000000"
        );
        assert_eq!(
            credential.secret_key,
            "SKTEST0000000000000000000000000000000000000"
        );
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
        // HMAC-SHA1 的 URL-safe Base64：带 padding 共 28 字符，且以 "=" 结尾
        assert_eq!(parts[1].len(), 28);
        assert!(parts[1].ends_with('='));
    }

    #[test]
    fn parses_account_space_usage() {
        let (storage, updated_at) = parse_space_usage(
            r#"{"times":[1767196800,1767283200],"datas":[1024,4096]}"#,
            200,
        )
        .unwrap();
        assert_eq!(storage, 4096);
        assert_eq!(updated_at, 1767283200);
    }

    #[test]
    fn parses_empty_account_space_usage_as_zero() {
        let (storage, updated_at) = parse_space_usage(r#"{"times":[],"datas":[]}"#, 200).unwrap();
        assert_eq!(storage, 0);
        assert_eq!(updated_at, 200);
    }

    #[test]
    fn sums_daily_metric_values() {
        let body = r#"[
            {"time":"2026-09-01T00:00:00+08:00","values":{"hits":12,"flow":34}},
            {"time":"2026-09-02T00:00:00+08:00","values":{"hits":30,"flow":56}},
            {"time":"2026-09-03T00:00:00+08:00","values":{"flow":78}}
        ]"#;
        assert_eq!(parse_metric_total(body, "hits").unwrap(), 42);
        assert_eq!(parse_metric_total(body, "flow").unwrap(), 168);
        assert_eq!(parse_metric_total("[]", "hits").unwrap(), 0);
    }

    #[test]
    fn billing_month_start_uses_china_calendar_month() {
        // 2026-02-16 00:00:00 UTC = 当天 08:00 中国时间。
        let begin = current_billing_month_start(1_771_200_000);
        assert_eq!(format_stats_time(begin), "20260131160000");
    }

    // 可选真实接口冒烟：QINIU_ACCESS_KEY=... QINIU_SECRET_KEY=... cargo test -- --ignored
    #[test]
    #[ignore]
    fn reads_real_account_usage_when_credentials_are_provided() {
        let Ok(access_key) = std::env::var("QINIU_ACCESS_KEY") else {
            return;
        };
        let Ok(secret_key) = std::env::var("QINIU_SECRET_KEY") else {
            return;
        };
        let usage = tauri::async_runtime::block_on(qiniu_get_usage(QiniuRawCredential {
            access_key,
            secret_key,
        }))
        .expect("读取七牛账号用量");
        assert!(usage.storage_bytes > 0);
    }

    #[test]
    fn builds_upload_token_with_policy() {
        let credential = QiniuCredential {
            access_key: "ak".repeat(20),
            secret_key: "sk".repeat(20),
        };
        let token = build_upload_token(
            &credential,
            "calendarmark",
            "date/2026-09-17.json",
            1900000000,
        );
        let parts: Vec<&str> = token.splitn(3, ':').collect();
        assert_eq!(parts[0], "ak".repeat(20));
        assert_eq!(parts[1].len(), 28);
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
