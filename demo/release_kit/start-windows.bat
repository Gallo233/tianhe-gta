@echo off
rem Tianhe demo: start a local web server for the game and open the browser (Windows 10/11, nothing to install).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\server.ps1"
if errorlevel 1 pause
