@echo off
REM Launches local Fragment Audio Server (grz0zrg/fas v2.0.2) for Spectral Timeline
REM Connects automatically to https://nextdaytre.github.io/spectral-timeline/ on ws://127.0.0.1:3003
setlocal
set FAS_EXE=%~dp0fas_bin\fas.exe
if not exist "%FAS_EXE%" (
    for /r "%~dp0fas_bin" %%F in (fas.exe) do set FAS_EXE=%%F
)
if not exist "%FAS_EXE%" (
    echo fas.exe not found inside %~dp0fas_bin\
    echo Download fas-2.0.2-x86_64-win.zip from https://github.com/grz0zrg/fas/releases/tag/v2.0.2
    echo and extract it into fas_bin\
    pause
    exit /b 1
)
echo Starting Fragment Audio Server on ws://127.0.0.1:3003 (48 kHz)...
echo Press Ctrl+C to stop.
"%FAS_EXE%" --iface 127.0.0.1 --port 3003 --sample_rate 48000 %*
