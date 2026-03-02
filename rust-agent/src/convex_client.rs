use anyhow::Result;

#[derive(Clone, Default)]
pub struct ConvexClient;

impl ConvexClient {
    pub fn new() -> Self {
        Self
    }

    pub async fn register_pending_device(&self, mac: &str, name: Option<&str>) -> Result<()> {
        println!(
            "[stub] register_pending_device called for mac={mac} name={}",
            name.unwrap_or("")
        );
        Ok(())
    }
}
