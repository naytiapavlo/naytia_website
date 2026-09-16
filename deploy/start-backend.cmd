@echo off
REM ============================================================
REM  启动后端（FastAPI）—— 只监听本机，供 deploy/server.py 转发
REM  用法：双击本文件，或在项目根目录执行 deploy\start-backend.cmd
REM
REM  --forwarded-allow-ips=127.0.0.1 的含义：
REM    隧道与本机入口都是回环地址，它们放进 X-Forwarded-For 的客户端 IP
REM    会被 uvicorn 采信并还原成 request.client.host。这样 AI 助手配额、
REM    公开 API 配额才能按「真实访客」记账，而不是所有访客共用一份
REM    （改这一项要同步 docs/plans/14 与 ADR-008 的记录）。
REM  这里**不写** 0.0.0.0：后端永远不需要被公网直接访问，出口只有隧道。
REM ============================================================
setlocal
cd /d "%~dp0..\backend"

echo [naytia] 启动后端 127.0.0.1:8000 ...
python -m uvicorn app.main:app ^
  --host 127.0.0.1 ^
  --port 8000 ^
  --proxy-headers ^
  --forwarded-allow-ips=127.0.0.1

endlocal
