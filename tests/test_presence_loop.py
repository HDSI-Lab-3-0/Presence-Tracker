import asyncio
import time

from presence_tracker.config import Config
from presence_tracker.convex_client import BluetoothRemovalRequest, DeviceRecord
from presence_tracker.presence_loop import PresenceLoop


class FakeConvex:
    def __init__(self, devices=None, removals=None) -> None:
        self.devices = devices or []
        self.removals = removals or []
        self.pending = []
        self.acks = []
        self.statuses = []

    async def get_devices(self):
        return self.devices

    async def get_bluetooth_removal_requests(self):
        return self.removals

    async def register_pending_device(self, mac, name=None, source=None):
        self.pending.append((mac, name, source))

    async def acknowledge_bluetooth_removal_request(self, request_id, mac):
        self.acks.append((request_id, mac))

    async def update_device_status(self, mac, status):
        self.statuses.append((mac, status))


class FakeBluetooth:
    def __init__(self, connected=None, probes=None) -> None:
        self.connected = set(connected or [])
        self.probes = probes or {}
        self.removed = []

    async def get_connected_devices(self):
        return self.connected

    async def begin_probe_batch(self):
        pass

    async def end_probe_batch(self):
        pass

    async def probe_device(self, mac):
        return self.probes.get(mac, False)

    async def probe_device_passive(self, mac):
        return self.probes.get(mac, False)

    async def probe_device_connect(self, mac):
        return self.probes.get(mac, False)

    async def remove_device(self, mac):
        self.removed.append(mac)
        return True


def run(coro):
    return asyncio.run(coro)


def test_unknown_connected_device_registers_pending(tmp_path) -> None:
    config = Config.from_dict({"paths": {"state_file": str(tmp_path / "state.json")}})
    config.normalize()
    convex = FakeConvex(devices=[])
    bluetooth = FakeBluetooth(connected={"AA:BB:CC:DD:EE:FF"})
    loop = PresenceLoop(config, convex, bluetooth)

    run(loop.run_cycle())

    assert convex.pending == [("AA:BB:CC:DD:EE:FF", None, None)]


def test_present_ttl_holds_status_after_probe_misses(tmp_path) -> None:
    config = Config.from_dict(
        {
            "presence": {"absent_threshold": 1, "present_ttl_seconds": 300},
            "paths": {"state_file": str(tmp_path / "state.json")},
        }
    )
    config.normalize()
    device = DeviceRecord(
        None,
        "AA:BB:CC:DD:EE:FF",
        "present",
        False,
        last_seen=int(time.time() * 1000),
    )
    convex = FakeConvex(devices=[device])
    bluetooth = FakeBluetooth()
    loop = PresenceLoop(config, convex, bluetooth)

    run(loop.run_cycle())
    run(loop.run_cycle())

    assert convex.statuses == []


def test_connected_device_marks_present_immediately(tmp_path) -> None:
    # An active OS-level connection is the strongest signal and must not be
    # held back by present_threshold debouncing meant for weak probes.
    config = Config.from_dict(
        {
            "presence": {"present_threshold": 3},
            "paths": {"state_file": str(tmp_path / "state.json")},
        }
    )
    config.normalize()
    device = DeviceRecord(None, "AA:BB:CC:DD:EE:FF", "absent", False, last_seen=None)
    convex = FakeConvex(devices=[device])
    bluetooth = FakeBluetooth(connected={"AA:BB:CC:DD:EE:FF"})
    loop = PresenceLoop(config, convex, bluetooth)

    run(loop.run_cycle())

    assert convex.statuses == [("AA:BB:CC:DD:EE:FF", "present")]


def test_present_device_gets_touched_when_still_seen(tmp_path) -> None:
    config = Config.from_dict({"paths": {"state_file": str(tmp_path / "state.json")}})
    config.normalize()
    device = DeviceRecord(None, "AA:BB:CC:DD:EE:FF", "present", False, last_seen=int(time.time() * 1000))
    convex = FakeConvex(devices=[device])
    bluetooth = FakeBluetooth(probes={"AA:BB:CC:DD:EE:FF": True})
    loop = PresenceLoop(config, convex, bluetooth)

    run(loop.run_cycle())

    assert convex.statuses == [("AA:BB:CC:DD:EE:FF", "present")]


def test_absent_threshold_debounces_checkout(tmp_path) -> None:
    config = Config.from_dict(
        {
            "presence": {"absent_threshold": 2},
            "paths": {"state_file": str(tmp_path / "state.json")},
        }
    )
    config.normalize()
    device = DeviceRecord(None, "AA:BB:CC:DD:EE:FF", "present", False, last_seen=None)
    convex = FakeConvex(devices=[device])
    bluetooth = FakeBluetooth()
    loop = PresenceLoop(config, convex, bluetooth)

    run(loop.run_cycle())
    assert convex.statuses == []
    run(loop.run_cycle())
    assert convex.statuses == [("AA:BB:CC:DD:EE:FF", "absent")]


def test_removal_request_removes_and_acknowledges(tmp_path) -> None:
    config = Config.from_dict({"paths": {"state_file": str(tmp_path / "state.json")}})
    config.normalize()
    convex = FakeConvex(
        devices=[],
        removals=[BluetoothRemovalRequest("req1", "aa:bb:cc:dd:ee:ff")],
    )
    bluetooth = FakeBluetooth()
    loop = PresenceLoop(config, convex, bluetooth)

    run(loop.process_bluetooth_removals())

    assert bluetooth.removed == ["AA:BB:CC:DD:EE:FF"]
    assert convex.acks == [("req1", "AA:BB:CC:DD:EE:FF")]
