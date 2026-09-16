"""引擎注册表：每个引擎模块提供 validate / run / 版本与规则集常量。"""
from typing import Any, Callable

from . import chunk_coordinates, material_counter

Engine = Callable[[dict[str, Any]], tuple[dict[str, Any], list[str]]]
Validator = Callable[[dict[str, Any]], dict[str, Any]]


class EngineModule:
    def __init__(self, module: Any) -> None:
        self.validate: Validator = module.validate
        self.run: Engine = module.run
        self.implementation_version: str = module.IMPLEMENTATION_VERSION
        self.input_schema_version: int = module.INPUT_SCHEMA_VERSION
        self.ruleset_id: str = module.RULESET_ID


ENGINES: dict[str, EngineModule] = {
    "chunk-coordinates": EngineModule(chunk_coordinates),
    "material-counter": EngineModule(material_counter),
}
