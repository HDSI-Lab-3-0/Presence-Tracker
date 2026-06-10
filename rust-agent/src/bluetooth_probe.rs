use anyhow::{anyhow, Result};
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait CommandRunner: Send + Sync {
    fn run(&self, program: &str, args: &[&str], timeout: Duration) -> Result<CommandOutput>;
}

#[derive(Debug, Default)]
pub struct ProcessRunner;

impl CommandRunner for ProcessRunner {
    fn run(&self, program: &str, args: &[&str], timeout: Duration) -> Result<CommandOutput> {
        let mut command = Command::new("timeout");
        command
            .arg(format!("{}s", timeout.as_secs().max(1)))
            .arg(program)
            .args(args);

        let output = command
            .output()
            .map_err(|e| anyhow!("failed running {program}: {e}"))?;

        Ok(CommandOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }
}

pub fn normalize_mac(mac: &str) -> String {
    mac.trim().to_ascii_uppercase()
}

pub fn is_valid_mac(mac: &str) -> bool {
    let parts: Vec<&str> = mac.trim().split(':').collect();
    parts.len() == 6
        && parts
            .iter()
            .all(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_hexdigit()))
}

pub fn get_connected_devices(runner: &dyn CommandRunner, timeout_seconds: u64) -> Vec<String> {
    let output = runner
        .run(
            "bluetoothctl",
            &["devices", "Connected"],
            Duration::from_secs(timeout_seconds.max(1)),
        )
        .ok();

    match output {
        Some(out) if out.code == 0 => out
            .stdout
            .lines()
            .filter_map(|line| {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.len() >= 2 && fields[0] == "Device" && is_valid_mac(fields[1]) {
                    Some(normalize_mac(fields[1]))
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

pub fn get_paired_devices(runner: &dyn CommandRunner, timeout_seconds: u64) -> Vec<String> {
    let output = runner
        .run(
            "bluetoothctl",
            &["devices", "Paired"],
            Duration::from_secs(timeout_seconds.max(1)),
        )
        .ok();

    match output {
        Some(out) if out.code == 0 => out
            .stdout
            .lines()
            .filter_map(|line| {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.len() >= 2 && fields[0] == "Device" && is_valid_mac(fields[1]) {
                    Some(normalize_mac(fields[1]))
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

pub fn get_device_name(
    runner: &dyn CommandRunner,
    mac: &str,
    timeout_seconds: u64,
) -> Option<String> {
    if !is_valid_mac(mac) {
        return None;
    }
    let mac = normalize_mac(mac);
    let out = runner
        .run(
            "bluetoothctl",
            &["info", mac.as_str()],
            Duration::from_secs(timeout_seconds.max(1)),
        )
        .ok()?;
    if out.code != 0 {
        return None;
    }
    out.stdout.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Name:")
            .map(|s| s.trim().to_string())
    })
}

pub fn is_device_connected(runner: &dyn CommandRunner, mac: &str, timeout_seconds: u64) -> bool {
    if !is_valid_mac(mac) {
        return false;
    }
    let mac = normalize_mac(mac);
    let out = match runner.run(
        "bluetoothctl",
        &["info", mac.as_str()],
        Duration::from_secs(timeout_seconds.max(1)),
    ) {
        Ok(out) => out,
        Err(_) => return false,
    };
    if out.code != 0 {
        return false;
    }

    out.stdout
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("Connected: yes"))
}

pub fn is_device_paired(runner: &dyn CommandRunner, mac: &str, timeout_seconds: u64) -> bool {
    if !is_valid_mac(mac) {
        return false;
    }
    let mac = normalize_mac(mac);
    let out = match runner.run(
        "bluetoothctl",
        &["info", mac.as_str()],
        Duration::from_secs(timeout_seconds.max(1)),
    ) {
        Ok(out) => out,
        Err(_) => return false,
    };
    if out.code != 0 {
        return false;
    }

    out.stdout
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("Paired: yes"))
}

pub fn disconnect_device(runner: &dyn CommandRunner, mac: &str, timeout_seconds: u64) -> bool {
    if !is_valid_mac(mac) {
        return false;
    }
    let mac = normalize_mac(mac);
    match runner.run(
        "bluetoothctl",
        &["disconnect", mac.as_str()],
        Duration::from_secs(timeout_seconds.max(1)),
    ) {
        Ok(out) => out.code == 0 || out.stdout.contains("Successful disconnected"),
        Err(_) => false,
    }
}

pub fn trust_device(runner: &dyn CommandRunner, mac: &str, timeout_seconds: u64) -> bool {
    if !is_valid_mac(mac) {
        return false;
    }
    let mac = normalize_mac(mac);
    runner
        .run(
            "bluetoothctl",
            &["trust", mac.as_str()],
            Duration::from_secs(timeout_seconds.max(1)),
        )
        .map(|out| out.code == 0)
        .unwrap_or(false)
}

pub fn configure_adapter(runner: &dyn CommandRunner) {
    let commands: &[(&str, &[&str])] = &[
        ("bluetoothctl", &["--timeout", "5", "power", "on"]),
        ("bluetoothctl", &["--timeout", "5", "discoverable", "on"]),
        ("bluetoothctl", &["--timeout", "5", "pairable", "on"]),
        (
            "bluetoothctl",
            &["--timeout", "5", "discoverable-timeout", "0"],
        ),
        ("bluetoothctl", &["--timeout", "5", "pairable-timeout", "0"]),
        // Enable Secure Simple Pairing mode for "Just Works" auto-pairing
        ("hciconfig", &["hci0", "sspmode", "1"]),
    ];
    for (program, args) in commands {
        let _ = runner.run(program, args, Duration::from_secs(7));
    }
}

pub fn l2ping_device(
    runner: &dyn CommandRunner,
    mac: &str,
    count: u32,
    timeout_seconds: u64,
) -> bool {
    if !is_valid_mac(mac) {
        return false;
    }

    let mac = normalize_mac(mac);
    let ping_count = count.max(1);
    let per_ping_timeout = timeout_seconds.max(1);
    let count = ping_count.to_string();
    let timeout = per_ping_timeout.to_string();
    let args = ["-c", count.as_str(), "-t", timeout.as_str(), mac.as_str()];
    // Allow each ping up to per_ping_timeout; add slack for process startup.
    let command_timeout_secs = per_ping_timeout
        .saturating_mul(u64::from(ping_count))
        .saturating_add(2);

    match runner.run("l2ping", &args, Duration::from_secs(command_timeout_secs)) {
        Ok(out) => out.code == 0 && out.stdout.to_ascii_lowercase().contains("bytes from"),
        Err(_) => false,
    }
}

pub fn connect_probe(runner: &dyn CommandRunner, mac: &str, timeout_seconds: u64) -> bool {
    if !is_valid_mac(mac) {
        return false;
    }
    let mac = normalize_mac(mac);
    match runner.run(
        "bluetoothctl",
        &["connect", mac.as_str()],
        Duration::from_secs(timeout_seconds.max(1)),
    ) {
        Ok(out) => command_output_indicates_connect_success(&out),
        Err(_) => false,
    }
}

fn command_output_indicates_connect_success(out: &CommandOutput) -> bool {
    let combined = format!("{}\n{}", out.stdout, out.stderr);
    let normalized = combined.to_ascii_lowercase();
    let failed = [
        "failed",
        "not available",
        "not connected",
        "no route",
        "host is down",
        "connection refused",
        "connection timed out",
        "timeout",
    ]
    .iter()
    .any(|needle| normalized.contains(needle));

    if failed {
        return false;
    }

    out.code == 0
        || normalized.contains("connected: yes")
        || normalized.contains("connection successful")
        || normalized.contains("successful")
}

/// Presence probe: prefer passive BlueZ state, then l2ping, then a bounded connect attempt.
pub fn probe_device(
    runner: &dyn CommandRunner,
    mac: &str,
    l2ping_count: u32,
    l2ping_timeout_seconds: u64,
    connect_probe_timeout_seconds: u64,
) -> bool {
    if is_device_connected(runner, mac, connect_probe_timeout_seconds) {
        return true;
    }
    if l2ping_device(runner, mac, l2ping_count, l2ping_timeout_seconds) {
        return true;
    }
    connect_probe(runner, mac, connect_probe_timeout_seconds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use std::sync::Mutex;

    #[derive(Debug)]
    struct StubRunner {
        responses: Mutex<Vec<CommandOutput>>,
        calls: Mutex<Vec<(String, Vec<String>)>>,
    }

    impl StubRunner {
        fn new(responses: Vec<CommandOutput>) -> Self {
            Self {
                responses: Mutex::new(responses),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CommandRunner for StubRunner {
        fn run(&self, program: &str, args: &[&str], _timeout: Duration) -> Result<CommandOutput> {
            self.calls.lock().unwrap().push((
                program.to_string(),
                args.iter().map(|arg| arg.to_string()).collect(),
            ));
            Ok(self.responses.lock().unwrap().remove(0))
        }
    }

    fn output(code: i32, stdout: &str, stderr: &str) -> CommandOutput {
        CommandOutput {
            code,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn probe_succeeds_from_bluez_connected_state_without_l2ping() {
        let runner = StubRunner::new(vec![output(
            0,
            "Device AA:BB:CC:DD:EE:FF\n\tConnected: yes\n",
            "",
        )]);

        assert!(probe_device(&runner, "AA:BB:CC:DD:EE:FF", 1, 2, 2));

        let calls = runner.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "bluetoothctl");
        assert_eq!(calls[0].1, vec!["info", "AA:BB:CC:DD:EE:FF"]);
    }

    #[test]
    fn probe_falls_back_to_connect_when_l2ping_fails() {
        let runner = StubRunner::new(vec![
            output(0, "Device AA:BB:CC:DD:EE:FF\n\tConnected: no\n", ""),
            output(1, "", "Host is down"),
            output(0, "Connection successful\n", ""),
        ]);

        assert!(probe_device(&runner, "AA:BB:CC:DD:EE:FF", 1, 2, 2));

        let calls = runner.calls();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].1, vec!["info", "AA:BB:CC:DD:EE:FF"]);
        assert_eq!(calls[1].0, "l2ping");
        assert_eq!(calls[2].1, vec!["connect", "AA:BB:CC:DD:EE:FF"]);
    }

    #[test]
    fn connect_probe_rejects_failed_output_even_with_zero_exit() {
        let runner = StubRunner::new(vec![output(
            0,
            "Failed to connect: org.bluez.Error.Failed br-connection-page-timeout\n",
            "",
        )]);

        assert!(!connect_probe(&runner, "AA:BB:CC:DD:EE:FF", 2));
    }
}
