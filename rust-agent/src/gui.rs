use eframe::egui;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    #[serde(rename = "firstName")]
    pub first_name: Option<String>,
    #[serde(rename = "lastName")]
    pub last_name: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StatusFilter {
    All,
    Present,
    Absent,
}

pub struct PresenceGuiApp {
    convex_url: String,
    present_users: Vec<User>,
    absent_users: Vec<User>,
    last_update: Instant,
    update_interval: Duration,
    loading: bool,
    error_message: Option<String>,
    auto_refresh: bool,
    status_filter: StatusFilter,
    refresh_sender: mpsc::Sender<()>,
}

impl PresenceGuiApp {
    pub fn new() -> (Self, mpsc::Receiver<()>) {
        let convex_url = std::env::var("CONVEX_URL")
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let missing_convex_url = convex_url.is_empty();
        
        let (tx, rx) = mpsc::channel(100);
        
        let app = Self {
            convex_url,
            present_users: Vec::new(),
            absent_users: Vec::new(),
            last_update: Instant::now(),
            update_interval: Duration::from_secs(30),
            loading: false,
            error_message: if missing_convex_url {
                Some("CONVEX_URL is not set. Add it to your .env file before launching the GUI.".to_string())
            } else {
                None
            },
            auto_refresh: true,
            status_filter: StatusFilter::All,
            refresh_sender: tx,
        };
        
        (app, rx)
    }

    pub async fn fetch_users(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.convex_url.is_empty() {
            self.error_message = Some(
                "CONVEX_URL is not set. Add it to your .env file before launching the GUI.".to_string(),
            );
            self.loading = false;
            return Ok(());
        }

        self.loading = true;
        self.error_message = None;

        let client = reqwest::Client::new();
        
        // Fetch present users
        let present_response = client
            .post(&format!("{}/api/getPresentUsers", self.convex_url))
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await?;

        if present_response.status().is_success() {
            let present_data: Vec<User> = present_response.json().await?;
            self.present_users = present_data;
        } else {
            self.error_message = Some(format!("Failed to fetch present users: {}", present_response.status()));
            self.loading = false;
            return Ok(());
        }

        // Fetch absent users
        let absent_response = client
            .post(&format!("{}/api/getAbsentUsers", self.convex_url))
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await?;

        if absent_response.status().is_success() {
            let absent_data: Vec<User> = absent_response.json().await?;
            self.absent_users = absent_data;
        } else {
            self.error_message = Some(format!("Failed to fetch absent users: {}", absent_response.status()));
            self.loading = false;
            return Ok(());
        }

        self.last_update = Instant::now();
        self.loading = false;
        Ok(())
    }

    fn get_filtered_users(&self) -> Vec<&User> {
        match self.status_filter {
            StatusFilter::All => {
                let mut all_users: Vec<&User> = self.present_users.iter().collect();
                all_users.extend(&self.absent_users);
                all_users.sort_by(|a, b| a.name.cmp(&b.name));
                all_users
            }
            StatusFilter::Present => self.present_users.iter().collect(),
            StatusFilter::Absent => self.absent_users.iter().collect(),
        }
    }

    fn get_time_since_last_update(&self) -> String {
        let elapsed = self.last_update.elapsed();
        if elapsed < Duration::from_secs(60) {
            format!("{}s", elapsed.as_secs())
        } else if elapsed < Duration::from_secs(3600) {
            format!("{}m", elapsed.as_secs() / 60)
        } else if elapsed < Duration::from_secs(86400) {
            format!("{}h", elapsed.as_secs() / 3600)
        } else {
            format!("{}d", elapsed.as_secs() / 86400)
        }
    }

    fn trigger_refresh(&self) {
        let _ = self.refresh_sender.try_send(());
    }
}

impl eframe::App for PresenceGuiApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Auto-refresh logic
        if self.auto_refresh && self.last_update.elapsed() >= self.update_interval && !self.loading {
            self.trigger_refresh();
        }

        egui::TopBottomPanel::top("top_panel").show(ctx, |ui| {
            egui::menu::bar(ui, |ui| {
                ui.menu_button("File", |ui| {
                    if ui.button("Refresh Now").clicked() {
                        self.trigger_refresh();
                    }
                    if ui.button("Quit").clicked() {
                        _frame.close();
                    }
                });
                
                ui.menu_button("View", |ui| {
                    ui.radio_value(&mut self.status_filter, StatusFilter::All, "All Users");
                    ui.radio_value(&mut self.status_filter, StatusFilter::Present, "Present Only");
                    ui.radio_value(&mut self.status_filter, StatusFilter::Absent, "Absent Only");
                });
                
                ui.checkbox(&mut self.auto_refresh, "Auto Refresh");
                ui.label(format!("Interval: {}s", self.update_interval.as_secs()));
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("🏢 Presence Tracker");
            
            // Status bar
            ui.horizontal(|ui| {
                if self.loading {
                    ui.spinner();
                    ui.label("Loading...");
                } else {
                    ui.label(format!("Updated: {} ago", self.get_time_since_last_update()));
                }
                
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let present_count = self.present_users.len();
                    let absent_count = self.absent_users.len();
                    let total_count = present_count + absent_count;
                    
                    ui.label(format!("Total: {}", total_count));
                    ui.separator();
                    ui.colored_label(egui::Color32::RED, format!("Absent: {}", absent_count));
                    ui.separator();
                    ui.colored_label(egui::Color32::GREEN, format!("Present: {}", present_count));
                });
            });
            
            ui.separator();

            if let Some(error) = &self.error_message {
                ui.colored_label(egui::Color32::RED, format!("❌ {}", error));
                ui.separator();
            }

            // User list
            egui::ScrollArea::vertical().show(ui, |ui| {
                let filtered_users = self.get_filtered_users();
                
                if filtered_users.is_empty() {
                    ui.centered_and_justified(|ui| {
                        if self.loading {
                            ui.label("🔄 Loading users...");
                        } else {
                            ui.label("📭 No users found");
                        }
                    });
                } else {
                    for user in filtered_users {
                        let is_present = self.present_users.iter().any(|u| u.name == user.name);
                        let status_color = if is_present {
                            egui::Color32::GREEN
                        } else {
                            egui::Color32::RED
                        };
                        
                        let status_text = if is_present { "✅ Present" } else { "❌ Absent" };
                        let status_icon = if is_present { "🟢" } else { "🔴" };
                        
                        egui::Frame::none()
                            .fill(if is_present { 
                                egui::Color32::from_rgb(230, 255, 230) 
                            } else { 
                                egui::Color32::from_rgb(255, 230, 230) 
                            })
                            .inner_margin(8.0)
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    // Status indicator
                                    ui.label(egui::RichText::new(status_icon).size(20.0));
                                    
                                    // User name
                                    ui.label(egui::RichText::new(&user.name).size(16.0).strong());
                                    
                                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                        // Status badge
                                        ui.colored_label(
                                            status_color,
                                            egui::RichText::new(status_text).size(14.0).strong()
                                        );
                                    });
                                });
                            });
                        
                        ui.add_space(4.0);
                    }
                }
            });
        });
    }
}

pub async fn run_gui() -> Result<(), eframe::Error> {
    // Load environment variables
    dotenvy::dotenv().ok();

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([800.0, 600.0])
            .with_min_inner_size([400.0, 300.0])
            .with_title("🏢 Presence Tracker - Raspberry Pi"),
        ..Default::default()
    };

    let (mut app, mut refresh_rx) = PresenceGuiApp::new();

    // Initial data fetch
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await; // Small delay to ensure GUI is ready
        if let Err(e) = app.fetch_users().await {
            eprintln!("Initial fetch failed: {}", e);
        }
    });

    // Background refresh task
    tokio::spawn(async move {
        while let Some(()) = refresh_rx.recv().await {
            if let Err(e) = app.fetch_users().await {
                eprintln!("Refresh failed: {}", e);
            }
        }
    });

    eframe::run_native(
        "Presence Tracker GUI",
        options,
        Box::new(|_cc| Box::new(app)),
    )
}
