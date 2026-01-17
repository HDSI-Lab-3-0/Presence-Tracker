# Bluetooth Pairing Guide

This guide explains how to pair your phone (or other Bluetooth devices) with the Raspberry Pi for the IEEE Presence Tracker.

## Quick Start

After running the setup script, your Raspberry Pi should be automatically configured as discoverable and pairable. The Pi will appear as **"IEEE Presence Tracker"** in your phone's Bluetooth settings.

### Pairing Your Phone

1. **Ensure the Pi is powered on** - The Bluetooth service must be running
2. **Open Bluetooth settings on your phone**
3. **Scan for devices** - Look for "IEEE Presence Tracker"
4. **Tap to pair** - No PIN should be required
5. **Confirm pairing** on your phone

That's it! Your device is now paired with the Pi.

## Manual Configuration (if needed)

If the Pi is not showing up in Bluetooth scans, you can manually configure it:

```bash
cd "/home/ieee/Desktop/IEEE Presence Tracker"
./make_discoverable.sh
```

This will:
- Enable Bluetooth power
- Set discoverable mode ON
- Set pairable mode ON
- Set the friendly name to "IEEE Presence Tracker"
- Enable NoInputNoOutput agent (no PIN required)

### Verify Settings

```bash
# Check Bluetooth controller status
bluetoothctl show

# Check discoverable status
bluetoothctl show | grep Discoverable

# Check pairable status
bluetoothctl show | grep Pairable

# Check alias (name)
bluetoothctl show | grep Alias

# List paired devices
bluetoothctl paired-devices
```

## Troubleshooting

### Pi Not Showing Up in Bluetooth Scan

**Symptom:** Your phone can't find "IEEE Presence Tracker" when scanning

**Solutions:**

1. **Check Bluetooth service is running**
   ```bash
   sudo systemctl status bluetooth
   sudo systemctl restart bluetooth
   ```

2. **Verify adapter is powered on**
   ```bash
   bluetoothctl power on
   ```

3. **Check for hardware blocks**
   ```bash
   sudo rfkill list bluetooth
   sudo rfkill unblock bluetooth
   ```

4. **Run make_discoverable.sh again**
   ```bash
   cd "/home/ieee/Desktop/IEEE Presence Tracker"
   ./make_discoverable.sh
   ```

5. **Restart the Pi**
   ```bash
   sudo reboot
   ```

### Pairing Fails or PIN Prompt Appears

**Symptom:** Pairing fails or phone asks for a PIN

**Solutions:**

1. **Ensure NoInputNoOutput agent is set**
   ```bash
   bluetoothctl
   > agent NoInputNoOutput
   > default-agent
   > quit
   ```

2. **Remove existing pairing and try again**
   ```bash
   bluetoothctl
   > remove XX:XX:XX:XX:XX:XX  # Replace with device MAC
   > quit
   ```

3. **On your phone:** Go to Bluetooth settings, find "IEEE Presence Tracker", tap "Forget" or "Unpair", then try pairing again

### Device Disconnects Frequently

**Symptom:** Device pairs but disconnects quickly or randomly

**Solutions:**

1. **Check device is trusted**
   ```bash
   bluetoothctl
   > trust XX:XX:XX:XX:XX:XX  # Replace with device MAC
   > quit
   ```

2. **Ensure device Bluetooth is always on**
   - **iOS:** Keep Bluetooth enabled in Control Center
   - **Android:** Disable battery optimization for Bluetooth, keep Bluetooth enabled

3. **Check range:** Stay within 10 meters (30 feet) of the Pi

4. **Disable power saving mode** on your phone

## iOS-Specific Notes

- iOS devices don't appear in Bluetooth scans after pairing (normal behavior)
- The tracker uses `bluetoothctl` to check connection status
- Keep iPhone unlocked and Bluetooth enabled for best results
- Some iOS versions may require active connection (not just paired)
- iOS may disconnect Bluetooth when the phone is locked or in low power mode

### Verifying iOS Pairing

After pairing, verify the device is recognized:

```bash
# Check paired devices
bluetoothctl paired-devices

# Check connection status
bluetoothctl info XX:XX:XX:XX:XX:XX  # Replace with your device's MAC
```

## Android-Specific Notes

- Android devices are more discoverable via Bluetooth scanning
- Connection checking works via `bluetoothctl`
- May disconnect when screen is off or in power saving mode
- Some Android devices have aggressive battery optimization that may interfere

### Optimizing Android for Reliable Detection

1. **Disable battery optimization for Bluetooth system apps**
2. **Keep Bluetooth always on** in settings
3. **Disable adaptive battery** if available
4. **Add the Pi to trusted devices** if your phone has this feature

## Verifying Pairing Worked

### 1. Check Device is Paired

```bash
bluetoothctl paired-devices
```

You should see your device listed with its MAC address.

### 2. Check Device Connection Status

```bash
# Get the MAC address from paired-devices
bluetoothctl info AA:BB:CC:DD:EE:FF  # Replace with your device MAC
```

Look for:
- `Connected: yes` - Device is currently connected
- `Trusted: yes` - Device is trusted (won't need re-pairing)

### 3. Test with Presence Tracker

```bash
cd "/home/ieee/Desktop/IEEE Presence Tracker"
uv run presence_tracker.py
```

Check the output to see if your device is detected.

### 4. Verify in Convex

```bash
# First register your device in Convex
npx convex run registerDevice --json '{"macAddress":"AA:BB:CC:DD:EE:FF","name":"My Phone"}'

# Then check if status updates
npx convex run getDevices
```

## Finding Your Device's MAC Address

### On iOS

1. Go to Settings > Bluetooth
2. Find "IEEE Presence Tracker" and tap the (i) info button
3. The MAC address is displayed

### On Android

1. Go to Settings > Connected Devices > Connection Preferences > Bluetooth
2. Find "IEEE Presence Tracker" and tap the gear icon
3. The MAC address is displayed

### On Raspberry Pi

```bash
# After pairing, list all paired devices
bluetoothctl paired-devices

# Or get detailed info for a specific device
bluetoothctl info AA:BB:CC:DD:EE:FF
```

## Security Considerations

The current configuration uses the `NoInputNoOutput` agent, which means:
- **No PIN required** for pairing
- **Easier initial setup** for testing
- **Less secure** than PIN-based pairing

For production environments, consider:
1. Using `KeyboardDisplay` agent for PIN-based pairing
2. Implementing device whitelisting in the presence tracker
3. Using the presence tracker only on a trusted local network
4. Limiting physical access to the Raspberry Pi

To enable PIN-based pairing:

```bash
bluetoothctl
> agent KeyboardDisplay
> default-agent
# Now pairing will require a PIN on your phone
```

## Advanced: Persistent Discoverable Mode

The setup script installs a systemd service (`bluetooth-discoverable.service`) that automatically configures the Pi as discoverable on boot. To manually manage this:

```bash
# Check service status
sudo systemctl status bluetooth-discoverable.service

# Start the service manually
sudo systemctl start bluetooth-discoverable.service

# Enable on boot
sudo systemctl enable bluetooth-discoverable.service

# Disable from starting on boot
sudo systemctl disable bluetooth-discoverable.service

# View service logs
sudo journalctl -u bluetooth-discoverable.service -f
```

## Getting Help

If you're still having issues:

1. Check Bluetooth logs: `sudo journalctl -u bluetooth -f`
2. Verify the presence tracker is running: `sudo systemctl status presence-tracker.service`
3. Check the presence tracker logs: `tail -f presence_tracker.log`
4. Ensure your CONVEX_DEPLOYMENT_URL is correctly set in `.env`

## References

- [BlueZ Documentation](https://www.bluez.org/)
- [bluetoothctl Command Reference](https://manpages.debian.org/unstable/bluez/bluetoothctl.1.en.html)
