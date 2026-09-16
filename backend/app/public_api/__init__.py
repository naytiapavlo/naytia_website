"""开放工具 API（v1）。

标准与体系见 docs/plans/09-开发者API标准.md 与 ADR-005：
- 统一响应信封（ok / data / meta | error）
- URL 主版本化；每次计算可追溯到工具与规则集版本
- 匿名低限额 + Bearer 密钥高限额；服务端强制限流
"""
from .errors import PublicApiError
from .router import router

__all__ = ["PublicApiError", "router"]
