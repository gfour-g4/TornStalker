@echo off
cd /d C:\path\to\your\bot

git fetch

for /f %%A in ('git show origin/main:version.txt') do set REMOTE=%%A
for /f %%A in (version.txt) do set LOCAL=%%A

if "%REMOTE%"=="%LOCAL%" exit /b

git pull
taskkill /F /IM node.exe >nul 2>&1
npm start
