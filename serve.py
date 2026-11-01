"""BookBoom web: tiny local server so the app can be installed (PWA) and used offline on this computer.

Double-click "Start BookBoom.command" (Mac) or run ./start-bookboom.sh (Linux); on Windows use "Start BookBoom.bat".
It serves this folder at http://localhost:5051 (only this computer can reach it) and opens your browser.
Nothing is uploaded anywhere: your books stay in the browser's storage on this computer.
"""
import http.server
import os
import socket
import sys
import threading
import webbrowser

PORT = int(os.environ.get("KETABYAR_PORT", "5051"))
ROOT = os.path.dirname(os.path.abspath(__file__))
URL = f"http://localhost:{PORT}/"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
        ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
        ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".wasm": "application/wasm",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        if self.path.split("?")[0] in ("/", "/index.html", "/sw.js"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *a):
        pass


def in_use() -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def main() -> None:
    if in_use():
        print(f"BookBoom is already running: {URL}")
        webbrowser.open(URL)
        return
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"BookBoom is running at {URL}")
    print("Keep this window open while you use it (after you install the app, it also works offline). Ctrl+C to stop.")
    threading.Timer(0.6, lambda: webbrowser.open(URL)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
