# IEEE Presence Tracker

Bluetooth-based presence detection system using Convex backend, designed for Raspberry Pi.

## Quick Links

- [Deployment Guide](DEPLOYMENT.md) - Complete setup and deployment instructions
- [Pairing Guide](PAIRING.md) - Bluetooth pairing instructions
- [Quick Start](#quick-start) - Get started in minutes
- [Architecture](#architecture) - System overview and data flow

## Overview

This system monitors Bluetooth device presence and updates a Convex backend database. It's designed to track when devices (phones, etc.) are connected/disconnected from a Raspberry Pi via Bluetooth, without requiring any mobile app installation.

## Features

- Polls device status every 60 seconds
- Works with both iOS (iPhone) and Android devices
- No mobile app required - uses native Bluetooth pairing
- Integrates with Convex backend for real-time status updates
- Comprehensive logging to file and console
- Graceful error handling for Bluetooth adapter issues

## Quick Start

### Automated Setup (Recommended)

Run the automated setup script on your Raspberry Pi:

```bash
cd "/home/ieee/Desktop/IEEE Presence Tracker"
./setup.sh
```

The script will:
- Install UV package manager
- Install BlueZ and Bluetooth tools
- Install Python dependencies
- Configure Bluetooth permissions
- Install systemd service

Then:
1. Edit `.env` and add your `CONVEX_DEPLOYMENT_URL`
2. Pair your Bluetooth devices (see [PAIRING.md](PAIRING.md))
3. Register devices in Convex
4. Start the tracker: `uv run presence_tracker.py`

### Manual Setup

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed manual setup instructions.

## Architecture

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
│  │  - macAddress, name, status, lastSeen               │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Common Commands

```bash
# Run tracker manually
uv run presence_tracker.py

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

# List Convex devices
npx convex run getDevices
```

## Manual Setup Steps

For detailed instructions, see [DEPLOYMENT.md](DEPLOYMENT.md).

### Quick Manual Setup

1. **Install UV**
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

2. **Create .env file**
   ```bash
   cp .env.example .env
   nano .env  # Add your CONVEX_DEPLOYMENT_URL
   ```

3. **Install dependencies**
   ```bash
   uv sync
   ```

4. **Pair Bluetooth devices**
   ```bash
   sudo bluetoothctl
   # power on, agent on, scan on, pair XX:XX:XX:XX:XX:XX, trust XX:XX:XX:XX:XX:XX
   ```

5. **Register devices in Convex**
   ```bash
   npx convex run registerDevice --json '{"macAddress":"AA:BB:CC:DD:EE:FF","name":"My Device"}'
   ```

6. **Run the tracker**
   ```bash
   uv run presence_tracker.py
   ```

## Systemd Service

To run the tracker automatically on boot:

```bash
# Install service
sudo cp presence-tracker.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable presence-tracker.service
sudo systemctl start presence-tracker.service
sudo systemctl status presence-tracker.service
```

## Making the Pi Discoverable

By default, the Raspberry Pi is not discoverable via Bluetooth. The setup script automatically configures the Pi to be discoverable and pairable, but you can manually configure it if needed.

### Automatic Configuration

The setup script (`setup.sh`) installs the `bluetooth-discoverable.service` which automatically makes the Pi discoverable on boot. Your Pi will appear as **"IEEE Presence Tracker"** in Bluetooth scans.

### Manual Configuration

If you need to manually make the Pi discoverable:

```bash
cd "/home/ieee/Desktop/IEEE Presence Tracker"
./make_discoverable.sh
```

This will:
- Enable Bluetooth power
- Set discoverable mode ON
- Set pairable mode ON
- Set the friendly name to "IEEE Presence Tracker"
- Enable NoInputNoOutput agent (no PIN required for pairing)

### Verify Discoverable Status

```bash
# Check discoverable status
bluetoothctl show | grep Discoverable

# Check pairable status
bluetoothctl show | grep Pairable

# Check the Pi's name
bluetoothctl show | grep Alias

# Scan for devices to test discoverability
bluetoothctl scan on
```

### Pairing Your Device

For detailed pairing instructions, see [PAIRING.md](PAIRING.md).

Quick pairing steps:
1. Open Bluetooth settings on your phone
2. Scan for devices
3. Find "IEEE Presence Tracker"
4. Tap to pair (no PIN required)

### Troubleshooting Discoverability

```bash
# Restart Bluetooth service
sudo systemctl restart bluetooth

# Check for hardware blocks
sudo rfkill list bluetooth
sudo rfkill unblock bluetooth

# Manually power on Bluetooth
bluetoothctl power on

# Re-run the discoverable script
./make_discoverable.sh

# Check the discoverable service
sudo systemctl status bluetooth-discoverable.service
```

## Troubleshooting

### Bluetooth Not Working

```bash
sudo systemctl status bluetooth
sudo systemctl restart bluetooth
bluetoothctl info
```

### Permission Denied

```bash
sudo usermod -a -G bluetooth $USER
# Log out and back in
```

### Device Not Detected

1. Ensure device is paired: `bluetoothctl paired-devices`
2. Verify MAC address matches exactly in Convex
3. Check device Bluetooth is enabled and in range
4. Some devices disconnect when locked (especially iOS)

### iOS Specific Notes

- iOS devices don't appear in Bluetooth scans when paired
- Tracker uses `bluetoothctl` to check connection status
- Keep iPhone unlocked and Bluetooth enabled
- Some iOS versions require active connection (not just paired)

### Android Specific Notes

- Android devices are more discoverable via Bluetooth scanning
- Connection checking works via `bluetoothctl`
- May disconnect when screen is off or in power saving mode

## Project Structure

```
.
├── pyproject.toml                    # UV project configuration
├── bluetooth_scanner.py              # Bluetooth detection functions
├── presence_tracker.py               # Main presence tracking script
├── .env.example                      # Environment variable template
├── setup.sh                          # Automated setup script
├── make_discoverable.sh              # Bluetooth discoverable configuration script
├── bluetooth-discoverable.service    # Systemd service for persistent discovery
├── presence-tracker.service          # Systemd service file for presence tracker
├── DEPLOYMENT.md                     # Complete deployment guide
├── PAIRING.md                        # Bluetooth pairing instructions
├── convex/                           # Convex backend
│   ├── schema.ts                    # Database schema
│   └── devices.ts                   # Device management functions
└── README.md                         # This file
```

## Convex Functions Used

- `getDevices` - Query all registered devices
- `updateDeviceStatus` - Update device presence status
- `registerDevice` - Register a new device

## License

MIT
