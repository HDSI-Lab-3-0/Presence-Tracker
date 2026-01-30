import os
import time
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime
from typing import Any, Callable, TypeVar
import convex
from dotenv import load_dotenv
import bluetooth_scanner
from concurrent.futures import ThreadPoolExecutor, TimeoutError

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        # Rotate log after ~100KB (approx 500 lines), keep 1 backup
        RotatingFileHandler("presence_tracker.log", maxBytes=100000, backupCount=1),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

# Get Convex deployment URL from environment
CONVEX_DEPLOYMENT_URL = os.getenv("CONVEX_DEPLOYMENT_URL")
CONVEX_SELF_HOSTED_URL = os.getenv("CONVEX_SELF_HOSTED_URL")
CONVEX_SELF_HOSTED_ADMIN_KEY = os.getenv("CONVEX_SELF_HOSTED_ADMIN_KEY")
DEPLOYMENT_URL = CONVEX_SELF_HOSTED_URL or CONVEX_DEPLOYMENT_URL

if not DEPLOYMENT_URL:
    raise ValueError(
        "CONVEX_DEPLOYMENT_URL or CONVEX_SELF_HOSTED_URL environment variable is not set. "
        "Please create a .env file with one of these variables."
    )

T = TypeVar("T")

# Convex client will be initialized lazily to avoid startup hangs
_convex_client: convex.ConvexClient | None = None
_convex_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="convex")


def get_convex_client() -> convex.ConvexClient:
    """Get or initialize the Convex client."""
    global _convex_client
    if _convex_client is None:
        logger.info("Initializing Convex client...")
        _convex_client = convex.ConvexClient(DEPLOYMENT_URL)
        if CONVEX_SELF_HOSTED_ADMIN_KEY:
            _convex_client.client.set_admin_auth(CONVEX_SELF_HOSTED_ADMIN_KEY)
        logger.info("Convex client initialized")
    return _convex_client

# Polling interval in seconds
POLLING_INTERVAL = 5

# Grace period for new device registration in seconds
GRACE_PERIOD_SECONDS = int(os.getenv("GRACE_PERIOD_SECONDS", "300"))

# Presence TTL for recently seen devices (seconds)
PRESENT_TTL_SECONDS = int(os.getenv("PRESENT_TTL_SECONDS", "120"))

# Grace period for newly registered devices to enter polling cycle (seconds)
# Ensures first-time registered devices are immediately tracked for connect/disconnect
NEWLY_REGISTERED_GRACE_PERIOD = int(os.getenv("NEWLY_REGISTERED_GRACE_PERIOD", "120"))

# First seen debounce window for registration (seconds)
FIRST_SEEN_DEBOUNCE_SECONDS = int(os.getenv("FIRST_SEEN_DEBOUNCE_SECONDS", "10"))

# Full probe interval (seconds): attempt connect+disconnect to each device
FULL_PROBE_ENABLED = os.getenv("FULL_PROBE_ENABLED", "true").lower() in (
    "1",
    "true",
    "yes",
)
FULL_PROBE_INTERVAL_SECONDS = int(os.getenv("FULL_PROBE_INTERVAL_SECONDS", "60"))
FULL_PROBE_DISCONNECT_AFTER = os.getenv("FULL_PROBE_DISCONNECT_AFTER", "true").lower() in (
    "1",
    "true",
    "yes",
)

# Time budget for probe work per cycle (seconds)
PROBE_TIME_BUDGET_SECONDS = float(os.getenv("PROBE_TIME_BUDGET_SECONDS", "8"))

# Discovery refresh interval (seconds): short scan window to refresh RSSI/TxPower
DISCOVERY_REFRESH_INTERVAL_SECONDS = int(
    os.getenv("DISCOVERY_REFRESH_INTERVAL_SECONDS", "20")
)



# Disconnect connected devices after each cycle to free connection slots
DISCONNECT_CONNECTED_AFTER_CYCLE = os.getenv("DISCONNECT_CONNECTED_AFTER_CYCLE", "false").lower() in (
    "1",
    "true",
    "yes",
)

# Track devices that failed to register, so we retry them
failed_registrations: set[str] = set()

# Track previous status of each device for deduplication
device_previous_status: dict[str, str] = {}

# Track devices seen recently to smooth presence when disconnecting after checks
recently_seen_devices: dict[str, float] = {}

# Track first seen timestamps for registration debouncing
device_first_seen: dict[str, float] = {}

# Track registration timeline for instrumentation
device_registration_timeline: dict[str, dict[str, float]] = {}

# Track when the last full probe ran
last_full_probe_time = 0.0

# Track when the last discovery refresh ran
last_discovery_refresh_time = 0.0

# Timeout for Convex queries in seconds
CONVEX_QUERY_TIMEOUT = 10
MAX_CONVEX_CONSECUTIVE_TIMEOUTS = int(
    os.getenv("MAX_CONVEX_CONSECUTIVE_TIMEOUTS", "3")
)
CONVEX_CIRCUIT_OPEN_SECONDS = float(os.getenv("CONVEX_CIRCUIT_OPEN_SECONDS", "30"))
_convex_consecutive_timeouts = 0
_convex_circuit_open_until = 0.0


def _submit_convex_call(fn: Callable[[], T], description: str) -> T | None:
    """Execute a Convex call on the shared executor with timeout + circuit breaker."""

    global _convex_consecutive_timeouts, _convex_circuit_open_until

    now = time.monotonic()
    if now < _convex_circuit_open_until:
        remaining = _convex_circuit_open_until - now
        logger.warning(
            "Skipping Convex %s because circuit breaker is open (%.1fs remaining)",
            description,
            remaining,
        )
        return None
    
    # Log circuit breaker close transition
    if _convex_consecutive_timeouts >= MAX_CONVEX_CONSECUTIVE_TIMEOUTS:
        logger.info("Convex circuit breaker CLOSED - resuming operations")

    future = _convex_executor.submit(fn)
    start = time.monotonic()
    try:
        result = future.result(timeout=CONVEX_QUERY_TIMEOUT)
        duration = time.monotonic() - start
        logger.info("Convex %s succeeded in %.2fs", description, duration)
        _convex_consecutive_timeouts = 0
        return result
    except TimeoutError:
        duration = time.monotonic() - start
        _convex_consecutive_timeouts += 1
        logger.error(
            "Convex %s timed out after %.2fs (%d/%d)",
            description,
            duration,
            _convex_consecutive_timeouts,
            MAX_CONVEX_CONSECUTIVE_TIMEOUTS,
        )
        if _convex_consecutive_timeouts >= MAX_CONVEX_CONSECUTIVE_TIMEOUTS:
            _convex_circuit_open_until = time.monotonic() + CONVEX_CIRCUIT_OPEN_SECONDS
            logger.error(
                "Convex circuit breaker OPEN for %.1fs after %d consecutive timeouts",
                CONVEX_CIRCUIT_OPEN_SECONDS,
                _convex_consecutive_timeouts,
            )
        return None
    except Exception as exc:
        duration = time.monotonic() - start
        logger.error("Convex %s failed after %.2fs: %s", description, duration, exc)
        _convex_consecutive_timeouts = 0
        return None


def shutdown_convex_executor(wait: bool = False) -> None:
    """Shut down the shared Convex executor."""

    _convex_executor.shutdown(wait=wait)


def get_known_devices() -> list[dict[str, Any]]:
    """
    Fetch all known devices from Convex using the getDevices function.
    Uses a thread executor to enforce timeout.

    Returns:
        List of device dictionaries with macAddress, name, status, and lastSeen fields
    """
    def _query() -> list[dict[str, Any]]:
        return get_convex_client().query("devices:getDevices")

    result = _submit_convex_call(_query, "getDevices")
    if result is None:
        return []
    logger.info("Retrieved %d devices from Convex", len(result))
    return result


def get_device_by_mac(mac_address: str) -> dict[str, Any] | None:
    """
    Find a device by MAC address in the Convex database.

    Args:
        mac_address: The MAC address to search for

    Returns:
        Device dictionary if found, None otherwise
    """
    try:
        devices = get_known_devices()
        for device in devices:
            if device.get("macAddress") == mac_address:
                return device
        return None
    except Exception as e:
        logger.error(f"Error finding device {mac_address}: {e}")
        return None


def register_new_device(mac_address: str, name: str | None = None) -> bool:
    """
    Register a new device in Convex with grace period.

    New devices are registered in pending state, giving them time to be
    properly named before being tracked for presence.

    Args:
        mac_address: The MAC address of the device
        name: Optional device name from Bluetooth scan

    Returns:
        True if registration was successful, False otherwise
    """
    def _mutation():
        return get_convex_client().mutation(
            "devices:registerPendingDevice",
            {
                "macAddress": mac_address,
                "name": name or "",
            },
        )

    # Record registration submitted time
    if mac_address not in device_registration_timeline:
        device_registration_timeline[mac_address] = {}
    device_registration_timeline[mac_address]["registration_submitted"] = time.time()
    
    logger.info("→ register_new_device called: mac=%s, name='%s'", mac_address, name)
    result = _submit_convex_call(_mutation, "registerPendingDevice")
    if result is None:
        logger.info("  Device %s will be retried on next polling cycle", mac_address)
        return False
    
    # Record registration completed time
    device_registration_timeline[mac_address]["registration_completed"] = time.time()
    
    logger.info(
        "✓ Registered new device %s (name='%s') in pending state",
        mac_address,
        name or "unknown",
    )
    return True


def cleanup_expired_devices(snapshot: dict[str, dict] | None = None) -> bool:
    """
    Clean up devices whose grace period has expired and are still pending.
    Also disconnects and removes the Bluetooth pairing for those devices.

    Returns:
        True if cleanup was successful, False otherwise
    """
    global failed_registrations
    
    def _action():
        return get_convex_client().action("devices:cleanupExpiredGracePeriods", {})

    result = _submit_convex_call(_action, "cleanupExpiredGracePeriods")
    if result is None:
        return False

    deleted_count = result.get("deletedCount", 0)
    deleted_macs = result.get("deletedMacs", [])

    if deleted_count > 0:
        logger.info("Cleaned up %d expired grace period(s)", deleted_count)

        # Disconnect and remove Bluetooth pairing for deleted devices
        for mac_address in deleted_macs:
            try:
                logger.info("Disconnecting and removing expired device: %s", mac_address)
                bluetooth_scanner.disconnect_device(mac_address, snapshot)
                bluetooth_scanner.remove_device(mac_address, snapshot)
                logger.info("Successfully removed Bluetooth pairing for: %s", mac_address)
                # Remove from failed registrations since device was cleaned up
                failed_registrations.discard(mac_address)
            except Exception as e:
                logger.error("Error removing Bluetooth device %s: %s", mac_address, e)
    else:
        logger.debug("No expired grace periods to clean up")

    return True


def cleanup_stale_bluetooth_pairings(
    convex_devices: list[dict[str, Any]] | None = None,
    snapshot: dict[str, dict] | None = None,
) -> None:
    """
    Remove Bluetooth pairings for devices that are no longer in the Convex database.
    Only runs during normal polling cycles, not at startup to avoid hangs.
    """
    try:
        # Get all paired devices from Bluetooth
        snapshot = snapshot or bluetooth_scanner.get_device_snapshot()
        paired_devices = bluetooth_scanner.get_paired_devices(snapshot)
        paired_set = set(paired_devices)
        logger.debug(f"Found {len(paired_set)} paired device(s) in Bluetooth")

        # Do not remove devices that are currently connected.
        connected_devices = bluetooth_scanner.get_all_connected_devices(snapshot)
        connected_set = set(connected_devices)
        if connected_set:
            logger.debug(f"Found {len(connected_set)} connected device(s) in Bluetooth")

        # Get all known devices from Convex (with timeout)
        convex_devices = convex_devices or get_known_devices()
        if not convex_devices:
            logger.debug("Skipping stale cleanup - no devices retrieved from Convex")
            return
            
        convex_macs = {device.get("macAddress") for device in convex_devices if device.get("macAddress")}
        logger.debug(f"Found {len(convex_macs)} device(s) in Convex database")

        # Find devices that are paired but not in Convex
        stale_devices = paired_set - convex_macs - connected_set

        if stale_devices:
            logger.info(f"Found {len(stale_devices)} stale Bluetooth pairing(s) to clean up")
            for mac_address in stale_devices:
                try:
                    bluetooth_scanner.remove_device(mac_address, snapshot)
                    logger.info(f"Removed stale Bluetooth pairing: {mac_address}")
                except Exception as e:
                    logger.error(f"Failed to remove stale pairing {mac_address}: {e}")
        else:
            logger.debug("No stale Bluetooth pairings found")
    except Exception as e:
        logger.error(f"Error during stale Bluetooth pairing cleanup: {e}")


def scan_all_connected_devices() -> list[str]:
    """
    Get all currently connected Bluetooth devices.

    Returns:
        List of MAC addresses of connected devices
    """
    return bluetooth_scanner.get_all_connected_devices()


def log_attendance(mac_address: str, name: str, status: str) -> bool:
    """
    Log attendance change to Convex using the logAttendance function.

    Args:
        mac_address: The MAC address of the device
        name: The display name of the device/user
        status: Either "present" or "absent"

    Returns:
        True if log was successful, False otherwise
    """
    def _mutation():
        return get_convex_client().mutation(
            "devices:logAttendance",
            {
                "userId": mac_address,
                "userName": name,
                "status": status,
                "deviceId": mac_address,
            },
        )

    result = _submit_convex_call(_mutation, "logAttendance")
    if result is None:
        logger.info("  Attendance logging will be retried on next polling cycle")
        return False
    logger.info("✓ Logged attendance: %s -> %s", name, status)
    return True


def update_device_status(
    mac_address: str,
    is_connected: bool,
    current_status: str | None = None,
    device_cache: dict[str, dict[str, Any]] | None = None,
) -> bool:
    """
    Update a device's status in Convex using the updateDeviceStatus function.
    Only logs attendance if the status has actually changed (deduplication).

    Args:
        mac_address: The MAC address of the device to update
        is_connected: True if the device is present (connected), False if absent

    Returns:
        True if the update was successful, False otherwise
    """
    def _mutation():
        return get_convex_client().mutation(
            "devices:updateDeviceStatus", {"macAddress": mac_address, "status": new_status}
        )

    new_status = "present" if is_connected else "absent"
    previous_status = (
        current_status if current_status is not None else device_previous_status.get(mac_address)
    )

    # Only update Convex when status changes
    if previous_status == new_status:
        logger.debug(
            "Status unchanged for %s: %s (skipping Convex update)",
            mac_address,
            new_status,
        )
        device_previous_status[mac_address] = new_status
        return True

    result = _submit_convex_call(_mutation, "updateDeviceStatus")
    if result is None:
        logger.info("  Status update for %s will be retried on next polling cycle", mac_address)
        return False

    logger.info("Updated device %s status to %s", mac_address, new_status)

    # Log attendance only for registered devices (not pending)
    device = device_cache.get(mac_address) if device_cache else get_device_by_mac(mac_address)
    if device and not device.get("pendingRegistration"):
        name = device.get("name", mac_address)
        if device.get("firstName") and device.get("lastName"):
            name = f"{device['firstName']} {device['lastName']}"
        log_attendance(mac_address, name, new_status)

    # Update previous status
    device_previous_status[mac_address] = new_status
    return True


def _should_register_device(mac_address: str, device_info: dict, now: float) -> bool:
    """
    Determine if a device should be registered based on presence signals and debouncing.
    
    Args:
        mac_address: Device MAC address
        device_info: Device snapshot information
        now: Current timestamp
        
    Returns:
        True if device should be registered, False otherwise
    """
    # Must be paired OR connected OR have trusted metadata
    if not (device_info.get("paired") or device_info.get("connected") or device_info.get("trusted")):
        return False
        
    # Check if we have a strong presence signal (connected OR fresh RSSI/TxPower)
    has_presence = (
        device_info.get("connected") or
        (device_info.get("rssi") is not None) or
        (device_info.get("tx_power") is not None)
    )
    
    if not has_presence:
        return False
        
    # Record first seen time
    if mac_address not in device_first_seen:
        device_first_seen[mac_address] = now
        # Record first observed in BlueZ snapshot
        if mac_address not in device_registration_timeline:
            device_registration_timeline[mac_address] = {}
        device_registration_timeline[mac_address]["first_observed"] = now
        logger.debug(
            "First observation of %s: paired=%s connected=%s rssi=%s tx_power=%s",
            mac_address,
            device_info.get("paired"),
            device_info.get("connected"),
            device_info.get("rssi"),
            device_info.get("tx_power")
        )
        return False  # Need to see it again within debounce window
        
    # Check debounce window - must be seen twice within N seconds
    first_seen = device_first_seen[mac_address]
    if now - first_seen < FIRST_SEEN_DEBOUNCE_SECONDS:
        return False
        
    return True


def _find_registration_candidates(snapshot: dict[str, dict], connected_set: set[str], now: float) -> list[tuple[str, dict]]:
    """
    Find devices that should be registered as new devices.
    
    Args:
        snapshot: Current device snapshot
        connected_set: Set of connected device MACs
        now: Current timestamp
        
    Returns:
        List of (mac_address, device_info) tuples for registration candidates
    """
    candidates = []
    
    # Check devices in range (connected or with fresh signals)
    devices_in_range = bluetooth_scanner.get_devices_in_range(snapshot, now=now)
    
    for mac_address in devices_in_range:
        if mac_address in connected_set:
            continue  # Already handled by connected device registration
            
        device_info = snapshot.get(mac_address)
        if not device_info:
            continue
            
        if _should_register_device(mac_address, device_info, now):
            candidates.append((mac_address, device_info))
            # Record entered registration pipeline
            if mac_address not in device_registration_timeline:
                device_registration_timeline[mac_address] = {}
            device_registration_timeline[mac_address]["entered_pipeline"] = now
            
    return candidates


def check_and_update_devices() -> None:
    """
    Check the connection status of all devices and update Convex.

    - Registers new devices that connect as pending (with grace period)
    - Updates status for all known devices (named or pending)
    - Marks devices as absent when they disconnect
    - Cleans up expired pending devices at end of cycle
    """
    global failed_registrations
    global last_full_probe_time
    global last_discovery_refresh_time

    # Generate unique cycle ID for correlation
    cycle_id = f"cycle_{int(time.time() * 1000) % 100000}"
    cycle_start = time.monotonic()
    now = time.time()

    logger.info("=== %s: Starting device check cycle ===", cycle_id)

    discovery_duration = 0.0
    if now - last_discovery_refresh_time >= DISCOVERY_REFRESH_INTERVAL_SECONDS:
        logger.info(
            f"Refreshing discovery for {bluetooth_scanner.IN_RANGE_SCAN_SECONDS}s to update proximity data"
        )
        discovery_start = time.monotonic()
        bluetooth_scanner.refresh_discovery(bluetooth_scanner.IN_RANGE_SCAN_SECONDS)
        discovery_duration = time.monotonic() - discovery_start
        last_discovery_refresh_time = now

    snapshot_start = time.monotonic()
    snapshot = bluetooth_scanner.get_device_snapshot()
    snapshot_duration = time.monotonic() - snapshot_start
    connected_set = {
        mac for mac, info in snapshot.items() if info.get("connected")
    }

    convex_start = time.monotonic()
    devices = get_known_devices()
    convex_duration = time.monotonic() - convex_start
    devices_by_mac = {
        device.get("macAddress"): device
        for device in devices
        if device.get("macAddress")
    }

    if not devices:
        logger.warning("No devices found in Convex database")
    else:
        logger.info(f"Found {len(devices)} known device(s) in Convex")

    # FAST PRESENCE CHECK:
    # Use snapshot signals (Connected/RSSI/TxPower) to detect presence cheaply.
    registered_macs = {
        d.get("macAddress")
        for d in devices
        if d.get("macAddress") and not d.get("pendingRegistration")
    }

    reconnect_results: dict[str, bool] = {}
    reconnected_success: set[str] = set()

    devices_in_range = bluetooth_scanner.get_devices_in_range(snapshot, now=now)
    if devices_in_range:
        logger.info(f"Devices in range (snapshot): {len(devices_in_range)} device(s)")
    else:
        logger.debug("No devices in range reported by snapshot signals")

    # Track recently seen devices (connected or proximity signals)
    for mac in devices_in_range:
        recently_seen_devices[mac] = now
        # Record entered connected_set or devices_in_range
        if mac not in device_registration_timeline:
            device_registration_timeline[mac] = {}
        if mac in connected_set:
            device_registration_timeline[mac]["entered_connected_set"] = now
        else:
            device_registration_timeline[mac]["entered_devices_in_range"] = now

    # FULL PROBE (rare fallback): attempt reconnect for devices not seen recently
    probe_due = now - last_full_probe_time >= FULL_PROBE_INTERVAL_SECONDS
    probe_duration = 0.0
    probed_count = 0
    if registered_macs and FULL_PROBE_ENABLED and probe_due:
        stale_candidates = {
            mac
            for mac in registered_macs
            if mac not in devices_in_range
            and now - recently_seen_devices.get(mac, 0) > PRESENT_TTL_SECONDS
        }

        if stale_candidates:
            logger.info(
                "Running full probe for %d registered device(s) not seen recently (budget=%.1fs)",
                len(stale_candidates),
                PROBE_TIME_BUDGET_SECONDS,
            )
            probe_start = time.monotonic()
            reconnect_results = bluetooth_scanner.probe_devices(
                sorted(stale_candidates),
                disconnect_after=FULL_PROBE_DISCONNECT_AFTER,
                connected_macs=connected_set,
                snapshot=snapshot,
                time_budget_seconds=PROBE_TIME_BUDGET_SECONDS,
            )
            probe_duration = time.monotonic() - probe_start
            last_full_probe_time = now
            reconnected_success = {
                mac for mac, success in reconnect_results.items() if success
            }
            probed_count = len(reconnect_results)
        else:
            logger.debug("Full probe due but no stale devices require probing")

    # Track recently seen devices (connected or successfully probed)
    for mac in reconnected_success:
        recently_seen_devices[mac] = now

    # Add newly registered devices to present_set to ensure they enter polling cycle immediately
    # This fixes the bug where first-time registered devices are not properly tracked
    for device in devices:
        mac_address = device.get("macAddress")
        if not mac_address:
            continue
        connected_since = device.get("connectedSince")
        status = device.get("status")

        # If device was just registered (has recent connectedSince) and status is "present"
        # Always include it in present_set to add it to the polling cycle
        if (connected_since and
            status == "present" and
            now - (connected_since / 1000) <= NEWLY_REGISTERED_GRACE_PERIOD):
            recently_seen_devices[mac_address] = now
            logger.debug(
                f"Added newly registered device to present_set: {mac_address} "
                f"(connectedSince: {connected_since / 1000:.1f}s ago)"
            )

    present_set = {
        mac
        for mac, last_seen in recently_seen_devices.items()
        if now - last_seen <= PRESENT_TTL_SECONDS
    }
    # Prune expired entries
    for mac in list(recently_seen_devices):
        if mac not in present_set:
            del recently_seen_devices[mac]

    logger.info(f"Present devices (connected/recently seen): {len(present_set)} device(s)")

    updated_count = 0
    newly_registered_count = 0

    # NEW REGISTRATION LOGIC: Handle connected devices and in-range devices
    # First, handle connected devices (immediate registration)
    for mac_address in connected_set:
        device = devices_by_mac.get(mac_address)
        if device:
            failed_registrations.discard(mac_address)
            continue

        # New connected device - register immediately
        if mac_address in failed_registrations:
            logger.info(
                f"Retrying registration for previously failed device: {mac_address}"
            )

        device_name = bluetooth_scanner.get_device_name(mac_address, snapshot)
        logger.info(
            f"New CONNECTED device detected: {mac_address} ({device_name or 'unknown'}) - registering as pending"
        )
        if register_new_device(mac_address, device_name):
            newly_registered_count += 1
            failed_registrations.discard(mac_address)
        else:
            failed_registrations.add(mac_address)

    # Second, handle in-range but not connected devices (with debouncing)
    registration_candidates = _find_registration_candidates(snapshot, connected_set, now)
    for mac_address, device_info in registration_candidates:
        device = devices_by_mac.get(mac_address)
        if device:
            # Already known, clean up tracking
            device_first_seen.pop(mac_address, None)
            continue
            
        if mac_address in failed_registrations:
            logger.info(
                f"Retrying registration for previously failed in-range device: {mac_address}"
            )

        device_name = device_info.get("alias") or device_info.get("name")
        logger.info(
            f"New IN-RANGE device detected: {mac_address} ({device_name or 'unknown'}) - registering as pending"
        )
        if register_new_device(mac_address, device_name):
            newly_registered_count += 1
            failed_registrations.discard(mac_address)
            # Clean up first seen tracking after successful registration
            device_first_seen.pop(mac_address, None)
        else:
            failed_registrations.add(mac_address)

    # Update status for known devices based on presence set
    for device in devices:
        mac_address = device.get("macAddress")
        if not mac_address:
            continue

        name = device.get("name")
        current_status = device.get("status", "unknown")

        if name:
            display_name = name
        else:
            display_name = f"[pending] {mac_address}"

        is_present = mac_address in present_set
        new_status = "present" if is_present else "absent"



        if new_status != current_status:
            logger.info(
                f"Status changed for {display_name} ({mac_address}): "
                f"{current_status} -> {new_status}"
            )
            if update_device_status(
                mac_address,
                is_present,
                current_status,
                device_cache=devices_by_mac,
            ):
                updated_count += 1
        else:
            logger.debug(f"No status change for {display_name} ({mac_address}): {current_status}")
            device_previous_status[mac_address] = new_status

    # Optionally disconnect devices to avoid hitting adapter connection limits
    if DISCONNECT_CONNECTED_AFTER_CYCLE and connected_set:
        logger.info(f"Disconnecting {len(connected_set)} device(s) to free slots")
        for mac_address in connected_set:
            bluetooth_scanner.disconnect_device(mac_address, snapshot)

    # Clean up expired grace periods
    cleanup_expired_devices(snapshot)
    
    # Clean up stale Bluetooth pairings (every cycle)
    cleanup_stale_bluetooth_pairings(convex_devices=devices, snapshot=snapshot)

    total_duration = time.monotonic() - cycle_start
    stale_candidates_count = len({
        mac
        for mac in registered_macs
        if mac not in devices_in_range
        and now - recently_seen_devices.get(mac, 0) > PRESENT_TTL_SECONDS
    })
    
    # Structured summary logging
    logger.info(
        "=== %s: Cycle summary ==="
        " | connected_set: %d"
        " | devices_in_range: %d" 
        " | present_set: %d"
        " | stale_candidates: %d"
        " | probed_count: %d"
        " | updated_count: %d"
        " | newly_registered_count: %d"
        " | timing: snapshot=%.2fs discovery=%.2fs probe=%.2fs convex=%.2fs total=%.2fs",
        cycle_id,
        len(connected_set),
        len(devices_in_range),
        len(present_set),
        stale_candidates_count,
        probed_count,
        updated_count,
        newly_registered_count,
        snapshot_duration,
        discovery_duration,
        probe_duration,
        convex_duration,
        total_duration,
    )

    # Log registration timelines for any new registrations this cycle
    if newly_registered_count > 0:
        for mac, timeline in device_registration_timeline.items():
            if "registration_completed" in timeline and timeline["registration_completed"] > cycle_start:
                first_observed = timeline.get("first_observed", 0)
                entered_pipeline = timeline.get("entered_pipeline", 0)
                registration_submitted = timeline.get("registration_submitted", 0)
                registration_completed = timeline["registration_completed"]
                
                logger.info(
                    "🕐 %s: Registration timeline for %s: "
                    "first_observed=%.1fs ago, "
                    "entered_pipeline=%.1fs ago, "
                    "registration_submitted=%.1fs ago, "
                    "registration_completed=%.1fs ago, "
                    "total_latency=%.1fs",
                    cycle_id,
                    mac,
                    now - first_observed if first_observed > 0 else 0,
                    now - entered_pipeline if entered_pipeline > 0 else 0,
                    now - registration_submitted if registration_submitted > 0 else 0,
                    now - registration_completed,
                    registration_completed - first_observed if first_observed > 0 else 0
                )


def run_presence_tracker() -> None:
    """
    Main polling loop for the presence tracker.

    Runs continuously with a 5-second polling interval, checking device
    connection status and updating Convex as needed. Attendance is only
    logged when device status actually changes (deduplication).
    """
    logger.info("Starting Presence Tracker")
    logger.info(f"Polling interval: {POLLING_INTERVAL} seconds")
    logger.info(f"Grace period for new devices: {GRACE_PERIOD_SECONDS} seconds")
    logger.info(f"Presence TTL: {PRESENT_TTL_SECONDS} seconds")
    logger.info(f"Full probe enabled: {FULL_PROBE_ENABLED}")
    logger.info(f"Full probe interval: {FULL_PROBE_INTERVAL_SECONDS} seconds")
    logger.info(f"Full probe disconnect after: {FULL_PROBE_DISCONNECT_AFTER}")

    logger.info(f"Disconnect after cycle: {DISCONNECT_CONNECTED_AFTER_CYCLE}")
    logger.info(f"Convex query timeout: {CONVEX_QUERY_TIMEOUT} seconds")

    bluetooth_scanner.init_dbus()

    # Skip startup cleanup to avoid hanging on Convex connection
    # Stale Bluetooth pairings will be cleaned during polling cycles

    try:
        while True:
            logger.info("=" * 50)
            logger.info(f"Starting check cycle at {datetime.now().isoformat()}")

            try:
                check_and_update_devices()
            except Exception as e:
                logger.error(f"Error during check cycle: {e}")

            logger.info(f"Cycle complete. Next check in {POLLING_INTERVAL} seconds...")
            logger.info("=" * 50)

            time.sleep(POLLING_INTERVAL)

    except KeyboardInterrupt:
        logger.info("Presence tracker stopped by user")
    except Exception as e:
        logger.error(f"Fatal error in presence tracker: {e}")
        raise
    finally:
        # Clean shutdown of Convex executor
        logger.info("Shutting down Convex executor...")
        shutdown_convex_executor(wait=True)
        logger.info("Presence tracker shutdown complete")


def main() -> None:
    """Entry point for the presence tracker."""
    try:
        run_presence_tracker()
    except Exception as e:
        logger.critical(f"Presence tracker crashed: {e}")
        raise


if __name__ == "__main__":
    main()
