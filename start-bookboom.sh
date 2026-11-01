#!/bin/sh
# Linux: run ./start-bookboom.sh to start BookBoom on http://localhost:5051 (installable, works offline).
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then exec python3 serve.py; fi
echo "Python 3 isn't installed. You can still double-click index.html to use BookBoom, or install Python from python.org."
xdg-open index.html 2>/dev/null
