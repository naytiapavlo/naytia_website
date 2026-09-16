@echo off
REM ============================================================
REM  启动站点入口（静态产物 + /api 反向代理）—— 127.0.0.1:8080
REM  「樱花」隧道要指向的就是这个端口（本地 IP 127.0.0.1、本地端口 8080），
REM  隧道里绑定的域名是 www.naytia.io（见 docs/plans/14 第 3 节）。
REM  改端口：python deploy\server.py --port 9000，隧道那边同步改。
REM ============================================================
setlocal
cd /d "%~dp0.."

if not exist "dist\index.html" (
  echo [naytia] dist\ 里没有构建产物，先构建一次 ...
  call npm run build || goto :fail
)

echo [naytia] 启动站点入口 http://127.0.0.1:8080 ...
python deploy\server.py --host 127.0.0.1 --port 8080

:fail
endlocal
