// dsh-skip-func-length: makeRouteHandler 是路由表装配入口，每个域处理器都是独立的 ≤50 行函数；静态分析把嵌套闭包行数算进了外层
/**
 * routes.mjs —— /api/mastodon-toot 的全部 HTTP 路由
 * 从 index.js 拆出来，index 只留生命周期与定时器。
 * 每个域一个小函数，handler 只做匹配分发。
 */
import { join } from 'node:path'
import {
  saveConfig, saveCreds, saveState, logLine, tailLog, mergeConfig,
  notebookStats, redactCreds, readJson,
} from './store.mjs'
import {
  digest, listPeople, listPromises, recentInteractions, setNote,
  addPromise, resolvePromise,
} from './notebook.mjs'
import { composePost, buildPostPrompt } from './compose.mjs'
import { categoryConfig, refreshRelations } from './relations.mjs'
import { ingestIfNeeded, postStats } from './posting.mjs'
import {
  AUTO_AGE_DAYS, FILE_LABEL, createCharacter, deleteCharacter, ensureDefault,
  listCharacters, personaBundle, readCharacter, readCurrentId, restoreSnapshot,
  saveCharacter, snapshotCharacter, switchCharacter,
} from './character.mjs'

export function makeRouteHandler(d) {
  const {
    ctx, dir, state, route, sendJson, readBody, sameOrigin, fenceReject,
    errText, nextSlotOf, refreshAccount, runReplyRound, doPost, setCfg, setCreds,
    VERSION, name,
  } = d
  let cfg = d.getCfg()
  let creds = d.getCreds()

  const bodyOf = async (req) => JSON.parse((await readBody(req)) || '{}')

  // 信任栅栏是否真的在跑：在 = 它已负责鉴权与 Host/Origin 校验，不必再卡回环 Host
  const fenceReady = () => {
    try { return typeof fenceReject.available === 'function' ? fenceReject.available() : false } catch { return false }
  }

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
      posting: { stats: postStats(dir), lastPostAt: state.lastPostAt || 0 },
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

  async function handleCharacter(req, res) {
    const id = ensureDefault(dir, cfg)
    const char = readCharacter(dir, id)
    const bundle = personaBundle(dir, cfg)
    return sendJson(res, 200, {
      ok: true,
      currentId: id,
      characters: listCharacters(dir),
      character: char,
      filesLabel: FILE_LABEL,
      autoAgeDays: AUTO_AGE_DAYS,
      preview: bundle.text,
      hasLegacy: !!String(cfg.personaFile || cfg.personaText || '').trim(),
    })
  }

  async function handleCharacterSave(req, res) {
    const body = await bodyOf(req)
    const action = String(body.action || 'save')
    const id = String(body.id || readCurrentId(dir) || '')
    try {
      if (action === 'switch') {
        const r = switchCharacter(dir, body.id)
        logLine(dir, `切换角色卡 → ${r.id}`)
        return sendJson(res, 200, { ok: true, ...r, currentId: r.id })
      }
      if (action === 'create') {
        const r = createCharacter(dir, {
          name: body.name, selfName: body.selfName, ownerName: body.ownerName,
          persona: body.files?.persona, tone: body.files?.tone,
          daily: body.files?.daily, scenes: body.files?.scenes,
        })
        if (body.activate !== false) switchCharacter(dir, r.id)
        logLine(dir, `新建角色卡：${r.name}`)
        return sendJson(res, 200, { ok: true, ...r, currentId: readCurrentId(dir) })
      }
      if (action === 'delete') {
        deleteCharacter(dir, body.id)
        logLine(dir, `删除角色卡 ${body.id}（已移入 .trash）`)
        return sendJson(res, 200, { ok: true, trashed: true })
      }
      if (action === 'snapshot') {
        snapshotCharacter(dir, id, { slot: `manual-${Date.now()}`, reason: 'manual' })
        return sendJson(res, 200, { ok: true, snapshots: readCharacter(dir, id).snapshots })
      }
      if (action === 'restore') {
        restoreSnapshot(dir, id, body.slot)
        logLine(dir, `恢复角色卡快照：${body.slot}`)
        return sendJson(res, 200, { ok: true, character: readCharacter(dir, id) })
      }
      const r = saveCharacter(dir, id, body.files || {}, body.meta || {})
      logLine(dir, `保存角色卡：${r.id}`)
      const char = readCharacter(dir, id)
      return sendJson(res, 200, { ok: true, ...r, character: char, preview: personaBundle(dir, cfg).text })
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: errText(e) })
    }
  }

  async function handleMemory(req, res) {
    const ledger = readJson(join(dir, 'state', 'posted.json'), {})
    const posted = Object.values(ledger)
      .filter((r) => r && r.text)
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .slice(0, 20)
      .map((r) => ({ at: Number(r.at) || 0, text: String(r.text), source: String(r.source || r.kind || ''), url: String(r.url || '') }))
    return sendJson(res, 200, {
      ok: true,
      book: notebookStats(dir),
      digest: digest(dir),
      people: listPeople(dir, { limit: 30 }),
      promises: listPromises(dir, { status: 'open' }),
      interactions: recentInteractions(dir, { limit: 15 }),
      posted,
      characterId: readCurrentId(dir),
    })
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
      stats: postStats(dir),
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
    ['GET', '/character', handleCharacter],
    ['POST', '/character', handleCharacterSave],
    ['GET', '/memory', handleMemory],
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
    // 栅栏在时它已经校验过 Host/Origin（回环、绑定地址、--trusted-host 都放行），
    // 这里再按老规矩卡回环会把反代域名下的设置页整个卡死；只有栅栏不可用才退回同源兜底。
    if (!fenceReady() && !sameOrigin(req, { loopbackOnly: true })) {
      return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
    }
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
