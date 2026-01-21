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

The script will display an interactive menu with options:
1. **Full Install** - Complete installation and configuration
2. **Update Config** - Update Bluetooth name and configuration
3. **Resetup/Redeploy Convex** - Trigger Convex re-deployment
4. **Restart Services** - Restart systemd services
5. **Make Bluetooth Discoverable** - Configure Bluetooth for discoverable mode

The script will:
- Install UV and Bun package managers
- Install BlueZ and Bluetooth tools
- Install Python and JavaScript dependencies
- Configure Bluetooth permissions and discoverability
- Install and configure systemd services
- Deploy to Convex backend

Then:
1. Edit `.env` and add your `CONVEX_DEPLOYMENT_URL`
2. Pair your Bluetooth devices (see [PAIRING.md](PAIRING.md))
3. Register devices in Convex
4. The tracker will run automatically via systemd service

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
uv run src/presence_tracker.py

# View logs
tail -f logs/presence_tracker.log

# Check service status
sudo systemctl status presence-tracker.service

# View service logs
sudo journalctl -u presence-tracker.service -f

# Restart service
sudo systemctl restart presence-tracker.service

# Check paired devices
bluetoothctl paired-devices

# List Convex devices
bunx convex run getDevices

# Run setup menu for configuration changes
./setup.sh
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
    bunx convex run registerDevice --json '{"macAddress":"AA:BB:CC:DD:EE:FF","name":"My Device"}'
    ```

6. **Run the tracker**
    ```bash
    uv run src/presence_tracker.py
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

By default, the Raspberry Pi is not discoverable via Bluetooth. The setup script automatically configures the Pi to be discoverable and pairable.

### Using the Setup Script

Run the setup script and select option 5:

```bash
./setup.sh
# Select option 5) Make Bluetooth Discoverable
```

Your Pi will appear as **"IEEE Knock Knock"** in Bluetooth scans.

### Configuration Details

The discoverable configuration:
- Enables Bluetooth power
- Sets discoverable mode ON
- Sets pairable mode ON
- Sets the friendly name to "IEEE Knock Knock"
- Enables NoInputNoOutput agent (no PIN required for pairing)

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
3. Find "IEEE Knock Knock"
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

# Re-run setup script discoverable option
./setup.sh
# Select option 5) Make Bluetooth Discoverable

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
├── src/                              # Python source files
│   ├── bluetooth_agent.py            # Bluetooth agent for pairing
│   ├── bluetooth_scanner.py          # Bluetooth detection functions
│   └── presence_tracker.py           # Main presence tracking script
├── logs/                             # Log files
│   ├── bluetooth_agent.log           # Bluetooth agent logs
│   └── presence_tracker.log          # Presence tracker logs
├── convex/                           # Convex backend
│   ├── schema.ts                    # Database schema
│   └── devices.ts                   # Device management functions
├── frontend/                         # Web dashboard
├── pyproject.toml                    # UV project configuration
├── package.json                      # Bun project configuration
├── .env.example                      # Environment variable template
├── setup.sh                          # Interactive setup script
├── DEPLOYMENT.md                     # Complete deployment guide
├── PAIRING.md                        # Bluetooth pairing instructions
└── README.md                         # This file
```

## Systemd Services

The setup script automatically installs and configures three systemd services:

- **presence-tracker.service** - Runs the main presence tracker (`src/presence_tracker.py`)
- **bluetooth-agent.service** - Runs the Bluetooth pairing agent (`src/bluetooth_agent.py`)
- **bluetooth-discoverable.service** - Makes the Pi discoverable on boot

All services are automatically enabled and started during full installation.

## License

MIT
