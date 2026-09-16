@echo off
REM ============================================================
REM  一键：构建前端产物 → 开两个窗口跑「后端」与「站点入口」
REM  跑完这个脚本只需要再做一件事：让樱花隧道指向 127.0.0.1:8080
REM  （隧道配置见 docs/plans/14 第 3 节）
REM ============================================================
setlocal
cd /d "%~dp0.."

echo [naytia] 1/3 构建前端产物（Astro → dist\）...
call npm run build || goto :fail

echo [naytia] 2/3 启动后端（新窗口）...
start "naytia backend :8000" cmd /k "%~dp0start-backend.cmd"

echo [naytia] 3/3 启动站点入口（新窗口）...
start "naytia site :8080" cmd /k "%~dp0start-site.cmd"

echo.
echo [naytia] 完成。两个窗口请保持开启；然后确认隧道指向 127.0.0.1:8080。
endlocal
exit /b 0

:fail
echo [naytia] 构建失败，已中止。先修好上面的报错再重跑。
endlocal
exit /b 1
