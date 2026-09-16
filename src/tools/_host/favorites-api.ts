/**
 * 工具收藏 API（工具箱模块个人数据）。
 * 契约见 backend/app/routers/favorites.py：GET 读取、PUT 添加、DELETE 移除，
 * 三者都返回更新后的完整列表，所以前端不需要自己维护增量状态。
 * 未登录时后端返回 401（ApiError.code === 'auth_required'）。
 */
import { apiFetch } from '../../shared/api-client';

export interface FavoriteList {
  tools: string[];
}

export function fetchFavorites(): Promise<FavoriteList> {
  return apiFetch<FavoriteList>('/api/favorites');
}

export function addFavorite(toolId: string): Promise<FavoriteList> {
  return apiFetch<FavoriteList>(`/api/favorites/${encodeURIComponent(toolId)}`, { method: 'PUT' });
}

export function removeFavorite(toolId: string): Promise<FavoriteList> {
  return apiFetch<FavoriteList>(`/api/favorites/${encodeURIComponent(toolId)}`, { method: 'DELETE' });
}
