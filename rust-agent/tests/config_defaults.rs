use presence_tracker_rs::config::Config;
use std::fs;

#[test]
fn writes_default_config_when_missing() {
    let root = tempfile::tempdir().unwrap();
    let cfg_path = root.path().join("agent.toml");

    std::env::set_var("CONVEX_DEPLOYMENT_URL", "https://example.convex.cloud");
    let cfg = Config::load(&cfg_path).unwrap();

    assert_eq!(cfg.convex.deployment_url, "https://example.convex.cloud");
    assert!(cfg_path.exists());

    let raw = fs::read_to_string(cfg_path).unwrap();
    assert!(raw.contains("deployment_url"));
}
