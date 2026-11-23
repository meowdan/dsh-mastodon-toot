/**
 * lib/dedup.mjs —— 查重：发过的、说过的，别再说第二遍
 * 归一化（去 链接/HTML/@提及/hashtag/空白）后比较：
 *   1) 全文相等
 *   2) 开头 24 字相同（模型换着措辞开头没跑）
 *   3) 整体措辞接近（bigram Dice ≥ 0.6）——堵住「措辞略变」的近重复
 *   4) 语义灰区（v0.3.16 新增）：字面相似度低（约 0.15–0.6）但可能是同一件事的
 *      候选，交给 index.js 的 LLM 复审（同一件事哪怕彻底换措辞也算重复）。
 *      这里提供词级 Dice（Intl.Segmenter 中文分词），比 bigram 更懂「同一件事」。
 * 数据来源：本机账本（state/posted.json）+ 队列里还没发的 + 自己主页最近的。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJson } from './store.mjs'

/** 归一化正文：链接 / HTML / @提及 / hashtag / 标点 / 空白 都剥掉，只留中英文与数字（标题骨架、引号、省略号不算数） */
export function normText(t) {
  return String(t || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/@\S+/g, '')
    .replace(/[#＃]\S+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/\s+/g, '')
    .trim()
}

/** 归一化文本的指纹 */
export function textHash(t) {
  return createHash('sha1').update(normText(t)).digest('hex').slice(0, 16)
}

function bigrams(s) {
  const set = new Set()
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2))
  return set
}

/** 两段归一化文本的相似度：bigram Dice ∈ [0,1] */
export function simDice(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}

// —— 词级 Dice（v0.3.16 语义查重用）——
let _seg
function segmenter() {
  if (!_seg) _seg = new Intl.Segmenter('zh', { granularity: 'word' })
  return _seg
}

/** 中文分词：按词切（≥2 字的词才算，单字虚词不算），用于词级相似度 */
export function wordTokens(s) {
  const out = []
  for (const g of segmenter().segment(String(s))) {
    const w = g.segment
    if (w && w.length >= 2 && /[\p{L}\p{N}]/u.test(w)) out.push(w)
  }
  return out
}

/** 词集合 Dice ∈ [0,1]：同一件事换了措辞，词的重合比字串 bigram 更能兜住 */
export function simWordDice(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = wordTokens(a)
  const B = wordTokens(b)
  if (!A.length || !B.length) return 0
  const sA = new Set(A)
  let inter = 0
  for (const w of B) if (sA.has(w)) inter++
  return (2 * inter) / (A.length + B.length)
}

/** 是不是重复：全文相等 / 开头重合 / 整体相近 */
export function isDuplicate(a, b, { headLen = 24, minLen = 12, dice = 0.6 } = {}) {
  if (a.length < minLen || b.length < minLen) return false
  if (a === b) return true
  const m = Math.min(a.length, b.length)
  if (m >= headLen && a.slice(0, headLen) === b.slice(0, headLen)) return true
  return simDice(a, b) >= dice
}

/** 合并成归一化文本池：账本 / 队列未发 / 最近主页 */
export function saidPool({ ledger = [], queue = [], recent = [] } = {}) {
  const pool = []
  const seenSig = new Set()
  const push = (t) => {
    const n = normText(t)
    if (!n || n.length < 12) return
    const sig = textHash(n)
    if (seenSig.has(sig)) return
    seenSig.add(sig)
    pool.push(n)
  }
  for (const r of ledger) push(r && r.n ? r.n : r)
  for (const q of queue) push(q && q.text ? q.text : q)
  for (const r of recent) push(r)
  return pool
}

/** 读 posted.json 账本 → 归一化文本数组（老条目没存 n 的用原文兜底） */
export function ledgerTexts(dir) {
  const ledger = readJson(join(dir, 'state', 'posted.json'), {})
  return Object.values(ledger || {})
    .filter((r) => r && (r.n || r.text))
    .map((r) => r.n || r.text)
}

/** 发前内容闸：空、纯链接、敏感基础设施字样、异常长度都不允许发。 */
export function sanityText(t, { kind = 'post' } = {}) {
  const s = String(t || '').trim()
  if (!s) return { ok: false, why: '空文本' }
  if (/^https?:\/\/\S+$/i.test(s.replace(/\s+/g, ''))) return { ok: false, why: '纯链接' }
  if (/<\s*think\b|thinking process/i.test(s)) return { ok: false, why: '疑似思考过程泄漏' }
  if (/\b(?:192\.168\.\d{1,3}\.|10\.\d{1,3}\.|172\.(?:1[6-9]|2\d|3[01])\.)|(?:飞牛|内网|NAS主机|token\s*[=:]|密码|密钥|序列号)/i.test(s)) {
    return { ok: false, why: '可能包含私密基础设施信息' }
  }
  const max = kind === 'reply' ? 160 : 400
  if (s.length > max) return { ok: false, why: `超过长度上限 ${max}` }
  return { ok: true, text: s }
}

/**
 * 最近 hours 小时内成功发过的素材类型集合（从 posted.json 的 source 字段拆出）。
 * buildPostPrompt 用它做题材级换话题：天气/新闻/开源项目这类同源高重复的，
 * 今天说过了第二天、或同一天换个 slot 时，就不再喂给模型，避免「一件事来回说」。
 */
export function recentlyUsedSources(dir, { hours = 24 } = {}) {
  const cutoff = Date.now() - hours * 3600_000
  const used = new Set()
  try {
    const ledger = readJson(join(dir, 'state', 'posted.json'), {})
    for (const r of Object.values(ledger || {})) {
      const at = Number(r?.at || 0)
      if (!at || at < cutoff) continue
      for (const n of String(r?.source || '').split('+')) {
        const k = n.trim().toLowerCase()
        if (k) used.add(k)
      }
    }
  } catch { /* 账本读不了就当没用过 */ }
  return used
}