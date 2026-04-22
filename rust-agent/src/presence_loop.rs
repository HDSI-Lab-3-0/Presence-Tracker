use crate::bluetooth_probe::{
    get_connected_devices, get_paired_devices, is_valid_mac, normalize_mac, probe_device, CommandRunner,
};
use crate::config::Config;
use crate::convex_client::{ConvexClient, DeviceRecord};
use crate::logging;
use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub struct PresenceLoop {
    config: Config,
    convex: Arc<ConvexClient>,
    runner: Arc<dyn CommandRunner>,
    misses: HashMap<String, u32>,
}

impl PresenceLoop {
    pub fn new(config: Config, convex: Arc<ConvexClient>, runner: Arc<dyn CommandRunner>) -> Self {
        Self {
            config,
            convex,
            runner,
            misses: HashMap::new(),
        }
    }

    pub async fn run_forever(&mut self) -> Result<()> {
        logging::info(
            "presence_loop",
            "started",
            None,
            Some("ok"),
            "Presence polling loop started",
        );

        let interval_seconds = self.config.presence.polling_interval_seconds.max(1);
        loop {
            if let Err(error) = self.run_cycle().await {
                logging::warn(
                    "presence_loop",
                    "cycle",
                    None,
                    Some("error"),
                    &error.to_string(),
                );
            }
            tokio::time::sleep(std::time::Duration::from_secs(interval_seconds)).await;
        }
    }

    async fn run_cycle(&mut self) -> Result<()> {
        let devices = self.convex.get_devices().await?;
        let connected: HashSet<String> = get_connected_devices(
            self.runner.as_ref(),
            self.config.bluetooth.command_timeout_seconds,
        )
        .into_iter()
        .map(|mac| normalize_mac(&mac))
        .collect();
        let paired: HashSet<String> = get_paired_devices(
            self.runner.as_ref(),
            self.config.bluetooth.command_timeout_seconds,
        )
        .into_iter()
        .map(|mac| normalize_mac(&mac))
        .collect();
        let known_macs: HashSet<String> = devices
            .iter()
            .map(|device| normalize_mac(&device.mac_address))
            .collect();

        for mac in connected.iter().filter(|mac| !known_macs.contains(*mac)) {
            if let Err(error) = self.convex.register_pending_device(mac, None).await {
                logging::warn(
                    "presence_loop",
                    "register_pending_fallback",
                    Some(mac),
                    Some("error"),
                    &error.to_string(),
                );
            } else {
                logging::info(
                    "presence_loop",
                    "register_pending_fallback",
                    Some(mac),
                    Some("ok"),
                    "Registered unknown connected device as pending",
                );
            }
        }
        for mac in paired.iter().filter(|mac| !known_macs.contains(*mac)) {
            if let Err(error) = self.convex.register_pending_device(mac, None).await {
                logging::warn(
                    "presence_loop",
                    "register_pending_paired_fallback",
                    Some(mac),
                    Some("error"),
                    &error.to_string(),
                );
            } else {
                logging::info(
                    "presence_loop",
                    "register_pending_paired_fallback",
                    Some(mac),
                    Some("ok"),
                    "Registered unknown paired device as pending",
                );
            }
        }

        let absent_threshold = self.config.presence.absent_threshold.max(1);
        let mut known = HashSet::new();

        for device in devices {
            if device.pending_registration {
                continue;
            }
            if !is_valid_mac(&device.mac_address) {
                continue;
            }

            let mac = normalize_mac(&device.mac_address);
            known.insert(mac.clone());
            let present = if connected.contains(&mac) {
                true
            } else {
                probe_device(
                    self.runner.as_ref(),
                    &mac,
                    self.config.bluetooth.l2ping_count,
                    self.config.bluetooth.l2ping_timeout_seconds,
                    self.config.bluetooth.connect_probe_timeout_seconds,
                    self.config.bluetooth.command_timeout_seconds,
                )
            };

            if present {
                self.misses.remove(&mac);
                if device.status != "present" {
                    self.transition_status(&device, "present").await;
                }
            } else {
                let misses = self.misses.entry(mac.clone()).or_insert(0);
                *misses += 1;
                if *misses >= absent_threshold && device.status != "absent" {
                    self.transition_status(&device, "absent").await;
                }
            }
        }

        self.misses.retain(|mac, _| known.contains(mac));
        Ok(())
    }

    async fn transition_status(&self, device: &DeviceRecord, status: &str) {
        let mac = normalize_mac(&device.mac_address);
        match self.convex.update_device_status(&mac, status).await {
            Ok(()) => logging::info(
                "presence_loop",
                "status_update",
                Some(&mac),
                Some(status),
                &format!("{} -> {status}", device.status),
            ),
            Err(error) => logging::warn(
                "presence_loop",
                "status_update",
                Some(&mac),
                Some("error"),
                &error.to_string(),
            ),
        }
    }
}
