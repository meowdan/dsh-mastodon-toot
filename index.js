/**
 * index.js —— 宿主侧：路由 + 心跳 + 状态
 * 插件只做「连接、状态、设置读写、暂停」；互动引擎在 lib/interact.mjs（M3）。
 */
import { homeDirOf } from './lib/paths.mjs'
import {
  loadConfig, saveConfig, loadCreds, saveCreds, importLegacyCreds,
  loadState, saveState, logLine, tailLog, notebookStats, redactCreds,
  mergeConfig,
} from './lib/store.mjs'
import { verify, instanceInfo, slimAccount, MastoError } from './lib/masto.mjs'
import {
  listPeople, setNote, addPromise, resolvePromise, listPromises,
  digest, prune, recentInteractions,
} from './lib/notebook.mjs'
import { composePost, buildPostPrompt } from './lib/compose.mjs'
import { replyTick } from './lib/interact.mjs'
import { refreshRelations, categoryConfig } from './lib/relations.mjs'
import {
  publish, dueSlot, dueQueueItem, markQueuePosted, recordPosted,
  ingestIfNeeded, slotsFor,
} from './lib/posting.mjs'
import { createHash } from 'node:crypto'

export const name = 'mastodon-toot'
export const inject = ['webServer']

const ROUTE = '/api/mastodon-toot'
const VERSION = '0.3.0'

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { reject(new Error('请求体太大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sameOrigin(req) {
  const host = String(req.headers.host || '')
  if (!host) return true // 非浏览器调用（curl/自测）
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const pick = String(req.headers.origin || req.headers.referer || '')
  if (!pick) return true
  try {
    const u = new URL(pick)
    return String(u.host || '').toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** DSH 自己的信任栅栏：connection.requestRejection 认 cookie/token；拿不到就退回同源这一道 */
function makeFence(ctx, log) {
  let conn = null
  let tried = false
  const getConn = () => {
    if (tried) return conn
    tried = true
    const tries = [
      () => (typeof ctx.get === 'function' ? ctx.get('connection') : null),
      () => Reflect.get(ctx, 'connection'),
      () => (ctx.root && typeof ctx.root === 'object' ? ctx.root.connection : null),
    ]
    for (const fn of tries) {
      try {
        const c = fn()
        if (c && typeof c.requestRejection === 'function') { conn = c; break }
      } catch { /* 换下一个 */ }
    }
    if (!conn) log('没有 connection 服务，只用本机同源校验')
    return conn
  }
  return (req, res) => {
    const c = getConn()
    if (!c) return false
    try {
      const rejection = c.requestRejection({ headers: req.headers })
      if (rejection === undefined) return false
      res.statusCode = typeof rejection === 'number' ? rejection : 403
      try { res.end() } catch { /* 忽略 */ }
      return true
    } catch (e) {
      log('信任栅栏出错，按拒绝处理：' + errText(e))
      res.statusCode = 403
      try { res.end() } catch { /* 忽略 */ }
      return true
    }
  }
}

function errText(e) {
  if (e instanceof MastoError) return e.message
  return e?.message ? String(e.message) : String(e)
}

function tzNow(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]))
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  }
}

function nextSlotOf(cfg) {
  try {
    const { date, minutes } = tzNow(cfg.tz)
    return slotsFor(date, cfg).find((s) => {
      const [h, m] = s.split(':').map(Number)
      return h * 60 + m > minutes
    }) || ''
  } catch {
    return ''
  }
}

export function apply(ctx, _config) {
  const dir = homeDirOf(ctx)
  let cfg = loadConfig(dir)
  let creds = importLegacyCreds(dir)
  let state = loadState(dir)

  if (creds.token) logLine(dir, `启动（v${VERSION}）：实例 ${creds.instance}，自动回复 ${cfg.autoReply ? '开' : '关'}`)
  else logLine(dir, `启动（v${VERSION}）：还没有凭证，等设置页填`)
  if (cfg.notebook !== 'off') {
    try {
      const dropped = prune(dir, cfg.retentionDays)
      if (dropped) logLine(dir, `小本本清理：${dropped} 条超期流水`)
    } catch (e) { logLine(dir, '小本本清理失败：' + errText(e)) }
  }

  const refreshAccount = async (target = creds) => {
    const acc = slimAccount(await verify(target))
    const info = await instanceInfo(target).catch(() => null)
    state.account = acc
    state.instanceInfo = info
    state.accountAt = Date.now()
    state.lastOkAt = Date.now()
    state.lastError = ''
    saveState(dir, state)
    return { account: acc, instanceInfo: info }
  }

  const fenceReject = makeFence(ctx, (m) => logLine(dir, m))

  // 心跳：每 5 分钟验一次 token；只在状态翻转时写日志，别刷屏
  ctx.effect(() => {
    const timer = setInterval(async () => {
      if (!creds.token) return
      state.lastCheckAt = Date.now()
      try {
        const acc = slimAccount(await verify(creds))
        if (state.lastError) logLine(dir, '心跳恢复：凭证可用')
        state.account = acc
        state.accountAt = Date.now()
        state.lastOkAt = Date.now()
        state.lastError = ''
      } catch (e) {
        const was = state.lastError
        state.lastError = errText(e)
        saveState(dir, state)
        if (!was) logLine(dir, `心跳失败：${state.lastError}`)
        return
      }
      saveState(dir, state)
    }, 5 * 60 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'mastodon-toot heartbeat')

  const textHash = (t) => createHash('sha1').update(t).digest('hex').slice(0, 16)
  const doPost = async (text, source) => {
    if (cfg.dryRun) {
      logLine(dir, `[试写] ${source}：${String(text).slice(0, 60).replace(/\n/g, ' ')}`)
      return { dryRun: true }
    }
    const r = await publish(creds, text)
    recordPosted(dir, { hash: textHash(text), ...r, source })
    logLine(dir, `已发（${source}）：${String(text).slice(0, 50).replace(/\n/g, ' ')}…`)
    return r
  }

  // 每分钟看一眼：队列到点没有、排期到点没有
  let ticking = false
  const tick = async () => {
    if (!creds.token || state.paused) return
    if (Date.now() - Number(state.lastIngestAt || 0) > 5 * 60 * 1000) {
      const n = ingestIfNeeded(state, dir, cfg)
      state.lastIngestAt = Date.now()
      if (n) logLine(dir, `队列收了 ${n} 条（对话/B 站）`)
    }
    const item = dueQueueItem(state)
    if (item && cfg.queueEnabled !== false) {
      await doPost(item.text, item.source || 'queue')
      markQueuePosted(state, item.id)
      state.lastPostAt = Date.now()
      state.lastPostError = ''
      saveState(dir, state)
      return
    }
    const slot = dueSlot(state, cfg)
    if (!slot) { saveState(dir, state); return }
    const { text, names } = await composePost(ctx, cfg, dir)
    await doPost(text, names.join('+') || 'compose')
    state.posting.used = [...(state.posting.used || []), slot]
    state.posting.lastAt = Date.now()
    state.lastPostAt = Date.now()
    state.lastPostError = ''
    saveState(dir, state)
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (ticking) return
      ticking = true
      tick()
        .catch((e) => {
          state.lastPostError = errText(e)
          logLine(dir, `发帖失败：${state.lastPostError}`)
          saveState(dir, state)
        })
        .finally(() => { ticking = false })
    }, 60 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'mastodon-toot scheduler')

  // 互动：每 pollSec 秒看一次通知与时间线；同一时刻只跑一轮
  let replying = false
  const runReplyRound = async (opts = {}) => {
    if (replying) return { skipped: true, reason: '上一轮还没跑完' }
    replying = true
    try {
      const out = await replyTick(ctx, creds, cfg, dir, state, { force: true, ...opts })
      if (!out.errors) state.lastReplyError = ''
      state.lastReplyAt = Date.now()
      state.replyStats = {
        lastAt: state.lastReplyAt,
        replied: Number(state.replyStats?.replied || 0) + out.replied,
        skipped: Number(state.replyStats?.skipped || 0) + out.skipped,
        errors: Number(state.replyStats?.errors || 0) + out.errors,
        lastActions: out.actions,
      }
      if (out.replied) logLine(dir, `回复了 ${out.replied} 条：${out.actions.map((a) => '@' + a.acct).join(', ')}`)
      saveState(dir, state)
      return out
    } finally {
      replying = false
    }
  }

  ctx.effect(() => {
    const every = Math.max(15, Number(cfg.pollSec) || 30) * 1000
    const timer = setInterval(() => {
      if (!cfg.autoReply || !creds.token || state.paused) return
      runReplyRound({ maxActions: 1 }).catch((e) => {
        state.lastReplyError = errText(e)
        logLine(dir, `互动失败：${state.lastReplyError}`)
        saveState(dir, state)
      })
    }, every)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'mastodon-toot reply loop')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => { // dsh-skip-func-length
      if (fenceReject(req, res)) return
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
      const u = new URL(req.url, 'http://x')
      const path = u.pathname.slice(ROUTE.length) || '/'

      try {
        // ---- 状态 ----
        if (req.method === 'GET' && path === '/status') {
          if (!state.account && creds.token && !state.paused) {
            await refreshAccount().catch((e) => { state.lastError = errText(e); saveState(dir, state) })
          }
          return sendJson(res, 200, {
            ok: true,
            version: VERSION,
            plugin: name,
            dir,
            creds: redactCreds(creds),
            account: state.account || null,
            instanceInfo: state.instanceInfo || null,
            paused: !!state.paused,
            lastCheckAt: state.lastCheckAt || 0,
            lastOkAt: state.lastOkAt || 0,
            lastError: state.lastError || '',
            notebook: notebookStats(dir),
            reply: {
              autoReply: !!cfg.autoReply,
              stats: state.replyStats || null,
              counts: state.reply?.counts || { owner: 0, friend: 0, other: 0 },
              lastSkip: state.reply?.lastSkip || '',
              lastError: state.lastReplyError || '',
            },
            relations: {
              ownerAcct: state.relations?.ownerAcct || '',
              mutual: (state.relations?.mutual || []).length,
              at: state.relations?.at || 0,
            },
            config: cfg,
            log: tailLog(dir, 30),
          })
        }

        // ---- 设置 ----
        if (req.method === 'GET' && path === '/config') {
          return sendJson(res, 200, { ok: true, config: cfg })
        }
        if (req.method === 'POST' && path === '/config') {
          const body = JSON.parse(await readBody(req) || '{}')
          cfg = mergeConfig(cfg, body.config || body)
          saveConfig(dir, cfg)
          logLine(dir, '设置已更新')
          return sendJson(res, 200, { ok: true, config: cfg })
        }

        // ---- 测试连接（可带草稿 credentials）----
        if (req.method === 'POST' && path === '/test') {
          const body = JSON.parse(await readBody(req) || '{}')
          const draft = {
            instance: body.instance ? String(body.instance) : creds.instance,
            token: body.token ? String(body.token) : creds.token,
            proxy: body.proxy !== undefined ? String(body.proxy) : creds.proxy,
          }
          if (!draft.token) return sendJson(res, 400, { ok: false, error: '先填访问令牌' })
          const { account, instanceInfo: info } = await refreshAccount(draft)
          if (body.save !== false) {
            creds = draft
            saveCreds(dir, creds)
            logLine(dir, `连接成功：@${account.acct} @ ${creds.instance}`)
          }
          return sendJson(res, 200, { ok: true, account, instanceInfo: info, creds: redactCreds(creds) })
        }

        // ---- 暂停 ----
        if (req.method === 'POST' && path === '/pause') {
          const body = JSON.parse(await readBody(req) || '{}')
          state.paused = !!body.paused
          saveState(dir, state)
          logLine(dir, state.paused ? '已暂停' : '已恢复')
          return sendJson(res, 200, { ok: true, paused: state.paused })
        }

        // ---- 互动（分组：主人/好友/其他人）----
        if (req.method === 'GET' && path === '/interact/stats') {
          return sendJson(res, 200, {
            ok: true,
            autoReply: !!cfg.autoReply,
            dryRun: !!cfg.dryRun,
            stats: state.replyStats || null,
            reply: state.reply || null,
            relations: {
              ownerAcct: state.relations?.ownerAcct || '',
              ownerId: state.relations?.ownerId || '',
              mutual: state.relations?.mutual || [],
              following: (state.relations?.following || []).length,
              at: state.relations?.at || 0,
            },
            groups: ['owner', 'friend', 'other'].map((cat) => ({
              cat,
              ...categoryConfig(cfg, cat),
              used: Number(state.reply?.counts?.[cat] || 0),
            })),
          })
        }
        if (req.method === 'POST' && path === '/interact/run') {
          const body = JSON.parse(await readBody(req) || '{}')
          const out = await runReplyRound({ maxActions: Math.max(1, Math.min(5, Number(body.maxActions) || 1)) })
          return sendJson(res, 200, { ok: true, ...out, reply: state.reply || null })
        }
        if (req.method === 'POST' && path === '/relations/refresh') {
          const rel = await refreshRelations(creds, state, { force: true })
          saveState(dir, state)
          logLine(dir, `关系刷新：互关 ${rel.mutual.length} 人`)
          return sendJson(res, 200, { ok: true, ownerAcct: rel.ownerAcct, mutual: rel.mutual })
        }

        // ---- 小本本 ----
        if (req.method === 'GET' && path === '/notebook') {
          return sendJson(res, 200, {
            ok: true,
            enabled: cfg.notebook !== 'off',
            stats: notebookStats(dir),
            digest: digest(dir, 7),
            people: listPeople(dir, { limit: 8 }),
            promises: listPromises(dir, { status: 'open' }),
            recent: recentInteractions(dir, { limit: 12 }),
          })
        }
        if (req.method === 'GET' && path === '/notebook/people') {
          return sendJson(res, 200, {
            ok: true,
            people: listPeople(dir, {
              limit: Number(u.searchParams.get('limit')) || 50,
              q: u.searchParams.get('q') || '',
            }),
          })
        }
        if (req.method === 'GET' && path === '/notebook/promises') {
          return sendJson(res, 200, {
            ok: true,
            promises: listPromises(dir, { status: u.searchParams.get('status') || 'open' }),
          })
        }
        if (req.method === 'POST' && path === '/notebook/note') {
          const body = JSON.parse(await readBody(req) || '{}')
          if (!body.acct) return sendJson(res, 400, { ok: false, error: '缺 acct' })
          const person = setNote(dir, body.acct, String(body.note || ''), Array.isArray(body.tags) ? body.tags : [])
          logLine(dir, `小本本备注：@${person.acct}`)
          return sendJson(res, 200, { ok: true, person })
        }
        if (req.method === 'POST' && path === '/notebook/promise') {
          const body = JSON.parse(await readBody(req) || '{}')
          if (!body.text) return sendJson(res, 400, { ok: false, error: '缺 text' })
          const row = addPromise(dir, { acct: body.acct || '', text: body.text, due: body.due })
          logLine(dir, `记下承诺 #${row.id}${row.acct ? ' → @' + row.acct : ''}`)
          return sendJson(res, 200, { ok: true, promise: row })
        }
        if (req.method === 'POST' && path === '/notebook/promise/resolve') {
          const body = JSON.parse(await readBody(req) || '{}')
          if (!body.id) return sendJson(res, 400, { ok: false, error: '缺 id' })
          const row = resolvePromise(dir, String(body.id), body.status)
          return sendJson(res, 200, { ok: true, promise: row })
        }

        // ---- 发帖 / 队列 ----
        if (req.method === 'GET' && path === '/posting') {
          const q = Array.isArray(state.queue) ? state.queue : []
          const today = state.posting && state.posting.date
            ? state.posting : { date: '', slots: [] }
          return sendJson(res, 200, {
            ok: true,
            enabled: !!cfg.postingEnabled,
            dryRun: !!cfg.dryRun,
            posting: today,
            queue: q.filter((x) => !x.postedAt).slice(0, 10),
            queuePending: q.filter((x) => !x.postedAt).length,
            lastPostAt: state.lastPostAt || 0,
            lastPostError: state.lastPostError || '',
            nextSlot: nextSlotOf(cfg),
          })
        }
        if (req.method === 'GET' && path === '/queue') {
          const q = Array.isArray(state.queue) ? state.queue : []
          return sendJson(res, 200, {
            ok: true,
            pending: q.filter((x) => !x.postedAt).slice(0, 30),
            done: q.filter((x) => x.postedAt).slice(-10).reverse(),
          })
        }
        if (req.method === 'POST' && path === '/queue/ingest') {
          const n = ingestIfNeeded(state, dir, cfg)
          saveState(dir, state)
          logLine(dir, `手动收队列：${n} 条`)
          return sendJson(res, 200, { ok: true, added: n })
        }
        if (req.method === 'POST' && path === '/queue/clear') {
          state.queue = (state.queue || []).filter((x) => x.postedAt)
          saveState(dir, state)
          return sendJson(res, 200, { ok: true })
        }
        if (req.method === 'POST' && path === '/post/preview') {
          const body = JSON.parse(await readBody(req) || '{}')
          const p = await buildPostPrompt(dir, cfg, { consumeChat: false })
          if (!p.prompt) return sendJson(res, 200, { ok: false, error: '今天素材都拿不到' })
          if (body.compose !== false) {
            const out = await composePost(ctx, cfg, dir, { consumeChat: false })
            return sendJson(res, 200, { ok: true, text: out.text, names: out.names, route: out.route })
          }
          return sendJson(res, 200, { ok: true, prompt: p.prompt, names: p.names })
        }
        if (req.method === 'POST' && path === '/post/now') {
          const body = JSON.parse(await readBody(req) || '{}')
          let text = String(body.text || '').trim()
          let names = []
          if (!text) {
            const out = await composePost(ctx, cfg, dir, { consumeChat: !body.draft })
            text = out.text
            names = out.names
          }
          if (!text) return sendJson(res, 400, { ok: false, error: '没有可发的内容' })
          if (body.draft) return sendJson(res, 200, { ok: true, draft: text, names })
          const r = await doPost(text, names.join('+') || 'manual')
          saveState(dir, state)
          return sendJson(res, 200, { ok: true, posted: r, text, names })
        }

        // ---- 日志 ----
        if (req.method === 'GET' && path === '/log') {
          return sendJson(res, 200, { ok: true, lines: tailLog(dir, 80) })
        }

        return sendJson(res, 404, { ok: false, error: '没有这个接口' })
      } catch (e) {
        logLine(dir, `接口错误 ${path}：${errText(e)}`)
        return sendJson(res, 500, { ok: false, error: errText(e), status: e?.status || 0 })
      }
    },
  }), 'mastodon-toot routes')
}
