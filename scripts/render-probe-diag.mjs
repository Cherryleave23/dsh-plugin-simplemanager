import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const candidates = [
  process.env.USERPROFILE + '/.dsh/profiles/desktop',
  process.env.USERPROFILE + '/.dsh/profiles/web',
  process.env.USERPROFILE + '/.dsh/profiles/desktop.bak-clean-20260822-171559',
]
for (const pf of candidates) {
  const pkgJson = join(pf, 'package.json')
  if (!existsSync(pkgJson)) continue
  console.log('=== profileDir =', pf, '===')
  const req = createRequire(pkgJson)
  const show = (id) => { try { return req.resolve(id) } catch (e) { return 'ERR: ' + e.message.split('\n')[0] } }
  console.log('  resolve react          ->', show('react'))
  console.log('  resolve react-dom      ->', show('react-dom'))
  console.log('  resolve react-dom/server->', show('react-dom/server'))

  let reactTop, rds
  try { reactTop = req('react') } catch (e) { console.log('  require react ERR', e.message.split('\n')[0]); continue }
  try { rds = req('react-dom/server') } catch (e) {
    console.log('  require react-dom/server ERR', e.message.split('\n')[0])
    console.log('  (=> 渲染探测应跳过，不执行 render)')
    continue
  }
  // 探测 react-dom/server 内部链接到的 react 入口：从 react-dom 的 package.json 反查 peer
  try {
    const rdPkg = JSON.parse(require('node:fs').readFileSync(join(pf, 'node_modules', 'react-dom', 'package.json'), 'utf8'))
    console.log('  react-dom version       ->', rdPkg.version)
    console.log('  react-dom deps/react    ->', JSON.stringify(rdPkg.dependencies?.react ?? rdPkg.peerDependencies?.react))
  } catch (e) { /* ignore */ }

  const Comp = () => { const [s] = reactTop.useState(7); return reactTop.createElement('div', null, 's=' + s) }
  try {
    const html = rds.renderToStaticMarkup(reactTop.createElement(Comp))
    console.log('  RENDER OK html=', html)
  } catch (e) {
    console.log('  RENDER ERR:', e.constructor.name, e.message)
    console.log('  stack:', (e.stack ?? '').split('\n').slice(0, 5).join('\n          '))
  }
  console.log('')
}