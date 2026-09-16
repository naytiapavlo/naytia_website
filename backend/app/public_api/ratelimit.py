"""进程内滑动窗口限流（09 标准：anonymous 30/min，standard 密钥 300/min）。

单进程内存实现，进程重启即清零；多实例部署时替换为 Redis（05 阶段 6）。
"""
import threading
import time
from dataclasses import dataclass, field

WINDOW_SECONDS = 60.0

TIERS: dict[str, int] = {
    "anonymous": 30,
    "standard": 300,
}


@dataclass
class _Window:
    hits: list[float] = field(default_factory=list)


class RateLimiter:
    def __init__(self) -> None:
        self._windows: dict[str, _Window] = {}
        self._lock = threading.Lock()

    def reset(self) -> None:
        """清空窗口（测试用；进程内实现不跨重启）。"""
        with self._lock:
            self._windows.clear()

    def check(self, identity: str, tier: str) -> tuple[bool, int, int, float]:
        """返回 (allowed, limit, remaining, retry_after_seconds)。"""
        limit = TIERS.get(tier, TIERS["anonymous"])
        now = time.monotonic()
        with self._lock:
            window = self._windows.setdefault(identity, _Window())
            window.hits = [t for t in window.hits if now - t < WINDOW_SECONDS]
            if len(window.hits) >= limit:
                retry_after = WINDOW_SECONDS - (now - window.hits[0])
                return False, limit, 0, max(retry_after, 0.0)
            window.hits.append(now)
            return True, limit, limit - len(window.hits), 0.0


rate_limiter = RateLimiter()
