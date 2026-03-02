mod bluetooth_agent;
mod bluetooth_probe;
mod config;
mod convex_client;
mod gui_simple;
mod logging;

use clap::{Arg, Command};
use gui_simple::run_gui;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load environment variables
    dotenvy::dotenv().ok();

    let matches = Command::new("presence-tracker-rs")
        .version("0.1.0")
        .about("Presence Tracker for Raspberry Pi with GUI")
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
        .get_matches();

    if matches.get_flag("gui") {
        println!("Starting Presence Tracker GUI...");
        run_gui().await?;
    } else if matches.get_flag("agent") {
        println!("Starting Bluetooth agent...");
        // You can add the agent logic here if needed
        todo!("Bluetooth agent integration");
    } else {
        println!("Please specify either --gui or --agent");
        println!("Use --help for more information");
    }

    Ok(())
}
