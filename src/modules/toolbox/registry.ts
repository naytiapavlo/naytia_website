/**
 * 工具注册表（契约见 docs/plans/03 第 4 节）。
 * 阶段 3：每个可运行工具在 src/tools/<id>/ 建独立目录并在此登记；
 * 列表页只读取这份可序列化 manifest，不加载工具实现。
 * status='planned' 的工具不渲染任何可运行入口（01 文档第 6 节）。
 */

export type ToolStatus = 'planned' | 'experimental' | 'stable' | 'deprecated';

export interface ToolManifest {
  id: string;
  slug: string;
  title: string;
  summary: string;
  icon: string;
  status: ToolStatus;
}

export const toolStatusLabels: Record<ToolStatus, string> = {
  planned: '概念预览',
  experimental: '实验性',
  stable: '可用',
  deprecated: '已弃用',
};

export const toolRegistry: ToolManifest[] = [
  {
    id: 'chunk-coordinates',
    slug: 'chunk-coordinates',
    title: '区块与坐标助手',
    summary: '区块定位、相对坐标与维度换算。',
    icon: 'i-target',
    status: 'planned',
  },
  {
    id: 'redstone-clock',
    slug: 'redstone-clock',
    title: '红石时序计算器',
    summary: '游戏刻换算，梳理周期与频率。',
    icon: 'i-bolt',
    status: 'planned',
  },
  {
    id: 'material-counter',
    slug: 'material-counter',
    title: '材料清单助手',
    summary: '把物品数量换算成组数和盒数。',
    icon: 'i-box',
    status: 'planned',
  },
];
