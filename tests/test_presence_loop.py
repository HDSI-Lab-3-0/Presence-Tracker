import asyncio

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

    async def probe_device(self, mac):
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


def test_absent_threshold_debounces_checkout(tmp_path) -> None:
    config = Config.from_dict(
        {
            "presence": {"absent_threshold": 2},
            "paths": {"state_file": str(tmp_path / "state.json")},
        }
    )
    config.normalize()
    device = DeviceRecord(None, "AA:BB:CC:DD:EE:FF", "present", False)
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
