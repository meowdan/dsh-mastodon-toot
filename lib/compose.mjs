/**
 * lib/compose.mjs —— 「今天写点什么」
 * 素材 → 提示词 → 模型 → 一段能直接发的正文。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { weatherMaterial, newsMaterial, githubMaterial, blogMaterial, pluginsMaterial, timelineMaterial } from './sources.mjs'
import { generate } from './llm.mjs'
import { chatMaterial } from './chat.mjs'
import { readJson } from './store.mjs'
import { recentlyUsedSources } from './dedup.mjs'
import { personaBundle } from './character.mjs'
import { digest } from './notebook.mjs'

const STYLE = [
  '你是一个在长毛象上发嘟文的中文博主，口吻可爱、具体、像真人。',
  '写 30–150 字，只写一件小事或一个感想。',
  '要具体：写数字、写细节、写你自己的反应；不许编造没给的数字和事实。',
  '不要客服腔、不要总结体、不要连串感叹号、不要「作为 AI」。',
  '不 @ 任何人、不放链接、最多 1 个 hashtag。',
  '只输出正文本身，不要引号、不要前缀、不要解释。',
  '素材只是引子——也可以不写素材，写你自己此刻的心事、遇到的问题、刚看完的番/B 站视频的观后感、或生活里的小事；像真人随口说，别端着。',
 '下面会给你完整的角色卡：你是谁、你的口吻、你的日常、遇到场景怎么反应。按角色卡写，别越写越像通用助手。',
].join('\n')

export function personaText(cfg, dir = '') {
  if (dir) {
    try {
      const bundle = personaBundle(dir, cfg)
      if (!bundle.empty && bundle.text) return bundle.text
    } catch { /* 角色卡坏了就回落老配置，不能卡住发帖 */ }
  }
  const p = String(cfg.personaFile || '').trim()
  if (p && existsSync(p)) {
    try {
      return `\n\n【人设/口吻参考】\n` + readFileSync(p, 'utf8').slice(0, 3000)
    } catch { /* 读不到就用默认 */ }
  }
  return cfg.personaText ? `\n\n【人设/口吻参考】\n` + String(cfg.personaText).slice(0, 3000) : ''
}

function block(title, text) {
  return text ? `\n【${title}】\n${text}` : ''
}

/**
 * 最近 10 条已发的嘟文主旨，喂给模型让它换话题。
 * v0.3.16 修复：账本键序是「最新在前」（recordPosted 按 at 降序插入），
 * 旧代码 slice(-10) 取到的是最旧的 10 条 —— 变成根本拦不住「刚发完又写同一件事」。
 * 现在按 at 显式降序、取最新 10 条；老条目没存 text 的空行直接过滤。
 */
export function recentToastsBlock(dir) {
  try {
    const ledger = readJson(join(dir, 'state', 'posted.json'), {})
    const texts = Object.values(ledger)
      .filter((r) => r && r.text && String(r.text).trim().length >= 20)
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .slice(0, 10)
      .map((r) => String(r.text).replace(/\s+/g, ' ').trim().slice(0, 80))
    if (!texts.length) return ''
    const lines = texts.map((t, i) => `${i + 1}. ${t}`).join('\n')
    return (
      `\n【我最近已经发过的嘟文】（这些是我已经发出去的内容。` +
      `写新的这条时：绝对不要写同一件事、同一个素材、同一个感想。` +
      `哪怕换个说法、换个角度、换个开头也不行——读者会连续看到两条差不多的嘟文。` +
      `必须换一个完全不同的话题。如果实在想不出新话题，就写日常生活里的一件小事、` +
      `刚看到的番或 B 站视频的观后感、或此刻的心情，但内容要跟上面的每条都明显不一样。）\n${lines}`
    )
  } catch { return '' }
}

/** 收集可用素材，返回 {prompt, materialNames} */
export async function buildPostPrompt(dir, cfg, opts = {}) {
  const parts = []
  const names = []
  // 24h 内发过什么题材：weather/news/github 这类同源高重复的，今天说过了就不再喂，
  // 堵住「一件事来回说、删了还说」；blog/chat/timeline 是自家/独有内容不在此列。
  const recentlyUsed = recentlyUsedSources(dir, { hours: 24 })
  const skipSource = (k) => recentlyUsed.has(k.toLowerCase())
  const want = {
    weather: cfg.srcWeather !== false && !skipSource('weather'),
    news: cfg.srcNews !== false && !skipSource('news'),
    github: cfg.srcGithub !== false && !skipSource('github'),
    blog: cfg.srcBlog !== false && !!String(cfg.blogFeed || '').trim(),
    plugins: cfg.srcPlugins !== false,
    chat: cfg.srcChat !== false,
    timeline: cfg.srcTimeline !== false && !!opts.creds,
  }
  if (want.weather) {
    const w = await weatherMaterial(cfg).catch(() => '')
    if (w) { parts.push(block('此刻天气', w)); names.push('weather') }
  }
  if (want.news) {
    const n = await newsMaterial(cfg, 3).catch(() => '')
    if (n) { parts.push(block('今天的新闻标题（挑一条，说它跟普通人/跟我有什么关系，不要复述标题）', n)); names.push('news') }
  }
  if (want.github) {
    const g = await githubMaterial(3).catch(() => '')
    if (g) { parts.push(block('这几天新冒出来的开源项目', g)); names.push('github') }
  }
  if (want.blog) {
    const b = await blogMaterial(dir, cfg, 1).catch(() => '')
    if (b) { parts.push(block('我自己以前写过的旧文（不是新闻，别写成新闻）', b)); names.push('blog') }
  }
  if (want.plugins) {
    const p = await pluginsMaterial(cfg).catch(() => '')
    if (p) { parts.push(block('最近上架的 DSH 插件', p)); names.push('plugins') }
  }
  if (want.chat) {
    try {
      const c = chatMaterial(dir, cfg, { pick: 1, consume: opts.consumeChat !== false })
      if (c) {
        parts.push(block(
          '今天跟主人聊过的一段（已经去掉隐私；可以写「今天跟人聊到……」的语气，挑其中一件小事或一句感想，不要逐句复述，不要出现人名、地址、命令、数字细节）',
          c.text,
        ))
        names.push('chat')
      }
    } catch { /* 会话读不到就当没有 */ }
  }
  if (want.timeline) {
    try {
      const tl = await timelineMaterial(opts.creds, dir, cfg, { consume: opts.consumeTimeline !== false })
      if (tl) {
        parts.push(block(
          '首页上关注的人在聊的事（挑一件，用自己的话接一句或写自己的看法；不要复读原文、不要出现对方账号、不要 @、不要照抄数字）',
          tl,
        ))
        names.push('timeline')
      }
    } catch { /* 首页拉不到就当没有 */ }
  }
  if (!parts.length) return { prompt: '', names: [] }
  // 小本本记忆：最近跟谁聊过、聊了多少，写的时候心里有人，不重复问
  let memPart = ''
  try {
    const mem = digest(dir)
    if (mem.total) {
      const top = mem.top.map((t) => `@${t.acct}（${t.n} 次）`).join('、')
      memPart = `\n【我记得的事】（最近 ${mem.days} 天跟 ${mem.people} 个人打过交道${mem.skips ? '，有些话我选择没回' : ''}${top ? `：${top}` : ''}。写的时候可以想起他们，但不要复述这些记录。）`
    }
  } catch { /* 记忆坏了不影响写 */ }
  const now = new Date()
  const when = `现在是 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}。`
  const prompt = [
    when,
    '下面是今天的素材。挑一块最想说的写，不要全部都说，也不要写成清单。',
    names.includes('chat') ? '如果【今天跟主人聊过的一段】在，优先写它——它比资讯更像人话。' : '',
    names.includes('timeline') ? '如果【首页上关注的人在聊的事】在，也可以顺着那个话题写一句自己的看法。' : '',
    ...parts,
    memPart,
    '',
    recentToastsBlock(dir),
    '写之前先想：这条嘟文发出去，像不像一个真人在说话？',
  ].filter(Boolean).join('\n')
  return { prompt, names }
}

export async function composePost(ctx, cfg, dir, opts = {}) {
  const { prompt, names } = await buildPostPrompt(dir, cfg, opts)
  if (!prompt) return { text: '', names, error: '今天素材都拿不到' }
  const system = STYLE + personaText(cfg, dir)
  const { text, route } = await generate(ctx, cfg, { system, prompt, maxTokens: 500, temperature: 0.9 })
  const clean = String(text || '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/^\s*(嘟文|正文)[:：]\s*/i, '')
    .trim()
    .slice(0, 400)
  if (!clean) throw new Error('模型返回空文本')
  return { text: clean, names, route }
}
