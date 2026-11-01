@echo off
rem Windows: double-click to start BookBoom on http://localhost:5051 (installable, works offline).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
if errorlevel 1 start "" "%~dp0index.html"
