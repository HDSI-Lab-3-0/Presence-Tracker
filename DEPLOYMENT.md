# Deployment Guide - IEEE Presence Tracker

Complete deployment instructions for running the IEEE Presence Tracker on a Raspberry Pi.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Architecture Overview](#architecture-overview)
- [Part 1: Convex Backend Setup](#part-1-convex-backend-setup)
- [Part 2: Raspberry Pi Setup](#part-2-raspberry-pi-setup)
- [Part 3: Bluetooth Configuration](#part-3-bluetooth-configuration)
- [Part 4: Python Environment Setup](#part-4-python-environment-setup)
- [Part 5: Running the Tracker](#part-5-running-the-tracker)
- [Part 6: Systemd Service](#part-6-systemd-service)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)

---

## Prerequisites

### Hardware

- Raspberry Pi 3B+ or newer (with built-in Bluetooth)
- MicroSD card (16GB+ recommended)
- Power supply for Raspberry Pi
- Network connection (Ethernet or Wi-Fi)

### Software

- Raspberry Pi OS (Bookworm or Bullseye recommended)
- SSH access to the Raspberry Pi
- Python 3.10 or higher (included in Raspberry Pi OS)
- Internet connection for initial setup

### Accounts

- [Convex](https://www.convex.dev/) account (free tier available)
- GitHub account (for cloning the repository, if applicable)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Raspberry Pi                           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         presence_tracker.py (Python)                 │  │
│  │  - Polls every 60 seconds                            │  │
│  │  - Checks Bluetooth connections                      │  │
│  │  - Syncs with Convex backend                         │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │                                       │
│  ┌──────────────────▼───────────────────────────────────┐  │
│  │         bluetooth_scanner.py                         │  │
│  │  - Uses bluetoothctl to check device connections    │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │                                       │
│  ┌──────────────────▼───────────────────────────────────┐  │
│  │         BlueZ (Bluetooth Stack)                      │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS API
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                      Convex Backend                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         TypeScript Functions                        │  │
│  │  - getDevices() - Fetch all registered devices      │  │
│  │  - updateDeviceStatus() - Update device status       │  │
│  │  - registerDevice() - Add new device                │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │                                       │
│  ┌──────────────────▼───────────────────────────────────┐  │
│  │         Database (Devices Table)                     │  │
│  │  - macAddress (string)                               │  │
│  │  - name (string)                                     │  │
│  │  - status (present/absent)                           │  │
│  │  - lastSeen (timestamp)                              │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  Tracked Devices                           │
│  - iOS devices (iPhone, iPad)                              │
│  - Android devices                                          │
│  - Any Bluetooth-capable device                            │
│  - Must be paired with Raspberry Pi                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 1: Convex Backend Setup

### 1.1 Create a Convex Project

First, create a new Convex project:

```bash
# Install Convex CLI (if not already installed)
bun install -g convex-dev

# Create a new project
npx convex create ieee-presence-tracker
```

Or use the [Convex Dashboard](https://dashboard.convex.dev/) to create a project.

### 1.2 Set Up the Convex Schema

Navigate to your project directory and copy the Convex files:

```bash
cd "/home/ieee/Desktop/IEEE Presence Tracker"
```

The `convex/` directory contains:

- `convex/schema.ts` - Database schema definition
- `convex/devices.ts` - Device management functions

### 1.3 Deploy to Convex

Deploy the backend to Convex:

```bash
bun install
npx convex deploy
```

This will output your deployment URL, which you'll need for the next step.

**Example output:**
```
Deployed to: https://giant-bat-123.convex.cloud
```

### 1.4 Get Your Deployment URL

You can find your deployment URL in two ways:

**Option 1: Check `convex.json`**
```bash
cat convex.json
```

**Option 2: Use Convex CLI**
```bash
npx convex env
```

Save this URL - you'll need it for the `.env` file.

### 1.5 Register Your First Device

Use the Convex dashboard or CLI to register your first device:

**Via Dashboard:**
1. Go to https://dashboard.convex.dev
2. Select your project
3. Open the "Functions" tab
4. Run the `registerDevice` mutation:
   ```typescript
   await convex.mutation("registerDevice", {
     macAddress: "AA:BB:CC:DD:EE:FF",
     name: "My iPhone"
   });
   ```

**Via CLI:**
```bash
npx convex run registerDevice --json '{"macAddress":"AA:BB:CC:DD:EE:FF","name":"My iPhone"}'
```

---

## Part 2: Raspberry Pi Setup

### 2.1 Update the System

Start with a fresh Raspberry Pi OS installation and update:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt autoremove -y
```

### 2.2 Install UV Package Manager

UV is used for Python dependency management (much faster than pip):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

After installation, verify it's available:

```bash
uv --version
```

If UV is not found in PATH, reload your shell:

```bash
source $HOME/.local/bin/env
```

### 2.3 Install BlueZ and Bluetooth Tools

Install the Bluetooth stack and utilities:

```bash
sudo apt install -y bluez bluez-tools bluetooth python3-dev libbluetooth-dev
```

### 2.4 Enable Bluetooth Service

Ensure the Bluetooth service is running:

```bash
sudo systemctl enable bluetooth
sudo systemctl start bluetooth
sudo systemctl status bluetooth
```

### 2.5 Clone or Copy the Project

Move the project files to the Raspberry Pi:

```bash
# If using git:
git clone <your-repo-url> "/home/ieee/Desktop/IEEE Presence Tracker"
cd "/home/ieee/Desktop/IEEE Presence Tracker"

# Or copy files directly via SCP from your development machine
```

---

## Part 3: Bluetooth Configuration

### 3.1 Verify Bluetooth Adapter

Check that the Bluetooth adapter is detected:

```bash
bluetoothctl info
```

You should see output similar to:

```
Controller B8:27:EB:XX:XX:XX raspberrypi [default]
```

### 3.2 Pair Your Devices

Pair each device you want to track with the Raspberry Pi:

```bash
sudo bluetoothctl
```

Inside `bluetoothctl`, run:

```bash
# Enable the adapter
power on

# Set up pairing agent
agent on
default-agent

# Start scanning
scan on

# Find your device's MAC address in the output
# Then pair with it (replace XX:XX:XX:XX:XX:XX)
pair XX:XX:XX:XX:XX:XX

# Trust the device (auto-connect in future)
trust XX:XX:XX:XX:XX:XX

# Connect to verify
connect XX:XX:XX:XX:XX:XX

# Exit bluetoothctl
exit
```

### 3.3 Verify Paired Devices

List all paired devices:

```bash
bluetoothctl paired-devices
```

Note the MAC addresses - you'll need these for registering devices in Convex.

### 3.4 Test Device Connection

Verify a device is connected:

```bash
bluetoothctl info XX:XX:XX:XX:XX:XX
```

Look for `Connected: yes` in the output.

### 3.5 Bluetooth Permissions

Ensure your user has Bluetooth permissions:

```bash
sudo usermod -a -G bluetooth $USER
```

Log out and back in for changes to take effect.

---

## Part 4: Python Environment Setup

### 4.1 Create Environment File

Copy the example environment file:

```bash
cd "/home/ieee/Desktop/IEEE Presence Tracker"
cp .env.example .env
```

Edit the `.env` file with your Convex deployment URL:

```bash
nano .env
```

Replace `https://your-convex-deployment.convex.cloud` with your actual URL:

```bash
CONVEX_DEPLOYMENT_URL=https://your-actual-convex-url.convex.cloud
```

Save and exit (Ctrl+O, Enter, Ctrl+X).

### 4.2 Install Python Dependencies

Use UV to install dependencies:

```bash
cd "/home/ieee/Desktop/IEEE Presence Tracker"
uv sync
```

This installs:
- `convex` - Convex Python SDK
- `python-dotenv` - Environment variable management
- `pybluez` - Bluetooth library

### 4.3 Verify Installation

Test that the environment is set up correctly:

```bash
uv run python -c "import convex; import bluetooth_scanner; print('Dependencies OK')"
```

---

## Part 5: Running the Tracker

### 5.1 Manual Execution

Run the tracker manually to test:

```bash
cd "/home/ieee/Desktop/IEEE Presence Tracker"
uv run presence_tracker.py
```

The tracker will:
- Start polling every 60 seconds
- Log output to console and `presence_tracker.log`
- Check device connections and sync with Convex

Sample output:

```
2026-01-16 08:00:00 - INFO - Starting IEEE Presence Tracker
2026-01-16 08:00:00 - INFO - Polling interval: 60 seconds
2026-01-16 08:00:00 - INFO - ==================================================
2026-01-16 08:00:00 - INFO - Starting check cycle at 2026-01-16T08:00:00
2026-01-16 08:00:01 - INFO - Retrieved 2 devices from Convex
2026-01-16 08:00:01 - INFO - Checking device: John's iPhone (AA:BB:CC:DD:EE:FF)
2026-01-16 08:00:02 - INFO - Status changed for John's iPhone (AA:BB:CC:DD:EE:FF): absent -> present
2026-01-16 08:00:02 - INFO - Updated device AA:BB:CC:DD:EE:FF status to present
2026-01-16 08:00:02 - INFO - Updated 1 device(s) in this cycle
2026-01-16 08:00:02 - INFO - Cycle complete. Next check in 60 seconds...
```

### 5.2 Stop the Tracker

Press `Ctrl+C` to stop the tracker.

### 5.3 View Logs

Check the log file:

```bash
tail -f presence_tracker.log
```

---

## Part 6: Systemd Service

### 6.1 Install the Service File

Copy the provided service file to systemd:

```bash
sudo cp presence-tracker.service /etc/systemd/system/presence-tracker.service
```

### 6.2 Edit the Service File (If Needed)

If your installation differs from the default paths, edit the service:

```bash
sudo nano /etc/systemd/system/presence-tracker.service
```

Check these values:
- `User=` - Your username (default: `ieee`)
- `WorkingDirectory=` - Project path (default: `/home/ieee/Desktop/IEEE Presence Tracker`)
- `EnvironmentFile=` - Path to `.env` file
- `ExecStart=` - Full path to `uv` binary

Save and exit.

### 6.3 Reload Systemd

Reload systemd to recognize the new service:

```bash
sudo systemctl daemon-reload
```

### 6.4 Enable and Start the Service

```bash
sudo systemctl enable presence-tracker.service
sudo systemctl start presence-tracker.service
```

### 6.5 Check Service Status

```bash
sudo systemctl status presence-tracker.service
```

Expected output:

```
● presence-tracker.service - IEEE Presence Tracker - Bluetooth Device Monitoring Service
     Loaded: loaded (/etc/systemd/system/presence-tracker.service; enabled)
     Active: active (running) since Wed 2026-01-16 08:00:00 PST; 5s ago
   Main PID: 12345 (uv run presence_tracker.py)
      Tasks: 2 (limit: 4915)
        CPU: 123ms
     CGroup: /system.slice/presence-tracker.service
             ├─12345 /home/ieee/.local/bin/uv run presence_tracker.py
             └─12346 /home/ieee/.local/share/uv/python/cpython-3.12.0-linux-armv7l/bin/python ...

Jan 16 08:00:00 raspberrypi systemd[1]: Starting IEEE Presence Tracker...
Jan 16 08:00:01 raspberrypi presence_tracker.py[12345]: 2026-01-16 08:00:01 - INFO - Starting IEEE Presence Tracker
```

### 6.6 View Service Logs

View real-time logs from the service:

```bash
sudo journalctl -u presence-tracker.service -f
```

View recent logs:

```bash
sudo journalctl -u presence-tracker.service -n 50
```

### 6.7 Service Management Commands

```bash
# Restart the service
sudo systemctl restart presence-tracker.service

# Stop the service
sudo systemctl stop presence-tracker.service

# Disable auto-start on boot
sudo systemctl disable presence-tracker.service
```

---

## Troubleshooting

### Bluetooth Issues

**Problem: Bluetooth adapter not detected**

```bash
# Check if Bluetooth hardware is detected
sudo dmesg | grep -i bluetooth

# Restart Bluetooth service
sudo systemctl restart bluetooth

# Check Bluetooth status
sudo systemctl status bluetooth
```

**Problem: Cannot pair devices**

```bash
# Stop and restart Bluetooth service
sudo systemctl stop bluetooth
sudo systemctl start bluetooth

# Clear pairing cache
sudo rm -rf /var/lib/bluetooth/*
sudo systemctl restart bluetooth
```

**Problem: Device connects then disconnects**

This is normal for some devices (especially iOS) when locked. The tracker will detect reconnection when the device wakes up.

### Convex Issues

**Problem: Connection refused or timeout**

```bash
# Verify Convex URL in .env
cat .env

# Test network connectivity
curl -I https://your-convex-url.convex.cloud

# Check Convex deployment status
npx convex status
```

**Problem: "No devices found in Convex database"**

Ensure you've registered devices in Convex:

```bash
# List all devices via Convex CLI
npx convex run getDevices
```

### Python/UV Issues

**Problem: UV command not found**

```bash
# Add UV to PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Reinstall UV
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Problem: Import errors**

```bash
# Reinstall dependencies
cd "/home/ieee/Desktop/IEEE Presence Tracker"
uv sync
```

### Systemd Service Issues

**Problem: Service fails to start**

```bash
# Check service logs for errors
sudo journalctl -u presence-tracker.service -n 50

# Verify file permissions
ls -la /home/ieee/Desktop/IEEE\ Presence\ Tracker/

# Check .env file exists
cat /home/ieee/Desktop/IEEE\ Presence\ Tracker/.env
```

**Problem: Service stops unexpectedly**

```bash
# Check if UV is in the expected location
which uv
# Expected: /home/ieee/.local/bin/uv

# Update ExecStart path in service file if needed
sudo nano /etc/systemd/system/presence-tracker.service

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart presence-tracker.service
```

### Device Detection Issues

**Problem: Device always shows as absent**

1. Verify device is paired: `bluetoothctl paired-devices`
2. Check device MAC address matches exactly in Convex
3. Test connection manually: `bluetoothctl info XX:XX:XX:XX:XX:XX`
4. Ensure device Bluetooth is enabled and in range

**Problem: Device status doesn't update**

```bash
# Check tracker logs
tail -f presence_tracker.log

# Verify Convex mutations are working
npx convex run getDevices
```

---

## Testing

### Test 1: Manual Connection Check

Test Bluetooth detection manually:

```bash
bluetoothctl info XX:XX:XX:XX:XX:XX
```

Look for `Connected: yes` or `Connected: no`.

### Test 2: Convex Connection

Test Convex API access:

```bash
uv run python -c "
import os
from dotenv import load_dotenv
import convex

load_dotenv()
url = os.getenv('CONVEX_DEPLOYMENT_URL')
client = convex.ConvexClient(url)
devices = client.query('getDevices')
print(f'Found {len(devices)} devices:')
for device in devices:
    print(f'  - {device.get(\"name\")}: {device.get(\"status\")}')
"
```

### Test 3: Single Polling Cycle

Run the tracker for one cycle:

```bash
timeout 70 uv run presence_tracker.py
```

This will run for ~70 seconds (one 60-second cycle + startup time).

### Test 4: Service Logs

Check if the service is running correctly:

```bash
sudo systemctl status presence-tracker.service
sudo journalctl -u presence-tracker.service -n 20
```

### Test 5: End-to-End Test

1. Pair a device with the Raspberry Pi
2. Register it in Convex with its MAC address
3. Start the tracker (manual or service)
4. Turn Bluetooth off on the device
5. Wait 60 seconds
6. Check Convex dashboard - status should show "absent"
7. Turn Bluetooth back on
8. Wait 60 seconds
9. Check Convex dashboard - status should show "present"

---

## Quick Reference

### Common Commands

```bash
# Start tracker manually
cd "/home/ieee/Desktop/IEEE Presence Tracker" && uv run presence_tracker.py

# View logs
tail -f presence_tracker.log

# Check service status
sudo systemctl status presence-tracker.service

# View service logs
sudo journalctl -u presence-tracker.service -f

# Restart service
sudo systemctl restart presence-tracker.service

# Check paired devices
bluetoothctl paired-devices

# Check Convex devices
npx convex run getDevices

# Pair a device
sudo bluetoothctl
# power on, agent on, scan on, pair XX:XX:XX:XX:XX:XX, trust XX:XX:XX:XX:XX:XX
```

### File Locations

```
/home/ieee/Desktop/IEEE Presence Tracker/
├── presence_tracker.py          # Main tracker script
├── bluetooth_scanner.py         # Bluetooth detection
├── pyproject.toml              # UV project config
├── .env                        # Environment variables
├── presence_tracker.log        # Runtime logs
└── presence-tracker.service    # Systemd service file

/etc/systemd/system/
└── presence-tracker.service    # Installed service (after setup)
```

---

## Next Steps

After deployment:

1. **Monitor the first few hours** - Check logs to ensure devices are detected correctly
2. **Adjust polling interval** - Edit `POLLING_INTERVAL` in `presence_tracker.py` if needed
3. **Add more devices** - Use `registerDevice` to add each device
4. **Build a frontend** - Connect to Convex to display real-time device status
5. **Set up alerts** - Create Convex functions to notify on status changes

---

## Support

- **Convex Documentation**: https://docs.convex.dev
- **BlueZ Documentation**: https://www.bluez.org/
- **UV Documentation**: https://github.com/astral-sh/uv
- **Raspberry Pi Bluetooth**: https://www.raspberrypi.com/documentation/computers/configuration.html#bluetooth
