// 生成 dsh-v0.1.1-rc.2/typecheck-tmp/tsconfig.json：合并 rc2 官方 deepseek-harness base 的 paths
// （相对路径重写为指向 dsh-official/deepseek-harness-v0.1.1-rc.2），react 类型指向插件原 node_modules
// （@types/react16/18 在同一 @types 目录），并覆盖为宽松 strict 设置（与插件自身 tsconfig 一致）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 本目录位于 dsh-plugins/dsh-c/dsh-v0.1.1-rc.2/typecheck-tmp
const baseDir = resolve(here, '../../../dsh-official/deepseek-harness-v0.1.1-rc.2')
const rawBase = readFileSync(join(baseDir, 'tsconfig.base.json'), 'utf8')
  .replace(/^\s*\/\/[^\r\n]*\r?$/gm, '')
const base = JSON.parse(rawBase)

const prefix = relative(resolve(here), baseDir).replaceAll('\\', '/') + '/'
const paths = {}
const drop = new Set(['@deepseek-ai/dsh-client-ui-slots'])
for (const [key, targets] of Object.entries(base.compilerOptions.paths)) {
  if (drop.has(key)) continue
  paths[key] = targets.map((t) => prefix + t)
}

// react 类型：simplemanager 只消费 react（hooks + JSX，react-jsx 自动运行时不引入 react-dom），
// 解析到插件原 node_modules 的 @types/react（版本与 dsh-c 构建一致，避免 typecheck-tmp 自装依赖）。
const pluginTypes = 'D:/AI/默认工作流/dsh-plugins/dsh-c/node_modules/@types'
paths['react'] = [pluginTypes + '/react']
paths['react/jsx-runtime'] = [pluginTypes + '/react/jsx-runtime.d.ts']

// vendor/cordis 的第三方依赖（rc1 官方源码无 node_modules，指向 dsh-c 的 pnpm store，版本一致）
const store = relative(resolve(here), 'D:/AI/默认工作流/dsh-plugins/dsh-c/node_modules/.pnpm').replaceAll('\\', '/') + '/'
paths['@standard-schema/spec'] = [store + '@standard-schema+spec@1.1.0/node_modules/@standard-schema/spec']

const config = {
  extends: '../../../dsh-official/deepseek-harness-v0.1.1-rc.2/tsconfig.base.json',
  compilerOptions: {
    noEmit: true,
    composite: false,
    incremental: false,
    strict: false,
    noImplicitAny: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    exactOptionalPropertyTypes: false,
    noUncheckedIndexedAccess: false,
    noImplicitOverride: false,
    noFallthroughCasesInSwitch: false,
    skipLibCheck: true,
    jsx: 'react-jsx',
    lib: ['ES2024', 'DOM'],
    types: ['node', 'react'],
    typeRoots: [pluginTypes],
    paths,
  },
  // 与插件自身 tsconfig 的宿主 typecheck 范围对齐：client.tsx 是 client 包（tsdown 构建，
  // 浏览器侧类型面），不参与宿主 tsc 平面；三平面纪律禁止跨平面混检。
  include: [
    '../plugin/src/index.ts',
    '../plugin/src/host.ts',
    '../plugin/src/shims.d.ts',
  ],
}

writeFileSync(join(here, 'tsconfig.json'), JSON.stringify(config, null, 2) + '\n')
console.log('generated tsconfig with', Object.keys(paths).length, 'path entries')