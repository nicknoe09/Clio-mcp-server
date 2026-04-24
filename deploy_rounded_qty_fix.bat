@echo off
cd /d "C:\Users\nnoe\Desktop\Claude MCP\clio-mcp-server"

echo === Clio MCP Server: rounded_quantity fix ===
echo.

echo [1/3] Building TypeScript...
call npm run build
if errorlevel 1 (
    echo ERROR: Build failed. Fix TypeScript errors above.
    pause
    exit /b 1
)
echo Build OK.
echo.

echo [2/3] Committing...
git add -A
git commit -m "fix: use rounded_quantity instead of quantity for accurate billed hours

All tools now read Clio's rounded_quantity field (billed hours rounded
to billing increment) instead of raw quantity (actual tracked seconds).
Fixes underreported hours across get_time_entries, generate_weekly_goals,
audit tools, scorecard, performance reports, and /review route.

Files changed: time.ts, performance.ts, scorecard.ts, auditTime.ts,
audit.ts, routes/review.ts"
echo.

echo [3/3] Pushing to GitHub...
git push origin master
if errorlevel 1 (
    echo ERROR: Push failed.
    pause
    exit /b 1
)

echo.
echo === Done. Railway auto-deploys on push. ===
echo.
echo VERIFY: After deploy, run in Claude:
echo   get_time_entries user_id=358550509 start_date=2026-03-01 end_date=2026-03-31
echo   Expected: ~129 billable hours, ~146 total hours
pause
