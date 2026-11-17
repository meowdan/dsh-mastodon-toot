/**
 * index.js —— 宿主侧：路由 + 心跳 + 状态
 * 插件只做「连接、状态、设置读写、暂停」；互动引擎在 lib/interact.mjs（M3）。
 */
import { homeDirOf } from './lib/paths.mjs'
import {
  loadConfig, importLegacyCreds, loadState, saveState, logLine,
} from './lib/store.mjs'
import { api, verify, instanceInfo, slimAccount, MastoError } from './lib/masto.mjs'
import { prune } from './lib/notebook.mjs'
import { composePost } from './lib/compose.mjs'
import { replyTick } from './lib/interact.mjs'
import { makeRouteHandler } from './lib/routes.mjs'
import {
  publish, dueSlot, dueQueueItem, markQueuePosted, recordPosted, normalizeQueue,
  ingestIfNeeded, slotsFor,
} from './lib/posting.mjs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

export const name = 'mastodon-toot'
export const inject = ['webServer']

const ROUTE = '/api/mastodon-toot'
// 版本号只认 package.json 一处，别再手写常量（0.3.12 漏改过一次）
const VERSION = createRequire(import.meta.url)('./package.json').version

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

  // 查重：同一段话已经在我主页上出现过的，绝不再发第二遍。
  // 起因：旧 python 管道和插件各记各的账，同一条 bili 稿子 13:46 发过一次、16:00 又被插件当新稿发了一次。
  const normText = (t) => String(t).replace(/https?:\/\/\S+/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim()
  const recentMemo = { at: 0, list: [] }
  const recentOwnTexts = async () => {
    if (Date.now() - recentMemo.at < 2 * 60 * 1000) return recentMemo.list
    let id = state.account?.id
    if (!id) {
      try { state.account = slimAccount(await verify(creds)); id = state.account?.id } catch { /* 连不上就算了 */ }
    }
    if (!id) return recentMemo.list
    try {
      const { data } = await api(creds, `/api/v1/accounts/${id}/statuses?limit=40&exclude_replies=true&exclude_reblogs=true`)
      recentMemo.list = (Array.isArray(data) ? data : []).map((s) => normText(s.content))
      recentMemo.at = Date.now()
    } catch { /* 查不了就照发，不能因为查重把正事卡住 */ }
    return recentMemo.list
  }
  const looksDuplicate = async (text) => {
    if (cfg.skipDuplicate === false) return false
    const n = normText(text)
    if (n.length < 12) return false
    const head = n.slice(0, 24)
    const seen = await recentOwnTexts()
    const hit = seen.some((x) => x === n || (x.length >= 24 && x.slice(0, 24) === head))
    if (hit) recentMemo.list.push(n)
    return hit
  }

  const doPost = async (text, source) => {
    if (cfg.dryRun) {
      logLine(dir, `[试写] ${source}：${String(text).slice(0, 60).replace(/\n/g, ' ')}`)
      return { dryRun: true }
    }
    if (await looksDuplicate(text)) {
      logLine(dir, `跳过重复（这段话已经发过）：${String(text).slice(0, 40).replace(/\n/g, ' ')}…`)
      return { duplicate: true }
    }
    const r = await publish(creds, text)
    recordPosted(dir, { hash: textHash(text), ...r, source })
    recentMemo.list.push(normText(text))
    recentMemo.at = Date.now()
    logLine(dir, `已发（${source}）：${String(text).slice(0, 50).replace(/\n/g, ' ')}…`)
    return r
  }

  // 每分钟看一眼：队列到点没有、排期到点没有
  let ticking = false
  const tick = async () => {
    if (!creds.token || state.paused) return
    if (!cfg.postingEnabled) return
    if (Date.now() - Number(state.lastIngestAt || 0) > 5 * 60 * 1000) {
      const n = ingestIfNeeded(state, dir, cfg)
      state.lastIngestAt = Date.now()
      if (n) logLine(dir, `队列收了 ${n} 条（对话/B 站）`)
    }
    const fixed = normalizeQueue(state, cfg)
    if (fixed) logLine(dir, `队列时间修正 ${fixed} 条`)
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
    const { text, names } = await composePost(ctx, cfg, dir, { creds })
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

  const handler = makeRouteHandler({
    ctx, dir, state, route: ROUTE, sendJson, readBody, sameOrigin, fenceReject,
    errText, nextSlotOf, refreshAccount, runReplyRound, doPost, VERSION, name,
    getCfg: () => cfg,
    setCfg: (v) => { cfg = v },
    getCreds: () => creds,
    setCreds: (v) => { creds = v },
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'mastodon-toot routes')
}
