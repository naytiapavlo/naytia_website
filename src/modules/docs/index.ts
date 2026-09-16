/**
 * 文档树模块（docs）的公开入口。
 *
 * 页面只 import 这一个文件（docs/README 第 1 条：模块只有一个公开入口）；
 * API 类型与请求封装留在 api.ts，只有需要单独测渲染时才直接引 markdown.ts。
 */
export { initDocsView } from './ui';
export { renderDocument, type HeadingRef, type RenderResult } from './markdown';
export {
  ACTION_LABELS,
  FORMAT_LABELS,
  STATUS_LABELS,
  VISIBILITY_LABELS,
  docsApi,
  uploadFile,
  type DirectActionOut,
  type DocFormat,
  type DocsInfo,
  type DocsPermissions,
  type DocumentDetail,
  type DocumentOut,
  type FolderNode,
  type SearchHit,
  type SearchResponse,
  type SubmissionAction,
  type SubmissionOut,
  type SubmissionStatus,
  type TreeResponse,
  type Visibility,
} from './api';
