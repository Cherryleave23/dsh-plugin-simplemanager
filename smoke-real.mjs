import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pnpmAdd, pnpmRemove, verifyInstalled } from './lib/pnpm.js'

const profile = process.argv[2] // 复用真实 desktop profile 的形态（隔离目录）
const base = process.argv[3] // 软包目录

// 镜像真实桌面 profile 的 hoisted 全局 node_modules 语义（普适化依赖的前提）
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, '.npmrc'), 'nodeLinker=hoisted\n')
if (!existsSync(join(profile, 'package.json'))) {
  writeFileSync(join(profile, 'package.json'), '{"name":"smoke-profile","version":"1.0.0"}')
}

const fail = (m) => { console.log('✗', m); process.exit(1) }
const ok = (m) => console.log('•', m)

const A = join(base, 'a')
const B = join(base, 'b')
mkdirSync(A, { recursive: true })
mkdirSync(B, { recursive: true })
const write = (f, v) => { import('node:fs').then(fs => fs.writeFileSync(f, v)) }
write(join(B, 'package.json'), JSON.stringify({ name: '@smoke/b', version: '1.0.0' }))
// A 模拟真实插件的依赖形态：registry 依赖（可安装闭包）+ 一个本地链接包
write(join(A, 'package.json'), JSON.stringify({
  name: '@smoke/a', version: '1.0.0',
  dependencies: { '@smoke/b': `file:${B.replace(/\\/g, '/')}`, 'is-number': '^7.0.0' },
}))

// 1) 加 A，期望连带装齐依赖闭包（registry 依赖 is-number 必须落入共享 node_modules）
const add = await pnpmAdd(profile, `file:${A}`, { timeoutMs: 120000 })
ok(`add ok=${add.ok} code=${add.code} msg=${add.message}`)
if (!add.ok) fail(add.message)
const vA = verifyInstalled(profile, '@smoke/a')
ok(`verify A = ${JSON.stringify(vA)}`)
ok(`add 带回闭包容名 = ${JSON.stringify(add.installedDeps)}`)
const registryDep = existsSync(join(profile, 'node_modules', 'is-number', 'package.json'))
ok(`依赖闭包 is-number（registry）已装入 = ${registryDep}`)
// 嵌套 file: 链接依赖是 pnpm 已知限制：不随链接包递归安装，仅信息性输出
const vB = existsSync(join(profile, 'node_modules', '@smoke', 'b', 'package.json'))
ok(`链接包嵌套 file: 依赖 B 已装入（pnpm 限制，仅信息）= ${vB}`)
if (!vA.ok || !registryDep) fail('A 或 registry 依赖闭包未正确装入')
const depsMid = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies ?? {}
ok(`profile package.json 已登记 A = ${'@smoke/a' in depsMid}`)

// 2) 回滚：移除插件与其补装的 registry 闭包，依赖完整进退
const rm = await pnpmRemove(profile, '@smoke/a', { timeoutMs: 120000 })
ok(`remove A ok=${rm.ok} code=${rm.code} msg=${rm.message}`)
const rmClosure = await pnpmRemove(profile, 'is-number', { timeoutMs: 120000 })
ok(`remove 闭包 is-number ok=${rmClosure.ok} code=${rmClosure.code} msg=${rmClosure.message}`)
if (!rm.ok || !rmClosure.ok) fail('回滚失败')
const depsAfter = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies ?? {}
const aGone = !existsSync(join(profile, 'node_modules', '@smoke', 'a'))
const closureGone = !existsSync(join(profile, 'node_modules', 'is-number'))
const registryClean = !('@smoke/a' in depsAfter) && !('is-number' in depsAfter) && !('@smoke/b' in depsAfter)
ok(`回滚后插件 A 目录移除 = ${aGone}`)
ok(`回滚后闭包 is-number 移除 = ${closureGone}`)
ok(`回滚后 profile package.json 登记复原 = ${registryClean}`)
ok(vA.ok && registryDep && rm.ok && rmClosure.ok && aGone && closureGone && registryClean ? '全部通过' : '存在断言失败')