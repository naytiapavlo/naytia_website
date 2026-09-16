/**
 * 文档树工具的前端类型与 API 客户端。
 * 类型与 `backend/app/schemas_docs.py` 一一对应；字段变更时两边一起改。
 */
import { API_BASE, ApiError, apiFetch } from '../../shared/api-client';

export type Visibility = 'public' | 'members' | 'staff';
export type DocFormat = 'md' | 'txt' | 'json';
export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type SubmissionAction =
  | 'create_doc'
  | 'update_doc'
  | 'move_doc'
  | 'create_folder'
  | 'move_folder'
  | 'delete_doc'
  | 'delete_folder';

export interface FileRef {
  id: number;
  name: string;
  doc_format: DocFormat;
  byte_size: number;
  sha256: string;
  created_at: string;
}

export interface DocumentOut {
  id: number;
  parent_id: number | null;
  slug: string;
  title: string;
  summary: string;
  doc_format: DocFormat;
  visibility: Visibility;
  updated_at: string;
  published: boolean;
  file: FileRef;
}

export interface FolderNode {
  id: number;
  parent_id: number | null;
  name: string;
  path: string;
  visibility: Visibility;
  created_at: string;
  updated_at: string;
  published: boolean;
  children: FolderNode[];
  documents: DocumentOut[];
}

export interface TreeStats {
  folders: number;
  documents: number;
  published_documents: number;
  total_bytes: number;
}

export interface TreeResponse {
  root: FolderNode;
  stats: TreeStats;
  viewer_role: string | null;
}

export interface DocumentDetail extends DocumentOut {
  body: string;
  revision_no: number;
  revision_at: string | null;
  byte_size: number;
}

export interface SearchHit {
  id: number;
  title: string;
  path: string;
  doc_format: DocFormat;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  total: number;
  truncated: boolean;
  hits: SearchHit[];
}

export interface DocsPermissions {
  role: string | null;
  can_read_drafts: boolean;
  can_upload: boolean;
  can_submit: boolean;
  can_review: boolean;
  can_publish_directly: boolean;
  /** 移动 / 重命名：管理员提交单，超管直接生效 */
  can_organize: boolean;
  /** 删除：管理员提交单，超管直接生效 */
  can_delete: boolean;
}

/** 超管直接执行的结果。管理员走提交单，拿到的是 SubmissionOut。 */
export interface DirectActionOut {
  ok: boolean;
  message: string;
  document_id: number | null;
  folder_id: number | null;
  path: string | null;
  affected_documents: number;
}

export interface DocsInfo {
  allowed_extensions: string[];
  max_bytes: number;
  max_bytes_label: string;
  storage_dir: string;
  search_limit: number;
  review_required: boolean;
  notes: string[];
}

export interface SubmissionOut {
  id: number;
  action: SubmissionAction;
  status: SubmissionStatus;
  target_kind: string;
  document_id: number | null;
  folder_id: number | null;
  parent_id: number | null;
  parent_path: string | null;
  /** 移动类提交单的目标位置：'漏洞bug分析/8848yyds' 或 '（根目录）' */
  target_path: string | null;
  title: string;
  name: string;
  summary: string;
  visibility: Visibility;
  note: string;
  file: FileRef | null;
  body_preview: string;
  submitted_by: number | null;
  submitted_by_name: string | null;
  created_at: string;
  reviewed_by: number | null;
  reviewed_by_name: string | null;
  review_note: string;
  reviewed_at: string | null;
  applied_document_id: number | null;
  applied_folder_id: number | null;
}

export interface SubmissionList {
  items: SubmissionOut[];
  pending_total: number;
}

export interface UploadInit {
  upload_id: string;
  chunk_size: number;
  max_bytes: number;
  doc_format: DocFormat;
}

export interface UploadedFile extends FileRef {
  text_content: string | null;
  preview_lines: number;
}

/** 分片上传：按顺序切片、逐片提交，最后带上总长度收尾（服务端会核对）。 */
export async function uploadFile(
  file: File,
  onProgress?: (sent: number, total: number) => void,
): Promise<UploadedFile> {
  const init = await apiFetch<UploadInit>('/api/docs/uploads', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, total_bytes: file.size }),
  });
  const size = Math.min(init.chunk_size, 8 * 1024 * 1024);
  const total = Math.max(1, Math.ceil(file.size / size));
  for (let index = 0; index < total; index += 1) {
    const blob = file.slice(index * size, Math.min(file.size, (index + 1) * size));
    const form = new FormData();
    form.append('chunk', blob, `part-${index}`);
    const res = await fetch(
      `${API_BASE}/api/docs/uploads/${init.upload_id}/chunks?index=${index}`,
      { method: 'POST', body: form, credentials: 'include' },
    );
    if (!res.ok) throw await toApiError(res);
    onProgress?.(Math.min(file.size, (index + 1) * size), file.size);
  }
  const finish = new FormData();
  finish.append('filename', file.name);
  finish.append('total_bytes', String(file.size));
  const res = await fetch(`${API_BASE}/api/docs/uploads/${init.upload_id}/finish`, {
    method: 'POST',
    body: finish,
    credentials: 'include',
  });
  if (!res.ok) throw await toApiError(res);
  const body = (await res.json()) as UploadedFile & { file: FileRef; doc_format: DocFormat };
  return { ...body.file, text_content: body.text_content, preview_lines: body.preview_lines };
}

async function toApiError(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as
    | { detail?: { code?: string; message?: string } }
    | null;
  const detail = data?.detail;
  return new ApiError(res.status, detail?.code ?? 'http_error',
    detail?.message ?? `请求失败（${res.status}）`);
}

export const docsApi = {
  info: () => apiFetch<DocsInfo>('/api/docs/info'),
  permissions: () => apiFetch<DocsPermissions>('/api/docs/permissions'),
  tree: () => apiFetch<TreeResponse>('/api/docs/tree'),
  document: (id: number) => apiFetch<DocumentDetail>(`/api/docs/documents/${id}`),
  search: (query: string, limit?: number) =>
    apiFetch<SearchResponse>(
      `/api/docs/search?q=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ''}`,
    ),
  submissions: (scope: 'mine' | 'pending') =>
    apiFetch<SubmissionList>(`/api/docs/submissions?scope=${scope}`),
  submit: (payload: Record<string, unknown>) =>
    apiFetch<SubmissionOut>('/api/docs/submissions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  withdraw: (id: number) =>
    apiFetch<SubmissionOut>(`/api/docs/submissions/${id}/withdraw`, { method: 'POST' }),
  review: (id: number, decision: 'approve' | 'reject', note = '') =>
    apiFetch<SubmissionOut>(
      `/api/docs/review/${id}?decision=${decision}&note=${encodeURIComponent(note)}`,
      { method: 'POST' },
    ),

  // ---- 超管直接操作：立即生效，不走提交单（服务端按角色拦截） ----
  moveDocumentNow: (id: number, parentId: number | null, note = '') =>
    apiFetch<DirectActionOut>(`/api/docs/documents/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ document_id: id, parent_id: parentId, note }),
    }),
  renameDocumentNow: (id: number, title: string, note = '') =>
    apiFetch<DirectActionOut>(`/api/docs/documents/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ title, note }),
    }),
  deleteDocumentNow: (id: number, note = '') =>
    apiFetch<DirectActionOut>(
      `/api/docs/documents/${id}?note=${encodeURIComponent(note)}`,
      { method: 'DELETE' },
    ),
  moveFolderNow: (id: number, parentId: number | null, note = '') =>
    apiFetch<DirectActionOut>(`/api/docs/folders/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ folder_id: id, parent_id: parentId, note }),
    }),
  renameFolderNow: (id: number, name: string, note = '') =>
    apiFetch<DirectActionOut>(`/api/docs/folders/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name, note }),
    }),
  deleteFolderNow: (id: number, note = '') =>
    apiFetch<DirectActionOut>(`/api/docs/folders/${id}?note=${encodeURIComponent(note)}`, {
      method: 'DELETE',
    }),

  downloadUrl: (fileId: number) => `${API_BASE}/api/docs/files/${fileId}/download`,
  contentUrl: (fileId: number, disposition: 'inline' | 'attachment' = 'inline') =>
    `${API_BASE}/api/docs/files/${fileId}/content?disposition=${disposition}`,
};

export const FORMAT_LABELS: Record<DocFormat, string> = {
  md: 'Markdown',
  txt: '纯文本',
  json: 'JSON',
};

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: '所有人可见',
  members: '仅登录会员',
  staff: '仅管理员',
};

export const ACTION_LABELS: Record<SubmissionAction, string> = {
  create_doc: '新增文档',
  update_doc: '更新文档',
  move_doc: '移动文档',
  create_folder: '新建文件夹',
  move_folder: '移动文件夹',
  delete_doc: '删除文档',
  delete_folder: '删除文件夹',
};

export const STATUS_LABELS: Record<SubmissionStatus, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
};
