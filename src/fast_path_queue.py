"""Shared queue helpers for fast-path presence events.

This module exposes two helpers:

- ``start_queue_server``: Launches a background ``BaseManager`` server that
  shares a ``Queue`` with other processes (used by the presence tracker).
- ``connect_to_queue``: Connects to the running manager and returns the shared
  queue proxy (used by the bluetooth agent or any other producer).

The queue parameters are controlled via environment variables so multiple
processes can coordinate without hard-coded ports.
"""

from __future__ import annotations

import logging
import os
import threading
from multiprocessing.managers import BaseManager
from queue import Queue
from typing import Callable

FAST_PATH_QUEUE_HOST = os.getenv("FAST_PATH_QUEUE_HOST", "127.0.0.1")
FAST_PATH_QUEUE_PORT = int(os.getenv("FAST_PATH_QUEUE_PORT", "51975"))
FAST_PATH_QUEUE_AUTH_KEY = os.getenv("FAST_PATH_QUEUE_AUTH_KEY", "presence-fast-path")

_logger = logging.getLogger(__name__)
if not _logger.handlers:
    _logger.addHandler(logging.NullHandler())

_server_lock = threading.Lock()
_server_thread: threading.Thread | None = None
_manager_instance: BaseManager | None = None
_shared_queue: Queue | None = None


def _authkey() -> bytes:
    return FAST_PATH_QUEUE_AUTH_KEY.encode("utf-8")


def _endpoint() -> str:
    return f"{FAST_PATH_QUEUE_HOST}:{FAST_PATH_QUEUE_PORT}"


class _ServerManager(BaseManager):
    """BaseManager subclass used for hosting the shared queue."""


def start_queue_server() -> Queue:
    """Start (or return) the fast-path queue server.

    Returns the underlying ``Queue`` instance so local consumers can work with
    native queue semantics while remote processes connect via ``BaseManager``.
    """

    global _server_thread, _manager_instance, _shared_queue

    with _server_lock:
        if _shared_queue is not None:
            return _shared_queue

        queue: Queue = Queue()
        _shared_queue = queue

        _ServerManager.register("get_queue", callable=lambda: queue)
        manager = _ServerManager(
            address=(FAST_PATH_QUEUE_HOST, FAST_PATH_QUEUE_PORT),
            authkey=_authkey(),
        )
        server = manager.get_server()

        thread = threading.Thread(
            target=server.serve_forever,
            name="FastPathQueueServer",
            daemon=True,
        )
        thread.start()

        _manager_instance = manager
        _server_thread = thread
        _logger.info(
            "Fast-path queue server listening on %s (pid=%s)",
            _endpoint(),
            os.getpid(),
        )
        return queue


class _ClientManager(BaseManager):
    """BaseManager subclass for remote queue clients."""


def connect_to_queue() -> Queue:
    """Connect to the existing fast-path queue server.

    Raises the underlying ``ConnectionError`` if the queue server is not yet
    available so callers can implement their own retry/backoff strategies.
    """

    _ClientManager.register("get_queue")
    manager = _ClientManager(
        address=(FAST_PATH_QUEUE_HOST, FAST_PATH_QUEUE_PORT),
        authkey=_authkey(),
    )
    manager.connect()
    _logger.debug(
        "Fast-path queue client connected to %s (pid=%s)",
        _endpoint(),
        os.getpid(),
    )
    return manager.get_queue()
