/** One OpenAI-compatible endpoint. Anything that speaks /chat/completions fits here. */
export interface Provider {
  /** Stable id. Shows up in results and in the down list, so keep it short. */
  id: string
  /** Base URL without a trailing slash, for example https://api.groq.com/openai/v1 */
  baseUrl: string
  model: string
  apiKey?: string
  /** Send response_format: json_object. Providers that do not support it will reject the call. */
  json?: boolean
  /** Extra body fields merged into every request. Use it for vendor quirks. */
  body?: Record<string, unknown>
  headers?: Record<string, string>
  /** Defaults to 120000. Local models on CPU need more. */
  timeoutMs?: number
  /** USD per million tokens. Without it the provider counts as free and never spends the budget. */
  price?: { input: number; output: number }
  /** Free-form labels a caller can filter on, for example 'web' for a model with search. */
  tags?: string[]
}

export interface ChatCall {
  system?: string
  user: string
  /** Defaults to 1024. */
  maxTokens?: number
  /** Defaults to 0.2. */
  temperature?: number
}

export interface CallOptions {
  /** Narrows the pool for this call, for example to providers tagged 'web'. */
  filter?: (provider: Provider) => boolean
  /** Called after every failed attempt, before the chain moves on. */
  onAttempt?: (attempt: Attempt) => void
}

export interface Attempt {
  provider: string
  error: Error
  /** True when the provider was dropped for the rest of the run. */
  dropped: boolean
}

export interface Usage {
  input: number
  output: number
  usd: number
}

export interface Result<T> {
  value: T
  /** Id of the provider that answered. */
  provider: string
  usage: Usage
}

export interface ChainReport {
  usage: Usage
  /** Providers dropped for the rest of the run, with the reason. */
  down: { provider: string; reason: string }[]
  alive: string[]
}

export interface ChainOptions {
  providers: Provider[]
  /** Hard ceiling for the whole run. The chain refuses to call once it is reached. */
  budgetUsd?: number
}
