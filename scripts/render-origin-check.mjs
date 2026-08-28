// 验证 resolveRenderOrigin 思路：从 react-dom/server 落点反推 react，同源后干净组件可渲染、destructure 式崩可捕获。
import { createRequire } from 'node:module'

const profileDir = process.env.USERPROFILE + '/.dsh/profiles/desktop'
const baseReq = createRequire(profileDir + '/package.json')

console.log('profileDir =', profileDir)
console.log('base resolve react        ->', (() => { try { return baseReq.resolve('react') } catch (e) { return 'ERR ' + e.message.split('\n')[0] } })())
console.log('base resolve react-dom/server ->', (() => { try { return baseReq.resolve('react-dom/server') } catch (e) { return 'ERR ' + e.message.split('\n')[0] } })())

// —— 复刻 resolveRenderOrigin：锚定 react-dom/server 的落点 ——
let domPath, originReq, react, rds
try { domPath = baseReq.resolve('react-dom/server') } catch (e) { console.log('no react-dom/server -> render 探测应跳过'); process.exit(0) }
try { originReq = createRequire(domPath) } catch (e) { console.log('originReq fail', e.message); process.exit(0) }
try {
  react = originReq('react')
  rds = originReq('react-dom/server')
} catch (e) { console.log('origin react/dom load fail', e.message); process.exit(0) }

console.log('origin react (sibling of shell react-dom) version ->', react?.version)

// 干净组件：用 hooks
const Clean = () => { const [s] = react.useState(7); return react.createElement('div', null, 'clean s=' + s) }
// destructure 式崩溃：r.owner 是字符串，却 .name.toUpperCase()
const rec8 = { id: 8, title: 'x', owner: 'carol' }
const Destructure = () => { const owner = rec8.owner; return react.createElement('div', null, owner.name.toUpperCase()) }

function probe(fn) {
  try { const html = rds.renderToStaticMarkup(react.createElement(fn)); return 'RENDER OK: ' + html }
  catch (e) { return 'RENDER ERR: ' + e.constructor.name + ': ' + e.message }
}
console.log('\n[probe useState] ' + probe(() => { react.useState?.(0); return null }))
console.log('[Clean baseline  ] ' + probe(Clean))
console.log('[Destructure crsh] ' + probe(Destructure))