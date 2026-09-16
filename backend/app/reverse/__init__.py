"""逆向工作台模块（docs/plans/07）。

对外只暴露 router 与 service，其他模块不要直接 import 本包的内部实现
（与 02 文档「跨模块只通过公开导出引用」一致）。
"""
from .client import ReverseService, get_reverse_service
from .mcp_client import IdaMcpClient, IdaMcpError, get_ida_client

__all__ = [
    "ReverseService",
    "get_reverse_service",
    "IdaMcpClient",
    "IdaMcpError",
    "get_ida_client",
]
