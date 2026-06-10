from presence_tracker.bluetooth import (
    CommandOutput,
    command_output_indicates_connect_success,
    command_output_indicates_remove_success,
    has_audio_uuid,
    is_valid_mac,
    normalize_mac,
    path_to_mac,
)
from presence_tracker.config import DEFAULT_AUDIO_UUIDS


def test_mac_helpers() -> None:
    assert normalize_mac(" aa:bb:cc:dd:ee:ff ") == "AA:BB:CC:DD:EE:FF"
    assert is_valid_mac("AA:BB:CC:DD:EE:FF")
    assert not is_valid_mac("AA:BB:CC:DD:EE")
    assert path_to_mac("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF") == "AA:BB:CC:DD:EE:FF"


def test_audio_uuid_detection() -> None:
    blocked = set(DEFAULT_AUDIO_UUIDS)
    assert has_audio_uuid(["0000110b-0000-1000-8000-00805F9B34FB"], blocked)
    assert not has_audio_uuid(["0000180f-0000-1000-8000-00805f9b34fb"], blocked)


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
