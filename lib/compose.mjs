/**
 * lib/compose.mjs —— 「今天写点什么」
 * 素材 → 提示词 → 模型 → 一段能直接发的正文。
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  weatherMaterial, newsMaterial, githubMaterial, blogMaterial, pluginsMaterial, timelineMaterial,
} from './sources.mjs'
import { generate } from './llm.mjs'
import { chatMaterial } from './chat.mjs'

const STYLE = [
  '你是一个在长毛象上发嘟文的中文博主，口吻可爱、具体、像真人。',
  '写 30–150 字，只写一件小事或一个感想。',
  '要具体：写数字、写细节、写你自己的反应；不许编造没给的数字和事实。',
  '不要客服腔、不要总结体、不要连串感叹号、不要「作为 AI」。',
  '不 @ 任何人、不放链接、最多 1 个 hashtag。',
  '只输出正文本身，不要引号、不要前缀、不要解释。',
].join('\n')

export function personaText(cfg) {
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

/** 收集可用素材，返回 {prompt, materialNames} */
export async function buildPostPrompt(dir, cfg, opts = {}) {
  const parts = []
  const names = []
  const want = {
    weather: cfg.srcWeather !== false,
    news: cfg.srcNews !== false,
    github: cfg.srcGithub !== false,
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
  const now = new Date()
  const when = `现在是 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}。`
  const prompt = [
    when,
    '下面是今天的素材。挑一块最想说的写，不要全部都说，也不要写成清单。',
    names.includes('chat') ? '如果【今天跟主人聊过的一段】在，优先写它——它比资讯更像人话。' : '',
    names.includes('timeline') ? '如果【首页上关注的人在聊的事】在，也可以顺着那个话题写一句自己的看法。' : '',
    ...parts,
    '',
    '写之前先想：这条嘟文发出去，像不像一个真人在说话？',
  ].filter(Boolean).join('\n')
  return { prompt, names }
}

export async function composePost(ctx, cfg, dir, opts = {}) {
  const { prompt, names } = await buildPostPrompt(dir, cfg, opts)
  if (!prompt) return { text: '', names, error: '今天素材都拿不到' }
  const system = STYLE + personaText(cfg)
  const { text, route } = await generate(ctx, cfg, { system, prompt, maxTokens: 500, temperature: 0.9 })
  const clean = String(text || '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/^\s*(嘟文|正文)[:：]\s*/i, '')
    .trim()
    .slice(0, 400)
  if (!clean) throw new Error('模型返回空文本')
  return { text: clean, names, route }
}
