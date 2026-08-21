// 临时验证脚本（只读 + editPatch 纯函数），验证后删除，不进入发布产物。
import { SimpleManagerHost, editPatch, defaultFolderFor, isOfficialName } from './lib/host.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop')
const host = new SimpleManagerHost(PROFILE, join(homedir(), '.dsh', 'simplemanager'))

const log = console.log

log('=== 1. 内核版本 ===')
log(host.readKernelCurrent())

log('\n=== 2. 已扫描插件（前 8 + 计数）===')
const catalog = host.scanCatalog()
log('总数:', catalog.length)
for (const b of catalog.slice(0, 8)) log(`  ${b.scope.padEnd(8)} ${b.source.padEnd(8)} ${b.name}@${b.version}`)
log('...')
const names = catalog.map((b) => b.name)
log('含 dsh-plugin-simplemanager:', names.includes('dsh-plugin-simplemanager'))
log('含 dsh-msg-link:', names.includes('dsh-msg-link'))
log('含 @deepseek-ai/dsh-base:', names.includes('@deepseek-ai/dsh-base'))

log('\n=== 3. 补丁已启用 ids ===')
const ids = host.readPatchEnabledIds()
log([...ids])
log('含 dsh-recorder-backend:', ids.has('dsh-recorder-backend'))

log('\n=== 4. editPatch 纯函数自检 ===')
const sample = `# comment\n- insert:\n    - id: aaa\n      name: 'aaa'\n      config: {}\n    - id: bbb\n      name: 'bbb'\n`
const enableX = editPatch(sample, 'xxx', 'xxx', true)
log('enable 新增:', enableX.includes("    - id: xxx"))
log('enable 幂等:', editPatch(enableX, 'xxx', 'xxx', true) === enableX)
const disableB = editPatch(enableX, 'bbb', 'bbb', false)
log('disable 移除 bbb:', !disableB.includes('id: bbb'), '| 保留 aaa:', disableB.includes('id: aaa'), '| 保留 xxx:', disableB.includes('id: xxx'))
const onEmpty = editPatch('', 'yyy', 'yyy', true)
log('空文件 enable:', onEmpty === "\n- insert:\n    - id: yyy\n      name: 'yyy'\n      config: {}\n")
log('\n=== 5. 分类规则 ===')
log('@deepseek-ai/dsh-base 官方:', isOfficialName('@deepseek-ai/dsh-base'), '| @dsh/x 官方:', isOfficialName('@dsh/x'))
log('dsh-msg-link 默认文件夹:', defaultFolderFor(catalog.find((b) => b.name === 'dsh-msg-link')?.scope ?? 'third'))