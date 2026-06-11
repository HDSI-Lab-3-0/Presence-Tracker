import asyncio

from presence_tracker.bluetooth import (
    BlueZPresenceMonitor,
    CommandOutput,
    command_output_indicates_connect_success,
    command_output_indicates_remote_name_success,
    command_output_indicates_remove_success,
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


def test_probe_device_uses_remote_name_before_audio_skip(monkeypatch) -> None:
    monitor = BlueZPresenceMonitor(BluetoothConfig())
    checked_audio = False

    async def is_device_connected(mac: str) -> bool:
        return False

    async def is_device_passively_present(mac: str) -> bool:
        return False

    async def l2ping_device(mac: str, count: int, timeout_seconds: int) -> bool:
        return False

    async def remote_name_probe_device(mac: str, timeout_seconds: int) -> bool:
        return True

    async def device_has_audio_services(mac: str) -> bool:
        nonlocal checked_audio
        checked_audio = True
        return True

    monitor.is_device_connected = is_device_connected
    monitor.is_device_passively_present = is_device_passively_present
    monitor.device_has_audio_services = device_has_audio_services
    monkeypatch.setattr("presence_tracker.bluetooth.l2ping_device", l2ping_device)
    monkeypatch.setattr("presence_tracker.bluetooth.remote_name_probe_device", remote_name_probe_device)

    assert asyncio.run(monitor.probe_device("74:F4:41:2E:2B:3A"))
    assert not checked_audio
