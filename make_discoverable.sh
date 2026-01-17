#!/bin/bash

# IEEE Presence Tracker - Bluetooth Discoverable Setup
# This script configures the Raspberry Pi to be discoverable and pairable via Bluetooth

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Friendly name for the Pi
PI_NAME="IEEE Presence Tracker"

log_info "Configuring Bluetooth for IEEE Presence Tracker..."
log_info "Setting friendly name to: $PI_NAME"

# Check if bluetoothctl is available
if ! command -v bluetoothctl &> /dev/null; then
    log_error "bluetoothctl not found. Please install BlueZ first."
    log_error "Run: sudo apt install bluez bluez-tools bluetooth"
    exit 1
fi

# Ensure bluetooth service is running
if ! sudo systemctl is-active --quiet bluetooth 2>/dev/null; then
    log_warn "Bluetooth service is not running. Starting it..."
    sudo systemctl start bluetooth 2>/dev/null || {
        log_error "Failed to start bluetooth service"
        log_error "Try: sudo systemctl start bluetooth"
        exit 1
    }
    sleep 2
fi

log_info "Bluetooth service is running"

# Detect Bluetooth controller using sysfs (primary method)
log_info "Detecting Bluetooth controller..."
CONTROLLER=""

# Check /sys/class/bluetooth/ first - this works even if bluetoothctl list fails
if [ -d "/sys/class/bluetooth/hci0" ]; then
    CONTROLLER="hci0"
    log_info "Bluetooth controller found via sysfs: $CONTROLLER"
else
    # Fallback to bluetoothctl list if sysfs check fails
    CONTROLLER=$(bluetoothctl list 2>/dev/null | grep -oE "hci[0-9]+" | head -1)
    if [ -n "$CONTROLLER" ]; then
        log_info "Bluetooth controller found via bluetoothctl: $CONTROLLER"
    fi
fi

# Final check for controller
if [ -z "$CONTROLLER" ]; then
    log_error "No Bluetooth controller found"
    log_error ""
    log_error "Troubleshooting steps:"
    log_error "  1. Check if bluetooth service is running: sudo systemctl status bluetooth"
    log_error "  2. Restart bluetooth: sudo systemctl restart bluetooth"
    log_error "  3. Check for blocked adapters: sudo rfkill list bluetooth"
    log_error "     If blocked, unblock: sudo rfkill unblock bluetooth"
    log_error "  4. Check if adapter is detected: ls /sys/class/bluetooth/"
    log_error "  5. Check dmesg for errors: dmesg | grep -i bluetooth"
    log_error ""
    log_error "If using a USB Bluetooth dongle:"
    log_error "  - Make sure it's plugged in"
    log_error "  - Try a different USB port"
    log_error "  - Check with: lsusb | grep -i bluetooth"
    log_error ""
    log_error "If no adapter is present:"
    log_error "  - Raspberry Pi Zero/Zero W may need a USB dongle"
    log_error "  - Some Pi models don't have built-in Bluetooth"
    exit 1
fi

# Skip explicit verification - if hci0 exists in sysfs, it should work
log_info "Controller $CONTROLLER detected, proceeding with configuration..."

# Configure Bluetooth using individual commands
log_info "Applying Bluetooth configuration..."

# Power on the adapter
log_info "Powering on Bluetooth adapter..."
sudo bluetoothctl --timeout 5 power on 2>/dev/null || log_warn "Power command may have failed"
sleep 1

# Set discoverable
log_info "Making adapter discoverable..."
sudo bluetoothctl --timeout 5 discoverable on 2>/dev/null || log_warn "Discoverable command may have failed"
sleep 1

# Set pairable
log_info "Making adapter pairable..."
sudo bluetoothctl --timeout 5 pairable on 2>/dev/null || log_warn "Pairable command may have failed"
sleep 1

# Set up agent (no PIN required)
log_info "Setting up agent..."
sudo bluetoothctl --timeout 5 agent NoInputNoOutput 2>/dev/null || log_warn "Agent command may have failed"
sudo bluetoothctl --timeout 5 default-agent 2>/dev/null || log_warn "Default agent command may have failed"
sleep 1

# Set the friendly name using hciconfig (more reliable than bluetoothctl alias)
log_info "Setting friendly name to: $PI_NAME"
sudo hciconfig $CONTROLLER name "$PI_NAME" 2>/dev/null || log_warn "Name change may have failed"
sleep 1

# Verify the configuration was applied
log_info "Verifying configuration..."

# Use hciconfig to get the actual status (more reliable than bluetoothctl show)
HCI_STATUS=$(hciconfig $CONTROLLER 2>/dev/null || echo "")

if echo "$HCI_STATUS" | grep -q "UP RUNNING"; then
    POWERED="yes"
    log_info "✓ Bluetooth adapter is powered on"
else
    POWERED="no"
    log_warn "✗ Bluetooth adapter may not be powered on"
fi

if echo "$HCI_STATUS" | grep -q "PSCAN"; then
    DISCOVERABLE="yes"
    log_info "✓ Bluetooth adapter is discoverable"
else
    DISCOVERABLE="no"
    log_warn "✗ Bluetooth adapter may not be discoverable"
fi

if echo "$HCI_STATUS" | grep -q "ISCAN"; then
    PAIRABLE="yes"
    log_info "✓ Bluetooth adapter is pairable"
else
    PAIRABLE="no"
    log_warn "✗ Bluetooth adapter may not be pairable"
fi

# Get the device name
ALIAS=$(hciconfig $CONTROLLER name 2>/dev/null | grep -oP "Name: '\K[^']+")
if [ -n "$ALIAS" ]; then
    log_info "✓ Device name: $ALIAS"
else
    log_warn "✗ Could not retrieve device name"
fi

log_info ""
log_info "Bluetooth configured successfully"
log_info ""
log_info "Current Bluetooth settings:"
log_info "  Power: $POWERED"
log_info "  Discoverable: $DISCOVERABLE"
log_info "  Pairable: $PAIRABLE"
log_info "  Alias: $ALIAS"
log_info "  Agent: NoInputNoOutput (no PIN required)"
log_info ""
log_info "Verification commands:"
log_info "  Check status: hciconfig $CONTROLLER"
log_info "  Check name: hciconfig $CONTROLLER name"
log_info "  Scan for devices: sudo bluetoothctl scan on"
log_info ""
log_info "The Pi is now discoverable and pairable!"
log_info "You can pair your phone by scanning for \"$PI_NAME\" in Bluetooth settings."
