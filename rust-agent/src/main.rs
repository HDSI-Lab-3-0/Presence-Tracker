mod bluetooth_agent;
mod bluetooth_probe;
mod config;
mod convex_client;
mod gui_simple;
mod logging;
mod presence_loop;

use anyhow::{anyhow, Result};
use clap::{Arg, Command};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::signal;

use crate::bluetooth_agent::start_agent;
use crate::bluetooth_probe::{CommandRunner, ProcessRunner};
use crate::config::Config;
use crate::convex_client::ConvexClient;
use crate::presence_loop::PresenceLoop;
use gui_simple::run_gui;

#[tokio::main]
async fn main() -> Result<()> {
    // Load environment variables
    dotenvy::dotenv().ok();

    let matches = Command::new("presence-tracker-rs")
        .version("0.1.0")
        .about("Presence Tracker for Raspberry Pi")
        .arg(
            Arg::new("gui")
                .short('g')
                .long("gui")
                .help("Run the GUI application")
                .action(clap::ArgAction::SetTrue),
        )
        .arg(
            Arg::new("agent")
                .short('a')
                .long("agent")
                .help("Run the Bluetooth agent")
                .action(clap::ArgAction::SetTrue),
        )
        .arg(
            Arg::new("config")
                .short('c')
                .long("config")
                .value_name("FILE")
                .help("Path to TOML config file for agent mode")
                .default_value("config/agent.toml"),
        )
        .get_matches();

    let run_gui_flag = matches.get_flag("gui");
    let run_agent_flag = matches.get_flag("agent");
    let config_path = matches
        .get_one::<String>("config")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("missing config path"))?;

    if run_gui_flag && run_agent_flag {
        return Err(anyhow!("Cannot use --gui and --agent together"));
    }

    if run_gui_flag {
        println!("Starting Presence Tracker GUI...");
        run_gui().await.map_err(|e| anyhow!(e.to_string()))?;
    } else {
        // Default to agent mode for systemd/background usage.
        run_agent(config_path).await?;
    }

    Ok(())
}

async fn run_agent(config_path: PathBuf) -> Result<()> {
    let config = match Config::load_from_file(&config_path) {
        Ok(config) => config,
        Err(err) => {
            eprintln!(
                "Failed to load config from {}: {err}. Falling back to defaults.",
                config_path.display()
            );
            Config::default()
        }
    };

    println!(
        "Starting Bluetooth agent with config path: {}",
        config_path.display()
    );

    let runner: Arc<dyn CommandRunner> = Arc::new(ProcessRunner);
    let convex = Arc::new(ConvexClient::from_config(&config)?);
    let _runtime = start_agent(&config, runner.clone(), convex.clone()).await?;

    if convex.is_configured() {
        let mut presence_loop =
            PresenceLoop::new(config.clone(), convex.clone(), Arc::new(ProcessRunner));
        tokio::spawn(async move {
            if let Err(error) = presence_loop.run_forever().await {
                logging::warn(
                    "presence_loop",
                    "run_forever",
                    None,
                    Some("error"),
                    &error.to_string(),
                );
            }
        });
    } else {
        logging::warn(
            "main",
            "convex_config",
            None,
            Some("missing"),
            "Convex URL is not configured; presence status updates are disabled",
        );
    }

    println!("Bluetooth agent is running. Press Ctrl+C to stop.");
    signal::ctrl_c().await?;
    println!("Shutdown signal received. Exiting.");
    Ok(())
}
