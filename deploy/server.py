"""Naytia 站点对外入口：静态产物 + 后端 API 的反向代理（同源单端口）。

为什么需要它（docs/plans/14 第 2 节）：Astro 产物是静态文件，后端是可选的
FastAPI 服务。若让内网穿透直接指向其中一端，就会出现两种坏结果——
要么 /api 无处可去，要么前后端变成两个来源（跨站 Cookie 被浏览器拦掉、
CORS 预检全都要单独放行）。这里用**一个本地端口**同时承载两者：

    GET  /             → dist/index.html（Astro 产物，直接读磁盘）
    GET  /_astro/*.js  → dist/_astro/...（immutable 缓存）
    *    /api/...      → 转发到 127.0.0.1:8000（FastAPI）
    *    /openapi.json, /docs → 同样转发（FastAPI 自带的接口文档）

于是浏览器看到的「站点」只有一个来源，会话 Cookie 按 SameSite=Lax 正常工作，
隧道只需要一条、指向一个端口。

依赖：只用项目已有的 httpx + uvicorn（backend/requirements.txt），不新增任何
东西，也不引入 nginx/caddy 这类需要另行安装的二进制。

启动：
    python deploy/server.py                  # 127.0.0.1:8080
    python deploy/server.py --port 9000      # 换端口
    python deploy/server.py --backend http://127.0.0.1:8000

真正的请求头由自己的脚本设置（见 deploy/start-backend.cmd），本文件不做鉴权，
只监听回环地址，不要直接暴露到公网。
"""
from __future__ import annotations

import argparse
import ipaddress
import logging
import mimetypes
import os
import sys
import time
from pathlib import Path

import httpx
import uvicorn

logger = logging.getLogger("naytia.edge")

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = Path(os.environ.get("NAYTIA_DIST_DIR") or ROOT / "dist")
BACKEND_ORIGIN = os.environ.get("NAYTIA_BACKEND_ORIGIN", "http://127.0.0.1:8000")
DEFAULT_PORT = int(os.environ.get("NAYTIA_EDGE_PORT", "8080"))

# 转发到后端的路径前缀。后端的路由本身就带 /api 前缀，所以原样转发。
API_PREFIX = "/api"
# FastAPI 自带的接口文档与契约文件也挂在 /api 下：站点自己有 /docs/（文档树）
# 与 /redoc 无关，挪到 /api/docs 才不会和访客页面抢同一个 URL（见 main.py）。
BACKEND_PATHS: tuple[str, ...] = ()

# 逐跳首部（RFC 9110 §7.6.1）：只对相邻的那一跳有意义，代理不得转发
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

# 长缓存：Astro 产物的文件名带内容哈希，内容一变文件名就变
IMMUTABLE_PREFIXES = ("/_astro/",)
IMMUTABLE_MAX_AGE = 60 * 60 * 24 * 365

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")


class ClientGone(Exception):
    """客户端在上传途中断开（关页面 / 取消请求）。"""


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# 「我们自己这一串代理」会用的地址：回环、链路本地、RFC 1918 私网、CGNAT。
# 这里必须逐个列出来，不能用 ipaddress 的 is_private——它把 198.18.0.0/15、
# 198.51.100.0/24、203.0.113.0/24 这类保留段也算作 private，一旦访客恰好来自
# 那些网段就会被误判成代理、真实 IP 被丢掉（deploy/test_server.py 有对照用例）。
_TRUSTED_NETWORKS = tuple(
    ipaddress.ip_network(cidr) for cidr in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "169.254.0.0/16",
        "fe80::/10",
        "fc00::/7",
    )
)


def _trusted_proxy(ip: str) -> bool:
    """这段地址是不是「我们自己这一串代理」——它们的 XFF 条目不代表访客。"""
    if not ip:
        return True
    text = ip.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    try:
        addr = ipaddress.ip_address(text)
    except ValueError:
        return True  # 不是合法 IP，宁可当成不可信链来处理
    if addr.is_loopback:
        return True
    # IPv4-mapped IPv6（::ffff:192.168.1.5）按其 IPv4 语义判断
    if addr.version == 6 and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
        if addr.is_loopback:
            return True
    return any(addr in net for net in _TRUSTED_NETWORKS if net.version == addr.version)


def _client_ip(scope, trust_proxy_xff: bool) -> str | None:
    """访客的真实 IP。

    为什么不是直接取 socket 地址：正式链路上访客在内网穿透的另一头，
    socket 地址永远是 127.0.0.1（frpc 在本机），照抄就会让所有访客共用一份
    配额、也可能被当成同一个登录来源。

    樱花的 **HTTP 隧道**会把访客 IP **追加到 X-Forwarded-For 尾部**
    （官方文档 bestpractice/realip：XFF 前半段访客完全可控，只应读最后一个）。
    所以这里的规则是：从右往左走，跳过属于我们自己这一串代理的地址，
    取第一个不属于它的地址；越靠左的条目一律不采信。若整条链都是本机地址
    （说明没有穿透、访客就在本机），返回 None，交给后端按 socket 地址记账。
    """
    if trust_proxy_xff:
        chain = [_first(scope, b"x-forwarded-for") or ""]
        entries = [part.strip() for part in chain[0].split(",") if part.strip()]
        for entry in reversed(entries):
            if not _trusted_proxy(entry):
                return entry
    client = scope.get("client")
    if client and client[0] and not _trusted_proxy(client[0]):
        return client[0]
    return None


def _request_headers(scope, *, trust_proxy_xff: bool) -> list[tuple[bytes, bytes]]:
    """构造转发给后端的首部：去掉逐跳首部，重建 X-Forwarded-*。

    转发头一律由本进程重写（不原样透传），否则访客可以自己塞一个
    X-Forwarded-For 冒充别人。
    """
    forwarded: list[tuple[bytes, bytes]] = []
    real_ip = _client_ip(scope, trust_proxy_xff)
    for name, value in scope.get("headers") or ():
        lower = name.decode("latin-1").lower()
        if lower in HOP_BY_HOP or lower == "host":
            continue
        if lower in ("x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
                     "x-real-ip", "forwarded"):
            continue
        forwarded.append((name, value))
    host = _first(scope, b"host") or f"127.0.0.1:{scope.get('server', ('', 0))[1]}"
    # 协议：HTTPS 隧道会带 X-Forwarded-Proto，Cookie 的 Secure 属性依赖它，
    # 所以只在取值合法时采信（本地直连时就是 http）。
    proto = "http"
    if trust_proxy_xff:
        candidate = (_first(scope, b"x-forwarded-proto") or "").split(",")[0].strip().lower()
        if candidate in ("http", "https"):
            proto = candidate
    if real_ip:
        forwarded.append((b"x-forwarded-for", real_ip.encode("latin-1")))
        forwarded.append((b"x-real-ip", real_ip.encode("latin-1")))
    forwarded.append((b"x-forwarded-proto", proto.encode("latin-1")))
    forwarded.append((b"x-forwarded-host", host.encode("latin-1")))
    return forwarded


def _to_bytes(value) -> bytes:
    """首部值统一成 bytes：httpx 的 raw 给 bytes，我们自己传 str。"""
    if isinstance(value, bytes):
        return value
    return str(value).encode("latin-1")


def _response_headers(
    headers: list[tuple[bytes | str, bytes | str]],
    *,
    is_html: bool,
    immutable: bool,
) -> list[tuple[bytes, bytes]]:
    """构造回给客户端的首部：同样去掉逐跳首部，再补上站点自己的策略。"""
    out: list[tuple[bytes, bytes]] = []
    seen: set[bytes] = set()
    for name, value in headers:
        name_b = _to_bytes(name)
        lower = name_b.lower()
        if lower.decode("latin-1") in HOP_BY_HOP:
            continue
        out.append((name_b, _to_bytes(value)))
        seen.add(lower)
    if immutable:
        out.append((b"cache-control", f"public, max-age={IMMUTABLE_MAX_AGE}, immutable".encode()))
        seen.add(b"cache-control")
    elif is_html and b"cache-control" not in seen:
        # 页面不缓存：改了内容重新构建后，访客刷新就能看到
        out.append((b"cache-control", b"no-cache"))
    if b"x-content-type-options" not in seen:
        out.append((b"x-content-type-options", b"nosniff"))
    return out


def _first(scope, key: bytes) -> str | None:
    for name, value in scope.get("headers") or ():
        if name.lower() == key:
            return value.decode("latin-1")
    return None


def _accepts_gzip(scope) -> bool:
    enc = (_first(scope, b"accept-encoding") or "").lower()
    return "gzip" in enc


def _backend_path(path: str) -> bool:
    """这个路径该转给后端吗？

    必须按整段判断，不能只用 startswith("/api")：那样 /apiary 之类的
    普通页面路径也会被抢走，站点自己的页面就永远打不开了。
    """
    return path == API_PREFIX or path.startswith(API_PREFIX + "/") or path in BACKEND_PATHS


# ---------------------------------------------------------------- 静态文件

def _resolve_file(path: str) -> Path | None:
    """把 URL 路径映射到 dist/ 下的真实文件；目录则回落到 index.html。

    返回 None 表示没有对应文件（交给 404 页）。绝对路径与 .. 都已被挡在外面。
    """
    if "\x00" in path:
        return None
    rel = path.lstrip("/")
    candidate = (DIST_DIR / rel).resolve()
    try:
        candidate.relative_to(DIST_DIR)
    except ValueError:
        return None
    if candidate.is_file():
        return candidate
    if candidate.is_dir():
        index = candidate / "index.html"
        if index.is_file():
            return index
    # 无扩展名的路径也试一下 .html（构建格式为 directory，正常不会走到）
    if not candidate.suffix and candidate.with_suffix(".html").is_file():
        return candidate.with_suffix(".html")
    return None


def _etag_of(stat: os.stat_result) -> str:
    return f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'


def _html_wants_index(path: str) -> bool:
    """访客访问的是目录而不是具体页面吗？这类请求需要临时 302 补斜杠。"""
    if path.endswith("/") or path.endswith(".html"):
        return False
    candidate = (DIST_DIR / path.lstrip("/")).resolve()
    try:
        candidate.relative_to(DIST_DIR)
    except ValueError:
        return False
    return candidate.is_dir() and (candidate / "index.html").is_file()


async def _serve_static(send, scope, path: str, method: str) -> int:
    """返回实际发出的状态码，供访问日志使用。"""
    if _html_wants_index(path):
        target = path + "/"
        query = scope.get("query_string") or b""
        if query:
            target += "?" + query.decode("latin-1")
        await send({"type": "http.response.start", "status": 302,
                    "headers": [(b"location", target.encode("latin-1")),
                                (b"content-length", b"0")]})
        await send({"type": "http.response.body", "body": b""})
        return 302

    file = _resolve_file(path)
    if file is None:
        return await _serve_404(send)

    stat = file.stat()
    etag = _etag_of(stat)
    if (_first(scope, b"if-none-match") or "") == etag:
        await send({"type": "http.response.start", "status": 304,
                    "headers": [(b"etag", etag.encode()), (b"cache-control", b"no-cache")]})
        await send({"type": "http.response.body", "body": b""})
        return 304

    content_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
    is_html = content_type.startswith("text/html")
    immutable = any(path.startswith(p) for p in IMMUTABLE_PREFIXES)
    headers = [(b"content-type", f"{content_type}; charset=utf-8".encode()
                if content_type.startswith("text/") or content_type.endswith("json")
                else content_type.encode()),
               (b"content-length", str(stat.st_size).encode()),
               (b"etag", etag.encode()),
               (b"last-modified", time.strftime("%a, %d %b %Y %H:%M:%S GMT",
                                                time.gmtime(stat.st_mtime)).encode())]
    headers = _response_headers(headers, is_html=is_html, immutable=immutable)
    await send({"type": "http.response.start", "status": 200, "headers": headers})
    if method == "HEAD":
        await send({"type": "http.response.body", "body": b""})
        return 200
    with file.open("rb") as fh:
        while chunk := fh.read(262144):
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
    await send({"type": "http.response.body", "body": b""})
    return 200


async def _serve_404(send) -> int:
    page = DIST_DIR / "404.html"
    if page.is_file():
        body = page.read_bytes()
        await send({"type": "http.response.start", "status": 404, "headers": [
            (b"content-type", b"text/html; charset=utf-8"),
            (b"content-length", str(len(body)).encode()),
            (b"cache-control", b"no-cache"),
            (b"x-content-type-options", b"nosniff"),
        ]})
        await send({"type": "http.response.body", "body": body})
        return 404
    body = "404 Not Found".encode()
    await send({"type": "http.response.start", "status": 404, "headers": [
        (b"content-type", b"text/plain; charset=utf-8"),
        (b"content-length", str(len(body)).encode()),
    ]})
    await send({"type": "http.response.body", "body": body})
    return 404


# ---------------------------------------------------------------- 应用

class Edge:
    def __init__(self, backend: str, *, trust_proxy_xff: bool = True) -> None:
        self.backend = backend
        self.trust_proxy_xff = trust_proxy_xff
        self.client: httpx.AsyncClient | None = None

    async def startup(self) -> None:
        # 传输层重试交给上层，这里只管转发；连接池按上传并发的量级给
        self.client = httpx.AsyncClient(
            base_url=self.backend,
            timeout=httpx.Timeout(connect=10.0, read=300.0, write=300.0, pool=30.0),
            limits=httpx.Limits(max_connections=64, max_keepalive_connections=16),
            follow_redirects=False,
            trust_env=False,
        )

    async def shutdown(self) -> None:
        if self.client is not None:
            await self.client.aclose()

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await self.startup()
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await self.shutdown()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
            return

        if scope["type"] != "http":
            # 本站没有 WebSocket 端点（前端不连实时通道），静态产物里也没有 HMR
            await send({"type": "websocket.close", "code": 1000})
            return

        path = scope.get("path") or "/"
        method = scope.get("method", "GET")
        started = time.perf_counter()
        status = 0
        try:
            if _backend_path(path):
                status = await self._proxy(scope, receive, send)
            elif method in ("GET", "HEAD"):
                status = await _serve_static(send, scope, path, method)
            else:
                body = "Method Not Allowed".encode()
                await send({"type": "http.response.start", "status": 405, "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                    (b"allow", b"GET, HEAD"),
                ]})
                await send({"type": "http.response.body", "body": body})
                status = 405
        except ClientGone:
            logger.info("客户端中断 %s %s", method, path)
            return
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            logger.error("后端连不上（%s）：%s", self.backend, exc)
            await self._fail(send, 502, "后端服务不可达", "后端没有在运行，或端口不对。")
            status = 502
        except httpx.HTTPError as exc:
            logger.error("转发 %s %s 失败：%s", method, path, exc)
            await self._fail(send, 502, "网关错误", "转发到后端时出错，请看后端日志。")
            status = 502
        finally:
            if status:
                logger.info("%s %s %s %d %.0fms", _now(), method, path, status,
                            (time.perf_counter() - started) * 1000)

    async def _fail(self, send, status: int, title: str, detail: str) -> None:
        body = (
            "<!doctype html><meta charset=\"utf-8\">"
            "<title>{0}</title>"
            "<body style=\"font:16px/1.6 system-ui;max-width:36rem;margin:12vh auto;padding:0 1.5rem\">"
            "<h1 style=\"font-size:1.25rem\">{1}</h1><p>{2}</p>"
            "<p style=\"color:#666\">Naytia 站点入口（deploy/server.py）</p>"
        ).format(title, title, detail).encode("utf-8")
        await send({"type": "http.response.start", "status": status, "headers": [
            (b"content-type", b"text/html; charset=utf-8"),
            (b"content-length", str(len(body)).encode()),
            (b"cache-control", b"no-store"),
        ]})
        await send({"type": "http.response.body", "body": body})

    async def _proxy(self, scope, receive, send) -> int:
        assert self.client is not None
        path = scope.get("path") or "/"
        query = scope.get("query_string") or b""
        url = path + (("?" + query.decode("latin-1")) if query else "")
        headers = _request_headers(scope, trust_proxy_xff=self.trust_proxy_xff)

        # 请求体直通：.mcstructure（≤32 MB）与文档树分块上传都从这里过，
        # 不落盘也不整体读进内存，边收边转。
        async def body_stream():
            while True:
                message = await receive()
                kind = message["type"]
                if kind == "http.request":
                    if message.get("body"):
                        yield message["body"]
                    if not message.get("more_body"):
                        return
                elif kind == "http.disconnect":
                    raise ClientGone()

        request = self.client.build_request(
            scope.get("method", "GET"), url, headers=headers, content=body_stream()
        )
        upstream = await self.client.send(request, stream=True)
        try:
            content_type = upstream.headers.get("content-type", "")
            is_html = content_type.startswith("text/html")
            immutable = any(path.startswith(p) for p in IMMUTABLE_PREFIXES)
            out_headers = _response_headers(
                list(upstream.headers.raw), is_html=is_html, immutable=immutable
            )
            # 后端会自行 gzip，这里去掉 content-length 的歧义交给 httpx 处理
            await send({"type": "http.response.start", "status": upstream.status_code,
                        "headers": out_headers})
            if scope.get("method") == "HEAD":
                await send({"type": "http.response.body", "body": b""})
            else:
                async for chunk in upstream.aiter_raw():
                    await send({"type": "http.response.body", "body": chunk,
                                "more_body": True})
                await send({"type": "http.response.body", "body": b""})
            return upstream.status_code
        finally:
            await upstream.aclose()


def build_app(backend: str, *, trust_proxy_xff: bool = True):
    return Edge(backend, trust_proxy_xff=trust_proxy_xff)


def main(argv: list[str] | None = None) -> int:
    global DIST_DIR
    parser = argparse.ArgumentParser(description="Naytia 站点入口：静态产物 + 后端 API 反代")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认只监听本机）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（默认 8080）")
    parser.add_argument("--backend", default=BACKEND_ORIGIN, help="后端 FastAPI 基地址")
    parser.add_argument("--dist", default=str(DIST_DIR), help="静态产物目录（默认 dist/）")
    parser.add_argument("--log-level", default="info")
    parser.add_argument(
        "--trust-proxy-xff",
        dest="trust_proxy_xff",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="采信上游代理放进 X-Forwarded-For 的访客 IP（默认开）。"
             "本入口只监听回环、上游是樱花隧道时应当保持开启；"
             "如果哪天直接把本入口暴露到公网，用 --no-trust-proxy-xff 关掉。",
    )
    args = parser.parse_args(argv)

    DIST_DIR = Path(args.dist).resolve()

    logging.basicConfig(level=logging.INFO, format="%(message)s",
                        stream=sys.stdout, force=True)
    # httpx 会把每个转发请求按 INFO 打一行「HTTP Request: ...」，和本进程自己的
    # 访问日志完全重复，静音掉它，只保留出错信息。
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if not DIST_DIR.is_dir():
        logger.warning("静态产物目录不存在：%s（先执行 npm run build）", DIST_DIR)
    logger.info("站点入口已就绪：http://%s:%d  →  静态 %s + 后端 %s",
                args.host, args.port, DIST_DIR, args.backend)
    logger.info("访客真实 IP：%s",
                "取上游 X-Forwarded-For 尾部（樱花 HTTP 隧道会追加）"
                if args.trust_proxy_xff else "只用 socket 地址（不采信转发头）")

    uvicorn.run(
        build_app(args.backend, trust_proxy_xff=args.trust_proxy_xff),
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        access_log=False,        # 访问日志由本进程自己打（顺带记录耗时）
        proxy_headers=False,     # 对外这一层不信任任何转发头
        server_header=False,
        date_header=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
