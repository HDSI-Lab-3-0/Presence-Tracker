use convex::{ConvexClient, FunctionResult, Value};
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

    Err(format!("Unexpected Convex response shape: {}", value))
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
        Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(convex_value_to_json).collect())
        }
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
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let missing_convex_url = convex_url.is_empty();

        Self {
            convex_url,
            checked_in_users: Arc::new(Mutex::new(Vec::new())),
            last_update: Arc::new(Mutex::new(Instant::now())),
            loading: Arc::new(Mutex::new(!missing_convex_url)),
            error_message: Arc::new(Mutex::new(if missing_convex_url {
                Some(
                    "CONVEX_URL is not set. Add it to your .env file before launching the GUI."
                        .to_string(),
                )
            } else {
                None
            })),
            connection_status: Arc::new(Mutex::new(if missing_convex_url {
                "Missing CONVEX_URL".to_string()
            } else {
                "Connecting...".to_string()
            })),
            http_polling_enabled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn subscribe_to_updates(&self, shutdown_rx: &mut mpsc::Receiver<()>) {
        if self.convex_url.is_empty() {
            *self.connection_status.lock().unwrap() = "Missing CONVEX_URL".to_string();
            *self.error_message.lock().unwrap() = Some(
                "CONVEX_URL is not set. Add it to your .env file before launching the GUI."
                    .to_string(),
            );
            *self.loading.lock().unwrap() = false;
            return;
        }

        println!("Attempting to connect to Convex at: {}", self.convex_url);

        loop {
            // Keep the websocket subscription alive for as long as it is healthy.
            // A subscription stream is long-lived by design, so timing out this future
            // would cancel live updates even when the connection is working.
            if self.try_websocket_subscription(shutdown_rx).await {
                return;
            }
            println!("WebSocket subscription failed or returned false");

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

                match client
                    .subscribe("devices:getCheckedInUsers", BTreeMap::new())
                    .await
                {
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
            "app+bluetooth" => egui::Color32::from_rgb(37, 99, 235),
            "app" => egui::Color32::from_rgb(22, 163, 74),
            "bluetooth" => egui::Color32::from_rgb(79, 70, 229),
            _ => egui::Color32::from_rgb(100, 116, 139),
        }
    }

    fn connection_color(status: &str) -> egui::Color32 {
        match status {
            "Live (WebSocket)" => egui::Color32::from_rgb(22, 163, 74),
            "HTTP Polling" => egui::Color32::from_rgb(37, 99, 235),
            "WebSocket only (polling off)" => egui::Color32::from_rgb(100, 116, 139),
            "Connecting..." | "Subscribing..." => egui::Color32::from_rgb(245, 158, 11),
            _ => egui::Color32::from_rgb(220, 38, 38),
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
        if count == 2 {
            return if window_aspect > 1.2 { (1, 2) } else { (2, 1) };
        }
        if count == 3 {
            return if window_aspect > 1.5 { (1, 3) } else { (2, 2) };
        }
        if count == 4 {
            return (2, 2);
        }

        let mut best_rows = 1usize;
        let mut best_cols = count;
        let mut best_score = f32::INFINITY;
        let target_card_aspect = 1.4f32;

        for cols in 1..=count.min(6) {
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

        let card_area = card_width * card_height;
        let min_dimension = card_width.min(card_height);

        let name_size = (min_dimension * 0.14).clamp(14.0, 28.0);
        let meta_size = (min_dimension * 0.09).clamp(10.0, 14.0);
        let badge_size = (min_dimension * 0.08).clamp(9.0, 12.0);
        let rounding = (min_dimension * 0.08).clamp(12.0, 24.0);

        let show_email = card_area > 15000.0 && !email.is_empty();
        let show_full_time = card_area > 10000.0;
        let show_badge = min_dimension > 80.0;

        let chars_per_line = (card_width / (name_size * 0.55)).floor() as usize;
        let max_name_chars = (chars_per_line * 2).clamp(10, 50);

        let accent_color = match user.check_in_method.as_str() {
            "app+bluetooth" => egui::Color32::from_rgb(37, 99, 235),
            "app" => egui::Color32::from_rgb(22, 163, 74),
            "bluetooth" => egui::Color32::from_rgb(79, 70, 229),
            _ => egui::Color32::from_rgb(100, 116, 139),
        };

        let outer_rect =
            egui::Rect::from_min_size(ui.cursor().min, egui::vec2(card_width, card_height));

        let response = ui.allocate_rect(outer_rect, egui::Sense::hover());

        ui.painter().rect(
            outer_rect,
            rounding,
            egui::Color32::WHITE,
            egui::Stroke::new(1.0, egui::Color32::from_rgb(226, 232, 240)),
        );

        ui.painter()
            .rect_filled(outer_rect.shrink(0.5), rounding, egui::Color32::WHITE);

        let center = outer_rect.center();

        let name_galley = ui.painter().layout_no_wrap(
            Self::truncate_text(&display_name, max_name_chars),
            egui::FontId::proportional(name_size),
            egui::Color32::from_rgb(15, 23, 42),
        );

        let time_text = if show_full_time {
            self.format_check_in_time(user.check_in_time)
        } else {
            self.format_check_in_time(user.check_in_time)
        };

        let time_galley = ui.painter().layout_no_wrap(
            time_text,
            egui::FontId::proportional(meta_size),
            egui::Color32::from_rgb(148, 163, 184),
        );

        let method_indicator_size = 8.0;
        let spacing = 8.0;

        let mut total_height = name_galley.size().y + spacing + time_galley.size().y;

        if show_email && !email.is_empty() {
            total_height += meta_size + 4.0;
        }

        let start_y = center.y - total_height / 2.0;
        let mut current_y = start_y;

        let name_pos = egui::pos2(center.x - name_galley.size().x / 2.0, current_y);
        ui.painter()
            .galley(name_pos, name_galley, egui::Color32::from_rgb(15, 23, 42));
        current_y += name_size + spacing;

        if show_email && !email.is_empty() {
            let email_galley = ui.painter().layout_no_wrap(
                email.to_string(),
                egui::FontId::proportional(meta_size),
                egui::Color32::from_rgb(100, 116, 139),
            );
            let email_pos = egui::pos2(center.x - email_galley.size().x / 2.0, current_y);
            ui.painter().galley(
                email_pos,
                email_galley,
                egui::Color32::from_rgb(100, 116, 139),
            );
            current_y += meta_size + 4.0;
        }

        let time_with_dot_width = method_indicator_size + 6.0 + time_galley.size().x;
        let time_start_x = center.x - time_with_dot_width / 2.0;

        let dot_center = egui::pos2(
            time_start_x + method_indicator_size / 2.0,
            current_y + time_galley.size().y / 2.0,
        );
        ui.painter()
            .circle_filled(dot_center, method_indicator_size / 2.0, accent_color);

        let time_pos = egui::pos2(time_start_x + method_indicator_size + 6.0, current_y);
        ui.painter().galley(
            time_pos,
            time_galley,
            egui::Color32::from_rgb(148, 163, 184),
        );
    }

    fn apply_dynamic_zoom(&self, ctx: &egui::Context) {
        let manual_zoom = std::env::var("PRESENCE_GUI_ZOOM")
            .ok()
            .and_then(|value| value.trim().parse::<f32>().ok())
            .map(|value| value.clamp(0.5, 1.5));

        let desired_zoom = if let Some(zoom) = manual_zoom {
            zoom
        } else {
            let (viewport_pixels, native_pixels_per_point) = ctx.input(|i| {
                let rect = i.viewport().inner_rect.unwrap_or(i.screen_rect());
                let pixels_per_point = i.pixels_per_point().max(0.1);
                (
                    rect.size() * pixels_per_point,
                    i.viewport().native_pixels_per_point.unwrap_or(1.0),
                )
            });

            let base_viewport = egui::vec2(1280.0, 800.0);
            let size_scale = (viewport_pixels.x / base_viewport.x)
                .min(viewport_pixels.y / base_viewport.y)
                .clamp(0.65, 1.0);
            let dpi_scale = (1.0 / native_pixels_per_point.max(1.0)).clamp(0.6, 1.0);

            (size_scale * dpi_scale).clamp(0.55, 1.0)
        };

        if (ctx.zoom_factor() - desired_zoom).abs() > 0.02 {
            ctx.set_zoom_factor(desired_zoom);
        }
    }
}

impl eframe::App for PresenceGuiApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        ctx.request_repaint();
        self.apply_dynamic_zoom(ctx);

        let outer_padding = 24.0;
        let grid_gap = 16.0;

        egui::CentralPanel::default()
            .frame(
                egui::Frame::none()
                    .fill(egui::Color32::from_rgb(241, 245, 249))
                    .inner_margin(egui::Margin::same(outer_padding)),
            )
            .show(ctx, |ui| {
                let checked_in_users = self.checked_in_users.lock().unwrap().clone();
                let checked_in_count = checked_in_users.len();

                ui.horizontal(|ui| {
                    ui.heading(
                        egui::RichText::new(format!("Presence Tracker"))
                            .size(24.0)
                            .strong()
                            .color(egui::Color32::from_rgb(15, 23, 42)),
                    );

                    ui.add_space(12.0);

                    egui::Frame::none()
                        .fill(egui::Color32::from_rgb(37, 99, 235))
                        .rounding(12.0)
                        .inner_margin(egui::vec2(12.0, 4.0))
                        .show(ui, |ui| {
                            ui.label(
                                egui::RichText::new(format!("{}", checked_in_count))
                                    .size(16.0)
                                    .strong()
                                    .color(egui::Color32::WHITE),
                            );
                        });

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .add(
                                egui::Button::new(
                                    egui::RichText::new("✕")
                                        .size(14.0)
                                        .color(egui::Color32::from_rgb(100, 116, 139)),
                                )
                                .fill(egui::Color32::from_rgb(226, 232, 240))
                                .rounding(8.0)
                                .min_size(egui::vec2(32.0, 32.0)),
                            )
                            .clicked()
                        {
                            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                        }

                        ui.add_space(12.0);

                        let mut http_enabled = self.http_polling_enabled.load(Ordering::Relaxed);
                        if ui
                            .checkbox(
                                &mut http_enabled,
                                egui::RichText::new("HTTP Polling")
                                    .size(12.0)
                                    .color(egui::Color32::from_rgb(71, 85, 105)),
                            )
                            .changed()
                        {
                            self.http_polling_enabled
                                .store(http_enabled, Ordering::Relaxed);
                            if !http_enabled {
                                let mut status = self.connection_status.lock().unwrap();
                                if *status == "HTTP Polling" {
                                    *status = "WebSocket only (polling off)".to_string();
                                }
                            }
                        }

                        ui.add_space(16.0);

                        let status = self.connection_status.lock().unwrap().clone();
                        egui::Frame::none()
                            .fill(Self::connection_color(status.as_str()).gamma_multiply(0.15))
                            .rounding(8.0)
                            .inner_margin(egui::vec2(10.0, 4.0))
                            .show(ui, |ui| {
                                ui.label(
                                    egui::RichText::new(format!("● {}", status))
                                        .size(12.0)
                                        .strong()
                                        .color(Self::connection_color(status.as_str())),
                                );
                            });

                        ui.add_space(12.0);

                        if !*self.loading.lock().unwrap() {
                            ui.label(
                                egui::RichText::new(format!(
                                    "Updated {} ago",
                                    self.get_time_since_last_update()
                                ))
                                .size(12.0)
                                .color(egui::Color32::from_rgb(148, 163, 184)),
                            );
                        }
                    });
                });

                ui.add_space(16.0);

                if let Some(error) = self.error_message.lock().unwrap().as_ref() {
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgb(254, 242, 242))
                        .stroke(egui::Stroke::new(
                            1.0,
                            egui::Color32::from_rgb(254, 202, 202),
                        ))
                        .rounding(12.0)
                        .inner_margin(12.0)
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.label(
                                    egui::RichText::new("⚠")
                                        .size(14.0)
                                        .color(egui::Color32::from_rgb(220, 38, 38)),
                                );
                                ui.label(
                                    egui::RichText::new(error)
                                        .size(12.0)
                                        .color(egui::Color32::from_rgb(185, 28, 28)),
                                );
                            });
                        });
                    ui.add_space(12.0);
                }

                if checked_in_users.is_empty() {
                    let available_rect = ui.available_rect_before_wrap();
                    ui.allocate_ui_at_rect(available_rect, |ui| {
                        ui.allocate_ui_with_layout(
                            available_rect.size(),
                            egui::Layout::centered_and_justified(egui::Direction::TopDown),
                            |ui| {
                                ui.vertical_centered(|ui| {
                                    if *self.loading.lock().unwrap() {
                                        ui.spinner();
                                        ui.add_space(16.0);
                                        ui.label(
                                            egui::RichText::new("Connecting...")
                                                .size(18.0)
                                                .color(egui::Color32::from_rgb(100, 116, 139)),
                                        );
                                    } else {
                                        ui.label(egui::RichText::new("👋").size(48.0));
                                        ui.add_space(12.0);
                                        ui.label(
                                            egui::RichText::new("No one checked in")
                                                .size(20.0)
                                                .strong()
                                                .color(egui::Color32::from_rgb(71, 85, 105)),
                                        );
                                        ui.add_space(4.0);
                                        ui.label(
                                            egui::RichText::new("Waiting for people to arrive...")
                                                .size(14.0)
                                                .color(egui::Color32::from_rgb(148, 163, 184)),
                                        );
                                    }
                                });
                            },
                        );
                    });
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
                let available_height = ui.available_height().max(1.0);
                let window_aspect = (available_width / available_height).max(0.1);

                let (rows, columns) = Self::choose_bento_grid(total_users, window_aspect);

                let total_h_gaps = (columns.saturating_sub(1)) as f32 * grid_gap;
                let total_v_gaps = (rows.saturating_sub(1)) as f32 * grid_gap;

                let card_width = ((available_width - total_h_gaps) / columns as f32).max(80.0);
                let card_height = ((available_height - total_v_gaps) / rows as f32).max(60.0);

                let actual_grid_width = card_width * columns as f32 + total_h_gaps;
                let actual_grid_height = card_height * rows as f32 + total_v_gaps;

                let h_offset = ((available_width - actual_grid_width) / 2.0).max(0.0);
                let v_offset = ((available_height - actual_grid_height) / 2.0).max(0.0);

                ui.add_space(v_offset);

                for row in 0..rows {
                    let start = row * columns;
                    let end = (start + columns).min(total_users);
                    let items_in_row = end - start;

                    let row_width = card_width * items_in_row as f32
                        + grid_gap * (items_in_row.saturating_sub(1)) as f32;
                    let row_h_offset = h_offset + ((actual_grid_width - row_width) / 2.0).max(0.0);

                    ui.horizontal(|ui| {
                        ui.add_space(row_h_offset);

                        for idx in start..end {
                            ui.allocate_ui_with_layout(
                                egui::vec2(card_width, card_height),
                                egui::Layout::centered_and_justified(egui::Direction::TopDown),
                                |cell_ui| {
                                    if let Some(user) = sorted_users.get(idx) {
                                        self.render_bento_card(
                                            cell_ui,
                                            user,
                                            card_width,
                                            card_height,
                                        );
                                    }
                                },
                            );
                            if idx + 1 < end {
                                ui.add_space(grid_gap);
                            }
                        }
                    });
                    if row + 1 < rows {
                        ui.add_space(grid_gap);
                    }
                }
            });
    }
}

pub async fn run_gui() -> Result<(), eframe::Error> {
    dotenvy::dotenv().ok();

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([960.0, 540.0])
            .with_title("Presence Tracker")
            .with_decorations(true),
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
            let mut visuals = egui::Visuals::light();
            visuals.window_fill = egui::Color32::from_rgb(241, 245, 249);
            visuals.panel_fill = egui::Color32::from_rgb(241, 245, 249);
            visuals.extreme_bg_color = egui::Color32::from_rgb(248, 250, 252);
            visuals.widgets.noninteractive.bg_fill = egui::Color32::WHITE;
            visuals.widgets.inactive.bg_fill = egui::Color32::from_rgb(241, 245, 249);
            visuals.widgets.hovered.bg_fill = egui::Color32::from_rgb(226, 232, 240);
            visuals.widgets.active.bg_fill = egui::Color32::from_rgb(203, 213, 225);
            visuals.selection.bg_fill = egui::Color32::from_rgb(219, 234, 254);
            visuals.selection.stroke = egui::Stroke::new(1.0, egui::Color32::from_rgb(37, 99, 235));
            cc.egui_ctx.set_visuals(visuals);

            let mut style = (*cc.egui_ctx.style()).clone();
            style.spacing.item_spacing = egui::vec2(8.0, 8.0);
            style.spacing.button_padding = egui::vec2(12.0, 8.0);
            style.visuals.widgets.noninteractive.rounding = egui::Rounding::same(8.0);
            style.visuals.widgets.inactive.rounding = egui::Rounding::same(8.0);
            style.visuals.widgets.hovered.rounding = egui::Rounding::same(8.0);
            style.visuals.widgets.active.rounding = egui::Rounding::same(8.0);
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
