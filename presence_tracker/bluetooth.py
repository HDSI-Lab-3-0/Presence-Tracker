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
        self.passive_seen_at: dict[str, float] = {}
        self.watched_device_paths: set[str] = set()
        self._connect_lock = asyncio.Lock()

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
        adapter_props = await self._interface(BLUEZ, self.adapter_path, PROPERTIES)
        await self._safe_set(adapter_props, ADAPTER, "Powered", Variant("b", True))
        await asyncio.sleep(0.2)
        await self._safe_set(adapter_props, ADAPTER, "Pairable", Variant("b", True))
        await self._safe_set(adapter_props, ADAPTER, "Discoverable", Variant("b", True))
        await self._safe_set(adapter_props, ADAPTER, "DiscoverableTimeout", Variant("u", 0))
        await self._safe_set(adapter_props, ADAPTER, "PairableTimeout", Variant("u", 0))
        if alias:
            await self._safe_set(adapter_props, ADAPTER, "Alias", Variant("s", alias))
        log_event("bluetooth", "configure_adapter", result="ok", message=self.adapter_path)

    async def start_discovery(self) -> None:
        adapter = await self._interface(BLUEZ, self.adapter_path, ADAPTER)
        try:
            await adapter.call_start_discovery()
        except DBusError as exc:
            if "InProgress" not in str(exc):
                raise
        log_event("bluetooth", "start_discovery", result="ok")

    async def stop_discovery(self) -> None:
        adapter = await self._interface(BLUEZ, self.adapter_path, ADAPTER)
        try:
            await adapter.call_stop_discovery()
        except DBusError as exc:
            if "NotReady" not in str(exc) and "not ready" not in str(exc).lower():
                log_event("bluetooth", "stop_discovery", result="ignored", message=str(exc))
        for _ in range(10):
            props = await self._interface(BLUEZ, self.adapter_path, PROPERTIES)
            discovering = _variant_value(await props.call_get(ADAPTER, "Discovering"))
            if discovering is not True:
                return
            await asyncio.sleep(0.1)

    async def get_connected_devices(self) -> set[str]:
        objects = await self.get_managed_objects()
        self._remember_passive_seen_from_objects(objects)
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
        self._remember_passive_seen_from_objects(objects)
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

    async def probe_device(self, mac: str) -> bool:
        if not is_valid_mac(mac):
            return False
        mac = normalize_mac(mac)
        if await self.is_device_connected(mac):
            return True
        if await self.is_device_passively_present(mac):
            log_event("bluetooth", "passive_probe", mac=mac, result="seen")
            return True
        if await l2ping_device(
            mac,
            self.config.l2ping_count,
            self.config.l2ping_timeout_seconds,
        ):
            log_event("bluetooth", "l2ping_probe", mac=mac, result="seen")
            return True
        if await remote_name_probe_device(mac, self.config.connect_probe_timeout_seconds):
            log_event("bluetooth", "name_probe", mac=mac, result="seen")
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

    async def connect_probe(self, mac: str) -> bool:
        async with self._connect_lock:
            await self.stop_discovery()
            last_error = ""
            try:
                for attempt in range(3):
                    connected, error = await self._connect_probe_once(mac)
                    if connected:
                        return True
                    last_error = error
                    if attempt < 2:
                        await asyncio.sleep(0.75)
                if last_error:
                    log_event("bluetooth", "connect_probe", mac=mac, result="failed", message=last_error)
                return False
            finally:
                await self.start_discovery()

    async def _connect_probe_once(self, mac: str) -> tuple[bool, str]:
        path = await self.device_path(mac)
        if not path:
            out = await run_command(
                "bluetoothctl",
                ["connect", normalize_mac(mac)],
                self.config.connect_probe_timeout_seconds,
            )
            if command_output_indicates_connect_success(out):
                return True, ""
            combined = f"{out.stdout}\n{out.stderr}".strip()
            return False, combined or f"exit={out.code}"
        try:
            device = await self._interface(BLUEZ, path, DEVICE)
            await asyncio.wait_for(device.call_connect(), timeout=self.config.connect_probe_timeout_seconds)
            return True, ""
        except Exception as exc:
            return False, str(exc)

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
                self._remember_passive_seen_from_objects(objects)
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
        self._remember_passive_seen_from_objects(objects)
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
                    if device_properties_indicate_passive_presence(changed_properties):
                        self.passive_seen_at[normalize_mac(watched_mac)] = time.monotonic()
                        log_event("bluetooth", "passive_seen", mac=watched_mac, result="event")

                return on_properties_changed

            props.on_properties_changed(make_handler(mac))
            self.watched_device_paths.add(path)

    async def is_device_passively_present(self, mac: str) -> bool:
        if not is_valid_mac(mac):
            return False
        mac = normalize_mac(mac)
        path = await self.device_path(mac)
        if path:
            props = await self.get_device_properties(path)
            self._remember_passive_seen(mac, props)
        seen_at = self.passive_seen_at.get(mac)
        if seen_at is None:
            return False
        return (time.monotonic() - seen_at) <= self.config.passive_presence_ttl_seconds

    def _remember_passive_seen_from_objects(self, objects: dict[str, dict[str, dict[str, Any]]]) -> None:
        for path, ifaces in objects.items():
            device = ifaces.get(DEVICE)
            mac = path_to_mac(path)
            if device and mac:
                self._remember_passive_seen(mac, device)

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

    def _remember_passive_seen(self, mac: str, props: dict[str, Any]) -> None:
        if device_properties_indicate_passive_presence(props):
            self.passive_seen_at[normalize_mac(mac)] = time.monotonic()

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


def device_properties_indicate_passive_presence(props: dict[str, Any]) -> bool:
    if "RSSI" in props:
        return True
    if _variant_value(props.get("AdvertisingFlags")):
        return True
    manufacturer_data = _variant_value(props.get("ManufacturerData"))
    return bool(manufacturer_data)


def command_output_indicates_connect_success(out: CommandOutput) -> bool:
    combined = f"{out.stdout}\n{out.stderr}".lower()
    failed = (
        "failed",
        "not available",
        "not connected",
        "no route",
        "host is down",
        "connection refused",
        "connection timed out",
        "timeout",
    )
    if any(text in combined for text in failed):
        return False
    return out.code == 0 or "connected: yes" in combined or "connection successful" in combined or "successful" in combined


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


def _variant_value(value: Any) -> Any:
    return value.value if isinstance(value, Variant) else value
