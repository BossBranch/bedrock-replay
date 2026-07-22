@echo off
cd /d "%~dp0"
echo.
echo === BEDROCK REPLAY (dual port) ===
echo.
echo   LIVE  (record)  advertiseHost:livePort   default 127.0.0.1:19132
echo   PLAY  (replay)  advertiseHost:playPort   default 127.0.0.1:19133
echo.
echo Edit config.json first (destination, version, advertiseHost).
echo In Minecraft add BOTH servers, or just LIVE and use .play / .live.
echo Chat LIVE:  .start  .stop  .play  .help
echo Chat PLAY:  .help  .live  .pause  .seek  .me ...
echo.
node src\cli.js start %*
if errorlevel 1 (
  echo.
  echo Failed. Install Node.js 18+ and run: node -v
  pause
)
