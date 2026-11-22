@echo off
setlocal
set "DIST="
if defined GRADLE_HOME if exist "%GRADLE_HOME%\lib\gradle-launcher-8.14.3.jar" set "DIST=%GRADLE_HOME%"
if not defined GRADLE_USER_HOME set "GRADLE_USER_HOME=%USERPROFILE%\.gradle"
if not defined DIST for /d %%i in ("%GRADLE_USER_HOME%\wrapper\dists\gradle-8.14.3-bin\*") do if exist "%%~i\gradle-8.14.3\lib\gradle-launcher-8.14.3.jar" set "DIST=%%~i\gradle-8.14.3"
if not defined DIST (
  echo Gradle 8.14.3 not found. See DEBUG.md for installation. 1>&2
  exit /b 1
)
call "%DIST%\bin\gradle.bat" -p "%~dp0." %*
exit /b %ERRORLEVEL%
