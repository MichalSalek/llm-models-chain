import { AuthError, BudgetError, ChainExhaustedError, OfflineError, QuotaError, ResponseError } from './errors.ts'
import { parseJsonLoose } from './parse.ts'
import type { CallOptions, ChainOptions, ChainReport, ChatCall, Provider, Result, Usage } from './types.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_TEMPERATURE = 0.2

interface Raw {
  text: string
  usage: Usage
}

/**
 * An ordered list of OpenAI-compatible providers with failover inside one run.
 *
 * A provider that runs out of quota, rejects the key or cannot be reached is dropped for the rest of the run,
 * so the next call does not pay the same timeout again. Anything else (a 500, a truncated answer, a model that
 * ignored the JSON instruction) only moves the call to the next provider and leaves this one in the pool.
 */
export class LlmChain {
  readonly #providers: Provider[]
  readonly #budgetUsd: number | null
  #down = new Map<string, string>()
  #usage: Usage = { input: 0, output: 0, usd: 0 }

  constructor(options: ChainOptions) {
    if (options.providers.length === 0) throw new Error('LlmChain needs at least one provider')
    const ids = new Set<string>()
    for (const p of options.providers) {
      if (ids.has(p.id)) throw new Error(`duplicate provider id: ${p.id}`)
      ids.add(p.id)
    }
    this.#providers = [...options.providers]
    this.#budgetUsd = options.budgetUsd ?? null
  }

  /** Providers still usable in this run, in order. */
  alive(): Provider[] {
    return this.#providers.filter((p) => !this.#down.has(p.id))
  }

  report(): ChainReport {
    return {
      usage: { ...this.#usage },
      down: [...this.#down].map(([provider, reason]) => ({ provider, reason })),
      alive: this.alive().map((p) => p.id),
    }
  }

  /** Clears the down list and the spend. Call it when a new run starts. */
  reset(): void {
    this.#down = new Map()
    this.#usage = { input: 0, output: 0, usd: 0 }
  }

  /** Returns the completion text of the first provider that answers. */
  text(call: ChatCall, options: CallOptions = {}): Promise<Result<string>> {
    return this.#run(call, options, (raw) => raw.text)
  }

  /**
   * Same as text(), with the outermost JSON object parsed out of the answer. A provider that returns
   * something unparseable is treated as a failed attempt, not as a broken provider.
   */
  json<T = unknown>(call: ChatCall, options: CallOptions = {}): Promise<Result<T>> {
    return this.#run(call, options, (raw, provider) => {
      try {
        return parseJsonLoose(raw.text) as T
      } catch (e) {
        throw new ResponseError(provider.id, 200, (e as Error).message)
      }
    })
  }

  async #run<T>(call: ChatCall, options: CallOptions, transform: (raw: Raw, provider: Provider) => T): Promise<Result<T>> {
    const pool = this.alive().filter(options.filter ?? (() => true))
    let last: Error | null = null

    for (const provider of pool) {
      this.#assertBudget()
      let raw: Raw
      try {
        raw = await this.#call(provider, call)
      } catch (e) {
        last = e as Error
        const dropped = e instanceof QuotaError || e instanceof OfflineError || e instanceof AuthError
        if (dropped) this.#down.set(provider.id, (e as Error).message.slice(0, 200))
        options.onAttempt?.({ provider: provider.id, error: e as Error, dropped })
        continue
      }

      this.#usage.input += raw.usage.input
      this.#usage.output += raw.usage.output
      this.#usage.usd += raw.usage.usd

      try {
        return { value: transform(raw, provider), provider: provider.id, usage: raw.usage }
      } catch (e) {
        last = e as Error
        options.onAttempt?.({ provider: provider.id, error: e as Error, dropped: false })
      }
    }

    if (this.alive().filter(options.filter ?? (() => true)).length === 0) {
      throw new ChainExhaustedError([...this.#down].map(([provider, reason]) => ({ provider, reason })))
    }
    throw last ?? new ChainExhaustedError([])
  }

  #assertBudget(): void {
    if (this.#budgetUsd !== null && this.#usage.usd >= this.#budgetUsd) {
      throw new BudgetError(this.#usage.usd, this.#budgetUsd)
    }
  }

  async #call(provider: Provider, call: ChatCall): Promise<Raw> {
    const body = JSON.stringify({
      model: provider.model,
      messages: [
        ...(call.system ? [{ role: 'system', content: call.system }] : []),
        { role: 'user', content: call.user },
      ],
      max_tokens: call.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: call.temperature ?? DEFAULT_TEMPERATURE,
      ...(provider.json ? { response_format: { type: 'json_object' } } : {}),
      ...provider.body,
    })

    let response: Response
    try {
      response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
          ...provider.headers,
        },
        body,
        signal: AbortSignal.timeout(provider.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (e) {
      throw new OfflineError(provider.id, (e as Error).message)
    }

    const text = await response.text()
    if (response.status === 429) throw new QuotaError(provider.id, text.slice(0, 200))
    if (response.status === 401 || response.status === 403) throw new AuthError(provider.id, response.status, text.slice(0, 200))
    if (!response.ok) throw new ResponseError(provider.id, response.status, `HTTP ${response.status} ${text.slice(0, 200)}`)

    return this.#readCompletion(provider, text)
  }

  #readCompletion(provider: Provider, text: string): Raw {
    let parsed: {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ResponseError(provider.id, 200, `body is not JSON: ${text.slice(0, 200)}`)
    }

    const content = parsed.choices?.[0]?.message?.content
    if (!content) throw new ResponseError(provider.id, 200, 'empty completion')

    // Providers that report only total_tokens are counted as input, which is the cheaper half. Reporting a
    // guess as output would overstate the spend and stop a run early.
    const input = parsed.usage?.prompt_tokens ?? parsed.usage?.total_tokens ?? 0
    const output = parsed.usage?.completion_tokens ?? 0
    const price = provider.price
    const usd = price ? (input * price.input + output * price.output) / 1_000_000 : 0
    return { text: content, usage: { input, output, usd } }
  }
}
