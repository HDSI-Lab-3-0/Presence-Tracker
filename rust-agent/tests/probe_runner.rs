use anyhow::{anyhow, Result};
use presence_tracker_rs::bluetooth_probe::{probe_device, CommandOutput, CommandRunner};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
struct MockRunner {
    queue: Mutex<VecDeque<Result<CommandOutput>>>,
}

impl MockRunner {
    fn push(&self, value: Result<CommandOutput>) {
        self.queue.lock().unwrap().push_back(value);
    }
}

impl CommandRunner for MockRunner {
    fn run(&self, _program: &str, _args: &[&str], _timeout: Duration) -> Result<CommandOutput> {
        self.queue
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(anyhow!("missing mock output")))
    }
}

#[test]
fn connect_probe_marks_present_after_l2ping_failure() {
    let runner = MockRunner::default();

    // l2ping fail
    runner.push(Ok(CommandOutput {
        code: 1,
        stdout: String::new(),
        stderr: String::new(),
    }));

    // connect-probe success
    runner.push(Ok(CommandOutput {
        code: 0,
        stdout: "Connection successful".to_string(),
        stderr: String::new(),
    }));

    // disconnect call
    runner.push(Ok(CommandOutput {
        code: 0,
        stdout: String::new(),
        stderr: String::new(),
    }));

    let present = probe_device(&runner, "AA:BB:CC:DD:EE:FF", 1, 1, 2, 2);
    assert!(present);
}
