/**
 * 重载预检后端之二 —— 真 cordis 门禁（实验室模式，仅门禁、不深挖 apply/渲染）。
 *
 * 对比三态门禁（index.ts 内 clientSmokeTest，A1 方案）：
 *   A1  用官方源码采集的白名单(RELOAD_REACHABLE_SERVICES) + 否认集(NON_INJECTABLE_CTX_METHODS)
 *       近似复刻门禁，且对可达插件深挖 apply/渲染。
 *   A2' 用真实 @deepseek-ai/cordis 的 Context + ctx.get() 判定 inject 可达性——
 *       `effect/on/…/拼错的服务名` 由真门禁**自然**判 pending，否认集可删；仅做门禁，不深挖。
 *
 * 真实 cordis 从目标 profile 解析（createRequire(profileDir/package.json)），与预检沙箱同源；
 * kernel 进程无需自持 cordis。若 profile 解析不到真 cordis，则回退按 realReachableNames 近似判定。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

import type { Context, Service } from '@deepseek-ai/cordis'

export interface RealGateResult { missing: string[]; reachable: string[] }

/**
 * 真实 cordis 门禁：对 inject 名逐一 `ctx.get(name)===undefined` 判定（对齐 web/src/boot.ts:149）。
 * - 用真实 Service 机制把 realReachableNames 注册进真实 Context（构造即 provide）；
 * - `effect/on/…` 是 ctx 方法非 Service，`ctx.get` 自然返 undefined → 判缺服务（否认集可删）；
 * - 拼错的服务名同样自然判缺服务。
 * 若 profile 解析不到真 cordis，回退按 realReachableNames 近似（与三态「可达」面一致）。
 */
export function realCordisGate(profileDir: string, injectNames: string[], realReachableNames: string[]): RealGateResult {
  const missing: string[] = []
  const reachable: string[] = []
  if (injectNames.length === 0) return { missing, reachable }

  let cordis: { Context?: new () => Context; Service?: typeof Service }
  try {
    const req = createRequire(join(profileDir, 'package.json'))
    cordis = req('@deepseek-ai/cordis') as never
  } catch {
    cordis = {}
  }

  if (typeof cordis.Context === 'function' && typeof cordis.Service === 'function') {
    const ctx = new cordis.Context()
    for (const name of realReachableNames) {
      try {
        const MockService = class extends (cordis.Service as typeof Service) {
          constructor() { super(ctx, name) }
        }
        new MockService()
      } catch { /* 单点注册失败不影响整体门禁 */ }
    }
    for (const name of injectNames) {
      if (ctx.get(name) === undefined) missing.push(name); else reachable.push(name)
    }
    return { missing, reachable }
  }

  // 真 cordis 不可用：回退近似判定
  for (const name of injectNames) {
    if (realReachableNames.includes(name)) reachable.push(name); else missing.push(name)
  }
  return { missing, reachable }
}