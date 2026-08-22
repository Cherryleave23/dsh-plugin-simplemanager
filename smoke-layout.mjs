import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pnpmAdd, pnpmRemove } from './lib/pnpm.js'

const profile = process.argv[2]
const base = process.argv[3]
writeFileSync(join(profile, '.npmrc'), 'nodeLinker=hoisted\n')
const A = join(base, 'a')
mkdirSync(A, { recursive: true })
writeFileSync(join(A, 'package.json'), JSON.stringify({
  name: '@smoke/plug', version: '1.0.0',
  dependencies: { 'is-number': '^7.0.0' },
}))

const has = (n) => existsSync(join(profile, 'node_modules', n))

// 阶段1：仅 pnpm add file:
const add = await pnpmAdd(profile, `file:${A}`, { timeoutMs: 180000 })
console.log('阶段1 add ok=', add.ok, '| 依赖已装 =', has('is-number'))

// 阶段2：add 后再跑一次 pnpm install --no-frozen-lockfile（补齐链接包的依赖闭包）
const cmd = process.env.ComSpec ?? 'cmd.exe'
const cmdline = 'pnpm install --no-frozen-lockfile --reporter=ndjson'
const c = spawn(cmd, ['/d', '/s', '/c', `"${cmdline}"`], {
  cwd: profile, windowsVerbatimArguments: true,
  env: { ...process.env, CI: 'true' },
})
let o = ''
c.stdout.on('data', (d) => (o += d))
c.stderr.on('data', (d) => (o += d))
await new Promise((r) => c.on('close', (code) => {
  console.log('阶段2 pnpm install exit=', code, '| 依赖已装 =', has('is-number'), '| 尾行:', o.slice(-200).replace(/\s+/g, ' '))
  r()
}))

await pnpmRemove(profile, '@smoke/plug', { timeoutMs: 120000 })
console.log('清理后 is-number 仍在=', has('is-number'))