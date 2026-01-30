"""Minimal tests for bluetooth_scanner connect/disconnect verification logic."""
from __future__ import annotations

import sys
from pathlib import Path
import unittest
from unittest.mock import patch

# Ensure src/ is importable when running the test directly
ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import bluetooth_scanner  # noqa: E402  pylint: disable=wrong-import-position


class BluetoothScannerPresenceTests(unittest.TestCase):
    mac = "AA:BB:CC:DD:EE:FF"

    def _make_snapshot(self, *, connected: bool) -> dict[str, dict]:
        return {
            self.mac: {
                "path": "/dev/mock",
                "connected": connected,
                "paired": True,
                "trusted": True,
            }
        }

    @patch("bluetooth_scanner._read_connected_property", return_value=True)
    @patch("bluetooth_scanner._invoke_with_hard_timeout", return_value=(True, None))
    @patch("bluetooth_scanner.get_device_snapshot")
    def test_connect_device_uses_fresh_connected_property(
        self,
        mock_snapshot,
        _mock_invoke,
        mock_read_connected,
    ) -> None:
        """connect_device should rely on a fresh Connected property check."""

        mock_snapshot.return_value = self._make_snapshot(connected=False)

        success = bluetooth_scanner.connect_device(self.mac)

        self.assertTrue(success)
        mock_read_connected.assert_called()

    @patch("bluetooth_scanner._read_connected_property", return_value=False)
    @patch("bluetooth_scanner._invoke_with_hard_timeout", return_value=(True, None))
    @patch("bluetooth_scanner.get_device_snapshot")
    def test_disconnect_device_uses_fresh_connected_property(
        self,
        mock_snapshot,
        _mock_invoke,
        mock_read_connected,
    ) -> None:
        """disconnect_device should confirm disconnection via Connected property."""

        mock_snapshot.return_value = self._make_snapshot(connected=True)

        success = bluetooth_scanner.disconnect_device(self.mac)

        self.assertTrue(success)
        mock_read_connected.assert_called()


if __name__ == "__main__":
    unittest.main()
