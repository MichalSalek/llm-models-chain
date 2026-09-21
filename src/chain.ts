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
   * Same as text(), with the JSON value parsed out of the answer. A provider that returns something
   * unparseable is treated as a failed attempt, not as a broken provider.
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
      // Re-checked here, not only when the pool was taken: another call in flight may have dropped this
      // provider while we were waiting on the previous one.
      if (this.#down.has(provider.id)) continue
      this.#assertBudget()
      let raw: Raw
      try {
        raw = await this.#call(provider, call)
      } catch (e) {
        last = e as Error
        // A refused answer can still have been billed, so its usage counts against the budget.
        if (e instanceof ResponseError && e.usage) this.#addUsage(e.usage)
        const dropped = e instanceof QuotaError || e instanceof OfflineError || e instanceof AuthError
        if (dropped) this.#down.set(provider.id, (e as Error).message.slice(0, 200))
        options.onAttempt?.({ provider: provider.id, error: e as Error, dropped })
        continue
      }

      this.#addUsage(raw.usage)

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

  #addUsage(usage: Usage): void {
    this.#usage.input += usage.input
    this.#usage.output += usage.output
    this.#usage.usd += usage.usd
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

    // The body is read inside its own try: a connection reset after the headers arrived is still a network
    // failure, and it must not escape as a raw error that leaves the provider in the pool.
    let text: string
    try {
      text = await response.text()
    } catch (e) {
      if (response.status === 429) throw new QuotaError(provider.id, `HTTP 429, body unreadable: ${(e as Error).message}`)
      throw new OfflineError(provider.id, `body unreadable: ${(e as Error).message}`)
    }

    if (response.status === 429) throw new QuotaError(provider.id, text.slice(0, 200))
    if (response.status === 401 || response.status === 403) throw new AuthError(provider.id, response.status, text.slice(0, 200))
    if (!response.ok) throw new ResponseError(provider.id, response.status, `HTTP ${response.status} ${text.slice(0, 200)}`)

    return this.#readCompletion(provider, text)
  }

  #readCompletion(provider: Provider, text: string): Raw {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ResponseError(provider.id, 200, `body is not JSON: ${text.slice(0, 200)}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ResponseError(provider.id, 200, `body is not a completion object: ${text.slice(0, 200)}`)
    }

    const payload = parsed as {
      choices?: { message?: { content?: string }; finish_reason?: string }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    const usage = this.#readUsage(provider, payload.usage)
    const choice = payload.choices?.[0]
    const content = choice?.message?.content

    // Usage rides along on the error: a refused or truncated answer was billed all the same, and leaving it
    // out would let a provider burn the budget without the budget ever noticing.
    if (!content) throw new ResponseError(provider.id, 200, 'empty completion', usage)
    if (choice?.finish_reason === 'length') {
      throw new ResponseError(provider.id, 200, 'answer was cut off at max_tokens', usage)
    }

    return { text: content, usage }
  }

  #readUsage(provider: Provider, reported: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): Usage {
    const output = reported?.completion_tokens ?? 0
    // total_tokens covers both halves, so the prompt half is what is left of it after the completion half.
    // Treating total as input on its own would count the completion tokens twice.
    const input = reported?.prompt_tokens ?? Math.max(0, (reported?.total_tokens ?? 0) - output)
    const price = provider.price
    const usd = price ? (input * price.input + output * price.output) / 1_000_000 : 0
    return { input, output, usd }
  }
}
