@echo off
rem Builds the three widget folders and packages each into an .icuewidget file.
rem Needs Corsair's CLI once:  npm install -g icuewidget-cli
cd /d "%~dp0"
node build.js || goto :fail
for %%W in (ClaudeUsage ChatGPTUsage AntigravityUsage) do (
  echo.
  echo === %%W
  call icuewidget package widgets\%%W || goto :fail
)
echo.
echo Done. Look for the .icuewidget files listed above.
pause
exit /b 0
:fail
echo.
echo Failed. Copy the messages above and send them to Claude.
pause
exit /b 1
