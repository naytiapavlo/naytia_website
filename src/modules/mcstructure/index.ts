/**
 * mcstructure 模块公开接口（唯一入口，见 src/modules/README.md 的模块约定）。
 *
 * 职责：基岩版结构文件（.mcstructure）的上传与解析结果访问。
 * 类型全部来自后端 OpenAPI 生成的 `src/ports/api-schema.d.ts`，
 * 不在前端重复维护一份字段定义（ADR-001）。
 *
 * 依赖方向：本模块只依赖 `shared/api-client` 与 `ports/api-schema`，
 * 不感知 account / site-config / toolbox。
 */
export {
  fetchBlocks,
  fetchInfo,
  fetchSlice,
  fetchVoxels,
  lookupPosition,
  parseStructure,
  type BlockCountEntry,
  type BlockEntityEntry,
  type EntityEntry,
  type ParseOptions,
  type PositionLookup,
  type StructureIndex,
  type StructureInfo,
  type StructureResponse,
  type VoxelLayer,
  type VoxelSlice,
} from './api';
export {
  formatBytes,
  positionToIndex,
  summarize,
  type StructureSummary,
} from './present';
