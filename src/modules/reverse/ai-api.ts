/**
 * AI 助手 API 客户端（docs/plans/11）。
 * 契约与 backend/app/ai/schemas.py 一一对应。
 */
import { apiFetch } from '../../shared/api-client';

export interface WorkspaceContext {
  module?: string | null;
  base_address?: string | null;
  selected_name?: string | null;
  selected_addr?: string | null;
  total_functions?: number | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<Record<string, unknown>> | null;
  tool_call_id?: string | null;
}

export interface ToolCallInfo {
  name: string;
  label: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface ChatResponse {
  reply: string;
  messages: ChatMessage[];
  tool_calls: ToolCallInfo[];
  remaining: number;
  limit: number;
  reset_in: number;
  truncated: boolean;
}

export interface QuotaInfo {
  configured: boolean;
  limit: number;
  used: number;
  remaining: number;
  reset_in: number;
  identity: 'account' | 'ip';
}

export const aiApi = {
  quota: () => apiFetch<QuotaInfo>('/api/ai/quota'),

  chat: (payload: {
    message: string;
    history: ChatMessage[];
    context?: WorkspaceContext;
    port?: number | null;
  }) =>
    apiFetch<ChatResponse>('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

/** 把剩余秒数说成人话。 */
export function humanizeReset(seconds: number): string {
  if (seconds <= 0) return '现在';
  const total = Math.ceil(seconds / 60);
  if (total < 60) return `约 ${total} 分钟`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `约 ${hours} 小时` : `约 ${hours} 小时 ${minutes} 分`;
}
