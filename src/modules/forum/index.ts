/**
 * forum 模块公开接口（唯一入口，见 src/modules/README.md 的模块约定）。
 *
 * 职责：论坛帖子的读写（列表 / 详情 / 发帖 / 回复 / 删除），
 * 以及随帖附件——`.mcstructure` 结构文件的材料清单与 3D 预览、帖子封面图。
 *
 * 依赖方向：本模块依赖 `shared/api-client`、`shared/toast`、`ports/api-schema`
 * 与 `modules/account`（会话与登录入口）；不感知 site-config / site-admin / tools。
 *
 * 类型全部来自后端 OpenAPI 生成的 `src/ports/api-schema.d.ts`，
 * 不在前端重复维护一份字段定义（ADR-001）。
 */
export {
  coverUrl,
  createReply,
  createThread,
  createThreadWithAttachments,
  deleteCover,
  deleteReply,
  deleteThread,
  fetchCategories,
  fetchRenderPayload,
  fetchThread,
  fetchThreads,
  parseUtc,
  structureFileUrl,
  type AttachmentUpload,
  type MaterialEntry,
  type PageResult,
  type ReplySummary,
  type StructureRenderPayload,
  type ThreadCover,
  type ThreadDetail,
  type ThreadStructure,
  type ThreadSummary,
  type ThreadQuery,
} from './api';
export {
  compressionText,
  coverCropHint,
  coverFormatLabel,
  coverSizeText,
  formatBytes,
  formatCount,
  formatRatio,
  formatStates,
  materialTotals,
  relativeTime,
  sortMaterials,
  structureFacts,
  structureWarnings,
  type MaterialTotals,
} from './present';
export { blockColor, cssColor, displayBlockName, type BlockColor } from './block-colors';
export {
  buildShell,
  decodeRenderPayload,
  fitView,
  indexToPosition,
  isSolid,
  planFrame,
  viewBasis,
  visibleFaceMask,
  VoxelPayloadError,
  type FramePlan,
  type RenderPayloadJson,
  type VoxelModel,
  type VoxelShell,
} from './voxel';
export { mountVoxelView, type VoxelViewOptions } from './voxel-view';
export { mountForum } from './ui';
