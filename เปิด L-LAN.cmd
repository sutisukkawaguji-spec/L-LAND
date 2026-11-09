@echo off
rem Starts the L-LAN local server and opens it in the default browser.
cd /d "%~dp0"
start "" http://127.0.0.1:4380
node server.mjs
pause
