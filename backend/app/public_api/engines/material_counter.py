"""材料清单助手 · Python 移植（与前端 src/tools/material-counter 同规格）。

规则（与 TS 版一致的确定算法）：
- 每种材料：组数 = floor(数量 / 堆叠上限)，余量 = 数量 % 堆叠上限；
  余量不为 0 时仍占 1 格，占用格数 = ceil(数量 / 堆叠上限)。
- 堆叠上限 1 的材料每件占 1 格。
- 容器数 = ceil(总格数 / 容器容量)，不假设最优装箱。
"""
import math
from typing import Any

IMPLEMENTATION_VERSION = "1.0.0"
INPUT_SCHEMA_VERSION = 1
RULESET_ID = "stack-count-v1"

MAX_ENTRIES = 40
MAX_COUNT = 1_000_000_000
MAX_STACK = 64
MAX_SLOTS = 1_000_000
MAX_CONTAINER_SLOTS = 10_000
DEFAULT_NAME = "未命名材料"

CONTAINER_PRESETS = [
    {"id": "none", "label": "不换算容器", "slots": 0},
    {"id": "shulker", "label": "潜影盒（27 格）", "slots": 27},
    {"id": "chest", "label": "箱子 / 木桶（27 格）", "slots": 27},
    {"id": "double-chest", "label": "大箱子（54 格）", "slots": 54},
]


def _int_field(value: Any, field: str, minimum: int, maximum: int, label: str) -> int:
    from ..errors import PublicApiError

    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise PublicApiError(422, "not_an_integer", f"{label} 必须是整数", field=field)
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise PublicApiError(422, "not_an_integer", f"{label} 必须是整数", field=field) from exc
    if not (minimum <= parsed <= maximum):
        raise PublicApiError(
            422,
            "out_of_range",
            f"{label} 需在 {minimum} ~ {maximum} 之间",
            field=field,
        )
    return parsed


def validate(raw: dict[str, Any]) -> dict[str, Any]:
    from ..errors import PublicApiError

    raw_entries = raw.get("entries")
    if not isinstance(raw_entries, list):
        raise PublicApiError(422, "invalid_input", "entries 必须是数组", field="entries")
    if len(raw_entries) > MAX_ENTRIES:
        raise PublicApiError(
            422, "too_many_entries", f"一次最多计算 {MAX_ENTRIES} 条材料", field="entries"
        )

    entries: list[dict[str, Any]] = []
    for index, item in enumerate(raw_entries):
        item = item if isinstance(item, dict) else {}
        field = f"entries.{index}"
        raw_name = item.get("name")
        name = raw_name.strip() if isinstance(raw_name, str) else ""
        if len(name) > 40:
            raise PublicApiError(
                422, "name_too_long", "材料名称请不要超过 40 个字符", field=f"{field}.name"
            )
        count_raw = item.get("count")
        if count_raw in ("", None):
            continue  # 留空视为未填写，跳过该行（与前端一致）
        count = _int_field(
            count_raw, f"{field}.count", 0, MAX_COUNT, f"第 {index + 1} 条数量"
        )
        if count == 0:
            continue
        stack = _int_field(
            item.get("stackSize", 64),
            f"{field}.stackSize",
            1,
            MAX_STACK,
            f"第 {index + 1} 条堆叠上限",
        )
        entries.append(
            {"name": name if name else DEFAULT_NAME, "count": count, "stackSize": stack}
        )

    if not entries:
        raise PublicApiError(
            422, "empty_list", "请至少填写一条材料的数量", field="entries.0.count"
        )

    container_slots = _int_field(
        raw.get("containerSlots", 0), "containerSlots", 0, MAX_CONTAINER_SLOTS, "容器格数"
    )
    container_label = raw.get("containerLabel")
    if container_label is not None and not isinstance(container_label, str):
        raise PublicApiError(422, "invalid_input", "containerLabel 必须是字符串", field="containerLabel")
    label = (container_label or "").strip() or "容器"
    if len(label) > 20:
        raise PublicApiError(422, "invalid_input", "containerLabel 请不要超过 20 个字符", field="containerLabel")

    return {"entries": entries, "containerSlots": container_slots, "containerLabel": label}


def run(inp: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    entries: list[dict[str, Any]] = inp["entries"]
    container_slots: int = inp["containerSlots"]
    container_label: str = inp["containerLabel"]

    lines = []
    for entry in entries:
        count = entry["count"]
        stack = entry["stackSize"]
        full_stacks = count // stack
        lines.append(
            {
                "name": entry["name"],
                "count": count,
                "stackSize": stack,
                "fullStacks": full_stacks,
                "remainder": count % stack,
                "slots": math.ceil(count / stack),
            }
        )

    total_count = sum(line["count"] for line in lines)
    total_full_stacks = sum(line["fullStacks"] for line in lines)
    total_slots = sum(line["slots"] for line in lines)

    warnings: list[str] = []
    if total_slots > MAX_SLOTS:
        warnings.append(f"占用格数超过 {MAX_SLOTS:,} 格，容器换算结果仅供参考。")
    if any(line["stackSize"] == 1 for line in lines):
        warnings.append("存在堆叠上限为 1 的材料，它们每一件都单独占用一格。")

    container = None
    if container_slots > 0:
        need = math.ceil(total_slots / container_slots)
        capacity = need * container_slots
        container = {
            "label": container_label,
            "slots": container_slots,
            "need": need,
            "capacity": capacity,
            "spare": capacity - total_slots,
            "exact": capacity == total_slots,
        }

    formula = [
        f"共 {len(lines)} 种材料、{total_count:,} 件物品。",
        f"合计占用 {total_slots} 格（各材料占用格数之和）。",
    ]
    if container:
        tail = "刚好装满" if container["exact"] else f"最后一个还剩 {container['spare']} 格空位"
        formula.append(
            f"{total_slots} 格 ÷ {container_slots}（每个容器 {container_slots} 格）= 需要 {container['need']} 个{container_label}，{tail}。"
        )
        formula.append("容器数按占用格数换算，未假设多种材料之间的最优装箱。")
    else:
        formula.append("未选择容器，只给出组数与占用格数。")

    data = {
        "lines": lines,
        "totals": {
            "kinds": len(lines),
            "count": total_count,
            "fullStacks": total_full_stacks,
            "slots": total_slots,
        },
        "container": container,
        "formula": formula,
    }
    return data, warnings
