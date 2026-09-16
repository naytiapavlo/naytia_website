"""AI 助手的配额：滑动窗口计数。

规则来自需求：**普通用户每 5 小时 3 轮**。一轮 = 用户发一条消息
（agent 内部多次工具调用算同一轮，不额外扣）。

身份口径：登录用户按账号 ID，未登录按客户端 IP。这是必要的——否则
同一个访客刷新页面或换浏览器就能重置配额。未登录配额与登录配额相同
（需求没有区分），只是身份来源不同。

实现是**进程内内存**的：重启后端会重置。单机部署够用；
多实例部署需要换成 Redis 或数据库，见 docs/plans/11 的迁移条件。
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Callable

from ..config import AI_ROUNDS_PER_WINDOW, AI_WINDOW_SECONDS


class RateLimiter:
    """滑动窗口限流：只保留窗口内的使用时间戳。"""

    def __init__(self, limit: int = AI_ROUNDS_PER_WINDOW,
                 window_seconds: float = AI_WINDOW_SECONDS,
                 clock: Callable[[], float] | None = None) -> None:
        self.limit = limit
        self.window = window_seconds
        # 注入时钟便于测试，不必真的等 5 小时
        self._now = clock or time.monotonic
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _prune(self, key: str, now: float) -> deque[float]:
        bucket = self._hits[key]
        cutoff = now - self.window
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        return bucket

    def snapshot(self, key: str) -> dict[str, float | int]:
        """不消耗配额，只读当前状态（前端用来显示"还剩几轮"）。"""
        now = self._now()
        bucket = self._prune(key, now)
        used = len(bucket)
        return {
            "limit": self.limit,
            "used": used,
            "remaining": max(0, self.limit - used),
            "reset_in": round(bucket[0] + self.window - now, 1) if bucket else 0.0,
        }

    def consume(self, key: str) -> tuple[bool, dict[str, float | int]]:
        """尝试消耗一轮配额。返回 (是否允许, 状态快照)。"""
        now = self._now()
        bucket = self._prune(key, now)
        if len(bucket) >= self.limit:
            return False, {
                "limit": self.limit,
                "used": len(bucket),
                "remaining": 0,
                "reset_in": round(bucket[0] + self.window - now, 1),
            }
        bucket.append(now)
        return True, {
            "limit": self.limit,
            "used": len(bucket),
            "remaining": max(0, self.limit - len(bucket)),
            "reset_in": round(self.window, 1),
        }

    def reset(self, key: str | None = None) -> None:
        """清空配额。仅测试与运维使用。"""
        if key is None:
            self._hits.clear()
        else:
            self._hits.pop(key, None)


_limiter: RateLimiter | None = None


def get_rate_limiter() -> RateLimiter:
    global _limiter
    if _limiter is None:
        _limiter = RateLimiter()
    return _limiter
