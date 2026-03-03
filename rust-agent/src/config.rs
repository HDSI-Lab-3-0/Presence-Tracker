use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub bluetooth: BluetoothConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BluetoothConfig {
    #[serde(default)]
    pub audio_block_uuids: Vec<String>,
    #[serde(default = "default_command_timeout_seconds")]
    pub command_timeout_seconds: u64,
}

impl Config {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self> {
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read config file {}", path.as_ref().display()))?;
        let mut config: Config = toml::from_str(&contents)
            .with_context(|| format!("Failed to parse config file {}", path.as_ref().display()))?;

        if config.bluetooth.command_timeout_seconds == 0 {
            config.bluetooth.command_timeout_seconds = default_command_timeout_seconds();
        }

        Ok(config)
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bluetooth: BluetoothConfig::default(),
        }
    }
}

impl Default for BluetoothConfig {
    fn default() -> Self {
        Self {
            audio_block_uuids: Vec::new(),
            command_timeout_seconds: default_command_timeout_seconds(),
        }
    }
}

const fn default_command_timeout_seconds() -> u64 {
    10
}
