"""模型包：按模块归属拆分（account / forum / favorites / site）。

并行开发约定（docs/plans/02）：各模块的表只在自己的文件里改；
跨模块一律通过本包的公开导出引用，不深改别人的表结构。
"""
from .account import Account, AuthSession, ROLES, utcnow
from .favorites import ToolFavorite
from .forum import ForumReply, ForumThread
from .site import SiteConfigEntry

__all__ = [
    "Account",
    "AuthSession",
    "ROLES",
    "utcnow",
    "ToolFavorite",
    "ForumThread",
    "ForumReply",
    "SiteConfigEntry",
]
