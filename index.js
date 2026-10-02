/*!
 * dsh-context-fold v0.4.0 — Host half
 *
 * ── 设计原则（v0.4.0 修正）────────────────────────────────────────────────────
 * v0.3.0 曾注入一段静态"上下文管理纪律"到系统提示词。**实测判断：无效。**
 * 理由：提示词是"建议"，而长上下文里建议会被稀释——模型在第 5 步记得，
 * 在第 50 步就忘了；而且它白占系统提示词、每改一次就作废一次前缀缓存。
 * 这与 CLM 的立论（人设计的先验不如让模型在机制里自己搜索）也是拧的。
 *
 * 因此 v0.4.0 的分工是：
 *   - **时机由 hook 决定**（agent/pre-step 检查水位 → 登记 → agent/status 转 idle
 *     时执行）。不依赖模型记得任何事。
 *   - **保留什么的判断力留给模型**（compaction 的摘要本身就是模型生成的；
 *     模型也可以用 context_fold 工具提前折叠）。
 *
 * ── 四个实测结论塑造了这个版本 ────────────────────────────────────────────────
 * 1. **工具在 turn 中调用时 agent 不空闲**，直接调 compaction 必然被拒：
 *      "manual compaction requires an idle agent with no waking queued work"
 *    → 折叠一律**登记 + 空闲时执行**，这条对 hook 和工具都适用。
 * 2. **compaction 服务延迟就绪**：apply 期间 ctx.get('compaction') 是 undefined，
 *    运行中才拿到对象 → 只能惰性读取，绝不能在 apply 里判断。
 * 3. **pre-step 注入的消息会持久化**（实测写进 user/message seq=12）→
 *    "每步注入工作区"的方案会自我膨胀，已否决。
 * 4. **静态纪律段无效**（见上）→ 默认关闭，只作为可回退的开关保留。
 *
 * 契约要点（见 README）：parameters 必须是完整 JSON Schema；output 必填；
 * inject 决定 apply 时机。
 */

export const name = 'context-fold'

// systemPrompt 只在 discipline 打开时才需要，但 cordis 的 inject 是静态的；
// 保留它作为硬依赖（该服务在任何 DSH 组合里都存在）。
export const inject = ['tools', 'systemPrompt']

const DEFAULTS = {
  enabled: true,
  debug: false,
  // 静态纪律段：实测无效，默认关闭。留着只是为了可回退对比。
  discipline: false,
  // hook 驱动的自动折叠：不依赖模型自觉。
  autoFold: true,
  /** autoFold 的阈值也按窗口算：0.5 × contextWindow（1M → 500k），不用绝对值。 */
  autoFoldRatio: 0.5,
  /** 窗口尚未解析出来时的回退值（仅 autoFold 用；nudge 有自己的回退）。 */
  autoFoldWatermarkTokens: 120000,
  // 两次自动折叠之间的最小间隔，避免抖动。
  autoFoldCooldownMs: 300000,
  // 折叠请求的保鲜期：超过就丢弃（例如 agent 一直没空闲）。
  maxPendingMs: 600000,
  // 是否给模型 context_fold 工具（模型可以提前折叠，不是必需）。
  tool: true,
  // 机制把球踢给模型：窗口超过阈值时注入一条 ~60 token 的提示，让模型自己
  // 判断哪些过时。实测（6 次多轮会话）模型从不自发使用这些工具，所以不能
  // 只把工具放在那里等它想起来。
  nudge: true,
  // 阈值 = 当前模型窗口 × nudgeRatio。deepseek-flash 的 contextWindow 是 1,000,000
  // （注意：header 里的 maxTokens=256000 是最大输出，不是窗口），0.2 → 200k 触发。
  // 换更小窗口的模型时自动跟着变小。
  nudgeRatio: 0.2,
  /** 常规层：每轮收尾时，窗口达到这个规模就问一次"有没有过时的内容"。 */
  nudgeMinTokens: 30000,
  // 窗口尚未解析出来时的回退值（只在最初的步用一次）。
  nudgeThresholdTokens: 200000,
  nudgeCooldownMs: 600000,
}

const CONTEXT_DISCIPLINE = [
  'Context discipline (you manage your own context window):',
  '- Fold early and often, not late and large.',
  '- Before folding, make sure the durable facts survive: unfinished goals, constraints,',
  '  decisions already made, and dead ends worth remembering belong in your todo list,',
  '  a notes file, or the fold reason - never only in raw tool output.',
  '- Fold the finished; keep the live.',
].join('\n')

function emit(ctx, level, ...args) {
  const logger = ctx && ctx.logger
  if (logger && typeof logger[level] === 'function') {
    logger[level]('[context-fold]', ...args)
    return
  }
  const sink = typeof console[level] === 'function' ? console[level] : console.error
  sink('[context-fold]', ...args)
}

function diag(cfg, ...args) {
  if (cfg && cfg.debug === true) {
    // 写文件而不是 stderr：headless 的 stderr 流里混有非 UTF-8 字节，
    // 管道/工具会把它当二进制并截断行——关键字段就是这么丢的。
    // 路径必须跨平台：Windows 的 homedir 是 C:\Users\x，macOS 是 /Users/x。
    try {
      if (typeof process.getBuiltinModule !== 'function') return
      const fsMod = process.getBuiltinModule('node:fs')
      const pathMod = process.getBuiltinModule('node:path')
      const osMod = process.getBuiltinModule('node:os')
      if (fsMod === undefined || pathMod === undefined || osMod === undefined) return
      const file = cfg.debugFile || pathMod.join(osMod.homedir(), '.dsh', 'dsh-context-fold-debug.log')
      const parts = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()))
      fsMod.appendFileSync(file, parts.join(' ') + '\n')
    } catch {
      /* never let diagnostics break the hook */
    }
  }
}

function agentSessionId(agent) {
  if (agent === undefined || agent === null || typeof agent !== 'object') return undefined
  // 必须优先 session.header.id：实测 agent.id 是**截断的**（42 字符 vs 完整 44），
  // 拿它查账本永远查不到——nudge 就是这样静默失效的。
  const header = agent.session && agent.session.header
  if (header && typeof header.id === 'string' && header.id.length > 0) return header.id
  if (typeof agent.id === 'string' && agent.id.length > 0) return agent.id
  return undefined
}

function shortId(value) {
  const s = String(value === undefined || value === null ? '' : value)
  return s.length > 8 ? s.slice(-8) : s
}

function describe(value, max) {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value)
    if (typeof s !== 'string') return String(value)
    return s.length > max ? s.slice(0, max) + '…' : s
  } catch {
    return String(value)
  }
}

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config || {})

  /** sid -> { lastBilled, lastAt, folds: [], pending, lastResult, lastFoldAt, autoFolds } */
  let surfaceProbed = false
  /** "provider|model" -> contextWindow，由 llm.resolveModelInfo 异步预热。 */
  const windowCache = new Map()
  const windowPending = new Set()

  /**
   * 解析当前模型的 contextWindow（带缓存）。
   * 必须能被 await：fire-and-forget 的预热在同一个 tick 里读不到缓存，
   * 会静默回退到常量阈值——实测就是这样让 nudge 一次都没触发。
   */
  async function resolveContextWindow(agent) {
    const opts = (agent && agent.options) || {}
    if (!opts.provider || !opts.model) return 0
    const key = opts.provider + '|' + opts.model
    const cached = windowCache.get(key)
    if (cached !== undefined) return cached
    if (windowPending.has(key)) return 0
    const llmSvc = ctx.get('llm')
    if (!llmSvc || typeof llmSvc.resolveModelInfo !== 'function') return 0
    windowPending.add(key)
    try {
      const info = await llmSvc.resolveModelInfo(opts.provider, opts.model)
      const cw = info && info.context && typeof info.context.contextWindow === 'number' ? info.context.contextWindow : 0
      if (cw > 0) {
        windowCache.set(key, cw)
        diag(cfg, 'contextWindow ' + key + ' = ' + cw)
      }
      return cw
    } catch (error) {
      diag(cfg, 'resolveModelInfo failed: ' + String((error && error.message) || error))
      return 0
    } finally {
      windowPending.delete(key)
    }
  }

  const ledgers = new Map()
  /**
   * 最近一次真实计费输入。跨会话回退用：DSH 在 agent 上暴露的 session id 是
   * 截断的，按 id 查账本可能落空，而"窗口有多大"本身是个与会话无关的量。
   */
  let lastGlobalBilled = 0
  /**
   * 待兑现的提醒（全局；单会话足够，多会话并发时可能串到别的会话的工具结果上）。
   * 不在 pre-step 注入消息——那只可能以 user/message 落地，等于借用户的口说话。
   */
  let nudgeDue = undefined

  /**
   * 宽松查找：DSH 在 agent 上暴露的 session id 是**截断的**（实测比
   * llm/stream 的 options.sessionId 少 2 个字符），精确匹配必然落空；
   * 两者互为前缀，所以回退到前缀匹配。
   */
  function ledgerForLoose(sid) {
    if (sid === undefined) return undefined
    const exact = ledgers.get(sid)
    if (exact !== undefined) return exact
    for (const [key, value] of ledgers) {
      if (key.startsWith(sid) || sid.startsWith(key)) return value
    }
    return undefined
  }

  function ledgerFor(sid) {
    let ledger = ledgerForLoose(sid)
    if (ledger === undefined) {
      ledger = {
        sid,
        lastBilled: 0,
        lastAt: 0,
        folds: [],
        pending: undefined,
        lastResult: undefined,
        lastFoldAt: 0,
        autoFolds: 0,
        lastNudgeAt: 0,
        /** 保底层已提醒到的水位档位（level / nudgeThreshold 的整数部分）。 */
        lastNudgeTier: 0,
        nudges: 0,
      }
      ledgers.set(sid, ledger)
      if (ledgers.size > 50) {
        let oldestKey
        let oldestAt = Infinity
        for (const [key, value] of ledgers) {
          if (value.lastAt < oldestAt) {
            oldestAt = value.lastAt
            oldestKey = key
          }
        }
        if (oldestKey !== undefined && oldestKey !== sid) ledgers.delete(oldestKey)
      }
    }
    return ledger
  }

  // ── 可选的纪律段（默认关闭：实测无效）──────────────────────────────────────
  if (cfg.enabled && cfg.discipline) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'context-fold:discipline',
      order: 120,
      text: CONTEXT_DISCIPLINE,
    }))
    emit(ctx, 'info', 'discipline section registered (opt-in; measured ineffective in long contexts)')
  }

  // ── 账本：只观察 usage，量化窗口大小 ────────────────────────────────────────
  ctx.on('llm/stream', function (options, next) {
    const sid = options && options.sessionId !== undefined && options.sessionId !== null
      ? String(options.sessionId)
      : undefined
    let billed = 0
    const inner = next()
    async function* tracked() {
      try {
        for await (const chunk of inner) {
          if (chunk && chunk.type === 'usage' && chunk.usage) {
            const u = chunk.usage
            billed += (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
          }
          yield chunk
        }
      } finally {
        try {
          if (sid !== undefined && billed > 0) {
            const ledger = ledgerFor(sid)
            ledger.lastBilled = billed
            ledger.lastAt = Date.now()
            lastGlobalBilled = billed
          }
        } catch (error) {
          emit(ctx, 'error', 'ledger update failed (non-fatal)', error)
        }
        if (cfg.debug && billed > 0) diag(cfg, 'commit: sid=' + String(sid) + ' billed=' + billed)
      }
    }
    return tracked()
  })

  // ── 执行器：只在 agent 空闲时落地折叠 ───────────────────────────────────────
  async function runFold(agent, sid, job) {
    const reason = typeof job === 'string' ? job : job.reason
    const ledger = ledgerFor(sid)
    const before = ledger.lastBilled
    const compaction = ctx.get('compaction')
    if (compaction === undefined || compaction === null || typeof compaction.compactNow !== 'function') {
      ledger.lastResult = 'compaction service unavailable at execution time'
      emit(ctx, 'info', `fold for ${shortId(sid)} skipped: no compaction service`)
      return
    }
    const controller = new AbortController()
    const startedAt = Date.now()
    ledger.lastFoldAt = startedAt
    const useRange = job && typeof job === 'object' && Number.isFinite(job.from) && Number.isFinite(job.to) &&
      typeof compaction.compactRegion === 'function'
    try {
      const result = useRange
        ? await compaction.compactRegion(job.from, job.to, agent, controller.signal)
        : await compaction.compactNow(agent, controller.signal, undefined)
      const folded = result !== undefined && result !== null
      const ms = Date.now() - startedAt
      ledger.folds.push({ at: startedAt, ms, before, reason, ok: folded, result: describe(result, 300) })
      ledger.lastResult = folded
        ? `folded after ${ms}ms (window was ${before} tok)`
        : `engine declined: no safe range (window was ${before} tok)`
      diag(cfg, 'fold executed: ' + ledger.lastResult)
      emit(ctx, 'info', `fold for ${shortId(sid)} [${reason}]: ${ledger.lastResult}`)
    } catch (error) {
      const message = String((error && error.message) || error)
      ledger.folds.push({ at: startedAt, ms: Date.now() - startedAt, before, reason, ok: false, error: message.slice(0, 200) })
      ledger.lastResult = 'failed: ' + message
      diag(cfg, 'fold threw: ' + message)
      emit(ctx, 'info', `fold for ${shortId(sid)} failed: ${message}`)
    }
  }

  // ── 触发器：agent 转 idle 时执行登记的折叠（hook 与工具共用）────────────────
  ctx.on('agent/status', function (payload) {
    try {
      const status = payload && payload.status !== undefined ? String(payload.status) : ''
      if (status !== 'idle') return
      const agent = payload && payload.agent
      const sid = agentSessionId(agent)
      if (sid === undefined || agent === undefined || agent === null) return
      const ledger = ledgerForLoose(sid)
      if (ledger === undefined || ledger.pending === undefined) return
      const pending = ledger.pending
      ledger.pending = undefined
      if (Date.now() - pending.at > cfg.maxPendingMs) {
        diag(cfg, 'dropping stale fold request for ' + shortId(sid))
        return
      }
      diag(cfg, 'agent idle; executing queued fold for ' + shortId(sid) + ' [' + pending.reason + ']')
      void runFold(agent, sid, pending.reason)
    } catch (error) {
      emit(ctx, 'error', 'status hook failed (non-fatal)', error)
    }
  })

  // ── hook：每步开头按水位自动登记折叠（不依赖模型自觉）──────────────────────
  ctx.on('agent/pre-step', async function (payload, next) {
    let decision = await next()
    try {
      // 结构探针（debug）：找到 surface 的读取入口，才能把折叠精确落到"过时的那一段"。
      if (cfg.debug && !surfaceProbed) {
        surfaceProbed = true
        try {
          // 路线 A：sessionQuery.readSurface —— 契约原文 "Read one session's complete
          // current model surface from one corpus observation."
          const sq = ctx.get('sessionQuery')
          console.error('[context-fold] sessionQuery=' + (sq === undefined ? 'undefined' : typeof sq) +
            ' readSurface=' + typeof (sq && sq.readSurface))
          if (sq && typeof sq.readSurface === 'function') {
            const sid0 = agentSessionId(payload && payload.agent)
            try {
              const snap = await sq.readSurface(sid0)
              const evs = (snap && snap.events) || []
              console.error('[context-fold] surface events=' + evs.length +
                ' capturedThroughSeq=' + (snap && snap.capturedThroughSeq))
              if (evs.length > 0) {
                console.error('[context-fold] surface keys=' + Object.keys(evs[0]).join('|'))
                console.error('[context-fold] surface seqs=' + evs.slice(0, 25).map((e) => e.seq).join(','))
                console.error('[context-fold] surface types=' + evs.slice(0, 25).map((e) => e.type).join(','))
                console.error('[context-fold] sample=' + JSON.stringify(evs[0]).slice(0, 350))
              }
            } catch (e) {
              console.error('[context-fold] readSurface threw: ' + String(e))
            }
          }
          const agent = payload && payload.agent
          console.error('[context-fold] agent keys=' + Object.keys(agent || {}).join('|'))
          const session = agent && agent.session
          if (session) {
            console.error('[context-fold] session keys=' + Object.keys(session).join('|'))
            for (const k of ['surface', 'nodes', 'events', 'seq', 'messages', 'projection', 'log', 'store', 'query']) {
              let v
              try { v = session[k] } catch (e) { console.error('[context-fold] session.' + k + ' threw'); continue }
              console.error('[context-fold] session.' + k + '=' + (v === undefined ? 'undefined' : typeof v) +
                (v && typeof v === 'object' ? ' keys=' + Object.keys(v).slice(0, 15).join('|') : ''))
            }
          } else {
            console.error('[context-fold] agent.session undefined')
          }
          // 真实计价：tokenMeter.measure(session) 是官方压力/计量入口，
          // context_map 的 token 估算应该用它而不是 JSON 长度/4。
          const tm = ctx.get('tokenMeter')
          const session0 = payload && payload.agent && payload.agent.session
          if (tm && typeof tm.measure === 'function' && session0) {
            try {
              const m = tm.measure(session0)
              console.error('[context-fold] measure keys=' + Object.keys(m || {}).join('|'))
              console.error('[context-fold] measure=' + JSON.stringify(m).slice(0, 700))
            } catch (e) {
              console.error('[context-fold] measure threw: ' + String(e))
            }
          } else {
            console.error('[context-fold] tokenMeter=' + (tm === undefined ? 'undefined' : typeof tm) +
              ' measure=' + typeof (tm && tm.measure) + ' session=' + (session0 === undefined ? 'undefined' : typeof session0))
          }
          // 窗口大小：llm.listModels(provider) → LlmDiscoveredModel.contextWindow
          const llmSvc = ctx.get('llm')
          const opts = (payload && payload.agent && payload.agent.options) || {}
          console.error('[context-fold] agent.options=' + JSON.stringify(opts).slice(0, 200))
          if (llmSvc && typeof llmSvc.resolveModelInfo === 'function' && opts.provider && opts.model) {
            try {
              const info = await llmSvc.resolveModelInfo(opts.provider, opts.model)
              console.error('[context-fold] resolveModelInfo keys=' + Object.keys(info || {}).join('|'))
              console.error('[context-fold] resolveModelInfo=' + JSON.stringify(info).slice(0, 700))
            } catch (e) {
              console.error('[context-fold] resolveModelInfo threw: ' + String(e))
            }
          } else {
            console.error('[context-fold] resolveModelInfo=' + typeof (llmSvc && llmSvc.resolveModelInfo))
          }
        } catch (e) {
          console.error('[context-fold] surface probe failed: ' + String(e))
        }
      }
      // 窗口解析放在最前面：autoFold 与 nudge 共用同一个值，且必须 await
      // （fire-and-forget 的预热在同一 tick 里读不到缓存，会静默回退到常量阈值）。
      const ctxWindow = await resolveContextWindow(payload && payload.agent)

      // autoFold：容量驱动的自动折叠。**保持关闭**（默认 false，部署里也是 false）。
      // 阈值同样跟着模型窗口走：用绝对值 120k 会在 1M 窗口下于 12% 占用时就动手，
      // 比 nudge 激进得多——那是配置陷阱，不是设计。
      if (cfg.enabled && cfg.autoFold) {
        const autoFoldThreshold = ctxWindow > 0
          ? Math.round(ctxWindow * cfg.autoFoldRatio)
          : cfg.autoFoldWatermarkTokens
        const sid = agentSessionId(payload && payload.agent)
        const ledger = sid === undefined ? undefined : ledgerForLoose(sid)
        if (autoFoldThreshold > 0 &&
            ledger !== undefined &&
            ledger.lastBilled > autoFoldThreshold &&
            ledger.pending === undefined &&
            Date.now() - ledger.lastFoldAt >= cfg.autoFoldCooldownMs) {
          ledger.pending = { reason: 'auto: ' + ledger.lastBilled + '>' + autoFoldThreshold, at: Date.now() }
          ledger.autoFolds += 1
          emit(ctx, 'info', `auto-fold queued for ${shortId(sid)}: window ${ledger.lastBilled} tok > ${autoFoldThreshold}`)
        }
      }

      // nudge：实测（6 次多轮会话、上千次工具调用）模型**从不自发**调用
      // context_map / context_fold —— 把判断权完全交给模型等于什么都不发生。
      // 也不反过来替它决定（那是水位驱动）。正确分工是：机制在窗口真正变大时
      // 把球踢给它（一条 ~60 token 的提示，一次性），判断仍由模型做。
      // 注意：`sid` 在上面那个 autoFold 块里是块级 const，这里必须重新解析——
      // 直接引用它曾导致 ReferenceError 被 catch 吞掉，nudge 静默失效。
      // 只在**新一轮的第 1 步**提醒。挂在每一步上会打断模型连着调工具的心流；
      // 而一轮刚开始正是"上一轮已收尾"的自然节点（用户的要求）。
      const atTurnStart = cfg.nudgeAnyStep === true || (payload && (payload.step === 1 || payload.step === 0))
      // ctxWindow 已在上面解析（autoFold 与 nudge 共用同一个值）。
      const nudgeThreshold = ctxWindow > 0 ? Math.round(ctxWindow * cfg.nudgeRatio) : cfg.nudgeThresholdTokens
      const nudgeSid = (cfg.enabled && cfg.nudge && atTurnStart && decision && decision.kind === 'enter')
        ? agentSessionId(payload && payload.agent)
        : undefined
      // 前几步都记：只记 atTurnStart 会看不见"每步检查"这条路径到底有没有跑。
      if (cfg.debug && payload && (payload.step === undefined || payload.step <= 5)) {
        const dbgLedger = nudgeSid === undefined ? undefined : ledgerForLoose(nudgeSid)
        diag(cfg, 'nudge check: step=' + (payload && payload.step) + ' turn=' + (payload && payload.turn) +
          ' window=' + ctxWindow + ' threshold=' + nudgeThreshold +
          ' sid=' + String(nudgeSid) +
          ' ledgerKeys=[' + [...ledgers.keys()].join('/') + ']' +
          ' lastBilled=' + (dbgLedger ? dbgLedger.lastBilled : 'no-ledger') +
          ' pending=' + (dbgLedger ? String(dbgLedger.pending !== undefined) : 'no-ledger'))
      }
      if (nudgeSid !== undefined) {
        const nudgeLedger = ledgerFor(nudgeSid)
        // 账本按 id 查不到时回退到全局水位（窗口大小与会话无关）。
        const level = nudgeLedger !== undefined && nudgeLedger.lastBilled > 0
          ? nudgeLedger.lastBilled
          : lastGlobalBilled
        // 两层，缺一不可：
        //   ① 常规：每轮收尾（新一轮的第 1 步）问一次"有没有过时的"——及时整理；
        //   ② 保底：窗口超过 nudgeRatio × contextWindow 时，任何步骤都可以提醒。
        const turnCheck = atTurnStart && cfg.nudgeMinTokens > 0 && level >= cfg.nudgeMinTokens
        // 保底层 = 水位阶梯：每跨过 nudgeThreshold 一档才再问一次
        // （200k → 400k → 600k …），而不是"一旦超过阈值就持续满足条件"。
        // 后者只能靠冷却压着，观感是"隔一阵子随机冒一条"。
        const prevTier = nudgeLedger !== undefined && Number.isFinite(nudgeLedger.lastNudgeTier)
          ? nudgeLedger.lastNudgeTier
          : 0
        const tier = nudgeThreshold > 0 ? Math.floor(level / nudgeThreshold) : 0
        const waterlineHit = tier > prevTier
        if (nudgeLedger !== undefined &&
            (turnCheck || waterlineHit) &&
            nudgeLedger.pending === undefined &&
            Date.now() - nudgeLedger.lastNudgeAt >= cfg.nudgeCooldownMs) {
          nudgeLedger.lastNudgeAt = Date.now()
          nudgeLedger.nudges += 1
          // 记住跨过的档位：同一档位内不再因为保底层重复提醒。
          if (tier > prevTier) nudgeLedger.lastNudgeTier = tier
          // 措辞刻意保持"可忽略"：这是递给它的一个选项，不是派给它的任务，
          // 免得长会话里每次触发都把它从正事上拽走。
          // 必须用 level（判定时用的那个值），不能用 nudgeLedger.lastBilled：
          // 账本按 id 查不到时会回退到全局水位，两者不是同一个数，
          // 写错字段就会发出 "about 0 tokens" 这种自相矛盾的提醒。
          const text = '[context-guard] Context window is now about ' + level +
            ' tokens. If earlier work is finished, call context_map to see the structure and context_fold whatever is stale; if everything is still needed, ignore this.'
          // 不注入消息。两条路都验证过：
          //   role:'user'      → 能work，但看起来像用户自己打的字（设计很差）
          //   role:'developer' → 宿主直接拒绝整个请求：
          //     "developer/message and developer role must occur together"
          //     （pre-step 只能产生 user/message 事件）
          // 所以改为"挂起"，由下一次 tools/post-execute 附加到工具结果末尾：
          // 模型在刚用完工具的地方看到它，且完全不新增消息。
          nudgeDue = { text, at: Date.now() }
          emit(ctx, 'info', `nudge due for ${shortId(nudgeSid)} at ${level} tok (attaches to the next tool result)`)
        }
      }
    } catch (error) {
      // 这个 catch 曾把一个 ReferenceError 吞成"什么都不发生"。debug 下必须可见。
      if (cfg.debug) {
        try {
          console.error('[context-fold] pre-step hook failed: ' + String((error && error.stack) || error))
        } catch {
          /* stderr unavailable */
        }
      }
      emit(ctx, 'error', 'auto-fold check failed (non-fatal)', error)
    }
    return decision
  })

  // ── 兑现提醒：附加到工具结果的末尾 ────────────────────────────────────────
  // 不新增消息，因此不会出现"像用户刚说了一句话"的效果；模型是在刚用完工具的
  // 位置看到它，语义上也更像"系统在你干活时提了一句"。
  ctx.on('tools/post-execute', async function (exec, result, next) {
    const decision = await next()
    if (nudgeDue === undefined) return decision
    try {
      if (!decision || decision.kind !== 'accept') return decision
      if (Object.prototype.hasOwnProperty.call(decision, 'value')) return decision
      if (exec !== undefined && exec !== null && exec.parent !== undefined) return decision
      if (Date.now() - nudgeDue.at > cfg.maxPendingMs) {
        nudgeDue = undefined
        return decision
      }
      const content = decision.content !== undefined ? decision.content : result.content
      if (!Array.isArray(content)) return decision
      const text = nudgeDue.text
      nudgeDue = undefined
      diag(cfg, 'nudge attached after tool ' + String(exec && exec.name))
      return { kind: 'accept', content: content.concat([{ type: 'text', text }]) }
    } catch (error) {
      emit(ctx, 'error', 'nudge attach failed (non-fatal)', error)
      return decision
    }
  })

  // ── 工具：模型也可以提前折叠（可选，不是必需路径）──────────────────────────
  if (cfg.enabled && cfg.tool) {
    ctx.tools.register({
      name: 'context_fold',
      description: 'Fold part of this conversation into a summary, freeing context window. Call it when detail you no longer need verbatim is stealing attention (finished sub-investigations, superseded tool output, dead ends). Use context_map first to see the seq ranges. Pass from_seq/to_seq to fold exactly that range; omit them to let the engine choose. The fold is queued and lands when this turn ends, so the next turn sees a smaller window. Folding the NEWEST eligible range costs the least prompt-cache invalidation.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'One line: what is now safe to lose and why. Recorded in the fold ledger.',
          },
          from_seq: {
            type: 'number',
            description: 'First surface seq to fold, as shown by context_map. Optional.',
          },
          to_seq: {
            type: 'number',
            description: 'Last surface seq to fold, as shown by context_map. Optional.',
          },
        },
        required: ['reason'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          const text = value && typeof value.text === 'string' ? value.text : JSON.stringify(value)
          return [{ type: 'text', text }]
        },
      },
      execute(args) {
        const reason = args && typeof args.reason === 'string' && args.reason.trim().length > 0
          ? args.reason.trim()
          : '(no reason given)'
        const agents = ctx.get('agents')
        const agent = agents !== undefined && agents !== null && typeof agents.currentInitiator === 'function'
          ? agents.currentInitiator()
          : undefined
        if (agent === undefined || agent === null) {
          return { text: 'context_fold: no initiating agent in scope; nothing queued.' }
        }
        const sid = agentSessionId(agent)
        if (sid === undefined) {
          return { text: 'context_fold: cannot resolve this session id; nothing queued.' }
        }
        const ledger = ledgerFor(sid)
        const previous = ledger.lastResult
        const fromSeq = args && Number.isFinite(args.from_seq) ? Number(args.from_seq) : undefined
        const toSeq = args && Number.isFinite(args.to_seq) ? Number(args.to_seq) : undefined
        ledger.pending = { reason: 'tool: ' + reason, at: Date.now(), from: fromSeq, to: toSeq }
        diag(cfg, 'fold queued by tool for ' + shortId(sid) + ': ' + reason)
        const lines = [
          'context_fold: queued. The fold will run when this turn ends (manual compaction requires an idle agent),',
          'so the next turn should see a smaller window. Window right now: ' + (ledger.lastBilled > 0 ? ledger.lastBilled + ' tok' : 'unknown') + '.',
          'Reason recorded: ' + reason,
        ]
        if (previous !== undefined) lines.push('Previous fold result: ' + previous)
        return { text: lines.join('\n') }
      },
    })
    diag(cfg, 'context_fold tool registered')

    // ── context_map：把"自己的上下文结构"暴露给模型 ──────────────────────────
    // 模型平时只看到消息流，看不见结构，所以无法判断"哪一段过时了"。
    // readSurface 给出当前模型可见的 surface（带 seq），按轮次分组后就是一张地图。
    ctx.tools.register({
      name: 'context_map',
      description: 'Show the structure of your own context window: one row per turn with its seq range, event count, rough token cost and the tools it used. Use it to decide WHAT is stale before folding — you cannot judge relevance from the message stream alone.',
      parameters: {
        type: 'object',
        properties: {
          detail: {
            type: 'string',
            description: '"turns" (default) for a per-turn overview, or "events" to list every surface event with its seq.',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          const text = value && typeof value.text === 'string' ? value.text : JSON.stringify(value)
          return [{ type: 'text', text }]
        },
      },
      async execute(args) {
        const detail = args && typeof args.detail === 'string' ? args.detail.trim() : 'turns'
        const agents = ctx.get('agents')
        const agent = agents !== undefined && agents !== null && typeof agents.currentInitiator === 'function'
          ? agents.currentInitiator()
          : undefined
        const sid = agentSessionId(agent)
        const sq = ctx.get('sessionQuery')
        if (sq === undefined || sq === null || typeof sq.readSurface !== 'function') {
          return { text: 'context_map: this profile exposes no sessionQuery.readSurface; map unavailable.' }
        }
        let snap
        try {
          snap = await sq.readSurface(sid)
        } catch (error) {
          return { text: 'context_map failed: ' + String((error && error.message) || error) }
        }
        const evs = (snap && snap.events) || []
        if (evs.length === 0) {
          return { text: 'context_map: the surface is currently empty (capturedThroughSeq=' + (snap && snap.capturedThroughSeq) + ').' }
        }
        // token 估算：JSON 长度/4 会把不进上下文的大字段（stream 记录等）算进去，
        // 实测高估 3 倍以上。用 tokenMeter.measure() 的真实计量做整体校准。
        const roughTokens = (e) => {
          try {
            return Math.ceil(JSON.stringify(e).length / 4)
          } catch {
            return 0
          }
        }
        let measuredTotal = 0
        try {
          const tm = ctx.get('tokenMeter')
          const session = agent && agent.session
          if (tm && session && typeof tm.measure === 'function') {
            const m = tm.measure(session)
            measuredTotal = (m && (m.totalTokens || m.surfaceTokens)) || 0
          }
        } catch {
          measuredTotal = 0
        }
        const roughTotal = evs.reduce((acc, e) => acc + roughTokens(e), 0)
        const factor = measuredTotal > 0 && roughTotal > 0 ? measuredTotal / roughTotal : 1
        const tokOf = (e) => Math.max(1, Math.round(roughTokens(e) * factor))

        if (detail === 'events') {
          const lines = evs.map((e) => {
            const head = describe(e.data !== undefined ? e.data : e, 80).replace(/\s+/g, ' ')
            return `seq ${e.seq}\t${e.type}\t~${tokOf(e)} tok\t${head}`
          })
          return { text: 'surface events (' + evs.length + ', capturedThroughSeq=' + (snap && snap.capturedThroughSeq) + '):\n' + lines.join('\n') }
        }

        // 分组：surface 里**没有** turn/start 边界事件（实测 4 轮被并成 1 段），
        // 所以改用 user/developer 消息作为轮次边界。
        const isBoundary = (e) => {
          if (e.type === 'user/message' || e.type === 'developer/message') return true
          const m = e.data && (e.data.message || e.data)
          return Boolean(m) && m.role === 'user'
        }
        const groups = []
        let cur = null
        for (const e of evs) {
          if (cur === null || isBoundary(e)) {
            cur = { start: e.seq, end: e.seq, n: 0, tok: 0, tools: new Set(), types: new Set() }
            groups.push(cur)
          }
          cur.end = e.seq
          cur.n += 1
          cur.tok += tokOf(e)
          cur.types.add(e.type)
          const name = e.data && (e.data.name || (e.data.message && e.data.message.name))
          if (name) cur.tools.add(name)
        }
        const lines = groups.map((g, i) => {
          const tools = [...g.tools].slice(0, 6).join(',')
          const kinds = [...g.types].slice(0, 4).join(',')
          return `seg ${i + 1}\tseq ${g.start}-${g.end}\t${g.n} events\t~${g.tok} tok\t${kinds}${tools ? ' | ' + tools : ''}`
        })
        const head = measuredTotal > 0
          ? 'your context window: ' + measuredTotal + ' tok (measured), ' + evs.length + ' surface events in ' + groups.length + ' segment(s)'
          : 'your context window: ' + evs.length + ' surface events in ' + groups.length + ' segment(s), capturedThroughSeq=' + (snap && snap.capturedThroughSeq)
        return {
          text: head + '\n' + lines.join('\n') +
            '\n\nFolding a range invalidates the provider prompt cache from that point on; folding the NEWEST eligible range costs the least cache.',
        }
      },
    })
    diag(cfg, 'context_map tool registered')
  }

  emit(ctx, 'info', `ready (autoFold=${cfg.autoFold}, nudge at ${cfg.nudgeRatio}×contextWindow, tool=${cfg.tool})`)
}
