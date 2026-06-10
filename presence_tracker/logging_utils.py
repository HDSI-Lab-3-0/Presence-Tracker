from __future__ import annotations

import logging
from pathlib import Path


class LineCappedFileHandler(logging.FileHandler):
    def __init__(self, filename: Path, max_lines: int) -> None:
        filename.parent.mkdir(parents=True, exist_ok=True)
        super().__init__(filename)
        self.filename = filename
        self.max_lines = max(1, max_lines)
        self._emit_count = 0

    def emit(self, record: logging.LogRecord) -> None:
        super().emit(record)
        self._emit_count += 1
        if self._emit_count % 20 == 0:
            self.trim()

    def close(self) -> None:
        try:
            self.trim()
        finally:
            super().close()

    def trim(self) -> None:
        try:
            lines = self.filename.read_text(encoding="utf-8", errors="replace").splitlines()
            if len(lines) <= self.max_lines:
                return
            self.filename.write_text("\n".join(lines[-self.max_lines :]) + "\n", encoding="utf-8")
        except OSError:
            return


def configure_logging(log_file: Path, max_lines: int) -> None:
    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()

    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    root.addHandler(stream)

    try:
        file_handler = LineCappedFileHandler(log_file, max_lines)
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except OSError as exc:
        logging.warning("file logging disabled for %s: %s", log_file, exc)


def log_event(
    component: str,
    action: str,
    mac: str | None = None,
    result: str | None = None,
    message: str = "",
    level: int = logging.INFO,
) -> None:
    fields = [f"component={component}", f"action={action}"]
    if mac:
        fields.append(f"mac={mac}")
    if result:
        fields.append(f"result={result}")
    if message:
        fields.append(f"message={message}")
    logging.log(level, " ".join(fields))
