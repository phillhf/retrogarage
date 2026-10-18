@echo off
rem Retro Garage installieren/aktualisieren - startet install.ps1 (Parameter werden durchgereicht).
rem Fuer Hintergrunddienst und Firewall-Freigabe per Rechtsklick "Als Administrator ausfuehren".
rem Entfernen: install.bat -Uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
