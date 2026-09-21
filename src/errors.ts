import type { Usage } from './types.ts'

/** The provider refused on quota or rate limit. It is dropped for the rest of the run. */
export class QuotaError extends Error {
  readonly provider: string
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`)
    this.name = 'QuotaError'
    this.provider = provider
  }
}

/** The provider could not be reached or timed out. It is dropped for the rest of the run. */
export class OfflineError extends Error {
  readonly provider: string
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`)
    this.name = 'OfflineError'
    this.provider = provider
  }
}

/** The provider rejected the credentials. It is dropped for the rest of the run. */
export class AuthError extends Error {
  readonly provider: string
  readonly status: number
  constructor(provider: string, status: number, message: string) {
    super(`${provider}: HTTP ${status} ${message}`)
    this.name = 'AuthError'
    this.provider = provider
    this.status = status
  }
}

/** The provider answered, but the answer was unusable. The next provider is tried and this one stays alive. */
export class ResponseError extends Error {
  readonly provider: string
  readonly status: number
  /** Set when the provider reported usage anyway. A refused answer that was still billed has to be counted. */
  readonly usage: Usage | undefined
  constructor(provider: string, status: number, message: string, usage?: Usage) {
    super(`${provider}: ${message}`)
    this.name = 'ResponseError'
    this.provider = provider
    this.status = status
    this.usage = usage
  }
}

/** The run hit its USD ceiling. Nothing else will be called until reset(). */
export class BudgetError extends Error {
  readonly spentUsd: number
  readonly budgetUsd: number
  constructor(spentUsd: number, budgetUsd: number) {
    super(`budget spent: ${spentUsd.toFixed(4)} of ${budgetUsd.toFixed(4)} USD`)
    this.name = 'BudgetError'
    this.spentUsd = spentUsd
    this.budgetUsd = budgetUsd
  }
}

/** Every provider in the pool is down, or the filter matched none. */
export class ChainExhaustedError extends Error {
  readonly reasons: { provider: string; reason: string }[]
  constructor(reasons: { provider: string; reason: string }[]) {
    const detail = reasons.map((r) => `${r.provider}: ${r.reason}`).join(' | ')
    super(`no provider left${detail ? ` (${detail})` : ''}`)
    this.name = 'ChainExhaustedError'
    this.reasons = reasons
  }
}
