use base64::Engine;
use reqwest::Url;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HalinHttpResponse {
    pub status: u16,
    pub body: String,
}

async fn execute_fetch(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    body_base64: Option<String>,
) -> Result<HalinHttpResponse, String> {
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("URL scheme not allowed: {s}")),
    }

    let method = method.to_uppercase();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut rb = match method.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported HTTP method: {method}")),
    };

    for (k, v) in headers {
        rb = rb.header(k, v);
    }

    let body_bytes: Option<Vec<u8>> = if body_base64.is_some() {
        let b64 = body_base64.as_ref().unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("base64: {e}"))?;
        Some(decoded)
    } else if let Some(ref s) = body {
        Some(s.as_bytes().to_vec())
    } else {
        None
    };

    if let Some(bytes) = body_bytes {
        rb = rb.body(bytes);
    }

    let res = rb.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(HalinHttpResponse { status, body })
}

/// Flat IPC args: pass `method`, `url`, `headers`, `body`, `bodyBase64` at the top level (camelCase from JS).
#[tauri::command]
pub async fn halin_http_fetch(
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    body_base64: Option<String>,
) -> Result<HalinHttpResponse, String> {
    execute_fetch(
        method,
        url,
        headers.unwrap_or_default(),
        body,
        body_base64,
    )
    .await
}
