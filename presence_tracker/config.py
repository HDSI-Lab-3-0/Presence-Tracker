from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_AUDIO_UUIDS = [
    "00001108-0000-1000-8000-00805f9b34fb",
    "0000110a-0000-1000-8000-00805f9b34fb",
    "0000110b-0000-1000-8000-00805f9b34fb",
    "0000110c-0000-1000-8000-00805f9b34fb",
    "0000110d-0000-1000-8000-00805f9b34fb",
    "0000110e-0000-1000-8000-00805f9b34fb",
    "0000110f-0000-1000-8000-00805f9b34fb",
    "00001112-0000-1000-8000-00805f9b34fb",
    "0000111e-0000-1000-8000-00805f9b34fb",
    "0000111f-0000-1000-8000-00805f9b34fb",
]


@dataclass(slots=True)
class ConvexConfig:
    deployment_url: str = ""
    admin_key: str | None = None


@dataclass(slots=True)
class PresenceConfig:
    polling_interval_seconds: int = 60
    absent_threshold: int = 3
    present_threshold: int = 1
    present_ttl_seconds: int = 300
    grace_period_seconds: int = 300


@dataclass(slots=True)
class BluetoothConfig:
    l2ping_timeout_seconds: int = 2
    l2ping_count: int = 1
    connect_probe_timeout_seconds: int = 5
    command_timeout_seconds: int = 5
    max_concurrent_probes: int = 1
    passive_presence_ttl_seconds: int = 300
    adapter_name: str = ""
    audio_block_uuids: list[str] = field(default_factory=lambda: DEFAULT_AUDIO_UUIDS.copy())


@dataclass(slots=True)
class LoggingConfig:
    log_file: Path = Path("logs/presence_tracker.log")
    max_lines: int = 1000


@dataclass(slots=True)
class PathsConfig:
    state_file: Path = Path("config/agent_state.json")


@dataclass(slots=True)
class Config:
    convex: ConvexConfig = field(default_factory=ConvexConfig)
    presence: PresenceConfig = field(default_factory=PresenceConfig)
    bluetooth: BluetoothConfig = field(default_factory=BluetoothConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)
    bluetooth_name: str = "Presence Tracker"

    @classmethod
    def load(cls, path: Path) -> "Config":
        if path.exists():
            with path.open("rb") as fh:
                raw = tomllib.load(fh)
        else:
            raw = {}
        config = cls.from_dict(raw)
        config.apply_env_fallbacks()
        config.normalize()
        return config

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Config":
        convex = raw.get("convex", {})
        presence = raw.get("presence", {})
        bluetooth = raw.get("bluetooth", {})
        logging = raw.get("logging", {})
        paths = raw.get("paths", {})

        return cls(
            convex=ConvexConfig(
                deployment_url=str(convex.get("deployment_url", "")),
                admin_key=_optional_str(convex.get("admin_key")),
            ),
            presence=PresenceConfig(
                polling_interval_seconds=_int(presence.get("polling_interval_seconds"), 60),
                absent_threshold=_int(presence.get("absent_threshold"), 3),
                present_threshold=_int(presence.get("present_threshold"), 1),
                present_ttl_seconds=_int(presence.get("present_ttl_seconds"), 300),
                grace_period_seconds=_int(presence.get("grace_period_seconds"), 300),
            ),
            bluetooth=BluetoothConfig(
                l2ping_timeout_seconds=_int(bluetooth.get("l2ping_timeout_seconds"), 2),
                l2ping_count=_int(bluetooth.get("l2ping_count"), 1),
                connect_probe_timeout_seconds=_int(bluetooth.get("connect_probe_timeout_seconds"), 2),
                command_timeout_seconds=_int(bluetooth.get("command_timeout_seconds"), 5),
                max_concurrent_probes=_int(bluetooth.get("max_concurrent_probes"), 2),
                passive_presence_ttl_seconds=_int(bluetooth.get("passive_presence_ttl_seconds"), 180),
                adapter_name=str(bluetooth.get("adapter_name", "")),
                audio_block_uuids=[
                    str(uuid).strip().lower()
                    for uuid in bluetooth.get("audio_block_uuids", DEFAULT_AUDIO_UUIDS)
                    if str(uuid).strip()
                ],
            ),
            logging=LoggingConfig(
                log_file=Path(str(logging.get("log_file", "logs/presence_tracker.log"))),
                max_lines=_int(logging.get("max_lines"), 1000),
            ),
            paths=PathsConfig(
                state_file=Path(str(paths.get("state_file", "config/agent_state.json"))),
            ),
            bluetooth_name=str(raw.get("bluetooth_name") or os.getenv("BLUETOOTH_NAME") or "Presence Tracker"),
        )

    def apply_env_fallbacks(self) -> None:
        if not self.convex.deployment_url.strip() or is_placeholder_url(self.convex.deployment_url):
            self.convex.deployment_url = (
                _env_first("CONVEX_SELF_HOSTED_URL", "CONVEX_DEPLOYMENT_URL", "CONVEX_URL", "CONVEX_SITE_URL")
                or ""
            )
        if not self.convex.admin_key:
            self.convex.admin_key = _env_first("CONVEX_SELF_HOSTED_ADMIN_KEY", "CONVEX_ADMIN_KEY")

    def normalize(self) -> None:
        self.convex.deployment_url = self.convex.deployment_url.strip().rstrip("/")
        if is_placeholder_url(self.convex.deployment_url):
            self.convex.deployment_url = ""
        if self.convex.admin_key is not None:
            self.convex.admin_key = self.convex.admin_key.strip() or None

        self.presence.polling_interval_seconds = max(1, self.presence.polling_interval_seconds)
        self.presence.absent_threshold = max(1, self.presence.absent_threshold)
        self.presence.present_threshold = max(1, self.presence.present_threshold)
        self.presence.present_ttl_seconds = max(30, self.presence.present_ttl_seconds)
        self.presence.grace_period_seconds = max(1, self.presence.grace_period_seconds)
        self.bluetooth.l2ping_timeout_seconds = max(1, self.bluetooth.l2ping_timeout_seconds)
        self.bluetooth.l2ping_count = max(1, self.bluetooth.l2ping_count)
        self.bluetooth.connect_probe_timeout_seconds = max(1, self.bluetooth.connect_probe_timeout_seconds)
        self.bluetooth.command_timeout_seconds = max(1, self.bluetooth.command_timeout_seconds)
        self.bluetooth.max_concurrent_probes = max(1, self.bluetooth.max_concurrent_probes)
        self.bluetooth.passive_presence_ttl_seconds = max(30, self.bluetooth.passive_presence_ttl_seconds)
        self.logging.max_lines = max(1, self.logging.max_lines)


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _env_first(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return None


def is_placeholder_url(value: str) -> bool:
    return "your-convex-deployment" in value.lower()
