#!/usr/bin/env python3
from __future__ import annotations

import argparse
import mimetypes
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve a single file with range support.")
    parser.add_argument("--file", required=True, help="Path to the file to serve")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host")
    parser.add_argument("--port", type=int, default=54137, help="Bind port")
    return parser.parse_args()


class RangeFileHandler(BaseHTTPRequestHandler):
    server_version = "ReaperDownloadHTTP/1.0"
    protocol_version = "HTTP/1.1"

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve(send_body=False)

    def do_GET(self) -> None:  # noqa: N802
        self._serve(send_body=True)

    def _serve(self, send_body: bool) -> None:
        file_path: Path = self.server.file_path  # type: ignore[attr-defined]
        try:
            stat = file_path.stat()
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        size = stat.st_size
        start = 0
        end = size - 1
        status = HTTPStatus.OK

        range_header = self.headers.get("Range")
        if range_header:
            parsed = self._parse_range(range_header, size)
            if parsed is None:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            start, end = parsed
            status = HTTPStatus.PARTIAL_CONTENT

        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        content_length = end - start + 1

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        self.send_header("Cache-Control", "no-store")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        if not send_body:
            return

        with file_path.open("rb") as fh:
            fh.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = fh.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    @staticmethod
    def _parse_range(header: str, size: int) -> tuple[int, int] | None:
        if not header.startswith("bytes="):
            return None
        spec = header.removeprefix("bytes=").strip()
        if "," in spec:
            return None
        if "-" not in spec:
            return None
        start_s, end_s = spec.split("-", 1)
        if start_s == "":
            try:
                suffix = int(end_s)
            except ValueError:
                return None
            if suffix <= 0:
                return None
            start = max(0, size - suffix)
            return start, size - 1
        try:
            start = int(start_s)
        except ValueError:
            return None
        if start < 0 or start >= size:
            return None
        if end_s == "":
            return start, size - 1
        try:
            end = int(end_s)
        except ValueError:
            return None
        if end < start:
            return None
        return start, min(end, size - 1)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        print(f"{self.client_address[0]} - - [{self.log_date_time_string()}] {format % args}")


def main() -> int:
    args = parse_args()
    file_path = Path(args.file).expanduser().resolve()
    if not file_path.is_file():
        raise SystemExit(f"File not found: {file_path}")

    server = ThreadingHTTPServer((args.host, args.port), RangeFileHandler)
    server.file_path = file_path  # type: ignore[attr-defined]
    server.daemon_threads = True
    server.allow_reuse_address = True
    print(f"Serving {file_path} on http://{args.host}:{args.port}/")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
