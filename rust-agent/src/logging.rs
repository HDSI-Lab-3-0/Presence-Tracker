use anyhow::{anyhow, Result};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_STATE: OnceLock<Mutex<(PathBuf, usize, usize)>> = OnceLock::new();

pub fn init(log_file: impl AsRef<Path>, max_lines: usize) -> Result<()> {
    let path = log_file.as_ref().to_path_buf();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let existing = if path.exists() {
        let file = std::fs::File::open(&path)?;
        BufReader::new(file).lines().count()
    } else {
        0
    };
    LOG_STATE
        .set(Mutex::new((path, max_lines.max(1), existing)))
        .map_err(|_| anyhow!("logger already initialized"))?;
    Ok(())
}

pub fn info(component: &str, event: &str, mac: Option<&str>, result: Option<&str>, msg: &str) {
    write_line("INFO", component, event, mac, result, msg);
}

pub fn warn(component: &str, event: &str, mac: Option<&str>, result: Option<&str>, msg: &str) {
    write_line("WARN", component, event, mac, result, msg);
}

pub fn error(component: &str, event: &str, mac: Option<&str>, result: Option<&str>, msg: &str) {
    write_line("ERROR", component, event, mac, result, msg);
}

fn write_line(level: &str, component: &str, event: &str, mac: Option<&str>, result: Option<&str>, msg: &str) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let line = format!(
        "ts={} level={} component={} event={} mac={} result={} msg=\"{}\"",
        ts,
        level,
        component,
        event,
        mac.unwrap_or("-"),
        result.unwrap_or("-"),
        msg.replace('"', "'")
    );

    if level == "ERROR" || level == "WARN" {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }

    if let Some(lock) = LOG_STATE.get() {
        if let Ok(mut state) = lock.lock() {
            if state.2 >= state.1 {
                let _ = OpenOptions::new().create(true).write(true).truncate(true).open(&state.0);
                state.2 = 0;
            }
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&state.0) {
                let _ = writeln!(file, "{line}");
                state.2 += 1;
            }
        }
    }
}
