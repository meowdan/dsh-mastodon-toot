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
  publish, dueSlot, dueQueueItem, markQueuePosted, removeQueueItem, recordPosted, normalizeQueue,
  ingestIfNeeded, slotsFor,
} from './lib/posting.mjs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { normText, textHash, simDice, simWordDice, isDuplicate, saidPool, ledgerTexts, sanityText } from './lib/dedup.mjs'
import { generate } from './lib/llm.mjs'

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

/**
 * 本机/同源兜底。只在拿不到 DSH 信任栅栏（connection.requestRejection）时才当门用。
 *
 * 0.3.13 及以前这里把 Host 写死成 127.0.0.1/localhost/[::1]，结果从反代域名
 * （例如 https://deepseek.gdyxkj.com.cn → 127.0.0.1:3080）打开设置页时，所有
 * /api/mastodon-toot 请求都被判成「只接受本机同源请求」，读状态/保存设置全 403。
 * 栅栏本身已经校验 Host/Origin（回环、绑定地址、--trusted-host 都认），所以这里
 * 只负责浏览器侧的同源比较：Origin/Referer 的 authority 必须与 Host 一致。
 *
 * @param req 原始请求
 * @param opts.loopbackOnly = true 时保留旧的「Host 必须是回环」限制（栅栏不可用时的保守兜底）
 */
function sameOrigin(req, { loopbackOnly = false } = {}) {
  const host = String(req.headers.host || '')
  if (!host) return true // 非浏览器调用（curl/自测）
  if (loopbackOnly && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const pick = String(req.headers.origin || req.headers.referer || '')
  if (!pick) return true // 不是浏览器发的（本机脚本/宿主内部）
  try {
    const u = new URL(pick)
    const scheme = u.protocol === 'https:' ? 'https:' : u.protocol === 'http:' ? 'http:' : ''
    if (!scheme) return false
    // Host 可能不带端口（反代转发时），按 Origin 的 scheme 补默认端口后再比
    const hostUrl = new URL(`${scheme}//${host}`)
    return u.host === hostUrl.host
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
  const reject = (req, res) => {
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
  // 栅栏可用时它就是真鉴权（含 Host/Origin 校验），路由层不必再叠一道回环限制
  reject.available = () => !!getConn()
  return reject
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

  // 查重增强版（v0.3.15）：账本 + 队列 + 主页最近 100 条，bigram Dice ≥ 0.6 也算重复
  // v0.3.16：字面相似的直接拦；字面不太像（0.15–0.6）但可能是同一件事的灰区候选，
  // 交给 LLM 判「是不是同一件事」——措辞彻底重写（凌晨挤果醋 vs 凌晨挤果醋这事我干过一次）也能兜住。
  const recentMemo = { at: 0, list: [] }
  const recentOwnTexts = async () => {
    if (Date.now() - recentMemo.at < 2 * 60 * 1000) return recentMemo.list
    let id = state.account?.id
    if (!id) {
      try { state.account = slimAccount(await verify(creds)); id = state.account?.id } catch { /* 连不上就算了 */ }
    }
    if (!id) return recentMemo.list
    try {
      const { data } = await api(creds, `/api/v1/accounts/${id}/statuses?limit=100&exclude_replies=true&exclude_reblogs=true`)
      recentMemo.list = (Array.isArray(data) ? data : []).map((s) => normText(s.content))
      recentMemo.at = Date.now()
    } catch { /* 查不了就照发，不能因为查重把正事卡住 */ }
    return recentMemo.list
  }

  // 语义灰区复审：失败/拿不到 LLM 就当「不像重复」放行，绝不让查重卡死发帖
  async function asksSemanticDuplicate(n, cand, source) {
    try {
      const system =
        '你在帮一个长毛象 bot 查重。现在已经有很多条嘟文发出去了，' +
        '现在要判断一条新的嘟文是不是和历史上某一条在说同一件事。' +
        '只回答 JSON：{"dup": true|false, "why": "一句话理由"}。'
      const prompt =
        `历史嘟文（已发过）：\n「${String(cand).slice(0, 200)}」\n\n` +
        `新嘟文：\n「${String(n).slice(0, 200)}」\n\n` +
        '是不是在说同一件事（同一件事哪怕换措辞、换角度也算重复）？只输出 JSON。'
      const { text } = await generate(ctx, cfg, { system, prompt, maxTokens: 80, temperature: 0 })
      const m = String(text || '').match(/"(?:dup|duplicate)"\s*:\s*(true|false)/)
      return m ? m[1] === 'true' : false
    } catch {
      return { error: true }
    }
  }

  const looksDuplicate = async (text, opts = {}) => {
    if (cfg.skipDuplicate === false) return false
    const n = normText(text)
    if (n.length < 12) return false
    // ① 账本查重（300 条全查）+ 队列（排除自己，否则自己比自己必判重复）+ 主页最近 100 条
    try {
      const ledger = ledgerTexts(dir)
      const ex = new Set(opts.excludeIds || [])
      const qPool = (state.queue || []).filter((x) => !ex.has(x.id))
      const pool = saidPool({ ledger: ledger.map((t) => ({ n: t })), queue: qPool, recent: await recentOwnTexts() })
      const grayZone = []
      for (const existing of pool) {
        if (isDuplicate(n, existing)) {
          recentMemo.list.push(n)
          return true
        }
        // 灰区：bigram 0.15–0.6 —— 字面不够像，但可能是同一件事（措辞重写）。
        // 只收 top 3，LLM 复审开销最小；<0.15 基本是不同话题，不浪费查询。
        const d = simDice(n, existing)
        if (d >= 0.15 && d < 0.6) grayZone.push({ d, t: existing })
      }
      // 词级强通道（v0.3.16）：同主题重写，措辞换个说法但实词还撞着
      // 果醋/木碗/广州/闹钟… 这类 ≥2 字词命中足够多 → 不依赖 LLM 直接判重
      for (const existing of pool) {
        const wd = simWordDice(n, existing)
        if (wd >= 0.22) {
          recentMemo.list.push(n)
          logLine(dir, '词级判重（' + (opts.source || 'compose') + ' vs ' + String(existing).slice(0, 30) + '…）wordDice=' + wd.toFixed(3) + '：' + String(text).slice(0, 40) + '…')
          return true
        }
      }
      if (grayZone.length) {
        grayZone.sort((a, b) => b.d - a.d)
        const src = opts.source || 'compose'
        for (const g of grayZone.slice(0, 3)) {
          const verdict = await asksSemanticDuplicate(n, g.t, src)
          // 失败（LLM 链路不稳）时保守拦截：拿不准就当重复，宁缺毋滥 —— 用户要的是「不要发重复」
          if (verdict && (verdict === true || verdict.error)) {
            recentMemo.list.push(n)
            logLine(dir, verdict.error
              ? '语义判重（LLM 不可用，保守拦截）：' + String(text).slice(0, 40) + '…'
              : `语义判重（${src} vs 灰区 重复「${String(g.t).slice(0, 30)}…」dice=${g.d.toFixed(3)}）：${String(text).slice(0, 40)}…`)
            return true
          }
        }
      }
    } catch { /* 账本读坏了也别卡 */ }
    return false
  }

  const doPost = async (text, source, opts = {}) => {
    if (cfg.dryRun) {
      logLine(dir, `[试写] ${source}：${String(text).slice(0, 60).replace(/\n/g, ' ')}`)
      return { dryRun: true }
    }
    const sanity = sanityText(text, { kind: 'post' })
    if (!sanity.ok) {
      logLine(dir, `发帖拦截（${sanity.why}）：${String(text).slice(0, 40).replace(/\n/g, ' ')}…`)
      return { blocked: true, why: sanity.why }
    }
    if (await looksDuplicate(text, opts)) {
      logLine(dir, `跳过重复（账本/队列/主页）：${String(text).slice(0, 40).replace(/\n/g, ' ')}…`)
      return { duplicate: true }
    }
    const r = await publish(creds, text)
    recordPosted(dir, { hash: textHash(text), n: normText(text), text: String(text), ...r, source })
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
      // 查重时排除自己（自己还没发，不算重复），只和账本/其它队列条目/主页比
      const r = await doPost(item.text, item.source || 'queue', { excludeIds: [item.id] })
      // 只有真正发出去才算队列消费；重复/拦截/试写都不该白耗条目，等下轮还能重试
      if (r && (r.ok || r.id)) {
        markQueuePosted(state, item.id)
        state.lastPostAt = Date.now()
        state.lastPostError = ''
        saveState(dir, state)
        return
      }
      if (r && r.blocked) { return }
      if (r && r.duplicate) {
        // 真重复：这是主页/账本里已经发过的内容，留着只会每分钟重试卡死队列（live2D 那条就是）。
        // 直接移出队列，别再占位。
        removeQueueItem(state, item.id)
        saveState(dir, state)
        logLine(dir, `队列移除重复：${String(item.text).slice(0, 40).replace(/\n/g, ' ')}…`)
        return
      }
      if (r && r.dryRun) { return }
      // 其它情况（失败/异常）：也先留着，别把没发出去的丢掉
      return
    }
    const slot = dueSlot(state, cfg)
    if (!slot) { saveState(dir, state); return }
    const { text, names } = await composePost(ctx, cfg, dir, { creds })
    const r = await doPost(text, names.join('+') || 'compose')
    // 排期槽位发出的内容被判重复/拦截/失败时：槽位照常消耗、绝不重试同一段，
    // 避免每分钟死磕浪费 LLM（宁缺毋滥，防重复优先）；lastPostAt 只在真发出时才更新
    if (!(r && (r.ok || r.id))) {
      logLine(dir, `排期槽位 ${slot}：${r?.duplicate ? '内容与已发重复，本槽不发' : r?.blocked ? '被敏感/格式拦截' : '发布未成功'}（槽位照常消耗，下个槽点再生成新话题）`)
    } else {
      state.lastPostAt = Date.now()
    }
    state.posting.used = [...(state.posting.used || []), slot]
    state.posting.lastAt = Date.now()
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
