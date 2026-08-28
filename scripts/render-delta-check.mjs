// 验证「跑 effect + 真数据重渲染」机制的普适性：
// 用 react-test-renderer + act 驱动真实组件 挂载→异步取数→重渲染，捕获数据驱动(owner 字符串)崩溃。
// 完整复刻 clientSmokeTest 加载路径：vm 执行 client bundle → 取 registration.factory → 物化 apply → 抓 slot 组件。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const profileDir = process.env.USERPROFILE + '/.dsh/profiles/desktop'
const profileReq = createRequire(profileDir + '/package.json')
const React = profileReq('react')
const { act, create } = profileReq('react-test-renderer')

console.log('[infra] react + react-test-renderer 均从 profile 解析（同源副本）')

function makeShim() {
  return (id) => {
    if (id === 'react') return React
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime')
      return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
    return new Proxy(function(){}, { get: () => rec() })
    function rec(){ return new Proxy(function(){}, { get: (_t, p) => (p===Symbol.toPrimitive?()=>'':rec()) }) }
  }
}

// 复刻 clientSmokeTest 的加载+物化：返回 apply + inject
function loadBundle(clientPath, record) {
  const code = readFileSync(clientPath, 'utf8')
  const stash = { calls: 0 }        // 桩计数（闭包共享）
  const w = { __ModuleLoader__: { mode:'queue', pendingQueue:[], load(reg){ this.pendingQueue.push(reg) } } }
  const fetchStub = async (input) => {
    stash.calls++; record && record('fetch#'+stash.calls+' -> '+String(input))
    console.log('[loadBundle.fetchStub] CALL', String(input))
    const u = String(input)
    if (u.includes('/list')) return { ok: true, status: 200, json: async () => ({ total: 1, page: 1, pageSize: 4, list: stash.records }) }
    if (u.includes('/upsert')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }
  fetchStub.__stash = stash
  const sandbox = { window: w, globalThis: w, global: w, self: w, console, setTimeout, clearTimeout, fetch: fetchStub }
  vm.runInNewContext(code, sandbox, { filename: clientPath })
  const pending = w.__ModuleLoader__.pendingQueue
  if (pending.length !== 1) throw new Error('load 次数 != 1')
  const factory = pending[0].factory
  return { exports: factory(makeShim()), stash }
}

function grabComponent(mod) {
  let comp
  const mockCtx = {
    slots: { register: (o, c) => { comp = c; return { unregister(){} } } },
    effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
  }
  mod.apply(mockCtx)
  return comp
}

async function driveMod(bundle, label) {
  const comp = grabComponent(bundle.exports)
  if (typeof comp !== 'function') return `[${label}] no component`
  let tree
  let state
  try {
    await act(async () => {
      tree = create(React.createElement(comp))
      await new Promise((r) => setTimeout(r, 150)) // 让 effect 内 async fetch resolve → setState 排队 → act 末 flush 重渲染
    })
    const text = JSON.stringify(tree.toJSON())
    const hasRows = /接入飞书桥/.test(text)
    state = /加载中/.test(text) ? 'loading态' : /暂无记录/.test(text) ? '空态' : hasRows ? '有数据' : /加载失败/.test(text) ? 'error态' : '未知'
    return `[${label}] 渲染OK state=${state} 有数据行=${hasRows} fetch调用=${bundle.stash.calls}`
  } catch (e) {
    return `[${label}] CRASH捕获: ${e.constructor.name}: ${e.message.split('\n')[0]}`
  }
}

const srcBase = 'D:/AI/dsh-coder/dsh-plugins/dsh-test-fixtures'
function fetchStub(records, log) {
  return async (input) => {
    const u = String(input)
    if (log) log(`fetch -> ${u}`)
    if (u.includes('/list')) return { ok: true, status: 200, json: async () => { if(log) log('list.json called'); return { total: records.length, page: 1, pageSize: 4, list: records } } }
    if (u.includes('/upsert')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }
}
const objOwner = [{ id: 1, title: '接入飞书桥', status: 'done', owner: { name: 'alice' }, ts: 1710000000000 }]
const strOwner = [{ id: 1, title: '接入飞书桥', status: 'done', owner: 'alice', ts: 1710000000000 }] // owner 降级成字符串 = destructure 真实崩

const dest = join(srcBase, 'dsh-fixture-destructure', 'lib', 'client.js')
const logObj = (m) => console.log('   [stub] ' + m)
console.log('--- 组1 owner=对象 ---')
let modObj = loadBundle(dest, fetchStub(objOwner, logObj))
console.log(await driveMod(modObj, 'destructure owner=对象(基线旁)'))
console.log('--- 组2 owner=字符串 ---')
const logStr = (m) => console.log('   [stub] ' + m)
let modStr = loadBundle(dest, fetchStub(strOwner, logStr))
console.log(await driveMod(modStr, 'destructure owner=字符串(真实崩)'))