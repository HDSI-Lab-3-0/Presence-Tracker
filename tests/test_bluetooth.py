import asyncio

from dbus_next.errors import DBusError

from presence_tracker.bluetooth import (
    BlueZPresenceMonitor,
    CommandOutput,
    command_output_indicates_connect_success,
    command_output_indicates_remote_name_success,
    command_output_indicates_remove_success,
    dbus_error_matches,
    device_properties_indicate_passive_presence,
    has_audio_uuid,
    is_valid_mac,
    normalize_mac,
    path_to_mac,
)
from presence_tracker.config import DEFAULT_AUDIO_UUIDS, BluetoothConfig


def test_mac_helpers() -> None:
    assert normalize_mac(" aa:bb:cc:dd:ee:ff ") == "AA:BB:CC:DD:EE:FF"
    assert is_valid_mac("AA:BB:CC:DD:EE:FF")
    assert not is_valid_mac("AA:BB:CC:DD:EE")
    assert path_to_mac("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF") == "AA:BB:CC:DD:EE:FF"


def test_audio_uuid_detection() -> None:
    blocked = set(DEFAULT_AUDIO_UUIDS)
    assert has_audio_uuid(["0000110b-0000-1000-8000-00805F9B34FB"], blocked)
    assert not has_audio_uuid(["0000180f-0000-1000-8000-00805f9b34fb"], blocked)


def test_passive_presence_uses_discovery_properties() -> None:
    assert device_properties_indicate_passive_presence({"RSSI": -78})
    assert device_properties_indicate_passive_presence({"ManufacturerData": {117: b"abc"}})
    assert not device_properties_indicate_passive_presence({})


def test_passive_probe_ignores_stale_cached_properties() -> None:
    monitor = BlueZPresenceMonitor(BluetoothConfig(passive_presence_ttl_seconds=300))

    async def device_path(mac: str) -> str:
        return "/org/bluez/hci0/dev_FC_31_5D_72_AA_9C"

    async def get_device_properties(path: str) -> dict:
        return {
            "ManufacturerData": {76: b"\x10\x06y\x1eb\xacP\x9b"},
            "AdvertisingFlags": b"\x1a",
        }

    monitor.device_path = device_path
    monitor.get_device_properties = get_device_properties

    assert not asyncio.run(monitor.is_device_passively_present("FC:31:5D:72:AA:9C"))


def test_passive_presence_survives_routine_property_invalidation() -> None:
    # BlueZ invalidates RSSI as a side effect of stopping discovery every probe
    # cycle. A live advertisement must register presence, and a later event that
    # carries no fresh advertisement data must NOT erase a still-fresh sighting.
    monitor = BlueZPresenceMonitor(BluetoothConfig(passive_presence_ttl_seconds=180))
    monitor._record_property_change("AA:BB:CC:DD:EE:FF", {"RSSI": -55})
    monitor._record_property_change("AA:BB:CC:DD:EE:FF", {})

    assert asyncio.run(monitor.is_device_passively_present("AA:BB:CC:DD:EE:FF"))


def test_dbus_error_matches_name_and_text() -> None:
    # "Operation already in progress" is the human text; the error *name* is
    # org.bluez.Error.InProgress. start_discovery must tolerate this so an
    # already-scanning adapter does not crash the agent on startup.
    exc = DBusError("org.bluez.Error.InProgress", "Operation already in progress")
    assert dbus_error_matches(exc, "InProgress")
    assert dbus_error_matches(exc, "in progress")
    assert not dbus_error_matches(exc, "NotReady")


def test_connect_probe_rejects_failed_success_code() -> None:
    out = CommandOutput(
        code=0,
        stdout="Failed to connect: org.bluez.Error.Failed br-connection-page-timeout\n",
        stderr="",
    )
    assert not command_output_indicates_connect_success(out)


def test_remove_success_accepts_missing_device() -> None:
    out = CommandOutput(code=1, stdout="Device AA:BB:CC:DD:EE:FF not available", stderr="")
    assert command_output_indicates_remove_success(out)


def test_remove_rejects_controller_failure() -> None:
    out = CommandOutput(code=1, stdout="Failed to remove device: no default controller", stderr="")
    assert not command_output_indicates_remove_success(out)


def test_remote_name_probe_accepts_device_name() -> None:
    out = CommandOutput(code=0, stdout="Charlies iPhone\n", stderr="")
    assert command_output_indicates_remote_name_success(out)


def test_remote_name_probe_rejects_missing_tool() -> None:
    out = CommandOutput(code=-1, stdout="", stderr="[Errno 2] No such file or directory: 'hcitool'")
    assert not command_output_indicates_remote_name_success(out)


def test_remote_name_probe_rejects_timeout() -> None:
    out = CommandOutput(code=124, stdout="", stderr="timeout")
    assert not command_output_indicates_remote_name_success(out)


def test_probe_device_uses_remote_name_before_connect(monkeypatch) -> None:
    monitor = BlueZPresenceMonitor(BluetoothConfig())
    connect_called = False

    async def is_device_connected(mac: str) -> bool:
        return False

    async def is_device_passively_present(mac: str) -> bool:
        return False

    async def l2ping_device(mac: str, count: int, timeout_seconds: int) -> bool:
        return False

    async def remote_name_probe_device(mac: str, timeout_seconds: int) -> bool:
        return True

    async def connect_probe(mac: str) -> bool:
        nonlocal connect_called
        connect_called = True
        return False

    async def device_has_audio_services(mac: str) -> bool:
        return True

    monitor.is_device_connected = is_device_connected
    monitor.is_device_passively_present = is_device_passively_present
    monitor.connect_probe = connect_probe
    monitor.device_has_audio_services = device_has_audio_services
    monkeypatch.setattr("presence_tracker.bluetooth.l2ping_device", l2ping_device)
    monkeypatch.setattr("presence_tracker.bluetooth.remote_name_probe_device", remote_name_probe_device)

    assert asyncio.run(monitor.probe_device("74:F4:41:2E:2B:3A"))
    assert not connect_called


def test_probe_device_connects_audio_devices_for_presence(monkeypatch) -> None:
    monitor = BlueZPresenceMonitor(BluetoothConfig())
    disconnected = False

    async def is_device_connected(mac: str) -> bool:
        return False

    async def is_device_passively_present(mac: str) -> bool:
        return False

    async def l2ping_device(mac: str, count: int, timeout_seconds: int) -> bool:
        return False

    async def remote_name_probe_device(mac: str, timeout_seconds: int) -> bool:
        return False

    async def connect_probe(mac: str) -> bool:
        return True

    async def device_has_audio_services(mac: str) -> bool:
        return True

    async def disconnect_audio_capable_device(mac: str) -> None:
        nonlocal disconnected
        disconnected = True

    monitor.is_device_connected = is_device_connected
    monitor.is_device_passively_present = is_device_passively_present
    monitor.connect_probe = connect_probe
    monitor.device_has_audio_services = device_has_audio_services
    monitor.disconnect_audio_capable_device = disconnect_audio_capable_device
    monkeypatch.setattr("presence_tracker.bluetooth.l2ping_device", l2ping_device)
    monkeypatch.setattr("presence_tracker.bluetooth.remote_name_probe_device", remote_name_probe_device)

    assert asyncio.run(monitor.probe_device("F0:F5:64:4E:E5:05"))
    assert disconnected
