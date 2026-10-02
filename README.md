# dsh-context-fold

> **The model decides what is stale. The mechanism only decides when to ask.**
>
> A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that gives the agent control over
> its own context window instead of waiting for a compression threshold to fire.

---

## The problem

Every long agent session hits the same wall: the context window fills with detail that no longer
matters — finished sub-investigations, superseded tool output, dead ends — and it keeps costing
attention and money.

Three things are commonly tried, and **two of them do not work**:

| Approach | Result |
|---|---|
| Put a "context discipline" paragraph in the system prompt | ❌ The model follows it for the first few steps, then it drowns in a long context |
| Give the model the tools and wait for it to use them | ❌ Measured: **0 calls** across 6 multi-round sessions and >1000 tool calls |
| Let the engine fold automatically at a watermark | ⚠️ Works, but folds by ratio (16% retained), not by judgement — and it is the fallback, not the plan |

This plugin implements the fourth option, which does work:

**The mechanism times the question. The model makes the call.**

## What it does

| Piece | What it gives the model |
|---|---|
| `context_map` | A view of its **own** context structure: one row per segment with seq range, event count and measured token cost. Without this the model is judging relevance from an undifferentiated message stream. |
| `context_fold` | Folding **an exact range** (`from_seq` / `to_seq`, as shown by `context_map`) via `compaction.compactRegion` — or the engine's own choice when no range is given. |
| **Two-layer nudge** | ① **Per-turn:** when a turn closes, ask once whether anything is now stale. ② **Waterline:** once the window exceeds `nudgeRatio × contextWindow`, ask from any step. |

The nudge is a ~60-token message phrased as an option, not an order:

> `[context-guard] Context window is now about 210000 tokens. If earlier work is finished, call context_map to see the structure and context_fold whatever is stale; if everything is still needed, ignore this.`

Observed model behaviour after a nudge (verbatim from a real run):

```
context_fold {"from_seq":286,"to_seq":465,
  "reason":"The 25 file reads and writes from the rename round are fully superseded
            by the current verified sources."}
context_fold {"from_seq":11,"to_seq":253,
  "reason":"The first round's directory scanning, node location and the 25 original
            buggy sources read - conclusions are already in the current sources."}
```

The model picked the ranges itself, and its reasons were more precise than any rule we could
have written. **It never lacked judgement. It lacked attention.**

## Design principles

1. **Never fold automatically.** `autoFold` exists but defaults to `false`. Automatic folding by
   watermark is capacity logic, not relevance logic.
2. **Never fold silently on the model's behalf** when it can be asked instead.
3. **The threshold follows the model, not a constant.** `nudgeRatio × contextWindow`, where
   `contextWindow` comes from `llm.resolveModelInfo(provider, model).context.contextWindow`.
   `deepseek-flash` reports `1,000,000`, so `0.2` means 200k. Swap models and it adapts.
4. **Both layers matter.** Turn-level asking is the primary path; the waterline is the safety net
   for tasks that blow up mid-turn.

## Install

### From GitHub

```sh
dsh plugin --profile <your-profile> add github:jipika/dsh-context-fold
```

Then restart the Harness (plugin *code* is only re-imported on a fresh process; toggling an entry
off and on again re-mounts it but does **not** reload the module).

### Manual (local checkout)

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
{
  "dependencies": { "dsh-context-fold": "link:../../plugins/dsh-context-fold" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-context-fold"] } }
}
```

Works identically on Windows and macOS — the plugin reads `os.homedir()` and `path.join`, so it
resolves to `C:\Users\<you>\.dsh` or `/Users/<you>/.dsh` on its own.

## Configuration

```yaml
- id: context-fold
  config:
    enabled: true
    tool: true                 # expose context_map + context_fold
    nudge: true                # the two-layer ask
    nudgeRatio: 0.2            # waterline = 0.2 × contextWindow  (1M → 200k)
    nudgeMinTokens: 30000      # per-turn ask only once the window reaches this
    nudgeCooldownMs: 600000    # at most one ask per 10 minutes
    nudgeThresholdTokens: 200000  # fallback until contextWindow resolves
    nudgeAnyStep: false        # isolation-testing only (see below)
    autoFold: false            # watermark-driven automatic folding: deliberately OFF
    discipline: false          # static prompt paragraph: measured ineffective, OFF
    maxPendingMs: 600000       # how long a queued fold stays valid
    debug: false               # append diagnostics to a file instead of stderr
    debugFile: ''              # defaults to <homedir>/.dsh/dsh-context-fold-debug.log
```

## How it is wired (for plugin authors)

```
agent/pre-step ──► resolve contextWindow (cached) ──► decide whether to ask
                   └─ inject ~60 tokens as a durable user message (only when asking)

context_map ─────► sessionQuery.readSurface(sessionId) → events[] with seq
                   + tokenMeter.measure(session).totalTokens for real pricing

context_fold ────► queue the intent, because:
                   "manual compaction requires an idle agent with no waking queued work"
agent/status ────► on `idle`, run compaction.compactRegion(start, end, agent) or compactNow()
```

Four non-obvious host contracts, each of which cost real debugging time:

1. `parameters` must be a **complete JSON Schema**. Passing the internal `defineTool` shorthand
   makes **every request in the session fail**.
2. `output: { schema, render }` is **mandatory**; without it `tools.register()` throws — and if
   your own `try/catch` swallows that, the tool silently vanishes while requests keep succeeding.
3. `inject` decides when `apply()` runs. With `inject: []`, `ctx.get('tools')` is not ready yet.
4. `agent.id` is **truncated** (measured: 42 chars vs the full 44 from `options.sessionId`), so
   keying a map by it silently never matches. Match by prefix, or use `agent.session.header.id`.

## Measured results

Single-process, isolated `headless` profile, 5-round sessions over a 25-module fixture:

| Arm | Folds | Peak window | Final window | Total billed tokens |
|---|---|---|---|---|
| No context tools | 0 | 88,079 | — | 2,744,103 |
| Tools, no nudge | **0** | 97,913 | — | 2,706,124 |
| Tools + nudge | **1** | 78,534 | **29,431** | **1,625,091** |

The second row is the important one: **tools alone changed nothing**, because the model never
reached for them unprompted.

## Known limits

- The **per-turn** layer cannot be verified in a `headless` profile: each round there is a **new
  process**, so process-local state (the ledger) does not survive across rounds. Verify it in a
  long-lived instance.
- Folding invalidates the provider's prefix cache from the fold point onward. Folding a **newer**
  range costs less cache than folding an older one.
- `compaction` requires an idle agent, so a fold requested mid-turn lands when the turn ends.
- The engine's own fallback stays in place: `thresholdRatio: 0.8` of the window (800k on a 1M
  window), retaining 16%. This plugin aims to make that fallback unnecessary, not to replace it.

## Isolated verification

Never test a plugin in the profile you are working in. Build a throwaway one:

```sh
dsh --profile labh --from-default-profile headless --dump-config   # create it
dsh --profile labh "Reply with exactly: OK"                        # one real request
dsh --profile labh --session-id <id> "continue"                    # same session, new process
dsh --profile labh --patch ./arm.yml "task"                        # override config, no file edits
```

`--patch` lets you sweep configurations without touching the profile. `debug: true` writes a
diagnostic file — **not** stderr, which in headless runs carries non-UTF-8 bytes that make log
tools treat the stream as binary and truncate lines exactly where the interesting fields are.

## 中文说明

长会话里，模型不会自己整理上下文——不是它没有判断力，而是它**注意不到**。
提示词里写纪律没用（几步之后就被淹没），只给工具也没用（实测 6 次多轮会话、上千次工具调用，使用次数为 0）。

这个插件做的事只有一件：**机制负责在合适的时机问一句，判断权完全留给模型。**

- `context_map`：让模型"看见"自己上下文的结构（分段、seq 范围、真实 token 计费）
- `context_fold`：按 seq 精确折叠指定区间
- 两层提醒：每轮收尾问一次（常规），窗口超过 `nudgeRatio × 模型窗口` 时随时问（保底）
- 阈值跟着模型窗口自动变，不写死数字

MIT License.

## License

[MIT](./LICENSE)
