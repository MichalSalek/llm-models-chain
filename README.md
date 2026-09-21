# llm-models-chain

> Ordered list of OpenAI-compatible providers with failover inside one run

You give it a list of endpoints in the order you want them used. It calls the first one that is still usable
and moves down the list when that one refuses. A provider that runs out of quota, rejects the key or cannot be
reached is remembered as down, so the rest of the run does not pay for the same timeout again. A per-run USD
budget stops the whole thing before a retry loop turns into a bill.

Works with anything that speaks `POST /chat/completions`: hosted APIs, a gateway, or a local server such as
llama.cpp or Ollama. No dependencies.

## Install

```sh
npm install llm-models-chain
```

## Usage

```js
import {LlmChain} from 'llm-models-chain';

const chain = new LlmChain({
  providers: [
    {
      id: 'hosted',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      apiKey: process.env.GROQ_API_KEY,
      json: true,
      price: {input: 0.59, output: 0.79},
    },
    {
      id: 'local',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'qwen2.5-coder',
      json: true,
      timeoutMs: 240000,
    },
  ],
  budgetUsd: 0.5,
});

const {value, provider} = await chain.json({
  system: 'Answer with JSON only.',
  user: 'Which of these two companies is a product company? A: ... B: ...',
});

console.log(provider, value);
console.log(chain.report());
// {usage: {input: 812, output: 96, usd: 0.00055}, down: [], alive: ['hosted', 'local']}
```

Call `chain.reset()` when a new run starts. Until then the down list and the spend keep accumulating, which is
the point: the second call of a run should not rediscover that the first provider is out of quota.

## Failure handling

What happens to a provider depends on whether trying it again inside the same run could possibly help.

| Result | Error | Provider |
| --- | --- | --- |
| Timeout or connection refused | `OfflineError` | dropped for the run |
| `429` | `QuotaError` | dropped for the run |
| `401`, `403` | `AuthError` | dropped for the run |
| Other non-2xx | `ResponseError` | stays, call moves on |
| Body is not JSON, or no completion | `ResponseError` | stays, call moves on |
| `json()` cannot find an object in the answer | `ResponseError` | stays, call moves on |

The last three are the model being unhelpful rather than the provider being broken, so the provider is used
again on the next call. When every provider in the pool is down, the chain throws `ChainExhaustedError` with
the reason collected from each one. When the budget is spent, it throws `BudgetError` without calling anything.

## API

### new LlmChain(options)

#### options.providers

Type: `Provider[]`

Tried in the given order. Ids must be unique.

```ts
type Provider = {
  id: string;
  baseUrl: string;            // no trailing slash
  model: string;
  apiKey?: string;
  json?: boolean;             // sends response_format: {type: 'json_object'}
  body?: Record<string, unknown>;   // merged into every request, for vendor quirks
  headers?: Record<string, string>;
  timeoutMs?: number;         // default 120000
  price?: {input: number; output: number};   // USD per million tokens
  tags?: string[];            // free-form labels for filtering
};
```

Without `price` a provider counts as free and never moves the budget.

#### options.budgetUsd

Type: `number`\
Optional.

Ceiling for the whole run. Checked before each attempt, so the budget can be exceeded by at most one call.

### chain.text(call, options?)

Returns `{value: string, provider: string, usage: {input, output, usd}}` from the first provider that answers.

`call` is `{user: string, system?: string, maxTokens?: number, temperature?: number}`. Defaults are 1024 tokens
and temperature 0.2.

### chain.json(call, options?)

Same, with the outermost JSON object parsed out of the answer. Typed as `json<T>()` if you validate the shape
yourself.

### options.filter

Type: `(provider: Provider) => boolean`

Narrows the pool for one call without touching the down list. Useful when only some models can do what this
particular call needs.

```js
const {value} = await chain.text(
  {user: 'Who is on the board of this company?'},
  {filter: provider => provider.tags?.includes('web') === true},
);
```

### options.onAttempt

Type: `(attempt: {provider: string, error: Error, dropped: boolean}) => void`

Called after every failed attempt, before the chain moves on. Use it for logging.

### chain.report()

Returns `{usage, down, alive}` for the current run.

### chain.reset()

Clears the down list and the spend.

### chain.alive()

The providers still usable in this run, in order.

### parseJsonLoose(text)

Exported separately. Strips `<think>` blocks and code fences, then takes the text between the first `{` and the
last `}`. Throws when there is no object.

## License

MIT
