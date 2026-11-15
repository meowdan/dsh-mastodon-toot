/**
 * scripts/smoke.mjs —— 不上 DSH 的自测：假 ctx + 真 Mastodon
 * 用法：node scripts/smoke.mjs
 * 会读写 .tmp/home（不碰 %DSH_HOME%），会把旧 Mastodon 方案的凭证搬一次。
 */
import http from 'node:http'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { apply } from '../index.js'

const base = join(process.cwd(), '.tmp', 'home')
mkdirSync(base, { recursive: true })
const registrations = []
const ctx = {
  get: (k) => (k === 'dshHomePath' ? (name) => join(base, name) : undefined),
  effect: (fn) => { const d = fn(); return () => d?.() },
  webServer: { register: (r) => { registrations.push(r); return () => {} } },
}
apply(ctx, {})
const route = registrations[0]
if (!route) { console.error('没有注册路由'); process.exit(1) }

const server = http.createServer((req, res) => route.handler(req, res))
await new Promise((r) => server.listen(8787, '127.0.0.1', r))

const call = async (p, opts) => {
  const r = await fetch('http://127.0.0.1:8787' + p, opts)
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, body }
}
const post = (p, obj) => call(p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
})
let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

const st = await call('/api/mastodon-toot/status')
check('status 200', st.status === 200)
check('凭证已导入', st.body.creds?.hasToken === true, st.body.creds?.instance || '')

const test = await post('/api/mastodon-toot/test', { save: true })
check('verify_credentials', test.body.ok === true, test.body.account?.acct || test.body.error)

const cfg = await post('/api/mastodon-toot/config', {
  autoReply: false, maxPerDayOwner: 999, notebook: 'bogus', scope: 'all',
})
check('配置钳位', cfg.body.config?.maxPerDayOwner === 200 && cfg.body.config?.notebook === 'local')
check('配置生效', cfg.body.config?.autoReply === false && cfg.body.config?.scope === 'all')
// 还原
await post('/api/mastodon-toot/config', { autoReply: true, maxPerDayOwner: 16, scope: 'mentions' })

const pause = await post('/api/mastodon-toot/pause', { paused: true })
check('暂停', pause.body.paused === true)
await post('/api/mastodon-toot/pause', { paused: false })

const nb = await call('/api/mastodon-toot/notebook')
check('小本本可读', nb.status === 200 && !!nb.body.stats)

const note = await post('/api/mastodon-toot/notebook/note', { acct: '@Test_User', note: 'smoke 备注', tags: ['测试'] })
check('人物卡备注', note.body.ok === true && note.body.person?.acct === 'test_user', JSON.stringify(note.body.person || {}))

const people = await call('/api/mastodon-toot/notebook/people?q=test')
check('人物卡列表', (people.body.people || []).length === 1)

const pr = await post('/api/mastodon-toot/notebook/promise', { acct: 'test_user', text: 'smoke 测试承诺' })
check('记承诺', pr.body.ok === true && !!pr.body.promise?.id)
const prl = await call('/api/mastodon-toot/notebook/promises')
check('承诺列表', (prl.body.promises || []).some((x) => x.id === pr.body.promise.id))
const prr = await post('/api/mastodon-toot/notebook/promise/resolve', { id: pr.body.promise.id, status: 'done' })
check('兑现承诺', prr.body.promise?.status === 'done')

const po = await call('/api/mastodon-toot/posting')
check('发帖状态', po.status === 200 && Array.isArray(po.body.posting?.slots) && typeof po.body.nextSlot === 'string')
const qi = await post('/api/mastodon-toot/queue/ingest')
check('收队列', qi.status === 200 && typeof qi.body.added === 'number', `added=${qi.body.added}`)
const q = await call('/api/mastodon-toot/queue')
check('队列可读', q.status === 200 && Array.isArray(q.body.pending))
const draft = await post('/api/mastodon-toot/post/now', { text: 'smoke 试写', draft: true })
check('试写不发送', draft.body.ok === true && draft.body.draft === 'smoke 试写')

const bad = await call('/api/mastodon-toot/nope')
check('未知接口 404', bad.status === 404)

// 对话素材的隐私闸与「不像汇报」清洗（不联网、不读会话）
const chat = await import('../lib/chat.mjs')
check('隐私闸-IP', chat.looksPrivate('我家里 192.168.1.7 那台机器') === true)
check('隐私闸-路径', chat.looksPrivate('C:\\Users\\meowdan\\Documents') === true)
check('隐私闸-正常', chat.looksPrivate('今天出门吃了碗拉面，汤有点咸') === false)
check('清洗-列表去掉', !chat.cleanAssistant('- 改了 x.js\n- 修了接口\n**好了**').includes('x.js'))
check('清洗-保留句子', chat.cleanAssistant('拆好了，设置页现在是五个页签，用起来没那么乱。').includes('五个页签'))

server.closeAllConnections?.()
await new Promise((r) => server.close(r))
process.exitCode = failed ? 1 : 0
