// dsh#02 verification: launch the built CLI the way the TEST unit does (no token),
// with and without the fork opt-ins, and prove the gate behaviour over HTTP and in
// a browser. Never prints a token: server logs go to a file and are not echoed.
//
//   CHROME=<chromium> PW=<dir containing playwright-core> \
//   node scripts/fork/noauth-proof.mjs --home <DSH_HOME with a web profile> \
//        --lan <ip> --port <base port> --out <screenshot dir> [--section "OpenCode Go"]
import { spawn } from 'node:child_process'
import http from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []))
const { home, lan, out } = args
const base = Number(args.port ?? 3200)
const section = args.section ?? 'OpenCode Go'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = join(root, 'apps/cli/lib/bin.js')
mkdirSync(out, { recursive: true })
const { chromium } = createRequire((process.env.PW ?? '/home/ddv/.nvm/versions/node/v24.15.0/lib/node_modules') + '/')('playwright-core')

let failed = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++ }

const overlay = join(out, 'noauth.patch.yml')
writeFileSync(overlay, `- id: web-startup
  config:
    fork:
      allowWildcardHost: true
- id: connection
  config:
    trustedHosts: !!js ctx.webStartup.trustedHosts
    fork:
      noAuth: true
`)
// The TEST unit's flags (deploy/dsh-test.service), minus the fleet overlay.
const unit = (port) => ['--host', '0.0.0.0', '--trusted-host', 'localhost', '--trusted-host', '127.0.0.1', '--trusted-host', lan, '--trusted-host', 'harness-test.ddvnguyen.com', '--port', String(port), '--no-open']

function launch(argv, tag) {
  const log = openSync(join(out, `${tag}.log`), 'w')
  const child = spawn('node', [cli, '--profile', 'web', ...argv], { env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', log, log] })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  return { child, exited, log: () => readFileSync(join(out, `${tag}.log`), 'utf8') }
}
const get = (host, port, path, hostHeader) => new Promise((resolve) => {
  const req = http.request({ host, port, path, method: 'GET', headers: hostHeader ? { Host: hostHeader } : {} }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  req.on('error', () => resolve(0)); req.setTimeout(5000, () => { req.destroy(); resolve(0) }); req.end()
})
async function ready(host, port, tries = 90) {
  for (let i = 0; i < tries; i++) { if ((await get(host, port, '/')) !== 0) return true; await new Promise((r) => setTimeout(r, 1000)) }
  return false
}

// ── A. flags off: stock behavior ────────────────────────────────────────────
{
  const s = launch(unit(base), 'off-wildcard')
  const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('still-running'), 60000))])
  check('flag off: --host 0.0.0.0 is refused', code !== 'still-running' && code !== 0 && /wildcard|unspecified/i.test(s.log()), `exit=${code}`)
  if (code === 'still-running') s.child.kill()
}
{
  const p = base + 1
  const s = launch(['--host', '127.0.0.1', '--port', String(p), '--no-open'], 'off-loopback')
  const up = await ready('127.0.0.1', p)
  check('flag off: server up on loopback', up)
  check('flag off: GET / without token is 401', (await get('127.0.0.1', p, '/')) === 401)
  check('flag off: GET /api without token is 401', (await get('127.0.0.1', p, '/api')) === 401)
  s.child.kill()
}

// ── B. flags on: no token, TEST unit flags ──────────────────────────────────
const p = base + 2
const s = launch(['--patch', overlay, ...unit(p)], 'on')
check('flag on: server up (0.0.0.0, no token)', await ready('127.0.0.1', p))
for (const [label, host] of [['loopback', '127.0.0.1'], ['LAN', lan]]) {
  check(`flag on: GET / over ${label} is 200`, (await get(host, p, '/')) === 200)
}
check('flag on: trusted Host header (harness-test.ddvnguyen.com) admitted', (await get('127.0.0.1', p, '/', 'harness-test.ddvnguyen.com')) === 200)
for (const evil of ['evil.example', 'evil.example:' + p]) {
  const c = await get('127.0.0.1', p, '/', evil)
  check(`flag on: untrusted Host "${evil}" rejected on /`, c === 403 || c === 400 || c === 401, `status=${c}`)
  const a = await get('127.0.0.1', p, '/api', evil)
  check(`flag on: untrusted Host "${evil}" rejected on /api`, a === 403 || a === 400 || a === 401, `status=${a}`)
}

// ── C. browser: UI loads without auth, settings page renders, saves, reads back ──
const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROME })
for (const [label, host] of [['loopback', '127.0.0.1'], ['lan', lan]]) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await ctx.newPage()
  const url = `http://${host}:${p}/`
  const toSection = async () => {
    await page.keyboard.press('Escape'); await page.waitForTimeout(400)
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click(); await page.waitForTimeout(1500)
    await page.getByText(section, { exact: true }).first().click(); await page.waitForTimeout(1500)
  }
  await page.goto(url); await page.waitForTimeout(3500)
  const body0 = (await page.evaluate(() => document.body.innerText)).toLowerCase()
  // "Sign in to your DeepSeek account" is the model-provider onboarding card, not an access gate.
  check(`${label}: app shell loads, no access-auth prompt`, body0.includes('new session') && !/unauthori[sz]ed|401|token required|access denied/.test(body0))
  await toSection()
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ')
  check(`${label}: ${section} settings page renders`, !/unavailable|not available|loopback/i.test(text.slice(text.indexOf(section))) && (await page.getByRole('switch').count()) > 0)
  await page.screenshot({ path: join(out, `${label}-${section.replace(/\W+/g, '-')}.png`) })
  const sw = () => page.getByRole('switch').first()
  const before = await sw().getAttribute('aria-checked')
  await sw().click(); await page.waitForTimeout(600)
  await page.reload(); await page.waitForTimeout(3500); await toSection()
  const after = await sw().getAttribute('aria-checked')
  check(`${label}: ${section} save persists across reload`, after !== before, `${before} -> ${after}`)
  await sw().click(); await page.waitForTimeout(600) // restore
  await ctx.close()
}
await browser.close()
s.child.kill()
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
