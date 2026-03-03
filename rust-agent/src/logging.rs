use chrono::Utc;

pub fn info(module: &str, event: &str, entity: Option<&str>, status: Option<&str>, message: &str) {
    log("INFO", module, event, entity, status, message);
}

pub fn warn(module: &str, event: &str, entity: Option<&str>, status: Option<&str>, message: &str) {
    log("WARN", module, event, entity, status, message);
}

fn log(
    level: &str,
    module: &str,
    event: &str,
    entity: Option<&str>,
    status: Option<&str>,
    message: &str,
) {
    let timestamp = Utc::now().to_rfc3339();
    let entity_part = entity.unwrap_or("-");
    let status_part = status.unwrap_or("-");
    println!(
        "{timestamp} [{level}] {module}:{event} entity={entity_part} status={status_part} | {message}"
    );
}
