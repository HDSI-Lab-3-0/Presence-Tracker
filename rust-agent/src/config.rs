use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub convex: ConvexConfig,
    #[serde(default)]
    pub presence: PresenceConfig,
    #[serde(default)]
    pub bluetooth: BluetoothConfig,
    #[serde(default)]
    pub logging: LoggingConfig,
    #[serde(default)]
    pub paths: PathsConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConvexConfig {
    #[serde(default)]
    pub deployment_url: String,
    pub admin_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PresenceConfig {
    #[serde(default = "default_polling_interval_seconds")]
    pub polling_interval_seconds: u64,
    #[serde(default = "default_absent_threshold")]
    pub absent_threshold: u32,
    #[serde(default = "default_grace_period_seconds")]
    pub grace_period_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BluetoothConfig {
    #[serde(default = "default_l2ping_timeout_seconds")]
    pub l2ping_timeout_seconds: u64,
    #[serde(default = "default_l2ping_count")]
    pub l2ping_count: u32,
    #[serde(default = "default_connect_probe_timeout_seconds")]
    pub connect_probe_timeout_seconds: u64,
    #[serde(default)]
    pub audio_block_uuids: Vec<String>,
    #[serde(default = "default_command_timeout_seconds")]
    pub command_timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingConfig {
    #[serde(default = "default_log_file")]
    pub log_file: PathBuf,
    #[serde(default = "default_max_log_lines")]
    pub max_lines: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PathsConfig {
    #[serde(default = "default_state_file")]
    pub state_file: PathBuf,
}

impl Config {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self> {
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read config file {}", path.as_ref().display()))?;
        let mut config: Config = toml::from_str(&contents)
            .with_context(|| format!("Failed to parse config file {}", path.as_ref().display()))?;
        config.apply_env_fallbacks();
        config.normalize();
        Ok(config)
    }

    fn apply_env_fallbacks(&mut self) {
        if self.convex.deployment_url.trim().is_empty()
            || is_placeholder_url(&self.convex.deployment_url)
        {
            if let Some(url) = infer_convex_url_from_env() {
                self.convex.deployment_url = url;
            }
        }
    }

    fn normalize(&mut self) {
        self.convex.deployment_url = self.convex.deployment_url.trim_end_matches('/').to_string();

        if self
            .convex
            .admin_key
            .as_deref()
            .is_some_and(|k| k.trim().is_empty())
        {
            self.convex.admin_key = None;
        }

        self.presence.polling_interval_seconds = self.presence.polling_interval_seconds.max(1);
        self.presence.absent_threshold = self.presence.absent_threshold.max(1);
        self.bluetooth.l2ping_timeout_seconds = self.bluetooth.l2ping_timeout_seconds.max(1);
        self.bluetooth.l2ping_count = self.bluetooth.l2ping_count.max(1);
        self.bluetooth.connect_probe_timeout_seconds =
            self.bluetooth.connect_probe_timeout_seconds.max(1);
        self.bluetooth.command_timeout_seconds = self.bluetooth.command_timeout_seconds.max(1);
        self.logging.max_lines = self.logging.max_lines.max(1);
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            convex: ConvexConfig::default(),
            presence: PresenceConfig::default(),
            bluetooth: BluetoothConfig::default(),
            logging: LoggingConfig::default(),
            paths: PathsConfig::default(),
        }
    }
}

impl Default for ConvexConfig {
    fn default() -> Self {
        Self {
            deployment_url: String::new(),
            admin_key: None,
        }
    }
}

impl Default for PresenceConfig {
    fn default() -> Self {
        Self {
            polling_interval_seconds: default_polling_interval_seconds(),
            absent_threshold: default_absent_threshold(),
            grace_period_seconds: default_grace_period_seconds(),
        }
    }
}

impl Default for BluetoothConfig {
    fn default() -> Self {
        Self {
            l2ping_timeout_seconds: default_l2ping_timeout_seconds(),
            l2ping_count: default_l2ping_count(),
            connect_probe_timeout_seconds: default_connect_probe_timeout_seconds(),
            audio_block_uuids: Vec::new(),
            command_timeout_seconds: default_command_timeout_seconds(),
        }
    }
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            log_file: default_log_file(),
            max_lines: default_max_log_lines(),
        }
    }
}

impl Default for PathsConfig {
    fn default() -> Self {
        Self {
            state_file: default_state_file(),
        }
    }
}

fn infer_convex_url_from_env() -> Option<String> {
    std::env::var("CONVEX_SELF_HOSTED_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("CONVEX_DEPLOYMENT_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("CONVEX_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .or_else(|| {
            std::env::var("CONVEX_SITE_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
}

fn is_placeholder_url(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    normalized.contains("your-convex-deployment")
}

const fn default_polling_interval_seconds() -> u64 {
    15
}

const fn default_absent_threshold() -> u32 {
    3
}

const fn default_grace_period_seconds() -> u64 {
    300
}

const fn default_l2ping_timeout_seconds() -> u64 {
    2
}

const fn default_l2ping_count() -> u32 {
    1
}

const fn default_connect_probe_timeout_seconds() -> u64 {
    2
}

const fn default_command_timeout_seconds() -> u64 {
    5
}

fn default_log_file() -> PathBuf {
    PathBuf::from("logs/presence_tracker.log")
}

const fn default_max_log_lines() -> usize {
    1000
}

fn default_state_file() -> PathBuf {
    PathBuf::from("config/agent_state.json")
}
