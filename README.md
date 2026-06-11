# Presence Tracker

Bluetooth-based presence tracking for a Raspberry Pi with a Convex backend and web dashboard.

## Overview

The Pi runs an async Python agent (`main.py`) that monitors nearby paired Bluetooth devices and updates Convex. The web dashboard and PWA read from the same Convex backend for registration, attendance, logs, and integrations.

Core behavior:

- New Bluetooth devices are created as pending devices with a 5 minute registration grace period.
- Registered devices are checked every 1 minute.
- Present/absent transitions use the configured debounce thresholds.
- Deleted or expired devices are removed from the Pi adapter through queued removal requests.
- Bluetooth audio services are blocked by the Python BlueZ agent.

## Repository Layout

```text
main.py                         # Python agent entrypoint
presence_tracker/               # Agent helpers
  bluetooth.py                  # BlueZ D-Bus, pairing, probing, audio blocking
  config.py                     # TOML and environment config
  convex_client.py              # Async Convex HTTP client
  presence_loop.py              # One-minute presence polling loop
  state.py                      # Known-device state file
  logging_utils.py              # Console and line-capped file logging
config/agent.toml               # Pi agent config
setup.sh                        # Raspberry Pi installer and service manager
convex/                         # Convex backend functions and schema
src/                            # Web dashboard and PWA frontend
tests/                          # Python agent tests
```

## Requirements

Raspberry Pi:

- Python 3.10+
- UV package manager
- BlueZ and Bluetooth tools: `bluez bluez-tools bluetooth`
- `l2ping` with raw socket capability
- Bun, for Convex/web dependencies and deploys

Local development:

- Python 3.10+
- UV
- Bun

## Quick Start On The Pi

```bash
cd /home/hdsi/Desktop/Presence-Tracker
./setup.sh --full-install
```

The setup menu supports:

1. Full Install
2. Update Config
3. Resetup/Redeploy Backend
4. Restart Services
5. Make Bluetooth Discoverable

Non-interactive examples:

```bash
./setup.sh --full-install --non-interactive --skip-deploy
./setup.sh --update-config --bluetooth-name "Presence Tracker"
./setup.sh --restart-services
./setup.sh --make-discoverable
```

The installer:

- Installs Python, UV, Bun, BlueZ, and project dependencies.
- Writes `config/agent.toml`.
- Grants `l2ping` raw socket capability when available.
- Generates `presence-tracker.service`.
- Generates `bluetooth-discoverable.service`.
- Removes old systemd units that conflict with the current agent.

## Running The Agent

Manual test:

```bash
uv sync
uv run python main.py --config config/agent.toml --once
uv run python main.py --config config/agent.toml
```

Systemd:

```bash
sudo systemctl status presence-tracker.service
sudo systemctl restart presence-tracker.service
sudo journalctl -u presence-tracker.service -f
```

## Configuration

The Pi agent reads `config/agent.toml`.

```toml
bluetooth_name = "Presence Tracker"

[convex]
deployment_url = "https://your-deployment.convex.cloud"
admin_key = ""

[presence]
polling_interval_seconds = 60
absent_threshold = 3
present_threshold = 1
grace_period_seconds = 300

[bluetooth]
l2ping_timeout_seconds = 2
l2ping_count = 1
connect_probe_timeout_seconds = 2
command_timeout_seconds = 5
max_concurrent_probes = 2
passive_presence_ttl_seconds = 180
audio_block_uuids = [
  "0000110b-0000-1000-8000-00805f9b34fb",
]

[logging]
log_file = "logs/presence_tracker.log"
max_lines = 1000

[paths]
state_file = "config/agent_state.json"
```

Environment fallback:

- `CONVEX_SELF_HOSTED_URL`
- `CONVEX_DEPLOYMENT_URL`
- `CONVEX_URL`
- `CONVEX_SITE_URL`
- `CONVEX_SELF_HOSTED_ADMIN_KEY`
- `CONVEX_ADMIN_KEY`
- `BLUETOOTH_NAME`

## Bluetooth Behavior

The agent uses BlueZ D-Bus as the fast path:

- Adapter configuration uses D-Bus properties.
- Pairing uses a `NoInputNoOutput` BlueZ agent.
- Connected state and paired devices are read from BlueZ managed objects.
- Device removal uses `Adapter1.RemoveDevice`.

Active probing is bounded and hardware-aware:

- The loop does not overlap cycles.
- Registered devices are probed with an `asyncio.Semaphore`.
- Default probe concurrency is 2 to avoid stressing Raspberry Pi Bluetooth hardware.
- Paired phones seen through BlueZ RSSI/advertising count as present for `passive_presence_ttl_seconds`, so presence works without connecting audio profiles.
- `l2ping` is run with strict timeouts.
- Generic connect probes are skipped for devices advertising blocked audio UUIDs.

Audio protection:

- The agent rejects BlueZ `AuthorizeService` calls for configured audio UUIDs.
- Audio-capable devices can still be registered for presence through passive Bluetooth visibility, but the agent disconnects and avoids generic connect probes that would attach audio profiles.

## Registration Flow

1. Make the Pi discoverable:

   ```bash
   ./setup.sh --make-discoverable
   ```

2. Pair the phone with the Pi named by `bluetooth_name`.
3. The agent registers the MAC as a pending Convex device.
4. The user opens the web/PWA registration page and completes registration within 5 minutes.
5. If registration is not completed in time, backend maintenance expires the pending device and queues adapter removal.

## Backend And Dashboard

Install frontend/backend dependencies:

```bash
bun install
```

Run locally:

```bash
bun run dev
```

Build the web dashboard:

```bash
bun run build:frontend
```

Deploy Convex:

```bash
bunx convex deploy
```

Docker dashboard:

```bash
docker-compose up -d
```

## Testing

Local Python checks:

```bash
uv sync
uv run python -m compileall main.py presence_tracker
uv run pytest
```

Convex/frontend checks:

```bash
bunx convex codegen
bun run build:frontend
```

Pi smoke test:

```bash
ssh hdsi@100.105.57.6
cd /home/hdsi/Desktop/Presence-Tracker
git pull origin main
./setup.sh --full-install --non-interactive --skip-deploy
sudo systemctl status presence-tracker.service
sudo journalctl -u presence-tracker.service -f
```

Then pair a test phone, confirm it appears as pending, register it within 5 minutes, and verify that the one-minute loop updates presence.

## Troubleshooting

Bluetooth service:

```bash
sudo systemctl status bluetooth
sudo systemctl restart bluetooth
bluetoothctl show
rfkill list bluetooth
sudo rfkill unblock bluetooth
```

Agent logs:

```bash
sudo journalctl -u presence-tracker.service -n 100
tail -f logs/presence_tracker.log
```

Common fixes:

- If `l2ping` fails with permissions, run `sudo setcap cap_net_raw+ep "$(command -v l2ping)"`.
- If devices do not appear, run `./setup.sh --make-discoverable` and restart the service.
- If cycles are slow, lower `max_concurrent_probes` or keep `l2ping_count = 1`.
- If audio connects, check `audio_block_uuids` and restart `presence-tracker.service`.
