from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from dbus_next import BusType, Variant
from dbus_next.aio import MessageBus
from dbus_next.errors import DBusError
from dbus_next.service import ServiceInterface, method

from presence_tracker.config import BluetoothConfig
from presence_tracker.logging_utils import log_event

BLUEZ = "org.bluez"
BLUEZ_PATH = "/org/bluez"
OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager"
PROPERTIES = "org.freedesktop.DBus.Properties"
ADAPTER = "org.bluez.Adapter1"
DEVICE = "org.bluez.Device1"
AGENT_MANAGER = "org.bluez.AgentManager1"
AGENT = "org.bluez.Agent1"
AGENT_PATH = "/com/hdsi/presence_tracker/agent"

MAC_RE = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")


@dataclass(slots=True)
class CommandOutput:
    code: int
    stdout: str
    stderr: str


@dataclass(slots=True)
class PassiveSighting:
    seen_at: float
    rssi: int | None = None


class PresenceAgent(ServiceInterface):
    def __init__(self, audio_uuids: set[str]) -> None:
        super().__init__(AGENT)
        self.audio_uuids = audio_uuids

    @method()
    def Release(self) -> "":
        log_event("bluetooth_agent", "release", result="ok", message="BlueZ released agent")

    @method()
    def RequestPinCode(self, device: "o") -> "s":
        raise DBusError("org.bluez.Error.Rejected", "PIN pairing is not supported")

    @method()
    def DisplayPinCode(self, device: "o", pincode: "s") -> "":
        log_event("bluetooth_agent", "display_pin", result="ignored", message=str(device))

    @method()
    def RequestPasskey(self, device: "o") -> "u":
        raise DBusError("org.bluez.Error.Rejected", "Passkey pairing is not supported")

    @method()
    def DisplayPasskey(self, device: "o", passkey: "u", entered: "q") -> "":
        log_event("bluetooth_agent", "display_passkey", result="ignored", message=str(device))

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u") -> "":
        log_event("bluetooth_agent", "confirm_pairing", result="ok", message=str(device))

    @method()
    def RequestAuthorization(self, device: "o") -> "":
        log_event("bluetooth_agent", "authorize_pairing", result="ok", message=str(device))

    @method()
    def AuthorizeService(self, device: "o", uuid: "s") -> "":
        uuid_norm = uuid.lower()
        if uuid_norm in self.audio_uuids:
            log_event(
                "bluetooth_agent",
                "authorize_service",
                result="blocked_audio",
                message=f"device={device} uuid={uuid_norm}",
                level=logging.WARNING,
            )
            raise DBusError("org.bluez.Error.Rejected", "Bluetooth audio services are blocked")
        log_event("bluetooth_agent", "authorize_service", result="ok", message=f"uuid={uuid_norm}")

    @method()
    def Cancel(self) -> "":
        log_event("bluetooth_agent", "cancel", result="ok")


class BlueZPresenceMonitor:
    def __init__(self, config: BluetoothConfig) -> None:
        self.config = config
        self.audio_uuids = {uuid.strip().lower() for uuid in config.audio_block_uuids if uuid.strip()}
        self.bus: MessageBus | None = None
        self.adapter_path = ""
        self.agent = PresenceAgent(self.audio_uuids)
        self.seen_paired: set[str] = set()
        self.passive_seen_at: dict[str, PassiveSighting] = {}
        self.watched_device_paths: set[str] = set()
        self._connect_lock = asyncio.Lock()
        self._probe_batch_depth = 0
        self._probe_semaphore = asyncio.Semaphore(max(1, config.max_concurrent_probes))
        # HCI can only service one L2CAP ping at a time; parallel l2ping silently fails.
        self._l2ping_semaphore = asyncio.Semaphore(1)

    def seed_seen_paired(self, macs: set[str]) -> None:
        for mac in macs:
            if is_valid_mac(mac):
                self.seen_paired.add(normalize_mac(mac))

    async def connect(self) -> None:
        self.bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        await self.refresh_adapter_path()

    async def close(self) -> None:
        if not self.bus:
            return
        try:
            manager = await self._interface(BLUEZ, BLUEZ_PATH, AGENT_MANAGER)
            await manager.call_unregister_agent(AGENT_PATH)
        except Exception:
            pass
        self.bus.disconnect()

    async def refresh_adapter_path(self) -> None:
        objects = await self.get_managed_objects()
        adapter_paths = sorted(path for path, ifaces in objects.items() if ADAPTER in ifaces)
        if not adapter_paths:
            raise RuntimeError("No BlueZ adapter found")
        if self.config.adapter_name:
            candidate = f"/org/bluez/{self.config.adapter_name}"
            if candidate in adapter_paths:
                self.adapter_path = candidate
                return
        self.adapter_path = adapter_paths[0]

    async def register_agent(self) -> None:
        if not self.bus:
            raise RuntimeError("D-Bus is not connected")
        self.bus.export(AGENT_PATH, self.agent)
        manager = await self._interface(BLUEZ, BLUEZ_PATH, AGENT_MANAGER)
        try:
            await manager.call_register_agent(AGENT_PATH, "NoInputNoOutput")
        except DBusError as exc:
            if "AlreadyExists" not in str(exc):
                raise
        await manager.call_request_default_agent(AGENT_PATH)
        log_event("bluetooth_agent", "agent_started", result="ok", message="NoInputNoOutput agent registered")

    async def configure_adapter(self, alias: str) -> None:
        if not await self.ensure_adapter_ready():
            raise RuntimeError(f"Bluetooth adapter not ready: {self.adapter_path}")
        adapter_props = await self._interface(BLUEZ, self.adapter_path, PROPERTIES)
        await self._safe_set(adapter_props, ADAPTER, "Pairable", Variant("b", True))
        await self._safe_set(adapter_props, ADAPTER, "Discoverable", Variant("b", True))
        await self._safe_set(adapter_props, ADAPTER, "DiscoverableTimeout", Variant("u", 0))
        await self._safe_set(adapter_props, ADAPTER, "PairableTimeout", Variant("u", 0))
        if alias:
            await self._safe_set(adapter_props, ADAPTER, "Alias", Variant("s", alias))
        log_event("bluetooth", "configure_adapter", result="ok", message=self.adapter_path)

    async def ensure_adapter_ready(self, timeout_seconds: float = 30.0) -> bool:
        deadline = time.monotonic() + max(1.0, timeout_seconds)
        attempt = 0
        while time.monotonic() < deadline:
            attempt += 1
            if await self.is_adapter_powered():
                if attempt > 1:
                    log_event(
                        "bluetooth",
                        "adapter_ready",
                        result="ok",
                        message=f"{self.adapter_path} powered after {attempt} attempts",
                    )
                return True
            await unblock_bluetooth_rfkill(self.config.command_timeout_seconds)
            await power_on_adapter_cli(
                adapter_hci_name(self.adapter_path),
                self.config.command_timeout_seconds,
            )
            adapter_props = await self._interface(BLUEZ, self.adapter_path, PROPERTIES)
            try:
                await adapter_props.call_set(ADAPTER, "Powered", Variant("b", True))
            except Exception as exc:
                log_event(
                    "bluetooth",
                    "adapter_property",
                    result="retry",
                    message=f"Powered: {exc}",
                    level=logging.WARNING,
                )
            await asyncio.sleep(min(0.5 * attempt, 2.0))
        log_event(
            "bluetooth",
            "adapter_ready",
            result="failed",
            message=f"{self.adapter_path} still not powered after {timeout_seconds:.0f}s",
            level=logging.ERROR,
        )
        return False

    async def is_adapter_powered(self) -> bool:
        try:
            props = await self._interface(BLUEZ, self.adapter_path, PROPERTIES)
            return _variant_value(await props.call_get(ADAPTER, "Powered")) is True
        except Exception:
            return False

    async def is_discovering(self) -> bool:
        props = await self._interface(BLUEZ, self.adapter_path, PROPERTIES)
        return _variant_value(await props.call_get(ADAPTER, "Discovering")) is True

    async def start_discovery(self) -> None:
        if not await self.ensure_adapter_ready():
            log_event(
                "bluetooth",
                "start_discovery",
                result="failed",
                message="Adapter not powered; passive detection disabled",
                level=logging.WARNING,
            )
            return
        adapter = await self._interface(BLUEZ, self.adapter_path, ADAPTER)
        for attempt in range(5):
            try:
                await adapter.call_start_discovery()
                break
            except DBusError as exc:
                if dbus_error_matches(exc, "NotReady", "not ready", "resource not ready"):
                    log_event(
                        "bluetooth",
                        "start_discovery",
                        result="retry",
                        message=f"attempt={attempt + 1}: {exc}",
                        level=logging.WARNING,
                    )
                    await self.ensure_adapter_ready(timeout_seconds=5.0)
                    await asyncio.sleep(min(0.5 * (attempt + 1), 2.0))
                    continue
                if not dbus_error_matches(exc, "InProgress", "in progress"):
                    raise
                # "Already in progress" is only safe if the controller is *actually*
                # scanning. A crash loop can leave a stuck session where StartDiscovery
                # reports InProgress while Discovering stays false — passive detection
                # then silently never works. Verify, and force a stop/restart if stuck.
                if await self.is_discovering():
                    log_event("bluetooth", "start_discovery", result="already_active")
                    return
                log_event(
                    "bluetooth",
                    "start_discovery",
                    result="stuck",
                    message="InProgress reported but adapter not discovering; resetting",
                    level=logging.WARNING,
                )
                try:
                    await adapter.call_stop_discovery()
                except DBusError:
                    pass
                await asyncio.sleep(0.5)
                try:
                    await adapter.call_start_discovery()
                except DBusError as exc2:
                    if dbus_error_matches(exc2, "NotReady", "not ready", "resource not ready"):
                        await self.ensure_adapter_ready(timeout_seconds=5.0)
                        continue
                    if not dbus_error_matches(exc2, "InProgress", "in progress"):
                        raise
                break
        else:
            log_event(
                "bluetooth",
                "start_discovery",
                result="failed",
                message="Adapter not ready after retries; passive detection disabled",
                level=logging.WARNING,
            )
            return
        if await self.is_discovering():
            log_event("bluetooth", "start_discovery", result="ok")
        else:
            log_event(
                "bluetooth",
                "start_discovery",
                result="failed",
                message="Adapter not discovering after reset; passive detection disabled (controller may need an rfkill/HCI reset)",
                level=logging.WARNING,
            )

    async def stop_discovery(self) -> None:
        adapter = await self._interface(BLUEZ, self.adapter_path, ADAPTER)
        try:
            await adapter.call_stop_discovery()
        except DBusError as exc:
            if not dbus_error_matches(exc, "NotReady", "not ready"):
                log_event("bluetooth", "stop_discovery", result="ignored", message=str(exc))
        for _ in range(10):
            props = await self._interface(BLUEZ, self.adapter_path, PROPERTIES)
            discovering = _variant_value(await props.call_get(ADAPTER, "Discovering"))
            if discovering is not True:
                return
            await asyncio.sleep(0.1)

    async def get_connected_devices(self) -> set[str]:
        objects = await self.get_managed_objects()
        connected: set[str] = set()
        for path, ifaces in objects.items():
            device = ifaces.get(DEVICE)
            if not device:
                continue
            if _variant_value(device.get("Connected")) is True:
                mac = path_to_mac(path)
                if mac:
                    connected.add(mac)
        return connected

    async def get_paired_devices(self) -> dict[str, str]:
        objects = await self.get_managed_objects()
        paired: dict[str, str] = {}
        for path, ifaces in objects.items():
            device = ifaces.get(DEVICE)
            if not device:
                continue
            if _variant_value(device.get("Paired")) is True:
                mac = path_to_mac(path)
                if mac:
                    paired[mac] = path
        return paired

    async def get_device_name(self, mac: str) -> str | None:
        path = await self.device_path(mac)
        if not path:
            return None
        props = await self.get_device_properties(path)
        value = _variant_value(props.get("Name")) or _variant_value(props.get("Alias"))
        return str(value) if value else None

    async def is_device_connected(self, mac: str) -> bool:
        path = await self.device_path(mac)
        if not path:
            return False
        props = await self.get_device_properties(path)
        return _variant_value(props.get("Connected")) is True

    async def device_has_audio_services(self, mac: str) -> bool:
        path = await self.device_path(mac)
        if not path:
            return False
        props = await self.get_device_properties(path)
        uuids = _variant_value(props.get("UUIDs")) or []
        return has_audio_uuid([str(uuid) for uuid in uuids], self.audio_uuids)

    async def trust_device(self, mac: str) -> bool:
        path = await self.device_path(mac)
        if not path:
            return False
        try:
            props = await self._interface(BLUEZ, path, PROPERTIES)
            await props.call_set(DEVICE, "Trusted", Variant("b", True))
            return True
        except Exception as exc:
            log_event("bluetooth", "trust", mac=mac, result="error", message=str(exc), level=logging.WARNING)
            return False

    async def remove_device(self, mac: str) -> bool:
        if not is_valid_mac(mac):
            return False
        mac = normalize_mac(mac)
        path = await self.device_path(mac)
        if not path:
            return await self.remove_device_fallback(mac)
        try:
            adapter = await self._interface(BLUEZ, self.adapter_path, ADAPTER)
            await adapter.call_remove_device(path)
            return True
        except DBusError as exc:
            if any(text in str(exc).lower() for text in ("does not exist", "not available", "not found")):
                return True
            log_event("bluetooth", "remove", mac=mac, result="error", message=str(exc), level=logging.WARNING)
            return False

    async def remove_device_fallback(self, mac: str) -> bool:
        out = await run_command(
            "bluetoothctl",
            ["remove", normalize_mac(mac)],
            self.config.command_timeout_seconds,
        )
        return command_output_indicates_remove_success(out)

    async def probe_device_passive(self, mac: str) -> bool:
        if not is_valid_mac(mac):
            return False
        mac = normalize_mac(mac)
        if await self.is_device_connected(mac):
            return True
        if await self._l2ping_probe(mac):
            return True
        if await self.is_device_passively_present(mac):
            log_event("bluetooth", "passive_probe", mac=mac, result="seen")
            return True
        return False

    async def _l2ping_probe(self, mac: str) -> bool:
        async with self._l2ping_semaphore:
            for attempt in range(2):
                if await l2ping_device(
                    mac,
                    self.config.l2ping_count,
                    self.config.l2ping_timeout_seconds,
                ):
                    log_event("bluetooth", "l2ping_probe", mac=mac, result="seen")
                    return True
                if attempt == 0:
                    await asyncio.sleep(0.15)
        return False

    async def probe_device_connect(self, mac: str) -> bool:
        if not is_valid_mac(mac):
            return False
        mac = normalize_mac(mac)
        if await self.is_device_connected(mac):
            return True
        connected = await self.connect_probe(mac)
        if connected and await self.device_has_audio_services(mac):
            await self.disconnect_audio_capable_device(mac)
            log_event(
                "bluetooth",
                "connect_probe",
                mac=mac,
                result="seen_audio",
                message="Brief connect for presence; audio services remain blocked",
            )
            return True
        if connected:
            log_event("bluetooth", "connect_probe", mac=mac, result="seen")
            return True
        if await self.device_has_audio_services(mac):
            log_event("bluetooth", "connect_probe", mac=mac, result="failed_audio")
        else:
            log_event("bluetooth", "connect_probe", mac=mac, result="failed")
        return False

    async def probe_device(self, mac: str) -> bool:
        if await self.probe_device_passive(mac):
            return True
        return await self.probe_device_connect(mac)

    async def begin_probe_batch(self) -> None:
        async with self._connect_lock:
            if self._probe_batch_depth == 0:
                await self.stop_discovery()
                for mac in await self.get_connected_devices():
                    await self.disconnect_audio_capable_device(mac)
                await asyncio.sleep(0.3)
            self._probe_batch_depth += 1

    async def end_probe_batch(self) -> None:
        async with self._connect_lock:
            if self._probe_batch_depth == 0:
                return
            self._probe_batch_depth -= 1
            if self._probe_batch_depth == 0:
                await self.start_discovery()

    async def connect_probe(self, mac: str) -> bool:
        if self._probe_batch_depth > 0:
            async with self._probe_semaphore:
                return await self._connect_probe_inner(mac)
        async with self._connect_lock:
            await self.stop_discovery()
            try:
                return await self._connect_probe_inner(mac)
            finally:
                await self.start_discovery()

    async def _connect_probe_inner(self, mac: str) -> bool:
        last_error = ""
        attempts = max(1, self.config.connect_probe_attempts)
        for attempt in range(attempts):
            connected, error = await self._connect_probe_once(mac)
            if connected:
                return True
            last_error = error
            if attempt < attempts - 1:
                await asyncio.sleep(0.5)
        if last_error:
            log_event("bluetooth", "connect_probe", mac=mac, result="failed", message=last_error)
        return False

    async def _connect_probe_once(self, mac: str) -> tuple[bool, str]:
        mac = normalize_mac(mac)
        out = await run_command(
            "bluetoothctl",
            ["connect", mac],
            self.config.connect_probe_timeout_seconds,
        )
        deadline = time.monotonic() + self.config.connect_probe_timeout_seconds
        while time.monotonic() < deadline:
            if command_output_indicates_connect_success(out) or await self.is_device_connected(mac):
                return True, ""
            await asyncio.sleep(0.25)
        combined = f"{out.stdout}\n{out.stderr}".strip()
        return False, combined or f"exit={out.code}"

    async def monitor_new_pairings(
        self,
        register_pending: Callable[[str, str | None, str | None], Awaitable[None]],
    ) -> None:
        scheduled: set[str] = set()
        manager = await self._interface(BLUEZ, "/", OBJECT_MANAGER)

        def on_interfaces_added(path: str, interfaces: dict[str, dict[str, Any]]) -> None:
            device = interfaces.get(DEVICE)
            mac = path_to_mac(path)
            if not device or not mac or mac in scheduled:
                return
            if _variant_value(device.get("Paired")) is True:
                scheduled.add(mac)
                asyncio.create_task(self.handle_new_pairing(mac, register_pending))

        try:
            manager.on_interfaces_added(on_interfaces_added)
        except Exception as exc:
            log_event("bluetooth_agent", "event_listener", result="error", message=str(exc), level=logging.WARNING)

        while True:
            try:
                objects = await self.get_managed_objects()
                await self._watch_device_property_changes(objects)
                paired = self._paired_devices_from_objects(objects)
                for mac in sorted(set(paired) - self.seen_paired):
                    await self.handle_new_pairing(mac, register_pending)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log_event("bluetooth_agent", "pairing_monitor", result="error", message=str(exc), level=logging.WARNING)
            await asyncio.sleep(5)

    async def handle_new_pairing(
        self,
        mac: str,
        register_pending: Callable[[str, str | None, str | None], Awaitable[None]],
    ) -> None:
        if not is_valid_mac(mac):
            return
        mac = normalize_mac(mac)
        if mac in self.seen_paired:
            return
        self.seen_paired.add(mac)
        await self.trust_device(mac)
        name = await self.get_device_name(mac)
        await register_pending(mac, name, "pairing")
        if await self.device_has_audio_services(mac):
            await self.disconnect_audio_capable_device(mac)
            log_event("bluetooth_agent", "register_pending", mac=mac, result="ok_audio_blocked")
            return
        connected = await self.connect_probe(mac)
        log_event("bluetooth_agent", "device_connect_after_pair", mac=mac, result="ok" if connected else "failed")

    async def disconnect_audio_capable_device(self, mac: str) -> None:
        path = await self.device_path(mac)
        if not path:
            return
        try:
            device = await self._interface(BLUEZ, path, DEVICE)
            await asyncio.wait_for(device.call_disconnect(), timeout=self.config.command_timeout_seconds)
        except Exception:
            return

    async def device_path(self, mac: str) -> str | None:
        mac = normalize_mac(mac)
        objects = await self.get_managed_objects()
        suffix = mac.replace(":", "_")
        for path, ifaces in objects.items():
            if DEVICE in ifaces and path.endswith(f"/dev_{suffix}"):
                return path
        return None

    async def get_device_properties(self, path: str) -> dict[str, Any]:
        objects = await self.get_managed_objects()
        return dict(objects.get(path, {}).get(DEVICE, {}))

    async def get_managed_objects(self) -> dict[str, dict[str, dict[str, Any]]]:
        manager = await self._interface(BLUEZ, "/", OBJECT_MANAGER)
        return await manager.call_get_managed_objects()

    async def _watch_device_property_changes(self, objects: dict[str, dict[str, dict[str, Any]]]) -> None:
        for path, ifaces in objects.items():
            if DEVICE not in ifaces or path in self.watched_device_paths:
                continue
            mac = path_to_mac(path)
            if not mac:
                continue
            try:
                props = await self._interface(BLUEZ, path, PROPERTIES)
            except Exception as exc:
                log_event("bluetooth", "watch_device", mac=mac, result="error", message=str(exc), level=logging.WARNING)
                continue

            def make_handler(watched_mac: str) -> Callable[[str, dict[str, Any], list[str]], None]:
                def on_properties_changed(
                    interface_name: str,
                    changed_properties: dict[str, Any],
                    invalidated_properties: list[str],
                ) -> None:
                    if interface_name != DEVICE:
                        return
                    self._record_property_change(watched_mac, changed_properties)

                return on_properties_changed

            props.on_properties_changed(make_handler(mac))
            self.watched_device_paths.add(path)

    def _record_property_change(self, mac: str, changed_properties: dict[str, Any]) -> None:
        # Only a live advertisement with a credible RSSI counts as a passive sighting.
        # ManufacturerData/AdvertisingFlags alone are too noisy for paired-but-away devices.
        # We deliberately do NOT clear presence on property *invalidation*: BlueZ
        # invalidates RSSI as a routine side effect of stopping discovery (which happens
        # on every probe cycle), so an invalidation is not evidence the device left.
        rssi = passive_rssi_from_properties(changed_properties)
        if rssi is None:
            return
        if rssi < self.config.min_passive_rssi:
            return
        self.passive_seen_at[normalize_mac(mac)] = PassiveSighting(time.monotonic(), rssi)
        log_event("bluetooth", "passive_seen", mac=mac, result="event", message=f"rssi={rssi}")

    async def is_device_passively_present(self, mac: str) -> bool:
        if not is_valid_mac(mac):
            return False
        mac = normalize_mac(mac)
        sighting = self.passive_seen_at.get(mac)
        if sighting is None:
            return False
        if (time.monotonic() - sighting.seen_at) > self.config.passive_presence_ttl_seconds:
            return False
        if sighting.rssi is not None and sighting.rssi < self.config.min_passive_rssi:
            return False
        return True

    def _paired_devices_from_objects(self, objects: dict[str, dict[str, dict[str, Any]]]) -> dict[str, str]:
        paired: dict[str, str] = {}
        for path, ifaces in objects.items():
            device = ifaces.get(DEVICE)
            if not device:
                continue
            if _variant_value(device.get("Paired")) is True:
                mac = path_to_mac(path)
                if mac:
                    paired[mac] = path
        return paired

    async def _interface(self, bus_name: str, path: str, interface_name: str) -> Any:
        if not self.bus:
            raise RuntimeError("D-Bus is not connected")
        introspection = await self.bus.introspect(bus_name, path)
        obj = self.bus.get_proxy_object(bus_name, path, introspection)
        return obj.get_interface(interface_name)

    async def _safe_set(self, props: Any, interface_name: str, prop: str, value: Variant) -> None:
        try:
            await props.call_set(interface_name, prop, value)
        except Exception as exc:
            log_event("bluetooth", "adapter_property", result="ignored", message=f"{prop}: {exc}")


def adapter_hci_name(adapter_path: str) -> str:
    name = adapter_path.rsplit("/", 1)[-1]
    return name if name.startswith("hci") else "hci0"


async def unblock_bluetooth_rfkill(timeout_seconds: int) -> None:
    await run_command("rfkill", ["unblock", "bluetooth"], timeout_seconds)


async def power_on_adapter_cli(hci_name: str, timeout_seconds: int) -> None:
    if hci_name:
        await run_command("hciconfig", [hci_name, "up"], timeout_seconds)
    await run_command("bluetoothctl", ["power", "on"], timeout_seconds)


async def run_command(program: str, args: list[str], timeout_seconds: int) -> CommandOutput:
    try:
        proc = await asyncio.create_subprocess_exec(
            program,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=max(1, timeout_seconds))
        return CommandOutput(
            code=proc.returncode if proc.returncode is not None else -1,
            stdout=stdout.decode(errors="replace"),
            stderr=stderr.decode(errors="replace"),
        )
    except asyncio.TimeoutError:
        if "proc" in locals() and proc.returncode is None:
            proc.kill()
            await proc.communicate()
        return CommandOutput(code=124, stdout="", stderr="timeout")
    except OSError as exc:
        return CommandOutput(code=-1, stdout="", stderr=str(exc))


async def l2ping_device(mac: str, count: int, timeout_seconds: int) -> bool:
    if not is_valid_mac(mac):
        return False
    ping_count = max(1, count)
    per_ping_timeout = max(1, timeout_seconds)
    command_timeout = ping_count * per_ping_timeout + 2
    out = await run_command(
        "l2ping",
        ["-c", str(ping_count), "-t", str(per_ping_timeout), normalize_mac(mac)],
        command_timeout,
    )
    return out.code == 0 and "bytes from" in out.stdout.lower()


async def remote_name_probe_device(mac: str, timeout_seconds: int) -> bool:
    if not is_valid_mac(mac):
        return False
    out = await run_command(
        "hcitool",
        ["name", normalize_mac(mac)],
        timeout_seconds,
    )
    return command_output_indicates_remote_name_success(out)


def normalize_mac(mac: str) -> str:
    return mac.strip().upper()


def is_valid_mac(mac: str) -> bool:
    return bool(MAC_RE.match(normalize_mac(mac)))


def path_to_mac(path: str) -> str | None:
    marker = "/dev_"
    if marker not in path:
        return None
    mac = path.rsplit(marker, 1)[-1].replace("_", ":").upper()
    return mac if is_valid_mac(mac) else None


def has_audio_uuid(uuids: list[str], blocked: set[str]) -> bool:
    return any(uuid.strip().lower() in blocked for uuid in uuids)


def passive_rssi_from_properties(props: dict[str, Any]) -> int | None:
    if "RSSI" not in props:
        return None
    value = _variant_value(props.get("RSSI"))
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def device_properties_indicate_passive_presence(props: dict[str, Any]) -> bool:
    return passive_rssi_from_properties(props) is not None


def command_output_indicates_connect_success(out: CommandOutput) -> bool:
    combined = f"{out.stdout}\n{out.stderr}".lower()
    if "connected: yes" in combined or "connection successful" in combined:
        return True
    failed = (
        "not available",
        "not connected",
        "no route",
        "host is down",
        "connection refused",
        "connection timed out",
        "timeout",
        "page timeout",
    )
    if any(text in combined for text in failed):
        return False
    if "failed" in combined and "profile-unavailable" not in combined:
        return False
    return out.code == 0 or "successful" in combined


def command_output_indicates_remove_success(out: CommandOutput) -> bool:
    combined = f"{out.stdout}\n{out.stderr}".lower()
    if any(text in combined for text in ("not available", "does not exist", "not found")):
        return True
    return out.code == 0 and "failed" not in combined and any(
        text in combined for text in ("removed", "successful", "device has been removed")
    )


def command_output_indicates_remote_name_success(out: CommandOutput) -> bool:
    combined = f"{out.stdout}\n{out.stderr}".lower()
    failed = (
        "not available",
        "no route",
        "host is down",
        "connection refused",
        "connection timed out",
        "timeout",
        "invalid",
        "not found",
        "no such file",
    )
    if out.code != 0 or any(text in combined for text in failed):
        return False
    return bool(out.stdout.strip())


def dbus_error_matches(exc: DBusError, *needles: str) -> bool:
    """True if a needle matches the D-Bus error name (exc.type) or its text.

    dbus_next puts the error name (e.g. "org.bluez.Error.InProgress") in
    ``exc.type`` and the human-readable message (e.g. "Operation already in
    progress") in ``str(exc)``. Callers often only know one of the two, so match
    against both, case-insensitively.
    """
    haystack = f"{getattr(exc, 'type', '') or ''} {exc}".lower()
    return any(needle.lower() in haystack for needle in needles)


def _variant_value(value: Any) -> Any:
    return value.value if isinstance(value, Variant) else value
