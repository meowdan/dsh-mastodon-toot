/**
 * lib/relations.mjs —— 谁算「主人 / 好友 / 其他人」
 * 好友 = 互关（我关注 + 关注我）。关系每天刷新一次，缓存在 state.relations。
 */
import { api } from './masto.mjs'

const DAY = 24 * 3600_000

function lower(a) {
  return String(a || '').replace(/^@/, '').toLowerCase()
}

async function fetchAll(creds, path, pages = 3) {
  const out = []
  let maxId = ''
  for (let i = 0; i < pages; i++) {
    const sep = path.includes('?') ? '&' : '?'
    const { data: batch } = await api(creds, `${path}${sep}limit=80${maxId ? `&max_id=${maxId}` : ''}`)
    if (!Array.isArray(batch) || !batch.length) break
    out.push(...batch)
    maxId = batch[batch.length - 1].id
    if (batch.length < 80) break
  }
  return out
}

/** 刷新互关关系；失败就沿用旧缓存 */
export async function refreshRelations(creds, state, { force = false } = {}) {
  const old = state.relations || {}
  if (!force && old.at && Date.now() - old.at < DAY) return old
  const { data: me } = await api(creds, '/api/v1/accounts/verify_credentials')
  const following = await fetchAll(creds, `/api/v1/accounts/${me.id}/following`)
  const followers = await fetchAll(creds, `/api/v1/accounts/${me.id}/followers`)
  const fset = new Set(following.map((a) => lower(a.acct)))
  const mutual = [...new Set(followers.map((a) => lower(a.acct)).filter((a) => fset.has(a)))]
  const next = {
    at: Date.now(),
    ownerId: me.id,
    selfAcct: lower(me.acct),
    mutual,
    following: [...fset],
  }
  state.relations = next
  return next
}

/** 账号 → owner / friend / other */
export function categoryOf(acct, relations, cfg) {
  const a = lower(acct)
  let owners = String(cfg?.ownerAcct || relations?.ownerAcct || '')
    .split(/[,\s]+/).map(lower).filter(Boolean)
  if (!owners.length) {
    // 没填主人：只有一个互关就当主人（bot 场景），否则认本账号
    owners = (relations?.mutual || []).length === 1
      ? relations.mutual
      : [lower(relations?.selfAcct || '')].filter(Boolean)
  }
  if (owners.includes(a)) return 'owner'
  if ((relations?.mutual || []).includes(a)) return 'friend'
  return 'other'
}

/** 某一组的设置（带默认值） */
export function categoryConfig(cfg, cat) {
  const Key = cat[0].toUpperCase() + cat.slice(1)
  const pick = (name, dflt) => (cfg[`reply${Key}${name}`] === undefined ? dflt : cfg[`reply${Key}${name}`])
  return {
    enabled: pick('Enabled', true),
    mentions: pick('Mentions', true),
    timeline: pick('Timeline', cat !== 'other'),
    maxPerDay: pick('MaxPerDay', cat === 'owner' ? 0 : cat === 'friend' ? 12 : 8),
    perThread: pick('PerThread', cat === 'owner' ? 3 : cat === 'friend' ? 2 : 1),
    minGapMin: pick('MinGapMin', cat === 'owner' ? 2 : cat === 'friend' ? 10 : 15),
  }
}

export const CATEGORY_LABEL = { owner: '主人', friend: '好友', other: '其他人' }
