import logging
from logging.handlers import RotatingFileHandler
from typing import Optional
import time
import threading
from threading import Lock
from datetime import datetime, timedelta
import os
import subprocess
import dbus
import dbus.exceptions
import dbus.mainloop.glib

# Ensure logs directory exists
os.makedirs("logs", exist_ok=True)

# Configure logger for bluetooth_scanner
logger = logging.getLogger(__name__)
if not logger.handlers:
    logger.setLevel(logging.DEBUG)
    handler = RotatingFileHandler(
        "logs/bluetooth_scanner.log",
        maxBytes=100000,
        backupCount=1,
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
    )
    logger.addHandler(handler)

# Global state for auto-reconnection
# Track last connection attempt time for each device to avoid spamming
_last_connection_attempts: dict[str, float] = {}
_connection_state_lock = Lock()

# Global D-Bus operation serialization - ensure only one operation at a time
_dbus_operation_lock = threading.RLock()

# Track consecutive probe failures for exponential backoff
_failed_connection_attempts: dict[str, int] = {}
_next_probe_allowed_at: dict[str, float] = {}

# Cooldown period between connection attempts for the same device (seconds)
RECONNECT_COOLDOWN = 30

# How long to consider a device "recently attempted" (seconds)
RECENT_ATTEMPT_WINDOW = 60

# How long to wait for D-Bus connect attempts (seconds)
CONNECT_TIMEOUT_SECONDS = int(os.getenv("CONNECT_TIMEOUT_SECONDS", "10"))
# Extra buffer for hard timeout handling (seconds)
CONNECT_TIMEOUT_BUFFER_SECONDS = float(
    os.getenv("CONNECT_TIMEOUT_BUFFER_SECONDS", "2.0")
)
HARD_CONNECT_TIMEOUT_SECONDS = CONNECT_TIMEOUT_SECONDS + CONNECT_TIMEOUT_BUFFER_SECONDS

# How long to wait for probe connect attempts (seconds) - optimized for throughput
# PERFORMANCE OPTIMIZATION: Reduced from 10s to 5s to double throughput for missing devices
# This affects probe_devices() and auto_reconnect_paired_devices() functions
PROBE_CONNECT_TIMEOUT_SECONDS = int(os.getenv("PROBE_CONNECT_TIMEOUT_SECONDS", "5"))
# Extra buffer for probe hard timeout handling (seconds)
PROBE_CONNECT_TIMEOUT_BUFFER_SECONDS = float(
    os.getenv("PROBE_CONNECT_TIMEOUT_BUFFER_SECONDS", "1.0")
)
HARD_PROBE_CONNECT_TIMEOUT_SECONDS = PROBE_CONNECT_TIMEOUT_SECONDS + PROBE_CONNECT_TIMEOUT_BUFFER_SECONDS

# How long to run discovery refresh for in-range detection (seconds)
IN_RANGE_SCAN_SECONDS = int(os.getenv("IN_RANGE_SCAN_SECONDS", "5"))

# RSSI freshness window (seconds) for treating RSSI/TxPower as presence
RSSI_FRESHNESS_SECONDS = int(os.getenv("RSSI_FRESHNESS_SECONDS", "15"))

# Whether to disconnect after a successful auto-reconnect to free connection slots
DISCONNECT_AFTER_SUCCESS = os.getenv("DISCONNECT_AFTER_SUCCESS", "true").lower() in (
    "1",
    "true",
    "yes",
)

# Whether to probe paired devices if scan finds nothing in range
ALLOW_PAIRED_PROBE_ON_EMPTY_SCAN = os.getenv(
    "ALLOW_PAIRED_PROBE_ON_EMPTY_SCAN", "true"
).lower() in ("1", "true", "yes")

# Cap reconnection attempts per cycle to avoid long stalls
MAX_RECONNECT_PER_CYCLE = int(os.getenv("MAX_RECONNECT_PER_CYCLE", "4"))

# Exponential backoff configuration for probe failures
PROBE_BACKOFF_BASE_SECONDS = float(os.getenv("PROBE_BACKOFF_BASE_SECONDS", "5"))
PROBE_BACKOFF_MAX_SECONDS = float(os.getenv("PROBE_BACKOFF_MAX_SECONDS", "300"))

# bluetoothctl fallback command
BLUETOOTHCTL_BINARY = os.getenv("BLUETOOTHCTL_BINARY", "bluetoothctl")

# BlueZ D-Bus constants
BLUEZ_SERVICE = "org.bluez"
OBJECT_MANAGER_INTERFACE = "org.freedesktop.DBus.ObjectManager"
PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties"
DEVICE_INTERFACE = "org.bluez.Device1"
ADAPTER_INTERFACE = "org.bluez.Adapter1"

_system_bus: dbus.SystemBus | None = None
_adapter_path_cache: str | None = None
_dbus_mainloop_initialized = False
_last_rssi_refresh_time = 0.0


def _ensure_dbus_mainloop() -> None:
    global _dbus_mainloop_initialized
    if not _dbus_mainloop_initialized:
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        _dbus_mainloop_initialized = True


def init_dbus() -> None:
    """Initialize the D-Bus main loop and system bus once at startup."""
    _ensure_dbus_mainloop()
    _get_system_bus()


def _get_system_bus() -> dbus.SystemBus:
    global _system_bus
    if _system_bus is None:
        _ensure_dbus_mainloop()
        _system_bus = dbus.SystemBus()
    return _system_bus


def _dbus_to_native(value):
    if isinstance(value, (dbus.Boolean,)):
        return bool(value)
    if isinstance(value, (dbus.Int16, dbus.Int32, dbus.Int64, dbus.UInt16, dbus.UInt32, dbus.UInt64)):
        return int(value)
    if isinstance(value, (dbus.String, dbus.ObjectPath)):
        return str(value)
    if isinstance(value, dbus.Array):
        return [_dbus_to_native(item) for item in value]
    if isinstance(value, dbus.Dictionary):
        return {key: _dbus_to_native(val) for key, val in value.items()}
    return value


def _get_managed_objects() -> dict:
    bus = _get_system_bus()
    manager = dbus.Interface(bus.get_object(BLUEZ_SERVICE, "/"), OBJECT_MANAGER_INTERFACE)
    return manager.GetManagedObjects()


def _get_adapter_path(managed_objects: dict | None = None) -> str | None:
    global _adapter_path_cache
    if _adapter_path_cache is not None:
        return _adapter_path_cache
    objects = managed_objects or _get_managed_objects()
    for path, interfaces in objects.items():
        if ADAPTER_INTERFACE in interfaces:
            _adapter_path_cache = str(path)
            return _adapter_path_cache
    return None


def _normalize_mac(address: str | None) -> str | None:
    if not address:
        return None
    return address.upper()


def _device_has_presence_signal(device_info: dict, rssi_fresh: bool) -> bool:
    if bool(device_info.get("connected")):
        return True
    if not rssi_fresh:
        return False
    return device_info.get("rssi") is not None or device_info.get("tx_power") is not None


def _is_rssi_fresh(now: float) -> bool:
    return now - _last_rssi_refresh_time <= RSSI_FRESHNESS_SECONDS


def get_device_snapshot() -> dict[str, dict]:
    """Fetch a snapshot of all BlueZ Device1 objects in one D-Bus call."""
    devices: dict[str, dict] = {}
    try:
        managed_objects = _get_managed_objects()
    except Exception as e:
        logger.error(f"Error fetching BlueZ managed objects: {e}")
        return devices

    for path, interfaces in managed_objects.items():
        if DEVICE_INTERFACE not in interfaces:
            continue
        props = interfaces.get(DEVICE_INTERFACE, {})
        address = _normalize_mac(_dbus_to_native(props.get("Address")))
        if not address:
            continue
        device_info = {
            "path": str(path),
            "address": address,
            "name": _dbus_to_native(props.get("Name")),
            "alias": _dbus_to_native(props.get("Alias")),
            "connected": bool(_dbus_to_native(props.get("Connected", False))),
            "paired": bool(_dbus_to_native(props.get("Paired", False))),
            "trusted": bool(_dbus_to_native(props.get("Trusted", False))),
            "rssi": _dbus_to_native(props.get("RSSI")),
            "tx_power": _dbus_to_native(props.get("TxPower")),
        }
        devices[address] = device_info

    return devices


def refresh_discovery(duration: int) -> None:
    """Trigger a short BlueZ discovery window to refresh RSSI/TxPower signals."""
    global _last_rssi_refresh_time
    if duration <= 0:
        return
    try:
        logger.info("Starting discovery refresh for %ss", duration)
        managed_objects = _get_managed_objects()
        adapter_path = _get_adapter_path(managed_objects)
        if not adapter_path:
            logger.error("No Bluetooth adapter found for discovery refresh")
            return
        bus = _get_system_bus()
        adapter = dbus.Interface(bus.get_object(BLUEZ_SERVICE, adapter_path), ADAPTER_INTERFACE)
        start = time.monotonic()
        try:
            adapter.StartDiscovery()
        except dbus.exceptions.DBusException as e:
            if "InProgress" not in str(e):
                logger.debug(f"StartDiscovery failed: {e}")
        time.sleep(duration)
        try:
            adapter.StopDiscovery()
        except dbus.exceptions.DBusException as e:
            logger.debug(f"StopDiscovery failed: {e}")
        _last_rssi_refresh_time = time.time()
        elapsed = time.monotonic() - start
        logger.info("Discovery refresh complete in %.2fs", elapsed)
    except Exception as e:
        logger.debug(f"Discovery refresh failed: {e}")


def check_device_connected(mac_address: str, snapshot: dict[str, dict] | None = None) -> bool:
    """Check if a specific Bluetooth device is currently connected."""
    snapshot = snapshot or get_device_snapshot()
    device = snapshot.get(mac_address.upper())
    if not device:
        logger.debug(f"Device {mac_address} not found in BlueZ snapshot")
        return False
    return bool(device.get("connected"))


def scan_for_devices(snapshot: dict[str, dict] | None = None) -> dict[str, str]:
    """Compatibility wrapper to return known device names from the snapshot."""
    devices: dict[str, str] = {}
    snapshot = snapshot or get_device_snapshot()
    for mac_address, info in snapshot.items():
        name = info.get("alias") or info.get("name") or "Unknown"
        devices[mac_address] = name
    logger.info(f"Snapshot scan complete. Found {len(devices)} devices.")
    return devices


def get_device_name(
    mac_address: str, snapshot: dict[str, dict] | None = None
) -> Optional[str]:
    """
    Get the friendly name of a device by MAC address.

    Uses BlueZ D-Bus snapshot data for paired device metadata.

    Args:
        mac_address: The MAC address of the device (format: XX:XX:XX:XX:XX:XX)

    Returns:
        The device name if found, None otherwise
    """
    snapshot = snapshot or get_device_snapshot()
    device = snapshot.get(mac_address.upper())
    if not device:
        logger.debug(f"Device {mac_address} not found in BlueZ snapshot")
        return None
    name = device.get("alias") or device.get("name")
    if name:
        logger.info(f"✓ Device {mac_address} name found: '{name}'")
    else:
        logger.warning(f"✗ No Name field found for device {mac_address}")
    return name


def scan_paired_devices(snapshot: dict[str, dict] | None = None) -> dict[str, str]:
    """
    Scan for paired Bluetooth devices using BlueZ D-Bus snapshot data.

    Returns:
        Dictionary mapping MAC addresses to device names
    """
    devices: dict[str, str] = {}
    snapshot = snapshot or get_device_snapshot()
    for mac_address, info in snapshot.items():
        if info.get("paired"):
            name = info.get("alias") or info.get("name") or "Unknown"
            devices[mac_address] = name
            logger.debug(f"Paired device: {mac_address} - {name}")
    logger.info(f"Found {len(devices)} paired devices")
    return devices


def get_all_connected_devices(snapshot: dict[str, dict] | None = None) -> list[str]:
    """
    Get list of MAC addresses for all currently connected Bluetooth devices.

    Uses BlueZ D-Bus snapshot data to include paired devices that are
    connected but not discoverable (like iOS devices).

    Returns:
        List of MAC addresses of connected devices
    """
    connected_devices: list[str] = []
    snapshot = snapshot or get_device_snapshot()
    for mac_address, info in snapshot.items():
        if info.get("connected"):
            connected_devices.append(mac_address)
            logger.debug(f"Connected device: {mac_address}")
    logger.info(f"Found {len(connected_devices)} connected device(s)")
    return connected_devices


def _get_device_path(mac_address: str, snapshot: dict[str, dict] | None = None) -> str | None:
    snapshot = snapshot or get_device_snapshot()
    device = snapshot.get(mac_address.upper())
    if not device:
        return None
    return device.get("path")


def trust_device(mac_address: str, snapshot: dict[str, dict] | None = None) -> bool:
    """
    Trust a Bluetooth device to allow auto-connect.

    Trusted devices can automatically reconnect when they come into range.

    Args:
        mac_address: The MAC address of the device to trust

    Returns:
        True if the device was trusted successfully, False otherwise
    """
    try:
        snapshot = snapshot or get_device_snapshot()
        device_path = _get_device_path(mac_address, snapshot)
        if not device_path:
            logger.warning(f"Device {mac_address} not found for trust")
            return False
        bus = _get_system_bus()
        props = dbus.Interface(bus.get_object(BLUEZ_SERVICE, device_path), PROPERTIES_INTERFACE)
        props.Set(DEVICE_INTERFACE, "Trusted", dbus.Boolean(True))
        logger.info(f"Trusted device {mac_address}")
        return True
    except Exception as e:
        logger.error(f"Error trusting device {mac_address}: {e}")
        return False


def is_device_trusted(mac_address: str, snapshot: dict[str, dict] | None = None) -> bool:
    """
    Check if a device is trusted.

    Args:
        mac_address: The MAC address of the device to check

    Returns:
        True if the device is trusted, False otherwise
    """
    try:
        snapshot = snapshot or get_device_snapshot()
        device = snapshot.get(mac_address.upper())
        if not device:
            return False
        return bool(device.get("trusted"))
    except Exception as e:
        logger.error(f"Error checking trust status for {mac_address}: {e}")
        return False


def _dbus_device_method(device_path: str, method_name: str, timeout: int = CONNECT_TIMEOUT_SECONDS) -> None:
    """Invoke a Device1 method while serializing access to the bus."""

    with _dbus_operation_lock:
        bus = _get_system_bus()
        device = dbus.Interface(
            bus.get_object(BLUEZ_SERVICE, device_path), DEVICE_INTERFACE
        )
        method = getattr(device, method_name)
        method(timeout=timeout)


def _invoke_with_hard_timeout(
    fn, mac_address: str, operation: str, hard_timeout: float = HARD_CONNECT_TIMEOUT_SECONDS
) -> tuple[bool, str | None]:
    """Run fn in a worker thread and enforce a hard timeout."""

    result: dict[str, str | None] = {"error": None}
    done = threading.Event()

    def _worker() -> None:
        try:
            fn()
        except Exception as exc:  # pragma: no cover - error path
            result["error"] = str(exc)
        finally:
            done.set()

    thread = threading.Thread(
        target=_worker,
        name=f"dbus-{operation}-{mac_address}",
        daemon=True,
    )
    thread.start()
    finished = done.wait(hard_timeout)
    if not finished:
        logger.error(
            "DBus %s for %s exceeded hard timeout (%.1fs) - thread may be stuck",
            operation,
            mac_address,
            hard_timeout,
        )
        return False, "hard timeout"
    if result["error"]:
        return False, result["error"]
    return True, None


def _run_bluetoothctl_operation(
    command: str, mac_address: str, hard_timeout: float = HARD_CONNECT_TIMEOUT_SECONDS
) -> tuple[bool, str | None]:
    """Execute a bluetoothctl command with a hard timeout."""

    try:
        completed = subprocess.run(
            [BLUETOOTHCTL_BINARY, command, mac_address],
            capture_output=True,
            text=True,
            timeout=hard_timeout,
            check=False,
        )
        stdout = (completed.stdout or "").strip()
        stderr = (completed.stderr or "").strip()
        detail = stderr or stdout or None
        if completed.returncode == 0:
            logger.info(
                "bluetoothctl %s %s succeeded%s",
                command,
                mac_address,
                f": {detail}" if detail else "",
            )
            return True, detail
        logger.warning(
            "bluetoothctl %s %s failed (rc=%s): %s",
            command,
            mac_address,
            completed.returncode,
            detail,
        )
        return False, detail
    except subprocess.TimeoutExpired:
        logger.error(
            "bluetoothctl %s %s timed out after %.1fs",
            command,
            mac_address,
            hard_timeout,
        )
        return False, "bluetoothctl timeout"
    except FileNotFoundError as exc:  # pragma: no cover - environment specific
        logger.error("bluetoothctl binary not found: %s", exc)
        return False, "bluetoothctl missing"


def _read_connected_property(device_path: str) -> bool | None:
    """Read org.bluez.Device1.Connected via Properties.Get."""

    try:
        with _dbus_operation_lock:
            bus = _get_system_bus()
            props = dbus.Interface(
                bus.get_object(BLUEZ_SERVICE, device_path), PROPERTIES_INTERFACE
            )
            value = props.Get(DEVICE_INTERFACE, "Connected")
            return bool(_dbus_to_native(value))
    except Exception as exc:
        logger.error(
            "Failed to read Connected property for %s: %s", device_path, exc
        )
        return None


def _verify_connected_state(
    mac_address: str, device_path: str, expect_connected: bool
) -> bool:
    """Check if device connection state matches expectation using live D-Bus property reads."""

    max_attempts = 3
    base_delay = 0.2  # 200ms base delay
    
    for attempt in range(max_attempts):
        connected = _read_connected_property(device_path)
        if connected is None:
            logger.debug(
                "Attempt %d/%d: Failed to read Connected property for %s, falling back to snapshot",
                attempt + 1, max_attempts, mac_address
            )
            if attempt < max_attempts - 1:  # Don't sleep on last attempt
                time.sleep(base_delay * (2 ** attempt))  # Exponential backoff
            continue
            
        # Successfully read property
        state_matches = connected if expect_connected else not connected
        if state_matches:
            logger.debug(
                "Attempt %d/%d: Verified %s state for %s (connected=%s)",
                attempt + 1, max_attempts,
                "connected" if expect_connected else "disconnected",
                mac_address, connected
            )
            return True
        else:
            logger.debug(
                "Attempt %d/%d: State mismatch for %s - expected %s, got connected=%s",
                attempt + 1, max_attempts, mac_address,
                "connected" if expect_connected else "disconnected", connected
            )
            
        # If state doesn't match and we have more attempts, wait and retry
        if attempt < max_attempts - 1:
            time.sleep(base_delay * (2 ** attempt))
    
    # All attempts failed, fall back to snapshot check as last resort
    logger.debug(
        "All property read attempts failed for %s, falling back to snapshot check",
        mac_address
    )
    try:
        connected = check_device_connected(mac_address)
        return connected if expect_connected else not connected
    except Exception as exc:  # pragma: no cover - defensive fallback
        logger.error("Snapshot check failed for %s: %s", mac_address, exc)
        return False


def _record_probe_failure(mac_address: str) -> None:
    failures = _failed_connection_attempts.get(mac_address, 0) + 1
    _failed_connection_attempts[mac_address] = failures
    if failures <= 0:
        return
    backoff = min(
        PROBE_BACKOFF_BASE_SECONDS * (2 ** (failures - 1)),
        PROBE_BACKOFF_MAX_SECONDS,
    )
    _next_probe_allowed_at[mac_address] = time.monotonic() + backoff
    logger.debug(
        "Backoff scheduled for %s: failures=%d, next_attempt_in=%.1fs",
        mac_address,
        failures,
        backoff,
    )


def _reset_probe_failure(mac_address: str) -> None:
    if mac_address in _failed_connection_attempts:
        del _failed_connection_attempts[mac_address]
    if mac_address in _next_probe_allowed_at:
        del _next_probe_allowed_at[mac_address]


def connect_device(mac_address: str, snapshot: dict[str, dict] | None = None, timeout: int = CONNECT_TIMEOUT_SECONDS) -> bool:
    """
    Attempt to connect to a Bluetooth device.

    Args:
        mac_address: The MAC address of the device to connect to
        snapshot: Optional device snapshot to use
        timeout: Connection timeout in seconds (default: CONNECT_TIMEOUT_SECONDS)

    Returns:
        True if connected successfully, False otherwise
    """
    snapshot = snapshot or get_device_snapshot()
    if not is_device_trusted(mac_address, snapshot):
        logger.info(f"Device {mac_address} not trusted, trusting now...")
        trust_device(mac_address, snapshot)

    device_path = _get_device_path(mac_address, snapshot)
    if not device_path:
        logger.debug(f"Device {mac_address} not found for connect")
        return False

    start = time.monotonic()
    logger.info("Connecting to %s via DBus...", mac_address)

    # Calculate hard timeout based on the connection timeout
    hard_timeout = timeout + CONNECT_TIMEOUT_BUFFER_SECONDS
    if timeout == PROBE_CONNECT_TIMEOUT_SECONDS:
        hard_timeout = HARD_PROBE_CONNECT_TIMEOUT_SECONDS

    dbus_success, dbus_error = _invoke_with_hard_timeout(
        lambda: _dbus_device_method(device_path, "Connect", timeout),
        mac_address,
        "connect",
        hard_timeout,
    )

    fallback_error = None
    path_used = "dbus"
    if not dbus_success:
        logger.warning(
            "DBus connect failed for %s: %s; attempting bluetoothctl fallback",
            mac_address,
            dbus_error,
        )
        path_used = "bluetoothctl"
        bt_success, fallback_error = _run_bluetoothctl_operation(
            "connect", mac_address, hard_timeout
        )
        if not bt_success:
            logger.warning(
                "bluetoothctl connect failed for %s: %s", mac_address, fallback_error
            )

    verified = _verify_connected_state(mac_address, device_path, expect_connected=True)
    duration = time.monotonic() - start

    if verified:
        logger.info(
            "Successfully connected to %s (path=%s duration=%.2fs timeout=%ds dbus_error=%s, fallback_error=%s)",
            mac_address,
            path_used,
            duration,
            timeout,
            dbus_error,
            fallback_error,
        )
        _reset_probe_failure(mac_address)
        return True

    logger.warning(
        "Device %s not connected after attempt (path=%s duration=%.2fs timeout=%ds dbus_error=%s, fallback_error=%s)",
        mac_address,
        path_used,
        duration,
        timeout,
        dbus_error,
        fallback_error,
    )
    _record_probe_failure(mac_address)
    return False


def disconnect_device(mac_address: str, snapshot: dict[str, dict] | None = None) -> bool:
    """
    Disconnect from a Bluetooth device.

    Args:
        mac_address: The MAC address of the device to disconnect

    Returns:
        True if disconnected successfully, False otherwise
    """
    device_path = _get_device_path(mac_address, snapshot)
    if not device_path:
        logger.debug(f"Device {mac_address} not found for disconnect")
        return False

    start = time.monotonic()
    logger.info("Disconnecting from %s via DBus...", mac_address)

    dbus_success, dbus_error = _invoke_with_hard_timeout(
        lambda: _dbus_device_method(device_path, "Disconnect"),
        mac_address,
        "disconnect",
    )

    fallback_error = None
    path_used = "dbus"
    if not dbus_success:
        logger.warning(
            "DBus disconnect failed for %s: %s; attempting bluetoothctl fallback",
            mac_address,
            dbus_error,
        )
        path_used = "bluetoothctl"
        bt_success, fallback_error = _run_bluetoothctl_operation(
            "disconnect", mac_address
        )
        if not bt_success:
            logger.warning(
                "bluetoothctl disconnect failed for %s: %s",
                mac_address,
                fallback_error,
            )

    verified = _verify_connected_state(mac_address, device_path, expect_connected=False)
    duration = time.monotonic() - start

    if verified:
        logger.info(
            "Successfully disconnected from %s (path=%s duration=%.2fs dbus_error=%s, fallback_error=%s)",
            mac_address,
            path_used,
            duration,
            dbus_error,
            fallback_error,
        )
        return True

    logger.warning(
        "Device %s still connected after disconnect attempt (path=%s duration=%.2fs dbus_error=%s, fallback_error=%s)",
        mac_address,
        path_used,
        duration,
        dbus_error,
        fallback_error,
    )
    return False


def remove_device(mac_address: str, snapshot: dict[str, dict] | None = None) -> bool:
    """Remove a device from the Bluetooth adapter's paired devices list.

    Args:
        mac_address: The MAC address of the device to remove

    Returns:
        True if the device was successfully removed, False otherwise
    """
    try:
        snapshot = snapshot or get_device_snapshot()
        device_path = _get_device_path(mac_address, snapshot)
        if not device_path:
            logger.warning(f"Device {mac_address} not found for removal")
            return False
        managed_objects = _get_managed_objects()
        adapter_path = _get_adapter_path(managed_objects)
        if not adapter_path:
            logger.warning("No Bluetooth adapter found for removal")
            return False
        bus = _get_system_bus()
        adapter = dbus.Interface(bus.get_object(BLUEZ_SERVICE, adapter_path), ADAPTER_INTERFACE)
        adapter.RemoveDevice(device_path)
        logger.info(f"Successfully removed device {mac_address}")
        return True
    except Exception as e:
        logger.error(f"Error removing device {mac_address}: {e}")
        return False


def get_paired_devices(snapshot: dict[str, dict] | None = None) -> list[str]:
    """
    Get list of all paired Bluetooth device MAC addresses.

    Returns:
        List of MAC addresses of paired devices
    """
    paired_devices: list[str] = []
    snapshot = snapshot or get_device_snapshot()
    for mac_address, info in snapshot.items():
        if info.get("paired"):
            paired_devices.append(mac_address)
    return paired_devices


def _can_attempt_reconnection(mac_address: str) -> bool:
    """
    Check if we can attempt reconnection to a device based on cooldown.

    Args:
        mac_address: The MAC address of the device

    Returns:
        True if reconnection can be attempted, False if in cooldown
    """
    now = time.monotonic()
    with _connection_state_lock:
        # Cooldown window
        last_attempt = _last_connection_attempts.get(mac_address, 0)
        time_since_attempt = time.time() - last_attempt
        if time_since_attempt < RECONNECT_COOLDOWN:
            logger.debug(
                "Device %s in cooldown: %.1fs elapsed, need %ss",
                mac_address,
                time_since_attempt,
                RECONNECT_COOLDOWN,
            )
            return False

        # Backoff window (per-device failures)
        next_allowed = _next_probe_allowed_at.get(mac_address)
        if next_allowed and now < next_allowed:
            remaining = next_allowed - now
            logger.debug(
                "Device %s in backoff: next attempt in %.1fs",
                mac_address,
                remaining,
            )
            return False

        return True


def _record_connection_attempt(mac_address: str) -> None:
    """
    Record a connection attempt for cooldown tracking.

    Args:
        mac_address: The MAC address of the device
    """
    with _connection_state_lock:
        _last_connection_attempts[mac_address] = time.time()


def _cleanup_old_attempts() -> None:
    """
    Clean up old connection attempts that are outside the time window.
    """
    with _connection_state_lock:
        current_time = time.time()
        to_remove = []

        for mac_address, attempt_time in _last_connection_attempts.items():
            if current_time - attempt_time > RECENT_ATTEMPT_WINDOW:
                to_remove.append(mac_address)

        for mac_address in to_remove:
            del _last_connection_attempts[mac_address]

        if to_remove:
            logger.debug(f"Cleaned up {len(to_remove)} old connection attempt records")


def _pick_reconnect_candidates(candidates: set[str], max_count: int) -> list[str]:
    """
    Pick a fair subset of reconnection candidates based on last attempt time.

    Oldest (or never attempted) devices are tried first.
    """
    if max_count <= 0:
        return list(candidates)

    def last_attempt(mac: str) -> float:
        return _last_connection_attempts.get(mac, 0)

    return sorted(candidates, key=last_attempt)[:max_count]


def _probe_single_device(
    mac_address: str,
    disconnect_after: bool,
    snapshot: dict[str, dict] | None = None,
) -> tuple[str, bool]:
    """
    Helper function to probe a single device.
    
    Args:
        mac_address: The MAC address to probe.
        disconnect_after: Whether to disconnect after a successful connect.
        
    Returns:
        Tuple of (mac_address, success).
    """
    try:
        start = time.monotonic()
        logger.info("Probing device %s (disconnect_after=%s)", mac_address, disconnect_after)
        _record_connection_attempt(mac_address)
        success = connect_device(mac_address, snapshot, timeout=PROBE_CONNECT_TIMEOUT_SECONDS)
        if success and disconnect_after:
            disconnect_device(mac_address, snapshot)
        duration = time.monotonic() - start
        logger.info(
            "Probe result for %s: success=%s duration=%.2fs timeout=%ds",
            mac_address,
            success,
            duration,
            PROBE_CONNECT_TIMEOUT_SECONDS,
        )
        return (mac_address, success)
    except Exception as e:
        logger.error(f"Error probing device {mac_address}: {e}")
        return (mac_address, False)


def probe_devices(
    mac_addresses: list[str],
    disconnect_after: bool = True,
    connected_macs: set[str] | None = None,
    snapshot: dict[str, dict] | None = None,
    time_budget_seconds: float | None = None,
) -> dict[str, bool]:
    """
    Probe devices by attempting a connect and optional disconnect.

    Probes devices serially to avoid multi-threaded D-Bus access.
    
    PERFORMANCE OPTIMIZATION: Uses PROBE_CONNECT_TIMEOUT_SECONDS (5s) instead of 
    CONNECT_TIMEOUT_SECONDS (10s) to double throughput for missing devices.

    Args:
        mac_addresses: List of MAC addresses to probe.
        disconnect_after: Whether to disconnect after a successful connect.

    Returns:
        Dictionary mapping MAC address to connection result.
    """
    results: dict[str, bool] = {}
    
    if not mac_addresses:
        return results

    candidate_set = {mac.upper() for mac in mac_addresses}
    if connected_macs:
        candidate_set -= {mac.upper() for mac in connected_macs}

    if not candidate_set:
        return results

    max_candidates = MAX_RECONNECT_PER_CYCLE if MAX_RECONNECT_PER_CYCLE > 0 else 0
    ordered_candidates = _pick_reconnect_candidates(candidate_set, max_candidates)

    if not ordered_candidates:
        return results

    total_candidates = len(ordered_candidates)
    logger.info(
        "Probe planning: initial=%d filtered=%d time_budget=%s",
        len(mac_addresses),
        total_candidates,
        time_budget_seconds,
    )

    start_time = time.monotonic()
    for mac_address in ordered_candidates:
        if time_budget_seconds is not None:
            if time.monotonic() - start_time >= time_budget_seconds:
                logger.info("Probe time budget exceeded; stopping probe cycle")
                break
        if not _can_attempt_reconnection(mac_address):
            continue
        mac, success = _probe_single_device(mac_address, disconnect_after, snapshot)
        results[mac] = success

    spent = time.monotonic() - start_time
    logger.info(
        "Probe summary: attempted=%d success=%d duration=%.2fs",
        len(results),
        sum(1 for ok in results.values() if ok),
        spent,
    )
    return results


def scan_for_devices_in_range() -> set[str]:
    """Return devices that are connected or have recent RSSI/TxPower."""
    devices_in_range: set[str] = set()
    snapshot = get_device_snapshot()
    now = time.time()
    rssi_fresh = _is_rssi_fresh(now)
    for mac_address, info in snapshot.items():
        if _device_has_presence_signal(info, rssi_fresh):
            devices_in_range.add(mac_address)
    logger.debug(f"Total devices in range: {len(devices_in_range)}")
    return devices_in_range


def get_devices_in_range(snapshot: dict[str, dict], now: float | None = None) -> set[str]:
    """Return devices that are connected or have fresh RSSI/TxPower in a snapshot."""
    now = now or time.time()
    rssi_fresh = _is_rssi_fresh(now)
    return {mac for mac, info in snapshot.items() if _device_has_presence_signal(info, rssi_fresh)}


def _reconnect_single_device(
    mac_address: str,
    disconnect_after_success: bool,
    snapshot: dict[str, dict] | None = None,
) -> tuple[str, bool] | None:
    """
    Helper function to reconnect a single device.
    
    This function handles the cooldown check, connection attempt recording,
    and actual connection/disconnection logic for a single device.
    
    Args:
        mac_address: The MAC address to reconnect.
        disconnect_after_success: Whether to disconnect after a successful connection.
        
    Returns:
        Tuple of (mac_address, success) if a connection attempt was made, otherwise None.
    """
    # Check cooldown - this is thread-safe due to the lock in _can_attempt_reconnection
    if not _can_attempt_reconnection(mac_address):
        logger.debug(f"Skipping {mac_address} - in cooldown")
        return None

    # Record attempt before trying - thread-safe due to the lock in _record_connection_attempt
    _record_connection_attempt(mac_address)

    try:
        logger.info(f"Attempting auto-reconnection to: {mac_address}")

        # Attempt connection with probe timeout for faster throughput
        success = connect_device(mac_address, snapshot, timeout=PROBE_CONNECT_TIMEOUT_SECONDS)

        if success:
            logger.info(f"✓ Successfully auto-reconnected to: {mac_address}")
            if disconnect_after_success:
                disconnect_device(mac_address, snapshot)
        else:
            logger.warning(f"✗ Failed to auto-reconnect to: {mac_address}")

        return (mac_address, success)
    except Exception as e:
        logger.error(f"Error during auto-reconnection to {mac_address}: {e}")
        return (mac_address, False)


def auto_reconnect_paired_devices(
    whitelist_macs: set[str] | None = None,
    registered_macs: set[str] | None = None,
    disconnect_after_success: bool | None = None,
) -> dict[str, bool]:
    """
    Automatically reconnect to paired devices that are detected in range.

    This function:
    1. Gets the list of paired devices
    2. Scans for devices currently in range
    3. For paired devices in range that are not connected, attempts reconnection serially
    4. Respects cooldown periods to avoid spamming connection attempts
    5. Tracks connection attempts and logs success/failure
    
    PERFORMANCE OPTIMIZATION: Uses PROBE_CONNECT_TIMEOUT_SECONDS (5s) instead of 
    CONNECT_TIMEOUT_SECONDS (10s) to double throughput for missing devices.

    Args:
        whitelist_macs: Optional set of MAC addresses to limit reconnection attempts to.
                       If provided, only devices in this set will be candidates.
        registered_macs: Optional set of MAC addresses that are registered upstream.
                        If provided, only these devices will be candidates.
        disconnect_after_success: If True, disconnect after a successful connection
                                  to free connection slots.

    Returns:
        Dictionary mapping MAC addresses to connection results (True=success, False=failed)
    """
    results: dict[str, bool] = {}
    if disconnect_after_success is None:
        disconnect_after_success = DISCONNECT_AFTER_SUCCESS

    try:
        logger.info("=== Starting auto-reconnection cycle ===")

        # Clean up old attempt records periodically
        _cleanup_old_attempts()

        # Get currently connected devices
        snapshot = get_device_snapshot()
        connected_devices = get_all_connected_devices(snapshot)
        connected_set = set(connected_devices)
        logger.info(f"Currently connected: {len(connected_set)} device(s)")

        # Get paired devices
        paired_devices = get_paired_devices(snapshot)
        paired_set = set(paired_devices)
        logger.info(f"Paired devices: {len(paired_set)} device(s)")

        # Get devices in range
        devices_in_range = get_devices_in_range(snapshot)
        logger.info(f"Devices in range: {len(devices_in_range)} device(s)")

        if not devices_in_range and ALLOW_PAIRED_PROBE_ON_EMPTY_SCAN:
            logger.info("No devices detected in range; probing paired devices instead")
            devices_in_range = paired_set

        # Find paired devices that are in range but not connected
        devices_to_connect = (paired_set & devices_in_range) - connected_set

        # Apply whitelist if provided
        if whitelist_macs is not None:
            logger.debug(f"Applying whitelist: {len(whitelist_macs)} allowed device(s)")
            original_count = len(devices_to_connect)
            devices_to_connect = devices_to_connect & whitelist_macs
            logger.debug(f"Filtered candidates from {original_count} to {len(devices_to_connect)}")

        # Apply registered device filter if provided
        if registered_macs is not None:
            logger.debug(
                f"Applying registered filter: {len(registered_macs)} allowed device(s)"
            )
            original_count = len(devices_to_connect)
            devices_to_connect = devices_to_connect & registered_macs
            logger.debug(
                f"Filtered candidates from {original_count} to {len(devices_to_connect)}"
            )

        if not devices_to_connect:
            logger.info("No paired devices in range that need connection after filtering")
            return results

        max_candidates = MAX_RECONNECT_PER_CYCLE if MAX_RECONNECT_PER_CYCLE > 0 else 0
        ordered_candidates = _pick_reconnect_candidates(devices_to_connect, max_candidates)

        if not ordered_candidates:
            logger.info("No devices available for auto-reconnection after filtering")
            return results

        logger.info(f"Attempting to connect to {len(ordered_candidates)} device(s)")

        for mac_address in ordered_candidates:
            attempt = _reconnect_single_device(
                mac_address, disconnect_after_success, snapshot
            )
            if attempt is None:
                continue
            _, success = attempt
            results[mac_address] = success

        logger.info("=== Auto-reconnection cycle complete ===")
        return results

    except Exception as e:
        logger.error(f"Error during auto-reconnection: {e}")
        return results


def get_reconnection_status() -> dict[str, dict[str, any]]:
    """
    Get the current status of reconnection attempts.

    Returns:
        Dictionary with information about recent connection attempts
    """
    with _connection_state_lock:
        current_time = time.time()
        status = {}

        for mac_address, attempt_time in _last_connection_attempts.items():
            time_since = current_time - attempt_time
            status[mac_address] = {
                "last_attempt": datetime.fromtimestamp(attempt_time).isoformat(),
                "seconds_ago": round(time_since, 1),
                "in_cooldown": time_since < RECONNECT_COOLDOWN,
            }

        return status
