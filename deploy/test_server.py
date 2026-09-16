"""站点入口（deploy/server.py）的对照测试。

盯的是「部署以后才会暴露、本地开发看不出来」的那几件事：

1. 访客真实 IP 的解析规则。穿透链路上 socket 地址永远是 127.0.0.1，
   照抄会让所有访客共用一份配额；而 XFF 前半段访客完全可控，只能读
   樱花追加的尾部。这两个方向都会出错，所以逐条钉住。
2. 路径 → 文件的映射与目录穿越。
3. 转发首部：逐跳首部必须丢、客户端伪造的转发头必须丢。

运行（无额外依赖，只用标准库）：
    python deploy/test_server.py
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_edge():
    """按文件路径加载 server.py（它不在包内，避免依赖 sys.path 顺序）。"""
    spec = importlib.util.spec_from_file_location("naytia_edge", HERE / "server.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["naytia_edge"] = module
    spec.loader.exec_module(module)
    return module


edge = _load_edge()


def scope(*, xff: str | None = None, client=("127.0.0.1", 41234),
          proto: str | None = None, path: str = "/", host: bytes = b"example.com",
          extra=()) -> dict:
    headers = [(b"host", host)]
    if xff is not None:
        headers.append((b"x-forwarded-for", xff.encode("latin-1")))
    if proto is not None:
        headers.append((b"x-forwarded-proto", proto.encode("latin-1")))
    headers.extend(extra)
    return {"type": "http", "method": "GET", "path": path, "scheme": "http",
            "headers": headers, "client": client, "server": ("127.0.0.1", 8080)}


class TrustedProxyTest(unittest.TestCase):
    def test_loopback_and_private_are_our_own_chain(self) -> None:
        for ip in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3",
                   "172.20.0.9", "192.168.31.239", "169.254.1.1", "fe80::1"):
            with self.subTest(ip=ip):
                self.assertTrue(edge._trusted_proxy(ip), ip)

    def test_public_addresses_are_visitors(self) -> None:
        for ip in ("203.0.113.77", "198.51.100.4", "198.18.0.5", "8.8.8.8",
                   "2001:db8::1", "240e:390:1234::1"):
            with self.subTest(ip=ip):
                self.assertFalse(edge._trusted_proxy(ip), ip)

    def test_garbage_is_treated_as_untrusted(self) -> None:
        # 不是合法 IP 的条目不能当成「自己人」，否则访客随便写点东西就能把自己抹掉
        self.assertTrue(edge._trusted_proxy(""))
        self.assertTrue(edge._trusted_proxy("not-an-ip"))


class ClientIpTest(unittest.TestCase):
    def test_local_visit_falls_back_to_socket_address(self) -> None:
        """没有穿透的本地访问：socket 就是访客，XFF 留空交给后端按 socket 记账。"""
        self.assertIsNone(edge._client_ip(scope(), True))

    def test_sakura_http_tunnel_single_entry(self) -> None:
        """樱花 HTTP 隧道把访客 IP 追加到 XFF，单个条目就是访客本人。"""
        self.assertEqual(edge._client_ip(scope(xff="203.0.113.77"), True), "203.0.113.77")

    def test_spoofed_prefix_never_wins(self) -> None:
        """XFF 前半段访客可控，只有樱花追加的尾部可信。"""
        s = scope(xff="1.2.3.4, 5.6.7.8, 203.0.113.77")
        self.assertEqual(edge._client_ip(s, True), "203.0.113.77")

    def test_spoof_only_attaches_the_spoofed_address(self) -> None:
        """记录一个**已知的、被接受的**取舍，而不是假装它不存在。

        如果隧道不是 HTTP 类型（改用了 TCP 隧道），樱花就不会追加真实 IP，
        此时 XFF 里只有访客自己写的值，而本入口无从分辨——他会以那个地址记账。
        影响范围仅限「按 IP 的配额计数」，拿不到任何权限；而且只要按部署手册
        用 HTTP 隧道（尾部的真实 IP 一定存在）就不会出现这种情况。
        见 docs/plans/14 第 3 节与第 7 节的已知边界。
        """
        s = scope(xff="1.2.3.4", client=("127.0.0.1", 1))
        self.assertEqual(edge._client_ip(s, True), "1.2.3.4")

    def test_trust_disabled_ignores_headers_entirely(self) -> None:
        s = scope(xff="203.0.113.77")
        self.assertIsNone(edge._client_ip(s, False))

    def test_private_hop_is_skipped(self) -> None:
        # 本地开发时也可能出现「127.0.0.1, 192.168.1.20」这种全内网链
        s = scope(xff="127.0.0.1, 192.168.1.20")
        self.assertIsNone(edge._client_ip(s, True))


class ForwardedHeaderTest(unittest.TestCase):
    def test_hop_by_hop_and_client_supplied_headers_are_dropped(self) -> None:
        s = scope(xff="203.0.113.77", extra=[
            (b"connection", b"keep-alive"),
            (b"transfer-encoding", b"chunked"),
            (b"x-real-ip", b"6.6.6.6"),
            (b"forwarded", b"for=6.6.6.6"),
            (b"cookie", b"naytia_session=abc"),
        ])
        names = {k.decode().lower(): v for k, v in edge._request_headers(s, trust_proxy_xff=True)}
        self.assertNotIn("connection", names)
        self.assertNotIn("transfer-encoding", names)
        self.assertNotIn("forwarded", names)
        self.assertNotIn("host", names)          # Host 由 httpx 按后端地址重写
        # 访客自带的 x-real-ip 被丢弃，换成解析出来的真实 IP
        self.assertEqual(names["x-real-ip"], b"203.0.113.77")
        self.assertEqual(names["x-forwarded-for"], b"203.0.113.77")
        # 会话 Cookie 必须原样送给后端，否则登录态在同源部署下会失效
        self.assertEqual(names["cookie"], b"naytia_session=abc")

    def test_forwarded_proto_only_accepts_legal_values(self) -> None:
        good = edge._request_headers(scope(proto="https"), trust_proxy_xff=True)
        self.assertIn((b"x-forwarded-proto", b"https"), good)
        # 非法取值不能进后端（Cookie 的 Secure 判断依赖它）
        bad = edge._request_headers(scope(proto="javascript:alert(1)"), trust_proxy_xff=True)
        self.assertIn((b"x-forwarded-proto", b"http"), bad)

    def test_proto_ignored_when_trust_disabled(self) -> None:
        headers = edge._request_headers(scope(proto="https"), trust_proxy_xff=False)
        self.assertIn((b"x-forwarded-proto", b"http"), headers)


class ResponseHeaderTest(unittest.TestCase):
    def test_hop_by_hop_headers_are_stripped(self) -> None:
        out = edge._response_headers(
            [(b"content-type", b"text/html"), (b"transfer-encoding", b"chunked"),
             (b"connection", b"keep-alive"), (b"content-length", b"12")],
            is_html=True, immutable=False)
        names = {k.decode() for k, _ in out}
        self.assertNotIn("transfer-encoding", names)
        self.assertNotIn("connection", names)
        self.assertIn("content-length", names)
        self.assertIn((b"cache-control", b"no-cache"), out)

    def test_hashed_assets_are_immutable(self) -> None:
        out = edge._response_headers([(b"content-type", b"text/css")],
                                     is_html=False, immutable=True)
        cache = dict(out)[b"cache-control"]
        self.assertIn(b"immutable", cache)
        self.assertIn(b"max-age=31536000", cache)

    def test_bytes_values_are_not_stringified(self) -> None:
        # 这里踩过一次坑：httpx 的 raw 给 bytes，若走 str() 会得到 "b'12'"
        out = edge._response_headers([(b"content-length", b"12")],
                                     is_html=False, immutable=False)
        self.assertIn((b"content-length", b"12"), out)


class StaticRoutingTest(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = edge.DIST_DIR
        edge.DIST_DIR = HERE / "_tmp_dist"
        (edge.DIST_DIR / "blog").mkdir(parents=True, exist_ok=True)
        (edge.DIST_DIR / "index.html").write_text("home", encoding="utf-8")
        (edge.DIST_DIR / "blog" / "index.html").write_text("blog", encoding="utf-8")
        (edge.DIST_DIR / "404.html").write_text("miss", encoding="utf-8")

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(edge.DIST_DIR, ignore_errors=True)
        edge.DIST_DIR = self._saved

    def test_root_serves_index(self) -> None:
        self.assertEqual(edge._resolve_file("/").name, "index.html")

    def test_directory_serves_its_index(self) -> None:
        self.assertEqual(edge._resolve_file("/blog/").parent.name, "blog")

    def test_missing_page_is_none(self) -> None:
        self.assertIsNone(edge._resolve_file("/nope"))

    def test_traversal_is_refused(self) -> None:
        for attack in ("/../server.py", "/..%2fserver.py", "/blog/../../server.py",
                       "/....//server.py"):
            with self.subTest(attack=attack):
                resolved = edge._resolve_file(attack)
                self.assertIsNone(resolved, f"{attack} 竟然解析到了 {resolved}")

    def test_slashless_directory_wants_redirect(self) -> None:
        self.assertTrue(edge._html_wants_index("/blog"))
        self.assertFalse(edge._html_wants_index("/blog/"))
        self.assertFalse(edge._html_wants_index("/blog/index.html"))
        self.assertFalse(edge._html_wants_index("/nope"))

    def test_backend_only_covers_api_prefix(self) -> None:
        self.assertTrue(edge._backend_path("/api/health"))
        self.assertTrue(edge._backend_path("/api/docs"))
        self.assertTrue(edge._backend_path("/api/openapi.json"))
        # 站点自己的 /docs/（文档树）绝对不能转给后端
        self.assertFalse(edge._backend_path("/docs/"))
        self.assertFalse(edge._backend_path("/docs"))
        self.assertFalse(edge._backend_path("/"))
        self.assertFalse(edge._backend_path("/apiary"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
