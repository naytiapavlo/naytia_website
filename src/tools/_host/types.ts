/**
 * 工具宿主契约（docs/plans/03 第 4/5 节）。
 * 工具只依赖本文件，不依赖宿主实现、不依赖其他工具，也不依赖 DOM 之外的框架。
 */

export type ToolStatus = 'planned' | 'experimental' | 'stable' | 'deprecated';

/** 执行位置。当前两个工具都是纯函数，诚实标注为 inline；没有假装成 Worker。 */
export type ExecutionMode = 'inline' | 'worker' | 'wasm-worker' | 'server';

/** 结构化错误（03 文档第 5 节）。code 供程序分支，message 供人读。 */
export interface ToolError {
  code: string;
  message: string;
  field?: string;
  retryable: boolean;
}

/**
 * 计算结果。用判别联合而不是抛异常：
 * 「输入不合法」「规则不支持」都是正常返回，只有内部故障才是异常。
 */
export type ToolResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; error: ToolError };

/** 计算上下文。首版只有 rulesetId 有语义；signal 留给未来的 Worker 化。 */
export interface ComputeContext {
  rulesetId: string;
  signal: AbortSignal;
  reportProgress?: (completed: number, total?: number) => void;
}

export interface ToolEngine<I, O> {
  /** 当前实现版本，随算法语义变化递增（规则版本单独管理，见 03 文档第 7 节）。 */
  readonly implementationVersion: string;
  run(input: I, context: ComputeContext): Promise<ToolResult<O>>;
}

/** 校验结果：解析成功即得到规范化后的 I，失败给出可读错误。 */
export type SchemaResult<I> = { ok: true; value: I } | { ok: false; error: ToolError };

export interface ToolSchema<I> {
  readonly inputSchemaVersion: number;
  /** 规范化并按运行时规则校验输入；不对非法值「猜测修复」。 */
  parse(raw: unknown): SchemaResult<I>;
}

export interface RelatedContent {
  kind: 'post' | 'work';
  /** 稳定 ID（slug），不是显示名 */
  id: string;
  label: string;
}

/**
 * 工具的完整定义。列表页只读 registry 里的轻量 manifest，
 * 进入详情页才通过本对象拿到 view 与 engine（03 文档第 4 节）。
 */
export interface ToolHostConfig<I, O> {
  id: string;
  slug: string;
  title: string;
  summary: string;
  /** 像素图标 symbol id，见 BaseLayout 的 SVG sprite */
  icon: string;
  category: string;
  tags: string[];
  status: ToolStatus;
  /** 用途一句话，详情页副标题 */
  purpose: string;
  /** 适用范围（版本/平台限制），未验证的必须写清楚 */
  scope: string;
  implementationVersion: string;
  inputSchemaVersion: number;
  executionMode: ExecutionMode;
  /** 规则集 ID，记录在每次结果里以便复现（03 文档第 7 节） */
  supportedRulesetIds: string[];
  rulesetId: string;
  /** 算法依据、限制与版本说明的补充段（渲染为纯文本段落） */
  notes: string[];
  relatedContent: RelatedContent[];
  schema: ToolSchema<I>;
  engine: ToolEngine<I, O>;
  /** 挂载工具专属输入输出界面；返回清理函数，离开页面时释放。 */
  mount(container: HTMLElement, context: ToolViewContext<I, O>): void | (() => void);
}

/** 传给工具界面的上下文：工具通过它请求宿主执行计算，不自己调 engine。 */
export interface ToolViewContext<I, O> {
  /** 执行一次计算：内部完成 schema 校验 → engine.run → 统一错误处理。 */
  compute(raw: unknown): Promise<ToolResult<O>>;
  /** 展示可选的做法示例（首版未启用，保留扩展点） */
  readonly examples: ReadonlyArray<{ label: string; input: I }>;
}

/**
 * 擦除具体输入/输出类型的宿主配置，供注册表按 slug 存放。
 *
 * 这样做是安全的：实例当前挂载的输入输出类型未知，所以调用方只能传 unknown 进
 * compute（出参仍是 unknown），运行时行为与类型化版本完全一致。
 * 之所以需要显式擦除，是因为 mount 的参数是逆变的，TypeScript 不会自动把
 * ToolHostConfig<A, B> 当作 ToolHostConfig<unknown, unknown> 接受。
 */
export type ErasedToolConfig = ToolHostConfig<unknown, unknown>;

export function eraseToolTypes<I, O>(config: ToolHostConfig<I, O>): ErasedToolConfig {
  return config as unknown as ErasedToolConfig;
}

export type AnyToolConfig = ErasedToolConfig;
