@echo off
REM Double-click to play. Serves the game over http and opens a browser tab.
REM ES modules are blocked on file://, so the page CANNOT be opened from disk.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1"
