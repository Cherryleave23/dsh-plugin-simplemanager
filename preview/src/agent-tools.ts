/**
 * 面向 AGENT 的闭环能力层（v6）：把插件管家的热插拔闭环暴露成 DSH 进程内 agent 可直接调用的 tool。
 *
 * 本文件是「纯契约层」——只定义 DTO 形状 + AgentOps 接口 + defineTool 注册，不持有任何运行状态。
 * 执行逻辑（makeAgentOps）在 index.ts apply 内闭包构造，能访问 tempInfos/loaderLiveMap/buildView/
 * 各操作函数等全部内部状态；赋值逻辑与工具契约在此解耦。
 *
 * 接入通道：DSH 进程内 agent 看不到 HTTP 路由，只能调用 `ctx.tools.register(defineTool(...))` 注册的
 * tool 服务（@deepseek-ai/dsh-tools）。tool 的 description + parameters schema 自动流入 agent 的
 * system prompt，模型据此发现并正确传参。为避免污染无 tools 的宿主，注册走 ctx.get('tools') 动态探测。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** pm.status 返回的语义化现状快照（闭环的「眼睛」）。 */
export type StatusDTO = {
  name: string
  /** 是否出现在当前装配/物理残留里（完全缺席=false）。 */
  present: boolean
  /** 来源/附着轴（与 runtime 轴解耦）：会话热装=temporary、持久装配(含官方/壳)=persistent、物理残留=orphan。 */
  phase: 'temporary' | 'persistent' | 'orphan' | 'absent'
  /** 运行态轴（fiber phase）：none=无 runtime entry；disabled=entry 已停用。 */
  runtime: 'active' | 'disabled' | 'failed' | 'pending' | 'loading' | 'disposed' | 'unloading' | 'none'
  /** 作用域：official | shell | third。 */
  scope: 'official' | 'shell' | 'third'
  /** 是否可临时热装（会在 tempRemove 顺畅回收的判定）。 */
  hotLoadable: boolean
  /** 不可热装时的原因（可热装则为 null）。 */
  reason: string | null
  /** 依赖闭包大小（本次热装补装的包数）。 */
  depCount: number
  /** 挂起等待哪些服务（基础门禁下未命中白名单的服务名）。 */
  pendingServices: string[]
  /** 是否以可回收残留存在（orphan，可卸载清洗）。 */
  cleanupable: boolean
  /** 运行时 entryId（已装配时有值）。 */
  entryId: string | null
}

/** 一次操作的单步骤结果。 */
export type OpStep = {
  key: string
  status: 'idle' | 'running' | 'ok' | 'err'
  elapsed?: string
  note?: string
}

/** 变更操作（tempLoad/tempRemove/promote/uninstall）的统一结果。 */
export type OpResult = {
  ok: boolean
  action: 'tempLoad' | 'tempRemove' | 'promote' | 'uninstall'
  packageName?: string
  /** 门禁/装配终态：pass=通过、fail=失败、pending=将挂起等待。 */
  outcome: 'pass' | 'fail' | 'pending'
  steps: OpStep[]
  residue: boolean
  error?: string
  /** 操作后的下一步引导（如「带前端板块时需调 pm_reloadClient 重载才可见」），agent 据此衔接链路。 */
  hint?: string
}

/** 触发「刷新渲染进程」（reloadClient）的结果：仅登记信号，零检测、零阻塞。 */
export type ReloadClientDTO = {
  ok: boolean
  nonce?: string
  note: string
}

/** L0 真实探针（pm_probe）的结果：外置隔离实例的三态判定 + 逐步报告 + 归因。
 * 单候选与批量共存（specs）共用此形态：批量时 plugins 为共存名单、name 省略。 */
export type ProbeDTO = {
  ok: boolean
  /** 单候选探针时的包名（批量时省略，用 plugins 名单）。 */
  name?: string
  /** 共存于本隔离实例的候选插件名单。 */
  plugins: string[]
  /** 批量探针标记（specs 传入时置 probe-batch）。 */
  action?: 'probe-batch'
  outcome: 'pass' | 'crash' | 'hang' | 'render-crash' | 'error'
  rendered: boolean
  /** 崩溃/挂起时从启动日志定位到的候选插件。 */
  culprit?: { id: string | null; name: string } | null
  steps: string[]
  summary?: string
  error?: string
  elapsedMs: number
  /** 批量探针：解析失败的候选（附原因），不影响其余候选共存探测。 */
  unresolved?: Array<{ spec: string; name?: string; reason: string }>
  /** keep 模式：判定通过后保留隔离实例与副本（keptUrl 供浏览器人工检查）。 */
  kept?: boolean
  keptPid?: number
  keptPort?: number
  keptUrl?: string
  keptDir?: string
}

/** 执行器接口：index.ts 的 makeAgentOps 闭包实现，供本文件的 defineTool 薄装配。 */
export type AgentOps = {
  status(name: string): StatusDTO
  tempLoad(spec: string): Promise<OpResult>
  tempRemove(name: string): Promise<OpResult>
  promote(name: string): Promise<OpResult>
  uninstall(name: string, clearData?: boolean): Promise<OpResult>
  reloadClient(): ReloadClientDTO
  probe(name: string | undefined, keep: boolean, spec?: string): Promise<ProbeDTO>
  probeMany(specs: string[], keep: boolean): Promise<ProbeDTO>
}

// —— tool 参数/输出 schema（dsh schema DSL，auto-flow 进 agent system prompt）——

/* 字面量 schema 需 as const 保持 type 判别式（string/boolean/array/json）不被拓宽，否则失配 ValueSchemaSpec。 */
const PARAM_NAMES = { name: { type: 'string', required: true, description: '插件包名（用返回的 packageName，同名热装可能带 -hotN，勿用路径/原名）' } } as const
const PARAM_SPEC = { spec: { type: 'string', required: true, description: '插件源，三种形态任选：① registry 包名，如 foo 或 foo@1.2.0；② 本地插件目录路径（绝对或相对，如 D:/AI/dsh-coder/dsh-plugins/spectree/dsh-v0.1.1-rc.2 或 ./plugin）；③ 显式 file:/link: 前缀路径。要求目标是一个可解析插件包：目录/registry 包含 package.json（有规范 name + 可加载 main/exports 入口），且本地路径须为纯 ASCII（含中文/日文路径会被 pnpm 截断安装失败）' } } as const
const PARAM_OP = {
  name: { type: 'string', required: true, description: '插件包名（用 package.json 的 name，见 pm_tempLoad 返回的 packageName），不会用入参路径' },
  clearData: { type: 'boolean', description: '卸载时是否同时清除该插件的自持数据（默认 false）' },
} as const
const OUT_SCHEMA = { type: 'json' } as const

/** 把任意 DTO 渲染成模型可见的单块文本。 */
function text(v: unknown): { type: 'text'; text: string }[] {
  const rendered = JSON.stringify(v, null, 2)
  return [{ type: 'text', text: rendered }]
}

/** 归一化为 lossless JSON：丢掉 undefined 键、把 NaN/-0 转 null。
 * defineTool 在 execute 后经 snapshotJsonValue 校验，任何嵌套 undefined/non-finite 都会抛
 * 「value is not lossless JSON」。DTO 的可选字段（packageName/error/steps.elapsed 等）常为
 * undefined，必须在越过工具边界前洗净，否则热装/预检会整体失败。 */
function toLosslessJson(value: unknown): unknown {
  if (value === undefined || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))) return null
  if (Array.isArray(value)) return value.map(toLosslessJson)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = toLosslessJson(v)
    }
    return out
  }
  return value
}

/**
 * 在 ctx 存在 tools 服务时注册全部闭环工具，返回各 register 的 disposer（供 effect 回收）。
 * 无 tools 服务的宿主（非 agent 场景）静默跳过，不改变插件加载行为。
 */
export function registerAgentTools(ctx: Context, ops: AgentOps): (() => void)[] {
  const tools = (ctx as Context & { get?: (k: string) => unknown }).get?.('tools') as
    | { register(d: unknown): () => void }
    | undefined
  if (!tools) return []
  const dispose: (() => void)[] = []

  const reg = (def: unknown): void => {
    // 统一把 execute 结果归一化为 lossless JSON：DTO 可选字段（packageName/error/steps.elapsed
    // 等）常为 undefined，不洗净会在 snapshotJsonValue 校验处整单打回「value is not lossless JSON」。
    const { execute, ...rest } = def as { execute?: (...a: unknown[]) => unknown }
    const normalized: unknown = {
      ...rest,
      execute: execute && ((...a: unknown[]) => Promise.resolve(execute(...a)).then(toLosslessJson)),
    }
    const d = tools.register(normalized)
    if (d) dispose.push(d)
  }

  reg(
    defineTool({
      name: 'pm_status',
      description: '查询插件在 DSH 的现状（是否在场、运行态、能否热装、残留），输入插件包名或 entryId。',
      parameters: { ...PARAM_NAMES },
      output: { schema: OUT_SCHEMA, render: (_a, v) => text(v) },
      execute: (args, _exec) => Promise.resolve(ops.status(args.name)),
    }),
  )

  reg(
    defineTool({
      name: 'pm_tempLoad',
      description:
        '临时热装插件到运行时（不写入持久装配），输入 spec（registry 包名/本地路径/file:）。自动连携：调用即检查同逻辑名是否已有活动临时实例，有则先自动卸载旧实例再装载，保障始终单实例（同名再装不双开）；换键后返回名可能带 -hotN，属正常。成功后用返回的 packageName 接续后续操作。',
      parameters: { ...PARAM_SPEC },
      output: { schema: OUT_SCHEMA, render: (_a, v) => text(v) },
      execute: (args, _exec) => ops.tempLoad(args.spec),
    }),
  )

  reg(
    defineTool({
      name: 'pm_tempRemove',
      description: '卸载一个此前 pm_tempLoad 的临时插件（拆运行时 entry + 回收依赖），输入包名或 entryId。',
      parameters: { ...PARAM_NAMES },
      output: { schema: OUT_SCHEMA, render: (_a, v) => text(v) },
      execute: (args, _exec) => ops.tempRemove(args.name),
    }),
  )

  reg(
    defineTool({
      name: 'pm_promote',
      description: '把临时加载的插件转正为持久装配（写 patch，重启后仍生效），输入插件包名。',
      parameters: { ...PARAM_NAMES },
      output: { schema: OUT_SCHEMA, render: (_a, v) => text(v) },
      execute: (args, _exec) => ops.promote(args.name),
    }),
  )

  reg(
    defineTool({
      name: 'pm_uninstall',
      description:
        '彻底卸载插件（移除装配登记 + 物理移除包与依赖闭包）。clearData 传 true 时才额外清除该插件在 ~/.dsh 的自持数据目录（配置/凭据/缓存），默认 false 保留。',
      parameters: { ...PARAM_OP },
      output: { schema: OUT_SCHEMA, render: (_a, v) => text(v) },
      execute: (args, _exec) => ops.uninstall(args.name, args.clearData ?? false),
    }),
  )

  reg(
    defineTool({
      name: 'pm_reloadClient',
      description:
        '触发前端渲染进程刷新（重载界面）。仅刷渲染进程不重启内核，会话与热装状态保留。零检测零阻塞。带前端板块的插件改动需用户在面板肉眼可见时再调。',
      parameters: {} as const,
      output: { schema: OUT_SCHEMA, render: (_a, v) => text(v) },
      execute: () => Promise.resolve(ops.reloadClient()),
    }),
  )

  reg(
    defineTool({
      name: 'pm_probe',
      description:
        'L0 真实探针：对外置隔离实例实测插件能否干净启动（HTTP+渲染三态判定，崩溃/挂起自动隔离并回滚副本，真实 profile 只读不改）。候选源传 spec（本地路径/file:/包名）即可直接探针，不依赖 pm_tempLoad；也可只传包名（回落已热装 temp 源 / profile node_modules）。传 specs 数组则批量：全部候选共存于同一个隔离实例（一次装配/一个内核/一个 URL），返回单份报告 + plugins 名单 + unresolved 列表。隔离 home 携带真实 settings/credentials 快照。keep=true 时判定通过后不清理，保留隔离实例供浏览器直接打开人工检查（返回 keptUrl/keptPid/keptDir）。result 非 pass 且归因某插件时，建议禁用后再处理。注意：调用会真实 spawn 独立 dsh 子进程并 pnpm 装配隔离副本，耗时可达分钟级。',
      parameters: {
        name: { type: 'string', description: '插件包名；传 spec/specs 时可省略（自动从 spec 解析）' },
        spec: { type: 'string', description: '单个候选插件源（本地路径/file:/registry 包名），与 pm_tempLoad 的 spec 同形；传了则以它为探针候选' },
        specs: { type: 'array', items: { type: 'string' } as const, description: '批量候选源列表（本地路径/file:/包名）；非空时全部候选共存于同一个隔离实例，忽略 name/spec' },
        keep: { type: 'boolean', description: '判定通过后保留隔离实例与副本不清理：keptUrl 可直接在浏览器打开人工检查，keptPid/keptDir 供事后关闭回收；默认 false 即判即清' },
      } as const,
      output: { schema: OUT_SCHEMA, render: (_a, v) => text(v) },
      execute: (args, _exec) =>
        Array.isArray(args.specs) && args.specs.length > 0
          ? ops.probeMany(args.specs, args.keep === true)
          : ops.probe(args.name, args.keep === true, args.spec),
    }),
  )

  return dispose
}