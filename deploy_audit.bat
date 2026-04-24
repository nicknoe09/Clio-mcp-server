@echo off
cd /d "C:\Users\nnoe\Desktop\Claude MCP\clio-mcp-server"

echo === Clio MCP — Build and Deploy ===
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
git add src\tools\audit.ts
git commit -m "feat: HC fee audit pre-flagging improvements"
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
pause
