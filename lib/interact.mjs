/**
 * lib/interact.mjs —— 互动引擎
 * 分组：主人 / 好友（互关）/ 其他人。不掷骰子，按「开关 + 每日额度 + 冷却 + 每串上限」。
 * 通知（@ 我）与时间线（我关注的人）分开处理；每条决定都进小本本。
 */
import { api } from './masto.mjs'
import { generate } from './llm.mjs'
import { personaText } from './compose.mjs'
import { categoryOf, categoryConfig, refreshRelations, CATEGORY_LABEL } from './relations.mjs'
import { touchPerson, recordInteraction, contextFor } from './notebook.mjs'

const REPLY_RULES = [
  '你在长毛象上回别人的嘟文。',
  '写 15–80 字，像真人随口接一句：可以认同、可以吐槽、可以问一句。',
  '不要客服腔、不要总结对方的话、不要连串感叹号、不要「作为 AI」。',
  '不写 @ 前缀（系统会加）、不放链接、最多 1 个 hashtag。',
  '只输出回复正文，不要解释。',
].join('\n')

function lower(a) { return String(a || '').replace(/^@/, '').toLowerCase() }

function dayKey(cfg) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: cfg.tz || 'Asia/Shanghai' })
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function ensureReplyState(state, cfg, ownerId) {
  const today = dayKey(cfg)
  const old = state.reply || {}
  const fresh = old.date !== today
  state.reply = {
    date: today,
    ownerId: ownerId || old.ownerId || '',
    counts: fresh ? { owner: 0, friend: 0, other: 0 } : { owner: 0, friend: 0, other: 0, ...(old.counts || {}) },
    lastAt: fresh ? {} : { ...(old.lastAt || {}) },
    repliedIds: (old.repliedIds || []).slice(-500),
    notifSince: old.notifSince || '0',
    homeSince: old.homeSince || '0',
    lastSkip: old.lastSkip || '',
  }
  return state.reply
}

function idNewer(a, b) {
  try { return BigInt(a) > BigInt(b) } catch { return String(a) > String(b) }
}

function hourIn(cfg, now) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: cfg.tz || 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date(now)))
  } catch {
    return new Date(now).getHours()
  }
}

function stripReplyText(text) {
  return String(text || '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/^@[\w@.-]+\s*/g, '')
    .replace(/^\s*(回复|回)[:：]\s*/i, '')
    .trim()
}

async function contextOf(creds, statusId) {
  try {
    const { data } = await api(creds, `/api/v1/statuses/${statusId}/context`)
    return data
  } catch {
    return { ancestors: [], descendants: [] }
  }
}

/** 我在这条串里回过几次、是不是已经回过这一条 */
function threadInfo(context, meId, targetId) {
  const mine = [...(context.ancestors || []), ...(context.descendants || [])]
    .filter((s) => String(s.account?.id) === String(meId))
  return {
    count: mine.length,
    repliedThis: mine.some((s) => String(s.in_reply_to_id) === String(targetId)),
  }
}

async function composeReply(ctx, cfg, dir, acct, cat, status, thread) {
  const label = CATEGORY_LABEL[cat] || '其他人'
  const nb = (() => {
    try { return contextFor(dir, acct, { limit: 4 }) } catch { return '' }
  })()
  const earlier = (thread.ancestors || []).slice(-3)
    .map((s) => `- ${s.account?.acct}：${String(s.content || '').replace(/<[^>]+>/g, ' ').slice(0, 120)}`)
    .join('\n')
  const prompt = [
    `对方是「${label}」，账号 @${acct}。`,
    `他刚发：「${String(status.content || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 500)}」`,
    earlier ? `这串前面还有：\n${earlier}` : '',
    nb ? `小本本里关于这个人的记录：\n${nb}` : '',
    '',
    '写一条回复。',
  ].filter(Boolean).join('\n')
  const system = REPLY_RULES + personaText(cfg)
  const { text } = await generate(ctx, cfg, { system, prompt, maxTokens: 220, temperature: 0.9 })
  const clean = stripReplyText(text).slice(0, Math.max(20, Number(cfg.replyMaxChars) || 160))
  if (!clean) throw new Error('模型返回空回复')
  return clean
}

async function postReply(creds, cfg, acct, statusId, text, meId) {
  const body = {
    status: `@${acct} ${text}`,
    in_reply_to_id: statusId,
    visibility: cfg.replyVisibility || 'unlisted',
  }
  const { data } = await api(creds, '/api/v1/statuses', { method: 'POST', body })
  return data
}

function canReply(cfg, cat, rs, now) {
  const cc = categoryConfig(cfg, cat)
  if (!cc.enabled) return { ok: false, why: `${CATEGORY_LABEL[cat]}已关` }
  const used = Number(rs.counts?.[cat] || 0)
  if (cc.maxPerDay > 0 && used >= cc.maxPerDay) return { ok: false, why: `${CATEGORY_LABEL[cat]}今日额度用完` }
  const last = Number(rs.lastAt?.[cat] || 0)
  if (last && now - last < cc.minGapMin * 60_000) return { ok: false, why: `${CATEGORY_LABEL[cat]}冷却中` }
  return { ok: true, cc }
}

/**
 * 跑一轮互动。返回 { replied, skipped, errors }。
 * dryRun：照常生成，只记小本本不发。
 */
export async function replyTick(ctx, creds, cfg, dir, state, { now = Date.now(), maxActions = 1, force = false } = {}) {
  const out = { replied: 0, skipped: 0, errors: 0, actions: [] }
  if (state.paused || !creds.token) return out
  if (!cfg.autoReply && !force) return out
  const blocked = new Set((cfg.blocklist || []).map(lower))

  const night = cfg.nightPause && (hourIn(cfg, now) >= 23 || hourIn(cfg, now) < 8)
  let relations = state.relations || {}
  try {
    relations = await refreshRelations(creds, state)
  } catch (e) {
    out.errors++
    state.lastReplyError = String(e?.message || e)
  }
  const meId = relations.ownerId
  const rs = ensureReplyState(state, cfg, meId)
  const sinceMs = now - Math.max(1, Number(cfg.sinceHours) || 20) * 3600_000

  // ── 1. 通知（@ 我） ─────────────────────────────
  let notifs = []
  try {
    const q = `/api/v1/notifications?limit=40${rs.notifSince && rs.notifSince !== '0' ? `&since_id=${rs.notifSince}` : ''}`
    const { data } = await api(creds, q)
    notifs = (Array.isArray(data) ? data : []).filter((n) => n.type === 'mention' && n.status)
  } catch (e) {
    out.errors++
    state.lastReplyError = String(e?.message || e)
  }
  // 按账号分组：同一串只回最后一条
  const byAcct = new Map()
  for (const n of notifs) {
    const a = lower(n.account?.acct)
    const cur = byAcct.get(a)
    if (!cur || idNewer(n.status.id, cur.status.id)) byAcct.set(a, n)
  }
  const mentions = [...byAcct.values()].sort((x, y) => (idNewer(x.status.id, y.status.id) ? 1 : -1))

  for (const n of mentions) {
    if (out.replied >= maxActions) break
    if (Number(n.status.created_at ? new Date(n.status.created_at).getTime() : 0) < sinceMs) continue
    const acct = lower(n.account?.acct)
    if (blocked.has(acct)) continue
    const cat = categoryOf(acct, relations, cfg)
    if (night && cat !== 'owner') continue
    const cc = categoryConfig(cfg, cat)
    if (!cc.mentions) continue
    if (rs.repliedIds.includes(n.status.id)) continue
    const guard = canReply(cfg, cat, rs, now)
    if (!guard.ok) { out.skipped++; rs.lastSkip = guard.why; continue }
    const context = await contextOf(creds, n.status.id)
    const ti = threadInfo(context, meId, n.status.id)
    if (ti.repliedThis) { out.skipped++; continue }
    if (ti.count >= cc.perThread) { out.skipped++; rs.lastSkip = `${CATEGORY_LABEL[cat]}这串回够了`; continue }
    try {
      const text = await composeReply(ctx, cfg, dir, acct, cat, n.status, context)
      if (cfg.dryRun) {
        recordInteraction(dir, { kind: 'skip', acct, statusId: n.status.id, threadId: n.status.in_reply_to_id || n.status.id, direction: 'them', text: n.status.content, reply: text, why: 'dryRun 只记账', model: 'llm' })
        out.actions.push({ acct, cat, dryRun: true, text })
      } else {
        const r = await postReply(creds, cfg, acct, n.status.id, text, meId)
        rs.counts[cat] = Number(rs.counts[cat] || 0) + 1
        rs.lastAt[cat] = now
        rs.repliedIds.push(n.status.id)
        rs.repliedIds = rs.repliedIds.slice(-500)
        touchPerson(dir, { acct, id: n.account.id, display: n.account.display_name }, { lastSeen: now, count: 1 })
        recordInteraction(dir, { kind: 'reply', acct, statusId: n.status.id, threadId: n.status.in_reply_to_id || n.status.id, direction: 'me', text: n.status.content, reply: text, replyId: r?.id, url: r?.url, model: 'llm' })
        out.replied++
        out.actions.push({ acct, cat, text })
      }
    } catch (e) {
      out.errors++
      state.lastReplyError = String(e?.message || e)
    }
  }

  if (notifs.length) {
    const maxId = notifs.map((n) => n.id).sort((a, b) => (idNewer(a, b) ? 1 : -1)).pop()
    if (maxId) rs.notifSince = maxId
  }

  // ── 2. 时间线（我关注的人，没 @ 我） ─────────────
  if (out.replied < maxActions) {
    let home = []
    try {
      const q = `/api/v1/timelines/home?limit=20${rs.homeSince && rs.homeSince !== '0' ? `&since_id=${rs.homeSince}` : ''}`
      const { data } = await api(creds, q)
      home = Array.isArray(data) ? data : []
    } catch (e) {
      out.errors++
    }
    for (const s of home.slice().sort((x, y) => (idNewer(x.id, y.id) ? 1 : -1))) {
      if (out.replied >= maxActions) break
      if (!s || s.reblog || !s.account) continue
      if (String(s.account.id) === String(meId)) continue
      if (s.in_reply_to_id) continue                       // 只插话顶层帖，不闯别人串
      if (s.visibility === 'direct' || s.visibility === 'private') continue
      const t = s.created_at ? new Date(s.created_at).getTime() : 0
      if (t && t < sinceMs) continue
      const acct = lower(s.account.acct)
      if (blocked.has(acct)) continue
      const cat = categoryOf(acct, relations, cfg)
      if (night && cat !== 'owner') continue
      const cc = categoryConfig(cfg, cat)
      if (!cc.timeline) continue
      if (rs.repliedIds.includes(s.id)) continue
      const guard = canReply(cfg, cat, rs, now)
      if (!guard.ok) continue
      const context = await contextOf(creds, s.id)
      const ti = threadInfo(context, meId, s.id)
      if (ti.repliedThis || ti.count > 0) continue
      try {
        const text = await composeReply(ctx, cfg, dir, acct, cat, s, context)
        if (cfg.dryRun) {
          recordInteraction(dir, { kind: 'skip', acct, statusId: s.id, threadId: s.id, direction: 'them', text: s.content, reply: text, why: 'dryRun 只记账', model: 'llm' })
          out.actions.push({ acct, cat, dryRun: true, text, timeline: true })
        } else {
          const r = await postReply(creds, cfg, acct, s.id, text, meId)
          rs.counts[cat] = Number(rs.counts[cat] || 0) + 1
          rs.lastAt[cat] = now
          rs.repliedIds.push(s.id)
          rs.repliedIds = rs.repliedIds.slice(-500)
          touchPerson(dir, { acct, id: s.account.id, display: s.account.display_name }, { lastSeen: now, count: 1 })
          recordInteraction(dir, { kind: 'reply', acct, statusId: s.id, threadId: s.id, direction: 'me', text: s.content, reply: text, replyId: r?.id, url: r?.url, model: 'llm' })
          out.replied++
          out.actions.push({ acct, cat, text, timeline: true })
        }
      } catch (e) {
        out.errors++
        state.lastReplyError = String(e?.message || e)
      }
    }
    if (home.length) {
      const maxId = home.map((s) => s.id).sort((a, b) => (idNewer(a, b) ? 1 : -1)).pop()
      if (maxId) rs.homeSince = maxId
    }
  }

  return out
}
