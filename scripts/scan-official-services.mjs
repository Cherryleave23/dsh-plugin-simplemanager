#!/usr/bin/env node
/**
 * scan-official-services.mjs —— 从 dsh 官方源码树采集「web reload 引导期可达的服务名」。
 *
 * 用途
 *   插件管家前端重载预检需要一个「可达服务白名单」：真实 boot 门禁用 `ctx.get(name)===undefined`
 *   判定 `inject` 里的服务是否缺（缺则 entry 挂在 PENDING(waiting for service: X)，apply 不执行）。
 *   这个白名单必须来自 dsh 官方源码，而不是 desktop profile 的编译产物（产物可能被裁剪/一亮就不权威）。
 *
 * 用法
 *   node scripts/scan-official-services.mjs <dsh-official-repo>/packages/dsh-client/<版本>/packages/client
 *   例：
 *     node scripts/scan-official-services.mjs D:/AI/dsh-coder/dsh-official/deepseek-harness-v0.1.1-rc.2/packages/client
 *
 * 采集规则（服务 = cordis 里可注入的名字，即被 `provide` 注册的 Service）
 *   - `super(ctx, 'X')`            → Service 子类构造，cordis Service 基类构造即 `ctx.reflect.provide(X, this)`
 *   - `*.reflect.provide('X', …)`  → 对象方式注册的服务（如 uiRenderer = reflect.provide('uiRenderer', …)）
 *   - `*.service('X', …)`          → 显式服务声明
 *   排除 tests/dist/lib/node_modules。字符串字面量对编译稳定，minify 不改字符串。
 *
 * 版本对齐
 *   扫出的白名单必须与「桌面 profile 当前 dsh 版本」一致：dsh 升级后重跑本脚本，
 *   用新版本输出替换 src/index.ts 里的 RELOAD_REACHABLE_SERVICES。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2]
if (!ROOT) { console.error('usage: node scan-official-services.mjs <path/to/dsh-official>/packages/<版本>/packages/client'); process.exit(2) }

const EXT = /\.(ts|tsx)$/
const NAME = /^[A-Za-z][A-Za-z0-9-]*$/

const patterns = [
  /super\(\s*ctx\s*,\s*(['"])([A-Za-z][A-Za-z0-9-]*)\1/g,
  /reflect\.provide\(\s*(['"])([A-Za-z][A-Za-z0-9-]*)\1/g,
  /\.provide\(\s*(['"])([A-Za-z][A-Za-z0-9-]*)\1/g,
  /service\(\s*(['"])([A-Za-z][A-Za-z0-9-]*)\1/g,
]

function walk(dir, files) {
  for (const ent of readdirSync(dir)) {
    const full = join(dir, ent)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (ent === 'node_modules' || ent === 'dist' || ent === 'lib') continue
      walk(full, files)
    } else if (EXT.test(ent) && !/\/tests?$|\/tests\//.test(ent)) {
      const norm = full.replace(/\\/g, '/')
      if (/[\s:]\/tests?\//.test(norm) || /\/dist\/|\/lib\/|\/node_modules\//.test(norm)) continue
      files.push(full)
    }
  }
}

const files = []
walk(ROOT, files)
const found = new Map()
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const re of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(lines[i])) !== null) {
        const nm = m[2]
        if (!NAME.test(nm)) continue
        if (!found.has(nm)) found.set(nm, [])
        found.get(nm).push(f.replace(ROOT, '') + ':' + (i + 1))
      }
    }
  }
}

console.log('=== SERVICE NAMES (official source) ===')
for (const nm of [...found.keys()].sort()) {
  console.log(nm.padEnd(28) + '  ' + found.get(nm).slice(0, 3).join(' ; '))
}
console.log('\ncount=' + found.size)
console.log('\n# paste into src/index.ts RELOAD_REACHABLE_SERVICES (remember to add the boot-guaranteed "loader" service if not present)')