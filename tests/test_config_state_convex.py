import json

from presence_tracker.config import Config
from presence_tracker.convex_client import extract_value
from presence_tracker.state import load_known_macs, save_known_macs


def test_config_defaults_to_one_minute_polling() -> None:
    config = Config.from_dict({})
    config.normalize()
    assert config.presence.polling_interval_seconds == 60
    assert config.bluetooth.max_concurrent_probes == 2
    assert config.bluetooth.passive_presence_ttl_seconds == 180


def test_config_normalizes_invalid_minimums() -> None:
    config = Config.from_dict(
        {
            "presence": {"polling_interval_seconds": 0, "absent_threshold": 0},
            "bluetooth": {"max_concurrent_probes": 0, "passive_presence_ttl_seconds": 1},
            "logging": {"max_lines": 0},
        }
    )
    config.normalize()
    assert config.presence.polling_interval_seconds == 1
    assert config.presence.absent_threshold == 1
    assert config.bluetooth.max_concurrent_probes == 1
    assert config.bluetooth.passive_presence_ttl_seconds == 30
    assert config.logging.max_lines == 1


def test_state_round_trip_filters_invalid_macs(tmp_path) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text(
        json.dumps({"known_macs": ["aa:bb:cc:dd:ee:ff", "invalid"]}),
        encoding="utf-8",
    )
    assert load_known_macs(state_file) == {"AA:BB:CC:DD:EE:FF"}

    save_known_macs(state_file, {"11:22:33:44:55:66"})
    assert json.loads(state_file.read_text(encoding="utf-8")) == {
        "known_macs": ["11:22:33:44:55:66"]
    }


def test_extract_value_accepts_convex_shapes() -> None:
    assert extract_value({"value": [1]}) == [1]
    assert extract_value({"result": {"ok": True}}) == {"ok": True}
    assert extract_value({"other": 1}) == {"other": 1}
