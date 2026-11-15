/**
 * lib/llm.mjs —— 用宿主自带的模型生成正文
 * 不要求用户另配 DeepSeek key：优先跟随当前会话模型，其次取第一个可用 route。
 */

export function resolveModel(ctx, cfg) {
  const pinnedP = String(cfg.llmProvider || '').trim()
  const pinnedM = String(cfg.llmModel || '').trim()
  if (pinnedP && pinnedM) return { provider: pinnedP, model: pinnedM, source: 'config' }
  try {
    const sel = ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null
    const provider = sel?.provider ?? sel?.providerId
    const model = sel?.model ?? sel?.modelId
    if (provider && model) {
      return { provider: String(provider), model: String(model), reasoningEffort: sel.reasoningEffort, source: 'session' }
    }
  } catch { /* 老宿主没有这个服务 */ }
  return null
}

async function pickFallback(ctx) {
  const llm = ctx?.get?.('llm')
  if (!llm?.listProviders || !llm?.listModels) return null
  for (const p of llm.listProviders()) {
    const id = String(p?.id || '')
    if (!id) continue
    try {
      const models = await Promise.resolve(llm.listModels(id))
      const m = Array.isArray(models) ? models.find((x) => x?.id) : null
      if (m) return { provider: id, model: String(m.id), source: 'fallback' }
    } catch { /* 下一个 */ }
  }
  return null
}

/**
 * 生成一段文本。失败就抛，调用方决定「不发」而不是发半截。
 */
export async function generate(ctx, cfg, { system, prompt, maxTokens = 400, temperature = 0.85, timeoutMs = 60000 }) {
  const llm = ctx?.get?.('llm')
  if (!llm?.stream) throw new Error('宿主没有 llm 服务')
  let route = resolveModel(ctx, cfg) || await pickFallback(ctx)
  if (!route) throw new Error('没有可用的模型路由')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  timer.unref?.()
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      temperature,
      signal: ctrl.signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text
      else if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          const f = chunk.reason?.failure
          throw new Error(`模型没出结果（${kind}）${f?.message ? '：' + f.message : ''}`)
        }
      }
    }
    return { text, route }
  } finally {
    clearTimeout(timer)
  }
}
