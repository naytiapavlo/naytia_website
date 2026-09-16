/** 站点配置 API：GET 公开；PUT 仅超级管理员（服务端强制校验）。 */
import { apiFetch } from '../../shared/api-client';
import type { SiteConfigOverrides } from './types';

interface SiteConfigResponse {
  overrides: SiteConfigOverrides;
  updated_at: string | null;
}

export async function fetchSiteConfig(): Promise<SiteConfigOverrides | null> {
  const res = await apiFetch<SiteConfigResponse>('/api/site-config');
  return res.overrides;
}

export async function saveSiteConfig(patch: SiteConfigOverrides): Promise<SiteConfigOverrides> {
  const res = await apiFetch<SiteConfigResponse>('/api/site-config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  return res.overrides;
}
