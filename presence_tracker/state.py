from __future__ import annotations

import json
from pathlib import Path

from presence_tracker.bluetooth import is_valid_mac, normalize_mac
from presence_tracker.logging_utils import log_event


def load_known_macs(path: Path) -> set[str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return set()
    except (OSError, json.JSONDecodeError) as exc:
        log_event("state", "load", result="error", message=str(exc))
        return set()

    values = payload.get("known_macs", [])
    if not isinstance(values, list):
        return set()
    return {normalize_mac(str(mac)) for mac in values if is_valid_mac(str(mac))}


def save_known_macs(path: Path, known_macs: set[str]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"known_macs": sorted(known_macs)}
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        log_event("state", "save", result="error", message=str(exc))
