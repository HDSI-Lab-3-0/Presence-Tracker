from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict

from presence_tracker.bluetooth import is_valid_mac, normalize_mac
from presence_tracker.config import Config
from presence_tracker.convex_client import ConvexClient, DeviceRecord
from presence_tracker.logging_utils import log_event
from presence_tracker.state import load_known_macs, save_known_macs


class PresenceLoop:
    def __init__(self, config: Config, convex: ConvexClient, bluetooth: object) -> None:
        self.config = config
        self.convex = convex
        self.bluetooth = bluetooth
        self.misses: dict[str, int] = defaultdict(int)
        self.hits: dict[str, int] = defaultdict(int)
        self.known_macs = load_known_macs(config.paths.state_file)
        self.probe_semaphore = asyncio.Semaphore(config.bluetooth.max_concurrent_probes)

    async def run_forever(self) -> None:
        log_event("presence_loop", "started", result="ok", message="Presence polling loop started")
        interval = max(1, self.config.presence.polling_interval_seconds)
        while True:
            start = time.monotonic()
            try:
                await self.run_cycle()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log_event("presence_loop", "cycle", result="error", message=str(exc), level=logging.WARNING)
            elapsed = time.monotonic() - start
            if elapsed > interval:
                log_event(
                    "presence_loop",
                    "cycle_duration",
                    result="slow",
                    message=f"{elapsed:.1f}s exceeded {interval}s interval",
                    level=logging.WARNING,
                )
                sleep_for = 0
            else:
                sleep_for = interval - elapsed
            await asyncio.sleep(sleep_for)

    async def run_cycle(self) -> None:
        await self.process_bluetooth_removals()

        devices = await self.convex.get_devices()
        connected = {normalize_mac(mac) for mac in await self.bluetooth.get_connected_devices()}
        convex_macs = {normalize_mac(device.mac_address) for device in devices}

        deleted_macs = self.known_macs - convex_macs
        next_known_macs = set(convex_macs)
        for mac in sorted(deleted_macs):
            if is_valid_mac(mac):
                removed = await self.remove_mac_from_adapter(
                    mac,
                    "bluetooth_remove_missing",
                    "Removed Bluetooth device that disappeared from Convex device list",
                )
                if not removed:
                    next_known_macs.add(mac)
        self.known_macs = next_known_macs

        for mac in sorted(connected - convex_macs - deleted_macs):
            try:
                await self.convex.register_pending_device(mac, None, None)
                log_event(
                    "presence_loop",
                    "register_pending_fallback",
                    mac=mac,
                    result="ok",
                    message="Registered unknown connected device as pending",
                )
            except Exception as exc:
                log_event(
                    "presence_loop",
                    "register_pending_fallback",
                    mac=mac,
                    result="error",
                    message=str(exc),
                    level=logging.WARNING,
                )

        registered = [
            device
            for device in devices
            if not device.pending_registration and is_valid_mac(device.mac_address)
        ]
        present_results = await asyncio.gather(
            *(self.check_present(device, connected) for device in registered),
            return_exceptions=True,
        )
        for device, result in zip(registered, present_results, strict=False):
            if isinstance(result, Exception):
                log_event(
                    "presence_loop",
                    "probe",
                    mac=normalize_mac(device.mac_address),
                    result="error",
                    message=str(result),
                    level=logging.WARNING,
                )
                continue
            await self.apply_presence_result(device, bool(result), normalize_mac(device.mac_address) in connected)

        known_registered = {normalize_mac(device.mac_address) for device in registered}
        self.misses = defaultdict(int, {mac: count for mac, count in self.misses.items() if mac in known_registered})
        self.hits = defaultdict(int, {mac: count for mac, count in self.hits.items() if mac in known_registered})
        save_known_macs(self.config.paths.state_file, self.known_macs)

    async def check_present(self, device: DeviceRecord, connected: set[str]) -> bool:
        mac = normalize_mac(device.mac_address)
        if mac in connected:
            return True
        async with self.probe_semaphore:
            return await self.bluetooth.probe_device(mac)

    async def apply_presence_result(self, device: DeviceRecord, is_present: bool, via_connected: bool) -> None:
        mac = normalize_mac(device.mac_address)
        absent_threshold = max(1, self.config.presence.absent_threshold)
        present_threshold = max(1, self.config.presence.present_threshold)

        if is_present:
            self.misses.pop(mac, None)
            if device.status != "present":
                if via_connected:
                    self.hits[mac] += 1
                    if self.hits[mac] < present_threshold:
                        return
                    self.hits.pop(mac, None)
                else:
                    self.hits.pop(mac, None)
                await self.transition_status(device, "present")
            return

        self.hits.pop(mac, None)
        self.misses[mac] += 1
        if self.misses[mac] >= absent_threshold and device.status != "absent":
            await self.transition_status(device, "absent")

    async def process_bluetooth_removals(self) -> None:
        try:
            requests = await self.convex.get_bluetooth_removal_requests()
        except Exception as exc:
            log_event("presence_loop", "bluetooth_removal_fetch", result="error", message=str(exc), level=logging.WARNING)
            return

        for request in requests:
            mac = normalize_mac(request.mac_address)
            if not is_valid_mac(mac):
                log_event(
                    "presence_loop",
                    "bluetooth_remove",
                    mac=mac,
                    result="invalid_mac",
                    message="Skipping invalid Bluetooth removal request",
                    level=logging.WARNING,
                )
                continue
            if await self.remove_mac_from_adapter(
                mac,
                "bluetooth_remove",
                "Removed Bluetooth device from adapter for queued request",
            ):
                self.known_macs.discard(mac)
                try:
                    await self.convex.acknowledge_bluetooth_removal_request(request.id, mac)
                    log_event(
                        "presence_loop",
                        "bluetooth_remove",
                        mac=mac,
                        result="ok",
                        message="Removed Bluetooth device and acknowledged request",
                    )
                except Exception as exc:
                    log_event(
                        "presence_loop",
                        "bluetooth_remove_ack",
                        mac=mac,
                        result="error",
                        message=str(exc),
                        level=logging.WARNING,
                    )

    async def remove_mac_from_adapter(self, mac: str, action: str, success_message: str) -> bool:
        removed = await self.bluetooth.remove_device(mac)
        if removed:
            self.misses.pop(mac, None)
            self.hits.pop(mac, None)
            log_event("presence_loop", action, mac=mac, result="ok", message=success_message)
            return True
        log_event(
            "presence_loop",
            action,
            mac=mac,
            result="failed",
            message="Failed to remove Bluetooth device from adapter",
            level=logging.WARNING,
        )
        return False

    async def transition_status(self, device: DeviceRecord, status: str) -> None:
        mac = normalize_mac(device.mac_address)
        try:
            await self.convex.update_device_status(mac, status)
            log_event("presence_loop", "status_update", mac=mac, result=status, message=f"{device.status} -> {status}")
        except Exception as exc:
            log_event("presence_loop", "status_update", mac=mac, result="error", message=str(exc), level=logging.WARNING)
