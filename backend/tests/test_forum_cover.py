"""帖子封面：图片识别、上传校验、提供与删除（docs/plans/12）。

这一组测试要守住的东西按重要性排序：

1. **类型判定只看字节，不看文件名**。封面是全站唯一把用户字节当「可直接渲染的
   内容」发出去的地方，判错了就是存储型 XSS。所以「改名叫 .png 的 HTML」
   与「内嵌脚本的 SVG」都必须是拒绝路径上的断言，而不是「顺便试试」。
2. **尺寸读得对**。列表页靠宽高给图片预留位置（04 文档第 4 节：减少页面位移），
   读错了会让列表在图片加载完的瞬间跳一下。四种格式各自的
   头部布局都不一样，每种都要有对照值。
3. **能传就要能撤**：删除权限与删帖一致，删完之后磁盘上不留文件。
4. **内容寻址的引用计数**：同一张图被两个帖子当封面时，删掉一个不能让另一个 404。
"""
import base64
import hashlib

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.parsers.image_info import ImageFormatError, inspect_image
from tests.conftest import register
from tests.fixtures import image_fixtures as img
from tests.fixtures import mcstructure_fixtures as fx

THREAD_PATH = "/api/forum/threads/with-attachments"


def upload_cover(
    client: TestClient,
    cover: bytes,
    *,
    cover_name: str = "封面.png",
    structure: bytes | None = None,
    structure_name: str = "小屋.mcstructure",
    title: str = "带封面的帖子",
    category: str = "作品展示",
    body: str = "正文内容，超过两个字符。",
):
    """发帖并带封面（可选带结构文件）。"""
    data = {"category": category, "title": title, "body": body}
    files = [("cover", (cover_name, cover, "application/octet-stream"))]
    if structure is not None:
        files.append(("structure", (structure_name, structure, "application/octet-stream")))
    return client.post(THREAD_PATH, data=data, files=files)


def upload_structure_only(client: TestClient, data: bytes, **kwargs):
    """只带结构文件（回归：原有的结构附件链路不能被这次改动打断）。"""
    payload = {
        "category": kwargs.get("category", "作品展示"),
        "title": kwargs.get("title", "只带结构"),
        "body": kwargs.get("body", "正文内容，超过两个字符。"),
    }
    return client.post(
        THREAD_PATH,
        data=payload,
        files={"structure": ("小屋.mcstructure", data, "application/octet-stream")},
    )


# ================================================================ 识别层
#
# 这一层是纯函数，直接测比走 HTTP 更快也更准：HTTP 下面还会叠一层
# 体积上限与权限判断，混在一起就分不清是「认错了」还是「被拦了」。


class TestImageInspection:
    def test_png_宽高(self):
        info = inspect_image(img.png_with_declared_size(1280, 720))
        assert (info.mime, info.extension) == ("image/png", ".png")
        assert (info.width, info.height) == (1280, 720)

    def test_gif_宽高(self):
        info = inspect_image(img.gif(32, 16))
        assert (info.mime, info.extension) == ("image/gif", ".gif")
        assert (info.width, info.height) == (32, 16)

    def test_jpeg_宽高(self):
        info = inspect_image(img.jpeg(48, 36))
        assert (info.mime, info.extension) == ("image/jpeg", ".jpg")
        assert (info.width, info.height) == (48, 36)

    def test_jpeg_元数据很长时仍能找到帧头(self):
        """真实手机照片的 EXIF 可以有几万字节，宽高不在固定偏移上。

        定点读取（比如「取第 20 字节」）在这种文件上会读出垃圾值，
        所以这里专门用一个 8 KB 的 APP1 段把帧头推到后面去。
        """
        info = inspect_image(img.jpeg(1920, 1080, exif_bytes=8192))
        assert (info.width, info.height) == (1920, 1080)

    def test_webp_三种容器都要认(self):
        assert inspect_image(img.webp_lossless(40, 30)).width == 40
        assert inspect_image(img.webp_lossy(41, 31)).width == 41
        extended = inspect_image(img.webp_extended(42, 32))
        assert (extended.width, extended.height) == (42, 32)
        assert extended.mime == "image/webp"

    def test_改名的html不被当成图片(self):
        """文件名说它是 .png，字节说它是 HTML —— 只信文件名的实现会放它进来。"""
        with pytest.raises(ImageFormatError) as excinfo:
            inspect_image(img.fake_png_html())
        assert excinfo.value.code == "unsupported_image"

    def test_内嵌脚本的svg被拒(self):
        for payload in (img.svg_with_script(), img.svg_xml_declaration()):
            with pytest.raises(ImageFormatError) as excinfo:
                inspect_image(payload)
            assert excinfo.value.code == "unsupported_image"
            assert "SVG" in excinfo.value.message

    def test_截断的png被拒(self):
        with pytest.raises(ImageFormatError) as excinfo:
            inspect_image(img.truncated_png())
        assert excinfo.value.code == "invalid_image"

    def test_第一个数据块不是ihdr的png被拒(self):
        with pytest.raises(ImageFormatError):
            inspect_image(img.png_bad_first_chunk())

    def test_截断的jpeg被拒(self):
        with pytest.raises(ImageFormatError) as excinfo:
            inspect_image(img.truncated_jpeg())
        assert excinfo.value.code == "invalid_image"

    def test_尺寸为0的gif被拒(self):
        with pytest.raises(ImageFormatError):
            inspect_image(img.zero_size_gif())

    def test_空文件被拒(self):
        with pytest.raises(ImageFormatError) as excinfo:
            inspect_image(b"")
        assert excinfo.value.code == "empty_file"

    def test_夹具本身能被真正的png解码器接受(self):
        """自校验：夹具不只是「头部像 PNG」，得真的是一张合法 PNG。

        用 zlib 校验 IDAT 与文件尾的 IEND，避免夹具自己写错却一路绿灯。
        """
        import struct
        import zlib

        data = img.png(64, 48)
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        offset = 8
        kinds = []
        while offset < len(data):
            (length,) = struct.unpack(">I", data[offset : offset + 4])
            kind = data[offset + 4 : offset + 8]
            payload = data[offset + 8 : offset + 8 + length]
            (crc,) = struct.unpack(">I", data[offset + 8 + length : offset + 12 + length])
            assert crc == zlib.crc32(kind + payload) & 0xFFFFFFFF, f"{kind} 的 CRC 不对"
            kinds.append(kind)
            offset += 12 + length
        assert kinds == [b"IHDR", b"IDAT", b"IEND"]


# ================================================================ 上传


class TestCoverUpload:
    def test_未登录不能带封面上传(self, client: TestClient):
        res = upload_cover(client, img.png(8, 8))
        assert res.status_code == 401
        assert res.json()["detail"]["code"] == "auth_required"

    def test_发帖并带封面(self, client: TestClient):
        register(client, "楼主")
        res = upload_cover(client, img.png_with_declared_size(1280, 720))
        assert res.status_code == 201, res.text
        body = res.json()

        assert body["has_cover"] is True
        cover = body["cover"]
        assert cover["content_type"] == "image/png"
        assert (cover["width"], cover["height"]) == (1280, 720)
        assert cover["aspect_ratio"] == pytest.approx(1280 / 720)
        assert cover["original_name"] == "封面.png"
        assert cover["byte_size"] > 0
        assert len(cover["sha256"]) == 64
        # 同一个帖子里没有结构文件，两项徽标要各算各的
        assert body["has_structure"] is False
        assert body["structure"] is None

    def test_封面与结构文件可以同时带(self, client: TestClient):
        register(client, "楼主")
        res = upload_cover(client, img.png(16, 9), structure=fx.house())
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["has_cover"] is True
        assert body["has_structure"] is True
        # 结构摘要没被封面挤掉
        assert body["structure"]["solid_cells"] == 170
        # 封面也没被结构挤掉
        assert (body["cover"]["width"], body["cover"]["height"]) == (16, 9)

    def test_只带结构文件仍然可用(self, client: TestClient):
        """回归：把端点从 with-structure 换成 with-attachments 之后，
        原来「只传结构文件」的调用方不能失效。"""
        register(client, "楼主")
        res = upload_structure_only(client, fx.slab(x=2, y=2, z=2))
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["has_structure"] is True
        assert body["has_cover"] is False
        assert body["cover"] is None
        assert [m["count"] for m in body["structure"]["materials"]] == [8]

    def test_两种附件都不带时报错(self, client: TestClient):
        register(client, "楼主")
        res = client.post(
            THREAD_PATH,
            data={"category": "作品展示", "title": "空帖子", "body": "正文内容，超过两个字符。"},
        )
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "empty_upload"

    def test_改名的html封面被拒且不建帖(self, client: TestClient):
        register(client, "楼主")
        res = upload_cover(client, img.fake_png_html(), cover_name="封面.png")
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "unsupported_image"
        # 失败的帖子不该留下
        assert client.get("/api/forum/threads").json()["items"] == []

    def test_svg封面被拒且提示说明原因(self, client: TestClient):
        register(client, "楼主")
        res = upload_cover(client, img.svg_with_script(), cover_name="封面.svg")
        assert res.status_code == 400
        detail = res.json()["detail"]
        assert detail["code"] == "unsupported_image"
        assert "SVG" in detail["message"]
        assert client.get("/api/forum/threads").json()["items"] == []

    def test_损坏图片被拒(self, client: TestClient):
        register(client, "楼主")
        res = upload_cover(client, img.truncated_png())
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "invalid_image"

    def test_封面超过5MB被拒(self, client: TestClient):
        register(client, "楼主")
        res = upload_cover(client, b"\x00" * (5 * 1024 * 1024 + 1))
        assert res.status_code == 413
        assert res.json()["detail"]["code"] == "file_too_large"
        assert "5.00 MB" in res.json()["detail"]["message"]
        assert client.get("/api/forum/threads").json()["items"] == []

    def test_封面被拒时结构文件也不入库(self, client: TestClient):
        """一次请求要么全成，要么全不成——不能留下「有结构没封面」的半成品。"""
        register(client, "楼主")
        res = upload_cover(client, img.fake_png_html(), structure=fx.house())
        assert res.status_code == 400
        assert client.get("/api/forum/threads").json()["items"] == []
        root = get_settings().forum_storage_dir
        assert list(root.rglob("*.mcstructure")) == []

    def test_响应里不出现内部落盘路径(self, client: TestClient):
        register(client, "楼主")
        raw = upload_cover(client, img.png(8, 8)).text
        assert "storage_path" not in raw
        assert "covers/" not in raw
        assert "data/" not in raw

    def test_列表页带封面徽标(self, client: TestClient):
        register(client, "楼主")
        with_cover = upload_cover(client, img.png(8, 8)).json()["id"]
        client.post(
            "/api/forum/threads",
            json={"category": "机制研究", "title": "纯文字帖", "body": "只是聊聊天。"},
        )
        items = {t["id"]: t for t in client.get("/api/forum/threads").json()["items"]}
        assert items[with_cover]["has_cover"] is True
        assert any(t["has_cover"] is False for t in items.values())


# ================================================================ 提供


class TestCoverServing:
    def test_返回的字节与上传一致(self, client: TestClient):
        register(client, "楼主")
        data = img.png_with_declared_size(120, 90)
        thread_id = upload_cover(client, data).json()["id"]
        res = client.get(f"/api/forum/threads/{thread_id}/cover")
        assert res.status_code == 200
        assert res.content == data
        assert res.headers["content-type"] == "image/png"
        assert res.headers["x-content-type-options"] == "nosniff"
        assert "default-src 'none'" in res.headers["content-security-policy"]
        assert res.headers["etag"].strip('"') == hashlib.sha256(data).hexdigest()
        assert res.headers["cache-control"].startswith("public")

    def test_content_type来自字节而不是文件名(self, client: TestClient):
        """文件名叫 .png，内容其实是 GIF —— 返回的必须是 image/gif。

        这是「只信文件名」会直接变成安全问题的那个点：类型由文件名决定的话，
        攻击者能让浏览器按他自己挑的类型解释同一份字节。
        """
        register(client, "楼主")
        thread_id = upload_cover(client, img.gif(10, 10), cover_name="骗你的.png").json()["id"]
        res = client.get(f"/api/forum/threads/{thread_id}/cover")
        assert res.headers["content-type"] == "image/gif"

    def test_未登录也能看封面(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload_cover(client, img.png(8, 8)).json()["id"]
        client.post("/api/auth/logout")
        assert client.get(f"/api/forum/threads/{thread_id}/cover").status_code == 200

    def test_没有封面的帖子返回404(self, client: TestClient):
        register(client, "楼主")
        res = client.post(
            "/api/forum/threads",
            json={"category": "机制研究", "title": "纯文字帖", "body": "只是聊聊天。"},
        )
        thread_id = res.json()["id"]
        denied = client.get(f"/api/forum/threads/{thread_id}/cover")
        assert denied.status_code == 404
        assert denied.json()["detail"]["code"] == "cover_not_found"


# ================================================================ 删除


class TestCoverDeletion:
    def test_作者可以删除封面并清掉磁盘文件(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload_cover(client, img.png(8, 8)).json()["id"]
        root = get_settings().forum_storage_dir
        assert list(root.rglob("covers/*/*.png"))

        assert client.delete(f"/api/forum/threads/{thread_id}/cover").status_code == 204
        assert client.get(f"/api/forum/threads/{thread_id}/cover").status_code == 404
        # 帖子还在，只是没有封面了
        detail = client.get(f"/api/forum/threads/{thread_id}").json()
        assert detail["has_cover"] is False
        assert detail["cover"] is None
        assert list(root.rglob("covers/*/*.png")) == []

    def test_别人不能删我的封面(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload_cover(client, img.png(8, 8)).json()["id"]
        client.post("/api/auth/logout")
        register(client, "路人")
        res = client.delete(f"/api/forum/threads/{thread_id}/cover")
        assert res.status_code == 403
        assert res.json()["detail"]["code"] == "not_owner"

    def test_管理员可以删别人的封面(self, client: TestClient):
        from tests.conftest import make_staff

        # 先建站长（首个账号即 superadmin），再让楼主发帖——
        # make_staff 依赖「站长已存在且是超管」，顺序不能反
        register(client, "站长")
        register(client, "楼主")
        thread_id = upload_cover(client, img.png(8, 8)).json()["id"]
        make_staff(client)
        assert client.delete(f"/api/forum/threads/{thread_id}/cover").status_code == 204

    def test_重复删除返回404(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload_cover(client, img.png(8, 8)).json()["id"]
        assert client.delete(f"/api/forum/threads/{thread_id}/cover").status_code == 204
        assert client.delete(f"/api/forum/threads/{thread_id}/cover").status_code == 404

    def test_删帖子会一并删掉封面(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload_cover(client, img.png(8, 8)).json()["id"]
        root = get_settings().forum_storage_dir
        assert list(root.rglob("covers/*/*.png"))
        assert client.delete(f"/api/forum/threads/{thread_id}").status_code == 204
        assert list(root.rglob("covers/*/*.png")) == []

    def test_同一张图被两个帖子用时删一个不影响另一个(self, client: TestClient):
        """内容寻址最容易踩的坑：同一份字节只落盘一次，删除必须数引用。"""
        register(client, "楼主")
        data = img.png(24, 24)
        first = upload_cover(client, data, title="第一份").json()["id"]
        second = upload_cover(client, data, title="第二份").json()["id"]

        root = get_settings().forum_storage_dir
        assert len(list(root.rglob("covers/*/*.png"))) == 1, "内容相同的封面只应占一份磁盘"

        assert client.delete(f"/api/forum/threads/{first}").status_code == 204
        assert client.get(f"/api/forum/threads/{second}/cover").status_code == 200

    def test_封面路径不可能被拼出危险扩展名(self, client: TestClient):
        """白名单路径：即使有人绕过了图片校验，也拼不出 .html / .svg 的落盘名。"""
        from app.forum_storage import ForumStorageError, cover_relpath, resolve

        digest = "a" * 64
        assert cover_relpath(digest, ".png").endswith(".png")
        for bad in (".html", ".svg", ".php", ".PNG/../x", ""):
            with pytest.raises(ForumStorageError):
                cover_relpath(digest, bad)
        with pytest.raises(ForumStorageError):
            resolve(f"covers/aa/{digest}.html")
        with pytest.raises(ForumStorageError):
            resolve("covers/../../app/main.py")


# ================================================================ 基础数据

def test_封面base64往返() -> None:
    """夹具自检：生成的 PNG 能被 base64 解回原字节（E2E 脚本要把它写进页面）。"""
    data = img.png(4, 4)
    assert base64.b64decode(base64.b64encode(data)) == data
