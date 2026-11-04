@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Starting CRM (3100) and Agent (3200) in separate windows...
echo Keep both windows open. Closing them stops the services.
echo.

start "CRM 3100" cmd /k "npm run dev"
start "Agent 3200" cmd /k "cd agent && .venv\Scripts\python.exe app.py"

echo Done. Open http://127.0.0.1:3100/agent after both windows show "Ready" / "Application startup complete".
timeout /t 5 >nul
