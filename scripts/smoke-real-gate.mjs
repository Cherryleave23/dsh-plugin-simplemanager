// 冒烟：验证真 cordis 门禁后端（lib/preflight.js realCordisGate）对 fixture 的判定。
// fixture dsh-test-fixture inject=['slots','effect']：真门禁应判 effect 缺服务（deny 集可删）。
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)
const { realCordisGate } = req('D:/AI/dsh-coder/dsh-plugins/dsh-plugin-simplemanager/lib/preflight.js')

const profileDir = 'C:/Users/a2287/.dsh/profiles/desktop'
const reachable = [
  'chatFileMentions', 'clientModules', 'commandUi', 'connection', 'conversation',
  'conversationEvents', 'conversationViews', 'inputTriggers', 'layout', 'locale',
  'modelDirectories', 'modules', 'sessions', 'settingsSchema', 'settingsScope',
  'slots', 'theme', 'uiRenderer', 'workspaces', 'loader',
]

// fixture：inject=['slots','effect']
const r1 = realCordisGate(profileDir, ['slots', 'effect'], reachable)
console.log('fixture [slots,effect] =>', JSON.stringify(r1))
console.log('  期望 missing=["effect"] reachable=["slots"]:', JSON.stringify(r1.missing) === '["effect"]' && JSON.stringify(r1.reachable) === '["slots"]' ? 'PASS' : 'FAIL')

// 正常插件：inject=['slots'] 全可达
const r2 = realCordisGate(profileDir, ['slots'], reachable)
console.log('normal [slots] =>', JSON.stringify(r2), '=>', r2.missing.length === 0 ? 'PASS' : 'FAIL')

// 拼错服务名：应判缺服务
const r3 = realCordisGate(profileDir, ['typoService'], reachable)
console.log('typo [typoService] =>', JSON.stringify(r3), '=>', r3.missing.length === 1 ? 'PASS' : 'FAIL')

// 空 inject：门禁无需判定
const r4 = realCordisGate(profileDir, [], reachable)
console.log('empty [] =>', JSON.stringify(r4), '=>', r4.missing.length === 0 && r4.reachable.length === 0 ? 'PASS' : 'FAIL')
