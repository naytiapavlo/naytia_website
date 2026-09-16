# 真实结构文件夹具

本目录存放**真实游戏导出**的 `.mcstructure`，用于回归测试。

## 为什么需要它

`../../fixtures/mcstructure_fixtures.py` 生成的夹具是按
[bedrock.dev 格式文档](https://wiki.bedrock.dev/nbt/mcstructure) 手工构造的。
手工夹具能覆盖边界与畸形输入，但**测不出「文档与真实文件不一致」**——
这个风险已经真实发生过一次（见下）。所以真实文件必须留一份。

## 文件清单

| 文件 | 来源 | SHA-256 | 内容 |
| --- | --- | --- | --- |
| `sticky-piston-1x1x1.mcstructure` | 站长用游戏内 Structure Block 导出，2026-06-17 | `c73bea3fcf741b29356918cc8e1eeb97fbc40ff9d0b6d5f3737977a78bd7cac8` | 1×1×1，单个粘性活塞（`facing_direction=2`）+ `PistonArm` 方块实体 |

文件很小（515 字节），可以放心入库。

## 它暴露过的格式差异（重要）

**`structure_world_origin` 的层级与文档不一致。**

- bedrock.dev 文档：写在 `structure` 复合体**内部**。
- 真实文件：写在**根层级**，与 `format_version` / `size` 同级。本目录这份的实际取值是 `[72, 59, -10]`。

旧实现只按文档查 `structure` 内部，结果**解析不报错、但原点静默变成 `None`**——
正是那种最难发现的 bug。现在 `parse_mcstructure` 两处都探测，并用
`world_origin_source`（`'root'` / `'structure'` / `None`）标明取值来源。

交叉验证：该文件方块实体 `PistonArm` 的 NBT 里 `x/y/z = 72/59/-10`，
与根层级的原点完全一致（那是该方块的绝对世界坐标）。两处互相印证，
所以「原点」与「方块实体 NBT」这两条读取路径都对得上。

## 为什么这些文件直接读、不做成生成器

真实文件是**证据**，必须原样保留：一旦用代码「重新生成」，它就退化成了另一个手工夹具，
也就无法再发现文档与实现的偏差。因此回归测试直接读本目录的字节。

## 新增真实文件的约定

1. 文件名用「内容-尺寸」描述，如 `sticky-piston-1x1x1.mcstructure`。
2. 在 test 里断言**具体数值**（尺寸、调色板、方块数量、方块实体字段），不要只断言「不报错」。
3. 在 `backend/tests/test_real_files.py` 登记，并记录 SHA-256。
4. 若新文件暴露了与旧文件不同的格式差异，务必在
   `docs/plans/decisions/ADR-003-基岩版结构文件解析器.md` 里补记。
