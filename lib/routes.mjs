// dsh-skip-func-length: makeRouteHandler 是路由表装配入口，每个域处理器都是独立的 ≤50 行函数；静态分析把嵌套闭包行数算进了外层
/**
 * routes.mjs —— /api/mastodon-toot 的全部 HTTP 路由
 * 从 index.js 拆出来，index 只留生命周期与定时器。
 * 每个域一个小函数，handler 只做匹配分发。
 */
import {
  saveConfig, saveCreds, saveState, logLine, tailLog, mergeConfig,
  notebookStats, redactCreds,
} from './store.mjs'
import {
  digest, listPeople, listPromises, recentInteractions, setNote,
  addPromise, resolvePromise,
} from './notebook.mjs'
import { composePost, buildPostPrompt } from './compose.mjs'
import { categoryConfig, refreshRelations } from './relations.mjs'
import { ingestIfNeeded } from './posting.mjs'

export function makeRouteHandler(d) {
  const {
    ctx, dir, state, route, sendJson, readBody, sameOrigin, fenceReject,
    errText, nextSlotOf, refreshAccount, runReplyRound, doPost, setCfg, setCreds,
    VERSION, name,
  } = d
  let cfg = d.getCfg()
  let creds = d.getCreds()

  const bodyOf = async (req) => JSON.parse((await readBody(req)) || '{}')

  async function handleStatus(req, res) {
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

  async function handleConfigGet(req, res) {
    return sendJson(res, 200, { ok: true, config: cfg })
  }

  async function handleConfigSave(req, res) {
    const body = await bodyOf(req)
    cfg = mergeConfig(cfg, body.config || body)
    setCfg(cfg)
    saveConfig(dir, cfg)
    logLine(dir, '设置已更新')
    return sendJson(res, 200, { ok: true, config: cfg })
  }

  async function handleTest(req, res) {
    const body = await bodyOf(req)
    const draft = {
      instance: body.instance ? String(body.instance) : creds.instance,
      token: body.token ? String(body.token) : creds.token,
      proxy: body.proxy !== undefined ? String(body.proxy) : creds.proxy,
    }
    if (!draft.token) return sendJson(res, 400, { ok: false, error: '先填访问令牌' })
    const { account, instanceInfo: info } = await refreshAccount(draft)
    if (body.save !== false) {
      creds = draft
      setCreds(creds)
      saveCreds(dir, creds)
      logLine(dir, `连接成功：@${account.acct} @ ${creds.instance}`)
    }
    return sendJson(res, 200, { ok: true, account, instanceInfo: info, creds: redactCreds(creds) })
  }

  async function handlePause(req, res) {
    const body = await bodyOf(req)
    state.paused = !!body.paused
    saveState(dir, state)
    logLine(dir, state.paused ? '已暂停' : '已恢复')
    return sendJson(res, 200, { ok: true, paused: state.paused })
  }

  async function handleInteractStats(req, res) {
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

  async function handleInteractRun(req, res) {
    const body = await bodyOf(req)
    const out = await runReplyRound({ maxActions: Math.max(1, Math.min(5, Number(body.maxActions) || 1)) })
    return sendJson(res, 200, { ok: true, ...out, reply: state.reply || null })
  }

  async function handleRelationsRefresh(req, res) {
    const rel = await refreshRelations(creds, state, { force: true })
    saveState(dir, state)
    logLine(dir, `关系刷新：互关 ${rel.mutual.length} 人`)
    return sendJson(res, 200, { ok: true, ownerAcct: rel.ownerAcct, mutual: rel.mutual })
  }

  async function handleNotebook(req, res) {
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

  async function handleNotebookPeople(req, res, u) {
    return sendJson(res, 200, {
      ok: true,
      people: listPeople(dir, {
        limit: Number(u.searchParams.get('limit')) || 50,
        q: u.searchParams.get('q') || '',
      }),
    })
  }

  async function handleNotebookPromises(req, res, u) {
    return sendJson(res, 200, {
      ok: true,
      promises: listPromises(dir, { status: u.searchParams.get('status') || 'open' }),
    })
  }

  async function handleNotebookNote(req, res) {
    const body = await bodyOf(req)
    if (!body.acct) return sendJson(res, 400, { ok: false, error: '缺 acct' })
    const person = setNote(dir, body.acct, String(body.note || ''), Array.isArray(body.tags) ? body.tags : [])
    logLine(dir, `小本本备注：@${person.acct}`)
    return sendJson(res, 200, { ok: true, person })
  }

  async function handleNotebookPromise(req, res) {
    const body = await bodyOf(req)
    if (!body.text) return sendJson(res, 400, { ok: false, error: '缺 text' })
    const row = addPromise(dir, { acct: body.acct || '', text: body.text, due: body.due })
    logLine(dir, `记下承诺 #${row.id}${row.acct ? ' → @' + row.acct : ''}`)
    return sendJson(res, 200, { ok: true, promise: row })
  }

  async function handleNotebookPromiseResolve(req, res) {
    const body = await bodyOf(req)
    if (!body.id) return sendJson(res, 400, { ok: false, error: '缺 id' })
    const row = resolvePromise(dir, String(body.id), body.status)
    return sendJson(res, 200, { ok: true, promise: row })
  }

  async function handlePosting(req, res) {
    const q = Array.isArray(state.queue) ? state.queue : []
    const today = state.posting && state.posting.date ? state.posting : { date: '', slots: [] }
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

  async function handleQueue(req, res) {
    const q = Array.isArray(state.queue) ? state.queue : []
    return sendJson(res, 200, {
      ok: true,
      pending: q.filter((x) => !x.postedAt).slice(0, 30),
      done: q.filter((x) => x.postedAt).slice(-10).reverse(),
    })
  }

  async function handleQueueIngest(req, res) {
    const n = ingestIfNeeded(state, dir, cfg)
    saveState(dir, state)
    logLine(dir, `手动收队列：${n} 条`)
    return sendJson(res, 200, { ok: true, added: n })
  }

  async function handleQueueClear(req, res) {
    state.queue = (state.queue || []).filter((x) => x.postedAt)
    saveState(dir, state)
    return sendJson(res, 200, { ok: true })
  }

  async function handlePostPreview(req, res) {
    const body = await bodyOf(req)
    const p = await buildPostPrompt(dir, cfg, { consumeChat: false, consumeTimeline: false, creds })
    if (!p.prompt) return sendJson(res, 200, { ok: false, error: '今天素材都拿不到' })
    if (body.compose !== false) {
      const out = await composePost(ctx, cfg, dir, { consumeChat: false, consumeTimeline: false, creds })
      return sendJson(res, 200, { ok: true, text: out.text, names: out.names, route: out.route })
    }
    return sendJson(res, 200, { ok: true, prompt: p.prompt, names: p.names })
  }

  async function handlePostNow(req, res) {
    const body = await bodyOf(req)
    let text = String(body.text || '').trim()
    let names = []
    if (!text) {
      const out = await composePost(ctx, cfg, dir, { consumeChat: !body.draft, consumeTimeline: !body.draft, creds })
      text = out.text
      names = out.names
    }
    if (!text) return sendJson(res, 400, { ok: false, error: '没有可发的内容' })
    if (body.draft) return sendJson(res, 200, { ok: true, draft: text, names })
    const r = await doPost(text, names.join('+') || 'manual')
    saveState(dir, state)
    return sendJson(res, 200, { ok: true, posted: r, text, names })
  }

  async function handleLog(req, res) {
    return sendJson(res, 200, { ok: true, lines: tailLog(dir, 80) })
  }

  const table = [
    ['GET', '/status', handleStatus],
    ['GET', '/config', handleConfigGet],
    ['POST', '/config', handleConfigSave],
    ['POST', '/test', handleTest],
    ['POST', '/pause', handlePause],
    ['GET', '/interact/stats', handleInteractStats],
    ['POST', '/interact/run', handleInteractRun],
    ['POST', '/relations/refresh', handleRelationsRefresh],
    ['GET', '/notebook', handleNotebook],
    ['GET', '/notebook/people', handleNotebookPeople],
    ['GET', '/notebook/promises', handleNotebookPromises],
    ['POST', '/notebook/note', handleNotebookNote],
    ['POST', '/notebook/promise', handleNotebookPromise],
    ['POST', '/notebook/promise/resolve', handleNotebookPromiseResolve],
    ['GET', '/posting', handlePosting],
    ['GET', '/queue', handleQueue],
    ['POST', '/queue/ingest', handleQueueIngest],
    ['POST', '/queue/clear', handleQueueClear],
    ['POST', '/post/preview', handlePostPreview],
    ['POST', '/post/now', handlePostNow],
    ['GET', '/log', handleLog],
  ]

  return async (req, res) => {
    if (fenceReject(req, res)) return
    if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
    const u = new URL(req.url, 'http://x')
    const path = u.pathname.slice(route.length) || '/'
    const hit = table.find(([m, p]) => m === req.method && p === path)
    try {
      if (!hit) return sendJson(res, 404, { ok: false, error: '没有这个接口' })
      return await hit[2](req, res, u)
    } catch (e) {
      logLine(dir, `接口错误 ${path}：${errText(e)}`)
      return sendJson(res, 500, { ok: false, error: errText(e), status: e?.status || 0 })
    }
  }
}
