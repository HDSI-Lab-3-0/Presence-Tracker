use crate::config::Config;
use anyhow::{anyhow, Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ConvexClient {
    base_url: Option<String>,
    admin_key: Option<String>,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceRecord {
    #[serde(rename = "_id")]
    pub id: Option<String>,
    #[serde(rename = "macAddress")]
    pub mac_address: String,
    #[serde(default = "default_device_status")]
    pub status: String,
    #[serde(rename = "pendingRegistration", default)]
    pub pending_registration: bool,
}

impl ConvexClient {
    pub fn from_config(config: &Config) -> Result<Self> {
        Self::new(
            config.convex.deployment_url.clone(),
            config.convex.admin_key.clone(),
        )
    }

    pub fn new(base_url: impl Into<String>, admin_key: Option<String>) -> Result<Self> {
        let normalized = base_url.into().trim_end_matches('/').trim().to_string();
        let base_url = if normalized.is_empty() || is_placeholder_url(&normalized) {
            None
        } else {
            Some(normalized)
        };

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .context("failed building HTTP client")?;

        Ok(Self {
            base_url,
            admin_key: admin_key.filter(|k| !k.trim().is_empty()),
            http,
        })
    }

    pub fn is_configured(&self) -> bool {
        self.base_url.is_some()
    }

    pub async fn get_devices(&self) -> Result<Vec<DeviceRecord>> {
        if !self.is_configured() {
            return Ok(Vec::new());
        }

        let value = self.call("query", "devices:getDevices", json!({})).await?;
        serde_json::from_value::<Vec<DeviceRecord>>(value)
            .context("devices:getDevices did not return a valid device list")
    }

    pub async fn register_pending_device(&self, mac: &str, name: Option<&str>) -> Result<()> {
        if !self.is_configured() {
            return Ok(());
        }

        let args = json!({
            "macAddress": mac,
            "name": name.unwrap_or("")
        });
        let _ = self
            .call("mutation", "devices:registerPendingDevice", args)
            .await?;
        Ok(())
    }

    pub async fn update_device_status(&self, mac: &str, status: &str) -> Result<()> {
        if !self.is_configured() {
            return Ok(());
        }

        let args = json!({
            "macAddress": mac,
            "status": status
        });
        let _ = self
            .call("mutation", "devices:updateDeviceStatus", args)
            .await?;
        Ok(())
    }

    async fn call(&self, endpoint: &str, path: &str, args: Value) -> Result<Value> {
        let base_url = self
            .base_url
            .as_ref()
            .ok_or_else(|| anyhow!("Convex client is not configured"))?;

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            "Convex-Client",
            HeaderValue::from_static("presence-tracker-rs-0.1.0"),
        );

        if let Some(key) = &self.admin_key {
            let auth = HeaderValue::from_str(&format!("Convex {key}"))
                .context("invalid admin key in Authorization header")?;
            headers.insert(AUTHORIZATION, auth);
        }

        let payload = json!({
            "path": path,
            "args": args,
            "format": "json"
        });

        let url = format!("{base_url}/api/{endpoint}");
        let response = self
            .http
            .post(url)
            .headers(headers)
            .json(&payload)
            .send()
            .await
            .with_context(|| format!("Convex call failed for {path}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Convex {endpoint} {path} failed: {status} {body}"));
        }

        let body: Value = response
            .json()
            .await
            .with_context(|| format!("invalid JSON in Convex response for {path}"))?;

        if body
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|s| s != "success")
        {
            let message = body
                .get("errorMessage")
                .and_then(Value::as_str)
                .or_else(|| body.get("error").and_then(Value::as_str))
                .unwrap_or("unknown Convex error");
            return Err(anyhow!("Convex {endpoint} {path} error: {message}"));
        }

        Ok(extract_value(body))
    }
}

fn extract_value(body: Value) -> Value {
    if let Some(value) = body.get("value") {
        value.clone()
    } else if let Some(value) = body.get("result") {
        value.clone()
    } else {
        body
    }
}

fn default_device_status() -> String {
    "absent".to_string()
}

fn is_placeholder_url(value: &str) -> bool {
    value
        .to_ascii_lowercase()
        .contains("your-convex-deployment")
}
