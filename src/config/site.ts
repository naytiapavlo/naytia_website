/**
 * 站点配置（SiteConfig，见 docs/plans/03 第 2 节）。
 * 头像、简介、导航、外链、首页入口排序都在这里改，不编辑页面模板。
 */

export interface NavItem {
  href: string;
  label: string;
  /** 像素图标 symbol id，见 BaseLayout 中的 SVG sprite */
  icon: string;
}

export interface SiteConfig {
  /** 站长全名（页脚、论坛署名用） */
  name: string;
  /** 页面展示名 */
  displayName: string;
  /** 品牌后缀 */
  brandSuffix: string;
  description: string;
  avatar: string;
  nav: NavItem[];
  links: {
    bilibili: string;
  };
  /** 首页入口卡片的顺序 */
  homeEntries: Array<{ href: string; icon: string; title: string; summary: string }>;
}

export const site: SiteConfig = {
  name: 'Naytia_帕芙洛',
  displayName: '帕芙洛',
  brandSuffix: '的小小世界',
  description: 'Naytia_帕芙洛的个人小站。记录日常，探索 Minecraft，分享作品与技术工具，还有一个玩家小论坛。',
  avatar: '/avatar.png',
  nav: [
    { href: '/', label: '首页', icon: 'i-home' },
    { href: '/works/', label: '作品', icon: 'i-grid' },
    { href: '/tools/', label: '工具箱', icon: 'i-tool' },
    { href: '/docs/', label: '文档树', icon: 'i-note' },
    { href: '/forum/', label: '论坛', icon: 'i-chat' },
  ],
  links: {
    bilibili: 'https://space.bilibili.com/',
  },
  homeEntries: [
    { href: '/works/', icon: 'i-grid', title: '去看看我的作品', summary: '一些研究，一些方块之间的创造。' },
    { href: '/tools/', icon: 'i-tool', title: '打开玩家工具箱', summary: '让重复的事情，变得简单一点。' },
    { href: '/blog/', icon: 'i-note', title: '读一读博客', summary: '视频之外，用文字记录探索的过程。' },
    { href: '/docs/', icon: 'i-note', title: '翻翻文档树', summary: '基岩版机制与漏洞研究的笔记合集，边读边搜。' },
    { href: '/forum/', icon: 'i-chat', title: '来论坛聊聊', summary: '登录后发帖回复；机制、作品与互助的小广场。' },
  ],
};
