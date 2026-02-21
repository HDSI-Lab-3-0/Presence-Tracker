use anyhow::Result;
use clap::Parser;
use std::sync::Arc;
use presence_tracker_rs::bluetooth_agent;
use presence_tracker_rs::bluetooth_probe::{self, ProcessRunner};
use presence_tracker_rs::config::{Cli, Config};
use presence_tracker_rs::convex_client::ConvexClient;
use presence_tracker_rs::logging;
use presence_tracker_rs::presence_loop::PresenceLoop;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let config = Config::load(&cli.config)?;

    logging::init(&config.logging.log_file, config.logging.max_lines)?;
    logging::info(
        "main",
        "config_loaded",
        None,
        Some("ok"),
        &format!("config={}", cli.config.display()),
    );

    let runner: Arc<dyn bluetooth_probe::CommandRunner> = Arc::new(ProcessRunner::default());

    let convex = Arc::new(ConvexClient::new(
        config.convex.deployment_url.clone(),
        config.convex.admin_key.clone(),
    )?);

    let _agent = bluetooth_agent::start_agent(&config, runner.clone(), convex.clone()).await?;

    let mut loop_runtime = PresenceLoop::new(config, convex, runner);
    loop_runtime.run_forever().await?;

    Ok(())
}
