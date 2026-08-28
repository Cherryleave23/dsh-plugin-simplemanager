// render-drive.mjs — 数据驱动重渲染探测的最终机制验证（接入 clientSmokeTest 前的参考实现）。
//
// 正确模型（node:vm 实测结论）：
//   vm.runInNewContext 会把 sandbox 整体 contextify；在 vm 内创建的 factory 函数，即使在宿主
//   realm 调用，其自由变量 fetch 仍解析到沙箱全局对象。因此要让被测组件的取数打到 stub，必须
//   让 **沙箱全局本身** 持有 fetch 桩，而非把 globalThis/global 指向另一个不含 fetch 的扁平对象。
//
// 驱动链：沙箱内 load client bundle → factory(同源 shim) 物化 → apply(mockCtx) 捕获组件 →
//         宿主 react-test-renderer + act 驱动 挂载→异步取数→重渲染，捕获 render 期异常。
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const profileDir = process.env.USERPROFILE + '/.dsh/profiles/desktop'
const profileReq = createRequire(profileDir + '/package.json')
const React = profileReq('react')
const { act, create } = profileReq('react-test-renderer')
console.log('[infra] react + react-test-renderer 同源于 profile')

/** 惰性递归代理：官方运行时真实注入、本驱动没有的服务用占位，避免假命中 */
function recProxy() {
  const fn = function () { return recProxy() }
  return new Proxy(fn, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => '' : recProxy()),
    apply: () => recProxy(),
    construct: () => recProxy(),
    getPrototypeOf: () => Object.prototype,
  })
}

/**
 * 独立驱动沙箱：沙箱全局自身持有 fetch stub + __host（宿主 react / jsx / drive）。
 * 保证组件内自由变量 fetch、react 均解析到我们可控的同源副本。
 */
async function loadAndDrive(clientPath, { fetch, records }) {
  const stubFetch = async (input) => {
    const u = String(input)
    console.log('[stubFetch] CALL', u)
    if (u.includes('/list')) return { ok: true, status: 200, json: async () => { console.log('[stubFetch] list.json, records=', records); return { total: records.length, page: 1, pageSize: 4, list: records } } }
    if (u.includes('/upsert')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  }
  const jsx = { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
  const host = {
    react: React,
    jsx,
    proxy: () => recProxy(),
    makeShim: () => (id) => {
      if (id === 'react') return React
      if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return jsx
      return recProxy()
    },
    // 宿主驱动函数：注入沙箱，由沙箱驱动脚本以 async 方式调用；返回被驱动结果
    drive: async (comp) => {
      let snapshot
      const boundError = { v: null }
      // react-test-renderer 对渲染错误「unmount root + console.error」而不外抛到 act；
      // 必须包 ErrorBoundary 才能把数据驱动崩溃抓到（否则假阳性 ok）。
      const Boundary = class extends React.Component {
        componentDidCatch(e) { boundError.v = e }
        componentDidMount() {}
        render() { return React.createElement(React.Fragment, null, this.props.children) }
      }
      try {
        // 单 act：create + effect 发起 fetch + 等异步 resolve → setList → 全部在 act 作用域内 flush
        //（react-test-renderer 只 flush act 内的异步更新；数据驱动崩溃在重渲染时炸出→Boundary 捕获）
        await act(async () => {
          snapshot = create(React.createElement(Boundary, null, React.createElement(comp)))
          await new Promise((r) => setTimeout(r, 250))
        })
        if (boundError.v) {
          const e = boundError.v
          return { ok: false, crash: e instanceof Error ? `${e.constructor.name}: ${e.message.split('\n')[0]}` : String(e) }
        }
        const text = JSON.stringify(snapshot.toJSON())
        const hasRows = /接入飞书桥/.test(text)
        const state = /加载中/.test(text) ? 'loading' : /暂无记录/.test(text) ? 'empty' : hasRows ? 'rows' : /加载失败/.test(text) ? 'error' : 'unknown'
        return { ok: true, state, hasRows, snippet: text.slice(0, 600) }
      } catch (e) {
        const msg = e instanceof Error ? `${e.constructor.name}: ${e.message.split('\n')[0]}` : String(e)
        return { ok: false, crash: msg }
      }
    },
  }

  const sandbox = {
    window: null, // 见下方自引用：window/self/global/globalThis 统一指向「含 fetch 的沙箱自身」
    __ModuleLoader__: { pendingQueue: [], load(reg) { this.pendingQueue.push(reg) } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: stubFetch,      // 沙箱全局自身持有 → 组件自由变量 fetch 解析到它（不再用扁平对象覆盖 globalThis）
    // 标准 Web API：组件取数常依赖 URL/URLSearchParams，缺了会在构造 query 时崩（数据驱动必踩）
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    crypto,
    __host: host,
  }
  // 自引用：contextify 后全局就是 sandbox 本身，free 变量 fetch 恒命中 stubFetch；浏览器全局又都可见。
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.global = sandbox
  sandbox.globalThis = sandbox

  const code = readFileSync(clientPath, 'utf8')
  vm.runInNewContext(code, sandbox, { filename: clientPath })
  const q = sandbox.window.__ModuleLoader__.pendingQueue
  if (q.length !== 1) throw new Error(`load 次数 != 1 (got ${q.length})`)
  const factory = q[0].factory

  const driverCode = `
    (async () => {
      console.log('[driver] typeof fetch =', typeof fetch, '| typeof self.fetch =', typeof self.fetch)
      const factory = window.__ModuleLoader__.pendingQueue[0].factory
      // 探针：确认 factory 所在作用域能否触及 stub fetch（判定 realm 解析）
      try { fetch('http://probe/list').catch(() => {}) } catch (e) { console.log('[probe] sync fetch throw:', String(e.message || e)) }
      const exp = factory(__host.makeShim())
      let comp
      const mockCtx = {
        slots: { register: (o, c) => { comp = c; return { unregister(){} } } },
        effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
        on: () => () => {},
      }
      if (typeof exp.apply !== 'function') return { ok: false, crash: '未导出 apply' }
      try { exp.apply(mockCtx) } catch (e) { return { ok: false, crash: 'apply抛错: ' + String(e && e.message || e) } }
      if (typeof comp !== 'function') return { ok: false, crash: 'apply 未向 slots.register 组件' }
      return await __host.drive(comp)
    })()
  `
  return await vm.runInContext(driverCode, sandbox)
}

const srcBase = 'D:/AI/dsh-coder/dsh-plugins/dsh-test-fixtures'
const objOwner = [{ id: 1, title: '接入飞书桥', status: 'done', owner: { name: 'alice' }, ts: 1710000000000 }]
const strOwner = [{ id: 1, title: '接入飞书桥', status: 'done', owner: 'alice', ts: 1710000000000 }]

const dest = srcBase + '/dsh-fixture-destructure/lib/client.js'
console.log('--- 组1 owner=对象（干净，不应崩） ---')
console.log(JSON.stringify(await loadAndDrive(dest, { records: objOwner })))
console.log('--- 组2 owner=字符串（真实事故，应崩） ---')
console.log(JSON.stringify(await loadAndDrive(dest, { records: strOwner })))