from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from presence_tracker.config import Config, is_placeholder_url


@dataclass(slots=True)
class DeviceRecord:
    id: str | None
    mac_address: str
    status: str = "absent"
    pending_registration: bool = False


@dataclass(slots=True)
class BluetoothRemovalRequest:
    id: str
    mac_address: str


class ConvexClient:
    def __init__(self, base_url: str = "", admin_key: str | None = None) -> None:
        normalized = base_url.strip().rstrip("/")
        if not normalized or is_placeholder_url(normalized):
            normalized = ""
        self.base_url = normalized
        self.admin_key = admin_key.strip() if admin_key and admin_key.strip() else None
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(15.0))

    @classmethod
    def from_config(cls, config: Config) -> "ConvexClient":
        return cls(config.convex.deployment_url, config.convex.admin_key)

    @property
    def is_configured(self) -> bool:
        return bool(self.base_url)

    async def close(self) -> None:
        await self.http.aclose()

    async def get_devices(self) -> list[DeviceRecord]:
        if not self.is_configured:
            return []
        value = await self.call("query", "devices:getDevicesForPresence", {})
        if not isinstance(value, list):
            raise ValueError("devices:getDevicesForPresence did not return a list")
        return [
            DeviceRecord(
                id=item.get("_id"),
                mac_address=str(item.get("macAddress", "")),
                status=str(item.get("status", "absent")),
                pending_registration=bool(item.get("pendingRegistration", False)),
            )
            for item in value
            if isinstance(item, dict)
        ]

    async def get_bluetooth_removal_requests(self) -> list[BluetoothRemovalRequest]:
        if not self.is_configured:
            return []
        value = await self.call("query", "devices:getBluetoothRemovalRequestsForPresence", {})
        if not isinstance(value, list):
            raise ValueError("devices:getBluetoothRemovalRequestsForPresence did not return a list")
        return [
            BluetoothRemovalRequest(
                id=str(item.get("_id", "")),
                mac_address=str(item.get("macAddress", "")),
            )
            for item in value
            if isinstance(item, dict) and item.get("_id")
        ]

    async def register_pending_device(
        self,
        mac_address: str,
        name: str | None = None,
        source: str | None = None,
    ) -> None:
        if not self.is_configured:
            return
        args: dict[str, Any] = {"macAddress": mac_address, "name": name or ""}
        if source:
            args["source"] = source
        await self.call("mutation", "devices:registerPendingDevice", args)

    async def acknowledge_bluetooth_removal_request(self, request_id: str, mac_address: str) -> None:
        if not self.is_configured:
            return
        await self.call(
            "mutation",
            "devices:acknowledgeBluetoothRemovalRequest",
            {"id": request_id, "macAddress": mac_address},
        )

    async def update_device_status(self, mac_address: str, status: str) -> None:
        if not self.is_configured:
            return
        await self.call(
            "mutation",
            "devices:updateDeviceStatus",
            {"macAddress": mac_address, "status": status},
        )

    async def call(self, endpoint: str, path: str, args: dict[str, Any]) -> Any:
        if not self.base_url:
            raise RuntimeError("Convex client is not configured")

        headers = {
            "Content-Type": "application/json",
            "Convex-Client": "presence-tracker-py-0.1.0",
        }
        if self.admin_key:
            headers["Authorization"] = f"Convex {self.admin_key}"

        response = await self.http.post(
            f"{self.base_url}/api/{endpoint}",
            headers=headers,
            json={"path": path, "args": args, "format": "json"},
        )
        if response.status_code < 200 or response.status_code >= 300:
            raise RuntimeError(f"Convex {endpoint} {path} failed: {response.status_code} {response.text}")

        body = response.json()
        if isinstance(body, dict) and body.get("status") not in (None, "success"):
            message = body.get("errorMessage") or body.get("error") or "unknown Convex error"
            raise RuntimeError(f"Convex {endpoint} {path} error: {message}")
        return extract_value(body)


def extract_value(body: Any) -> Any:
    if isinstance(body, dict):
        if "value" in body:
            return body["value"]
        if "result" in body:
            return body["result"]
    return body
