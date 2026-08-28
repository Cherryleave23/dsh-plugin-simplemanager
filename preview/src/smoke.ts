/** 插件 client 产物的定位与契约探测（纯 helper，无 VM 深挖）。
 * 语义（演进：已砍掉 VM 沙箱 3 阀门预检测引擎——①load 求值 ②factory 物化 ③注入门禁，
 * 该引擎因内核破坏性改动彻底失效且保真度差，删除见 git 历史；真实运行判定统一交给
 * guard 式独立子进程探针 probe.ts）。此文件仅保留仍被 index.ts 引用的三个无副作用函数：
 * 官方 peer 依赖探测、client 目录定位、client 产物契约判定。不持有任何模块级可变状态。
 */
import { isAbsolute, join, normalize } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'

/** 读取某插件的 package.json 中是否声明「官方 DSH peer 依赖」（@deepseek-ai/dsh-*）及清单。
 * 无法定位 manifest 时返回 undefined。 */
export function detectOfficialPeerDeps(packageName: string, profileDir?: string): string[] | undefined {
  if (!profileDir) return undefined
  const manifestPath = join(profileDir, 'node_modules', packageName, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { peerDependencies?: Record<string, string> }
    const peers = manifest.peerDependencies
    if (!peers) return undefined
    return Object.keys(peers).filter((n) => n.startsWith('@deepseek-ai/dsh-'))
  } catch {
    return undefined
  }
}

/** 计算某插件 client 产物可能所在目录（优先级：temp 源目录 → profile node_modules）。
 * 热装插件（tempInfos 有 spec 源路径）常从任意目录临时加载、并不落在 profile node_modules，需按源目录定位。 */
export function locateClientRoots(packageName: string, profileDir?: string, tempSpec?: string): string[] {
  const roots: string[] = []
  if (tempSpec) {
    const raw = tempSpec.replace(/^file:/i, '')
    // 形似路径（含分隔符 / 盘符 / 相对前缀）才作候选；纯 name@ver 为 registry 安装，退回 profile node_modules。
    if (/[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('.')) {
      roots.push(normalize(isAbsolute(raw) ? raw : join(process.cwd(), raw)))
    }
  }
  if (profileDir) roots.push(join(profileDir, 'node_modules', packageName))
  return roots
}

/** 在候选目录里找某插件是否声明 client 板块并定位其产物（声明缺失目录 / 无 package.json 的目录按序跳过）。 */
export function detectClientArtifact(candidateRoots: string[]): { declared: boolean; artifactExists: boolean; artifactSize: number; path?: string } {
  const none = { declared: false, artifactExists: false, artifactSize: 0 }
  for (const root of candidateRoots) {
    const manifestPath = join(root, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dsh?: { client?: unknown }
        exports?: Record<string, unknown>
      }
      // 判定是否声明 client 板块：dsh.client 存在，或 exports 里有 "./client" 导出。
      const declared = Boolean(manifest.dsh?.client) || Boolean(manifest.exports?.['./client'])
      if (!declared) return none
      // 解析 "./client" 的相对入口（默认 field），退化到常见目录。
      const exp = manifest.exports?.['./client'] as { default?: string } | string | undefined
      const rel = typeof exp === 'string' ? exp : typeof exp === 'object' && exp ? (exp as { default?: string }).default : undefined
      const candidates = rel
        ? [rel]
        : ['./lib/client.js', './client.js', './src/client/index.tsx']
      for (const c of candidates) {
        const p = join(root, ...c.replace(/^\.\//, '').split('/'))
        if (existsSync(p)) {
          try { return { declared, artifactExists: true, artifactSize: statSync(p).size, path: p } } catch { return { declared, artifactExists: true, artifactSize: 0, path: p } }
        }
      }
      return { declared, artifactExists: false, artifactSize: 0 }
    } catch {
      return none
    }
  }
  return none
}