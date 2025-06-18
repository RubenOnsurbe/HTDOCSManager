@echo off
REM This batch file opens VS Code with the specified path
REM Usage: vscode-opener.bat [path]

if "%1"=="" (
    echo No path specified
    exit /b 1
)

REM Try with direct path
"C:\Program Files\Microsoft VS Code\Code.exe" "%~1" 2>nul
if %ERRORLEVEL% == 0 exit /b 0

REM Try with command
code "%~1" 2>nul
if %ERRORLEVEL% == 0 exit /b 0

REM Try with VSCodium if VS Code is not available
"C:\Program Files\VSCodium\VSCodium.exe" "%~1" 2>nul
if %ERRORLEVEL% == 0 exit /b 0

echo Failed to open VS Code with the path: %1
exit /b 1
