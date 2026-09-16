"""开发期临时后端：把 AI 配额放大到 100，用来隔离验证 tool_calls 是否回传。

用法：python tests/manual/dev_server_bigquota.py [port]
它是**验证工具**，不是产品代码。
"""
import sys
from pathlib import Path

import uvicorn

# 这个脚本在 tests/manual/ 下，直接跑时 backend/ 不在 sys.path 里
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import app.config as config  # noqa: E402

# 必须在 create_app 之前改：限流器读的是模块级常量
config.AI_ROUNDS_PER_WINDOW = 100

from app.main import app  # noqa: E402

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8012
    uvicorn.run(app, port=port, log_level="warning")
