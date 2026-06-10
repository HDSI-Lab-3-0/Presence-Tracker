from __future__ import annotations

import argparse
import asyncio
import signal
from pathlib import Path

from dotenv import load_dotenv

from presence_tracker.bluetooth import BlueZPresenceMonitor
from presence_tracker.config import Config
from presence_tracker.convex_client import ConvexClient
from presence_tracker.logging_utils import configure_logging, log_event
from presence_tracker.presence_loop import PresenceLoop


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Presence Tracker Raspberry Pi agent")
    parser.add_argument(
        "--config",
        default="config/agent.toml",
        help="Path to TOML config file",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one presence cycle and exit",
    )
    return parser.parse_args()


async def wait_for_shutdown() -> None:
    loop = asyncio.get_running_loop()
    event = asyncio.Event()

    def request_shutdown() -> None:
        event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, request_shutdown)
        except NotImplementedError:
            signal.signal(sig, lambda *_: request_shutdown())

    await event.wait()


async def run() -> None:
    load_dotenv()
    args = parse_args()
    config_path = Path(args.config)
    config = Config.load(config_path)
    configure_logging(config.logging.log_file, config.logging.max_lines)

    log_event("main", "start", result="ok", message=f"config={config_path}")

    convex = ConvexClient.from_config(config)
    monitor = BlueZPresenceMonitor(config.bluetooth)

    await monitor.connect()
    await monitor.configure_adapter(config.bluetooth_name)
    await monitor.register_agent()
    await monitor.start_discovery()

    pairing_task: asyncio.Task[None] | None = None
    if convex.is_configured:
        pairing_task = asyncio.create_task(monitor.monitor_new_pairings(convex.register_pending_device))
    else:
        log_event(
            "main",
            "convex_config",
            result="missing",
            message="Convex URL is not configured; presence status updates are disabled",
        )

    presence = PresenceLoop(config, convex, monitor)
    try:
        if args.once:
            await presence.run_cycle()
            return

        loop_task = asyncio.create_task(presence.run_forever())
        shutdown_task = asyncio.create_task(wait_for_shutdown())
        done, pending = await asyncio.wait(
            {loop_task, shutdown_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in done:
            exc = task.exception()
            if exc:
                raise exc

        for task in pending:
            task.cancel()
    finally:
        if pairing_task:
            pairing_task.cancel()
        await convex.close()
        await monitor.close()
        log_event("main", "shutdown", result="ok", message="agent stopped")


if __name__ == "__main__":
    asyncio.run(run())
