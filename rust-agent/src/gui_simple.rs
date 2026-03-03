use convex::{FunctionResult, Value, ConvexClient};
use eframe::egui;
use futures_util::StreamExt;
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::Number;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckedInUser {
    #[serde(rename = "_id")]
    pub id: String,
    pub name: String,
    #[serde(rename = "firstName")]
    pub first_name: Option<String>,
    #[serde(rename = "lastName")]
    pub last_name: Option<String>,
    pub email: Option<String>,
    #[serde(rename = "checkInTime", deserialize_with = "deserialize_timestamp_ms")]
    pub check_in_time: i64,
    #[serde(rename = "checkInMethod")]
    pub check_in_method: String,
    pub status: Option<String>,
    #[serde(rename = "appStatus")]
    pub app_status: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TimestampValue {
    Int(i64),
    Float(f64),
    String(String),
}

fn deserialize_timestamp_ms<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    match TimestampValue::deserialize(deserializer)? {
        TimestampValue::Int(v) => Ok(v),
        TimestampValue::Float(v) => Ok(v as i64),
        TimestampValue::String(v) => v
            .parse::<f64>()
            .map(|parsed| parsed as i64)
            .map_err(de::Error::custom),
    }
}

fn parse_checked_in_users(value: &serde_json::Value) -> Result<Vec<CheckedInUser>, String> {
    if value.is_array() {
        return serde_json::from_value::<Vec<CheckedInUser>>(value.clone())
            .map_err(|e| format!("Unable to parse checked-in users array: {}", e));
    }

    if let Some(inner) = value.get("value") {
        return parse_checked_in_users(inner);
    }

    if let Some(inner) = value.get("result") {
        return parse_checked_in_users(inner);
    }

    Err(format!(
        "Unexpected Convex response shape: {}",
        value
    ))
}

fn convex_value_to_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Int64(v) => serde_json::Value::Number(Number::from(*v)),
        Value::Float64(v) => Number::from_f64(*v)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::Boolean(v) => serde_json::Value::Bool(*v),
        Value::String(v) => serde_json::Value::String(v.clone()),
        Value::Bytes(bytes) => serde_json::Value::Array(
            bytes
                .iter()
                .map(|b| serde_json::Value::Number(Number::from(*b)))
                .collect(),
        ),
        Value::Array(values) => serde_json::Value::Array(values.iter().map(convex_value_to_json).collect()),
        Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), convex_value_to_json(v)))
                .collect(),
        ),
    }
}

pub struct PresenceGuiApp {
    convex_url: String,
    checked_in_users: Arc<Mutex<Vec<CheckedInUser>>>,
    last_update: Arc<Mutex<Instant>>,
    loading: Arc<Mutex<bool>>,
    error_message: Arc<Mutex<Option<String>>>,
    connection_status: Arc<Mutex<String>>,
    http_polling_enabled: Arc<AtomicBool>,
}

impl PresenceGuiApp {
    pub fn new() -> Self {
        let convex_url = std::env::var("CONVEX_URL")
            .unwrap_or_else(|_| "https://greedy-moose-508.convex.cloud".to_string());
        
        Self {
            convex_url,
            checked_in_users: Arc::new(Mutex::new(Vec::new())),
            last_update: Arc::new(Mutex::new(Instant::now())),
            loading: Arc::new(Mutex::new(true)),
            error_message: Arc::new(Mutex::new(None)),
            connection_status: Arc::new(Mutex::new("Connecting...".to_string())),
            http_polling_enabled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn subscribe_to_updates(&self, shutdown_rx: &mut mpsc::Receiver<()>) {
        println!("Attempting to connect to Convex at: {}", self.convex_url);

        loop {
            // Try WebSocket subscription first with timeout
            let websocket_future = self.try_websocket_subscription(shutdown_rx);
            match tokio::time::timeout(Duration::from_secs(10), websocket_future).await {
                Ok(result) => {
                    if result {
                        return;
                    }
                    println!("WebSocket subscription failed or returned false");
                }
                Err(_) => {
                    println!("WebSocket connection timed out after 10 seconds");
                }
            }

            if self.http_polling_enabled.load(Ordering::Relaxed) {
                println!("HTTP polling enabled; falling back to polling mode...");
                self.run_http_fallback(shutdown_rx).await;
                continue;
            }

            *self.connection_status.lock().unwrap() = "WebSocket only (polling off)".to_string();
            *self.loading.lock().unwrap() = false;

            loop {
                tokio::select! {
                    _ = shutdown_rx.recv() => return,
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {
                        if self.http_polling_enabled.load(Ordering::Relaxed) {
                            break;
                        }
                    }
                }
            }
        }
    }

    async fn try_websocket_subscription(&self, shutdown_rx: &mut mpsc::Receiver<()>) -> bool {
        let users_clone = self.checked_in_users.clone();
        let last_update_clone = self.last_update.clone();
        let loading_clone = self.loading.clone();
        let error_clone = self.error_message.clone();
        let status_clone = self.connection_status.clone();

        match ConvexClient::new(&self.convex_url).await {
            Ok(mut client) => {
                *status_clone.lock().unwrap() = "Subscribing...".to_string();
                
                match client.subscribe("devices:getCheckedInUsers", BTreeMap::new()).await {
                    Ok(mut subscription) => {
                        *status_clone.lock().unwrap() = "Live (WebSocket)".to_string();
                        *loading_clone.lock().unwrap() = false;

                        loop {
                            tokio::select! {
                                update = subscription.next() => {
                                    match update {
                                        Some(FunctionResult::Value(value)) => {
                                            let json_value = convex_value_to_json(&value);
                                            match parse_checked_in_users(&json_value) {
                                                Ok(parsed_users) => {
                                                    *users_clone.lock().unwrap() = parsed_users;
                                                    *last_update_clone.lock().unwrap() = Instant::now();
                                                    *error_clone.lock().unwrap() = None;
                                                    *status_clone.lock().unwrap() = "Live (WebSocket)".to_string();
                                                }
                                                Err(e) => {
                                                    let error_msg = format!("WebSocket payload parse error: {}", e);
                                                    *error_clone.lock().unwrap() = Some(error_msg);
                                                }
                                            }
                                        }
                                        Some(FunctionResult::ErrorMessage(message)) => {
                                            let error_msg = format!("Subscription error: {}", message);
                                            *error_clone.lock().unwrap() = Some(error_msg);
                                            *status_clone.lock().unwrap() = "Error".to_string();
                                            return false; // Fall back to HTTP
                                        }
                                        Some(FunctionResult::ConvexError(err)) => {
                                            let error_msg = format!("Convex error: {}", err);
                                            *error_clone.lock().unwrap() = Some(error_msg);
                                            *status_clone.lock().unwrap() = "Error".to_string();
                                            return false; // Fall back to HTTP
                                        }
                                        None => {
                                            *error_clone.lock().unwrap() = Some("Subscription ended".to_string());
                                            *status_clone.lock().unwrap() = "Disconnected".to_string();
                                            return false; // Fall back to HTTP
                                        }
                                    }
                                }
                                _ = shutdown_rx.recv() => {
                                    return true;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let error_msg = format!("Failed to subscribe: {}", e);
                        *error_clone.lock().unwrap() = Some(error_msg);
                        *status_clone.lock().unwrap() = "Error".to_string();
                        return false;
                    }
                }
            }
            Err(e) => {
                let error_msg = format!("Failed to connect: {}", e);
                *error_clone.lock().unwrap() = Some(error_msg);
                *status_clone.lock().unwrap() = "Error".to_string();
                return false;
            }
        }
    }

    async fn run_http_fallback(&self, shutdown_rx: &mut mpsc::Receiver<()>) {
        let users_clone = self.checked_in_users.clone();
        let last_update_clone = self.last_update.clone();
        let loading_clone = self.loading.clone();
        let error_clone = self.error_message.clone();
        let status_clone = self.connection_status.clone();
        let convex_url = self.convex_url.clone();

        println!("Starting HTTP polling to: {}", convex_url);
        *status_clone.lock().unwrap() = "HTTP Polling".to_string();
        *loading_clone.lock().unwrap() = false;

        let client = reqwest::Client::new();
        let mut interval = tokio::time::interval(Duration::from_secs(3));

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if !self.http_polling_enabled.load(Ordering::Relaxed) {
                        *status_clone.lock().unwrap() = "WebSocket only (polling off)".to_string();
                        break;
                    }
                    let url = format!("{}/api/query", convex_url);
                    println!("Making HTTP request to: {}", url);
                    let request_body = serde_json::json!({
                        "path": "devices:getCheckedInUsers",
                        "args": {},
                        "format": "json"
                    });
                    println!("Request body: {}", request_body);
                    match client
                        .post(&url)
                        .header("Content-Type", "application/json")
                        // Use an app-specific semver client id (older rust-x.y ids are rejected by Convex).
                        .header("Convex-Client", "presence-tracker-rs-0.1.0")
                        .json(&request_body)
                        .send()
                        .await
                    {
                        Ok(response) => {
                            println!("HTTP response status: {}", response.status());
                            let status = response.status();
                            match response.text().await {
                                Ok(body) if status.is_success() => {
                                    match serde_json::from_str::<serde_json::Value>(&body) {
                                        Ok(response_json) => {
                                            println!("Raw response: {}", response_json);
                                            match parse_checked_in_users(&response_json) {
                                                Ok(users) => {
                                                    println!("Successfully fetched {} users", users.len());
                                                    *users_clone.lock().unwrap() = users;
                                                    *last_update_clone.lock().unwrap() = Instant::now();
                                                    *error_clone.lock().unwrap() = None;
                                                    *status_clone.lock().unwrap() = "HTTP Polling".to_string();
                                                }
                                                Err(e) => {
                                                    println!("{}", e);
                                                    *error_clone.lock().unwrap() = Some(e);
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            println!("JSON parse error: {}", e);
                                            let error_msg = format!("JSON parse error: {}", e);
                                            *error_clone.lock().unwrap() = Some(error_msg);
                                        }
                                    }
                                }
                                Ok(body) => {
                                    println!("HTTP error {}: {}", status, body);
                                    let error_msg = format!("HTTP error {}: {}", status, body);
                                    *error_clone.lock().unwrap() = Some(error_msg);
                                }
                                Err(e) => {
                                    let error_msg = format!("Failed to read HTTP response body: {}", e);
                                    *error_clone.lock().unwrap() = Some(error_msg);
                                }
                            }
                        }
                        Err(e) => {
                            let error_msg = format!("Request failed: {}", e);
                            *error_clone.lock().unwrap() = Some(error_msg);
                        }
                    }
                }
                _ = shutdown_rx.recv() => {
                    break;
                }
            }
        }
    }

    fn format_check_in_time(&self, timestamp_ms: i64) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        
        let elapsed_ms = now - timestamp_ms;
        let elapsed_secs = elapsed_ms / 1000;
        
        if elapsed_secs < 60 {
            format!("{}s ago", elapsed_secs)
        } else if elapsed_secs < 3600 {
            format!("{}m ago", elapsed_secs / 60)
        } else if elapsed_secs < 86400 {
            format!("{}h ago", elapsed_secs / 3600)
        } else {
            format!("{}d ago", elapsed_secs / 86400)
        }
    }

    fn format_check_in_method(&self, method: &str) -> String {
        match method {
            "app+bluetooth" => "App + Bluetooth".to_string(),
            "app" => "App".to_string(),
            "bluetooth" => "Bluetooth".to_string(),
            _ => "Unknown".to_string(),
        }
    }

    fn get_time_since_last_update(&self) -> String {
        let elapsed = self.last_update.lock().unwrap().elapsed();
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

    fn display_name(user: &CheckedInUser) -> String {
        let first = user.first_name.as_deref().unwrap_or("").trim();
        let last = user.last_name.as_deref().unwrap_or("").trim();
        let full_name = format!("{} {}", first, last).trim().to_string();

        if !full_name.is_empty() {
            return full_name;
        }

        let fallback_name = user.name.trim();
        if !fallback_name.is_empty() && !fallback_name.eq_ignore_ascii_case("unknown") {
            return fallback_name.to_string();
        }

        if let Some(email) = user.email.as_ref() {
            let normalized = email.trim();
            if !normalized.is_empty() {
                return normalized
                    .split('@')
                    .next()
                    .unwrap_or(normalized)
                    .replace('.', " ");
            }
        }

        "Unknown User".to_string()
    }

    fn method_color(method: &str) -> egui::Color32 {
        match method {
            "app+bluetooth" => egui::Color32::from_rgb(26, 95, 180),
            "app" => egui::Color32::from_rgb(54, 120, 45),
            "bluetooth" => egui::Color32::from_rgb(0, 100, 180),
            _ => egui::Color32::from_gray(80),
        }
    }

    fn connection_color(status: &str) -> egui::Color32 {
        match status {
            "Live (WebSocket)" => egui::Color32::from_rgb(28, 132, 64),
            "HTTP Polling" => egui::Color32::from_rgb(21, 102, 192),
            "WebSocket only (polling off)" => egui::Color32::from_rgb(95, 95, 95),
            "Connecting..." | "Subscribing..." => egui::Color32::from_rgb(171, 119, 0),
            _ => egui::Color32::from_rgb(168, 42, 50),
        }
    }

    fn method_rank(method: &str) -> u8 {
        match method {
            "app+bluetooth" => 0,
            "app" => 1,
            "bluetooth" => 2,
            _ => 3,
        }
    }

    fn truncate_text(text: &str, max_chars: usize) -> String {
        if text.chars().count() <= max_chars {
            return text.to_string();
        }
        let truncated: String = text.chars().take(max_chars.saturating_sub(3)).collect();
        format!("{}...", truncated)
    }

    fn choose_bento_grid(count: usize, window_aspect: f32) -> (usize, usize) {
        if count == 0 {
            return (1, 1);
        }
        if count == 1 {
            return (1, 1);
        }

        let mut best_rows = 1usize;
        let mut best_cols = count;
        let mut best_score = f32::INFINITY;
        let target_card_aspect = 1.5f32;

        for cols in 1..=count {
            let rows = (count as f32 / cols as f32).ceil() as usize;
            let tile_aspect = window_aspect * (rows as f32 / cols as f32);
            let score = (tile_aspect / target_card_aspect).ln().abs();
            if score < best_score {
                best_score = score;
                best_rows = rows;
                best_cols = cols;
            }
        }

        (best_rows, best_cols)
    }

    fn render_bento_card(
        &self,
        ui: &mut egui::Ui,
        user: &CheckedInUser,
        card_width: f32,
        card_height: f32,
    ) {
        let display_name = Self::display_name(user);
        let email = user.email.as_deref().unwrap_or("").trim();

        let min_dim = card_width.min(card_height);
        let card_area = card_width * card_height;

        let name_size = (min_dim * 0.14).clamp(12.0, 26.0);
        let meta_size = (min_dim * 0.09).clamp(9.0, 14.0);
        let badge_size = (min_dim * 0.07).clamp(8.0, 11.0);
        let rounding = (min_dim * 0.08).clamp(8.0, 16.0);
        let inner_pad = (min_dim * 0.06).clamp(6.0, 16.0);

        let show_email = card_area > 18000.0 && !email.is_empty();
        let show_full_time = card_area > 10000.0;
        let show_badge = min_dim > 70.0;

        let chars_per_line = (card_width / (name_size * 0.55)).floor() as usize;
        let max_name_chars = (chars_per_line * 2).clamp(10, 50);

        let (card_bg, accent, glow) = match user.check_in_method.as_str() {
            "app+bluetooth" => (
                egui::Color32::from_rgb(30, 35, 55),
                egui::Color32::from_rgb(99, 102, 241),
                egui::Color32::from_rgba_unmultiplied(99, 102, 241, 25),
            ),
            "app" => (
                egui::Color32::from_rgb(28, 40, 35),
                egui::Color32::from_rgb(52, 211, 153),
                egui::Color32::from_rgba_unmultiplied(52, 211, 153, 25),
            ),
            "bluetooth" => (
                egui::Color32::from_rgb(30, 38, 50),
                egui::Color32::from_rgb(56, 189, 248),
                egui::Color32::from_rgba_unmultiplied(56, 189, 248, 25),
            ),
            _ => (
                egui::Color32::from_rgb(35, 35, 42),
                egui::Color32::from_rgb(120, 120, 140),
                egui::Color32::from_rgba_unmultiplied(120, 120, 140, 20),
            ),
        };

        egui::Frame::none()
            .fill(card_bg)
            .stroke(egui::Stroke::new(1.5, glow))
            .rounding(rounding)
            .shadow(egui::epaint::Shadow {
                offset: egui::vec2(0.0, 4.0),
                blur: 12.0,
                spread: 0.0,
                color: egui::Color32::from_rgba_unmultiplied(0, 0, 0, 60),
            })
            .inner_margin(egui::Margin::same(inner_pad))
            .show(ui, |ui| {
                ui.set_min_size(egui::vec2(card_width - inner_pad * 2.0, card_height - inner_pad * 2.0));
                ui.set_max_size(egui::vec2(card_width - inner_pad * 2.0, card_height - inner_pad * 2.0));

                ui.allocate_ui_with_layout(
                    egui::vec2(card_width - inner_pad * 2.0, card_height - inner_pad * 2.0),
                    egui::Layout::top_down(egui::Align::Center).with_main_align(egui::Align::Center),
                    |ui| {
                        ui.spacing_mut().item_spacing.y = 6.0;

                        if show_badge {
                            egui::Frame::none()
                                .fill(accent.linear_multiply(0.2))
                                .rounding(rounding * 0.4)
                                .inner_margin(egui::vec2(10.0, 4.0))
                                .show(ui, |ui| {
                                    ui.label(
                                        egui::RichText::new(self.format_check_in_method(&user.check_in_method).to_uppercase())
                                            .size(badge_size)
                                            .color(accent)
                                            .strong(),
                                    );
                                });
                            ui.add_space(4.0);
                        }

                        ui.label(
                            egui::RichText::new(Self::truncate_text(&display_name, max_name_chars))
                                .size(name_size)
                                .strong()
                                .color(egui::Color32::from_rgb(245, 245, 250)),
                        );

                        if show_email {
                            ui.label(
                                egui::RichText::new(email)
                                    .size(meta_size)
                                    .color(egui::Color32::from_rgb(140, 140, 160)),
                            );
                        }

                        ui.add_space(2.0);

                        let time_text = if show_full_time {
                            format!("Checked in {}", self.format_check_in_time(user.check_in_time))
                        } else {
                            self.format_check_in_time(user.check_in_time)
                        };

                        ui.label(
                            egui::RichText::new(time_text)
                                .size(meta_size)
                                .color(egui::Color32::from_rgb(100, 100, 120)),
                        );
                    },
                );
            });
    }
}

impl eframe::App for PresenceGuiApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        ctx.request_repaint();

        let bg_color = egui::Color32::from_rgb(15, 15, 20);
        let panel_bg = egui::Color32::from_rgb(22, 22, 30);

        egui::TopBottomPanel::top("header_panel")
            .frame(
                egui::Frame::none()
                    .fill(panel_bg)
                    .inner_margin(egui::Margin::symmetric(24.0, 16.0)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    let checked_in_count = self.checked_in_users.lock().unwrap().len();
                    
                    ui.label(
                        egui::RichText::new("PRESENCE")
                            .size(13.0)
                            .color(egui::Color32::from_rgb(120, 120, 140))
                            .strong(),
                    );
                    ui.add_space(8.0);
                    
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgb(99, 102, 241))
                        .rounding(12.0)
                        .inner_margin(egui::vec2(10.0, 4.0))
                        .show(ui, |ui| {
                            ui.label(
                                egui::RichText::new(format!("{}", checked_in_count))
                                    .size(13.0)
                                    .color(egui::Color32::WHITE)
                                    .strong(),
                            );
                        });

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let quit_btn = ui.add(
                            egui::Button::new(
                                egui::RichText::new("✕")
                                    .size(14.0)
                                    .color(egui::Color32::from_rgb(180, 180, 190)),
                            )
                            .fill(egui::Color32::TRANSPARENT)
                            .stroke(egui::Stroke::NONE),
                        );
                        if quit_btn.clicked() {
                            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                        }

                        ui.add_space(16.0);

                        let mut http_enabled = self.http_polling_enabled.load(Ordering::Relaxed);
                        let checkbox_text = egui::RichText::new("HTTP Polling")
                            .size(12.0)
                            .color(egui::Color32::from_rgb(140, 140, 160));
                        if ui.checkbox(&mut http_enabled, checkbox_text).changed() {
                            self.http_polling_enabled.store(http_enabled, Ordering::Relaxed);
                            if !http_enabled {
                                let mut status = self.connection_status.lock().unwrap();
                                if *status == "HTTP Polling" {
                                    *status = "WebSocket only (polling off)".to_string();
                                }
                            }
                        }

                        ui.add_space(20.0);

                        let status = self.connection_status.lock().unwrap().clone();
                        let status_color = Self::connection_color(status.as_str());
                        
                        egui::Frame::none()
                            .fill(status_color.linear_multiply(0.15))
                            .rounding(6.0)
                            .inner_margin(egui::vec2(10.0, 5.0))
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    ui.label(
                                        egui::RichText::new("●")
                                            .size(8.0)
                                            .color(status_color),
                                    );
                                    ui.add_space(4.0);
                                    ui.label(
                                        egui::RichText::new(&status)
                                            .size(11.0)
                                            .color(status_color),
                                    );
                                });
                            });

                        ui.add_space(12.0);

                        if !*self.loading.lock().unwrap() {
                            ui.label(
                                egui::RichText::new(format!("Updated {} ago", self.get_time_since_last_update()))
                                    .size(11.0)
                                    .color(egui::Color32::from_rgb(90, 90, 110)),
                            );
                        }
                    });
                });
            });

        egui::CentralPanel::default()
            .frame(
                egui::Frame::none()
                    .fill(bg_color)
                    .inner_margin(egui::Margin::same(20.0)),
            )
            .show(ctx, |ui| {
                let checked_in_users = self.checked_in_users.lock().unwrap().clone();

                if let Some(error) = self.error_message.lock().unwrap().as_ref() {
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgb(60, 30, 35))
                        .rounding(10.0)
                        .inner_margin(egui::Margin::symmetric(16.0, 12.0))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.label(
                                    egui::RichText::new("⚠")
                                        .size(14.0)
                                        .color(egui::Color32::from_rgb(248, 113, 113)),
                                );
                                ui.add_space(8.0);
                                ui.label(
                                    egui::RichText::new(error)
                                        .size(12.0)
                                        .color(egui::Color32::from_rgb(248, 180, 180)),
                                );
                            });
                        });
                    ui.add_space(16.0);
                }

                if checked_in_users.is_empty() {
                    let available = ui.available_size();
                    ui.allocate_ui_with_layout(
                        available,
                        egui::Layout::centered_and_justified(egui::Direction::TopDown),
                        |ui| {
                            ui.vertical_centered(|ui| {
                                if *self.loading.lock().unwrap() {
                                    ui.spinner();
                                    ui.add_space(16.0);
                                    ui.label(
                                        egui::RichText::new("Connecting...")
                                            .size(16.0)
                                            .color(egui::Color32::from_rgb(140, 140, 160)),
                                    );
                                } else {
                                    ui.label(
                                        egui::RichText::new("◯")
                                            .size(48.0)
                                            .color(egui::Color32::from_rgb(60, 60, 80)),
                                    );
                                    ui.add_space(16.0);
                                    ui.label(
                                        egui::RichText::new("No one checked in")
                                            .size(18.0)
                                            .color(egui::Color32::from_rgb(100, 100, 120)),
                                    );
                                }
                            });
                        },
                    );
                    return;
                }

                let mut sorted_users = checked_in_users;
                sorted_users.sort_by(|a, b| {
                    let ra = Self::method_rank(&a.check_in_method);
                    let rb = Self::method_rank(&b.check_in_method);
                    ra.cmp(&rb)
                        .then_with(|| b.check_in_time.cmp(&a.check_in_time))
                        .then_with(|| Self::display_name(a).cmp(&Self::display_name(b)))
                });

                let total_users = sorted_users.len();
                let available_width = ui.available_width();
                let available_height = ui.available_height();
                let window_aspect = (available_width / available_height.max(1.0)).max(0.1);

                let gap = 12.0_f32;
                let (rows, columns) = Self::choose_bento_grid(total_users, window_aspect);

                let total_gap_x = gap * (columns.saturating_sub(1)) as f32;
                let total_gap_y = gap * (rows.saturating_sub(1)) as f32;
                let card_width = ((available_width - total_gap_x) / columns as f32).max(80.0);
                let card_height = ((available_height - total_gap_y) / rows as f32).max(60.0);

                let grid_width = card_width * columns as f32 + total_gap_x;
                let grid_height = card_height * rows as f32 + total_gap_y;
                let offset_x = ((available_width - grid_width) / 2.0).max(0.0);
                let offset_y = ((available_height - grid_height) / 2.0).max(0.0);

                ui.add_space(offset_y);

                for row in 0..rows {
                    let start = row * columns;
                    let end = (start + columns).min(total_users);
                    let items_in_row = end - start;

                    let row_width = card_width * items_in_row as f32 + gap * (items_in_row.saturating_sub(1)) as f32;
                    let row_offset = ((available_width - row_width) / 2.0).max(0.0);

                    ui.horizontal(|ui| {
                        ui.add_space(row_offset);

                        for idx in start..end {
                            if let Some(user) = sorted_users.get(idx) {
                                self.render_bento_card(ui, user, card_width, card_height);
                            }
                            if idx + 1 < end {
                                ui.add_space(gap);
                            }
                        }
                    });

                    if row + 1 < rows {
                        ui.add_space(gap);
                    }
                }
            });
    }
}

pub async fn run_gui() -> Result<(), eframe::Error> {
    dotenvy::dotenv().ok();

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1400.0, 900.0])
            .with_min_inner_size([600.0, 400.0])
            .with_title("Presence Tracker"),
        ..Default::default()
    };

    let app = PresenceGuiApp::new();
    let app_clone = app.clone();

    let (shutdown_tx, mut shutdown_rx) = mpsc::channel(1);

    tokio::spawn(async move {
        app_clone.subscribe_to_updates(&mut shutdown_rx).await;
    });

    let result = eframe::run_native(
        "Presence Tracker",
        options,
        Box::new(|cc| {
            let mut visuals = egui::Visuals::dark();
            visuals.window_fill = egui::Color32::from_rgb(15, 15, 20);
            visuals.panel_fill = egui::Color32::from_rgb(15, 15, 20);
            visuals.extreme_bg_color = egui::Color32::from_rgb(10, 10, 14);
            visuals.faint_bg_color = egui::Color32::from_rgb(22, 22, 30);
            visuals.widgets.noninteractive.bg_fill = egui::Color32::from_rgb(30, 30, 40);
            visuals.widgets.inactive.bg_fill = egui::Color32::from_rgb(35, 35, 48);
            visuals.widgets.hovered.bg_fill = egui::Color32::from_rgb(45, 45, 60);
            visuals.widgets.active.bg_fill = egui::Color32::from_rgb(55, 55, 75);
            visuals.selection.bg_fill = egui::Color32::from_rgb(99, 102, 241);
            cc.egui_ctx.set_visuals(visuals);

            let mut style = (*cc.egui_ctx.style()).clone();
            style.spacing.item_spacing = egui::vec2(8.0, 8.0);
            style.spacing.button_padding = egui::vec2(14.0, 8.0);
            cc.egui_ctx.set_style(style);

            Ok(Box::new(app))
        }),
    );

    let _ = shutdown_tx.send(()).await;
    result
}

impl Clone for PresenceGuiApp {
    fn clone(&self) -> Self {
        Self {
            convex_url: self.convex_url.clone(),
            checked_in_users: self.checked_in_users.clone(),
            last_update: self.last_update.clone(),
            loading: self.loading.clone(),
            error_message: self.error_message.clone(),
            connection_status: self.connection_status.clone(),
            http_polling_enabled: self.http_polling_enabled.clone(),
        }
    }
}
