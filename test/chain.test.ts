import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { LlmChain } from '../src/chain.ts'
import { BudgetError, ChainExhaustedError } from '../src/errors.ts'
import type { Provider } from '../src/types.ts'

/** Reply the next request should get, set per test. */
type Reply = { status: number; body: string; delayMs?: number }

let server: http.Server
let port = 0
const hits: string[] = []
let replies = new Map<string, Reply[]>()

function completion(content: string, tokens = { prompt: 100, completion: 50 }): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: tokens.prompt, completion_tokens: tokens.completion },
  })
}

function queue(path: string, ...items: Reply[]): void {
  replies.set(path, items)
}

before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? ''
    hits.push(path)
    const next = replies.get(path)?.shift() ?? { status: 200, body: completion('{"ok":true}') }
    const send = () => {
      res.writeHead(next.status, { 'Content-Type': 'application/json' })
      res.end(next.body)
    }
    req.resume()
    if (next.delayMs) setTimeout(send, next.delayMs)
    else send()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

after(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))

function providers(...ids: string[]): Provider[] {
  return ids.map((id) => ({
    id,
    baseUrl: `http://127.0.0.1:${port}/${id}`,
    model: `model-${id}`,
    price: { input: 1, output: 2 },
  }))
}

function fresh(): void {
  hits.length = 0
  replies = new Map()
}

describe('LlmChain', () => {
  it('returns the first provider that answers', async () => {
    fresh()
    const chain = new LlmChain({ providers: providers('a', 'b') })
    const result = await chain.text({ user: 'hi' })

    assert.equal(result.provider, 'a')
    assert.deepEqual(hits, ['/a/chat/completions'])
  })

  it('drops a provider that answers 429 and never calls it again in the run', async () => {
    fresh()
    queue('/a/chat/completions', { status: 429, body: 'rate limit reached' })
    const chain = new LlmChain({ providers: providers('a', 'b') })

    const first = await chain.text({ user: 'hi' })
    assert.equal(first.provider, 'b')
    assert.deepEqual(chain.report().down, [{ provider: 'a', reason: 'a: rate limit reached' }])

    const second = await chain.text({ user: 'hi again' })
    assert.equal(second.provider, 'b')
    assert.equal(hits.filter((h) => h.startsWith('/a/')).length, 1, 'a must be called once, not twice')
  })

  it('drops a provider that rejects the key', async () => {
    fresh()
    queue('/a/chat/completions', { status: 401, body: 'invalid api key' })
    const chain = new LlmChain({ providers: providers('a', 'b') })

    await chain.text({ user: 'hi' })
    assert.deepEqual(chain.report().alive, ['b'])
  })

  it('keeps a provider alive after a server error and retries it on the next call', async () => {
    fresh()
    queue('/a/chat/completions', { status: 500, body: 'upstream exploded' })
    const chain = new LlmChain({ providers: providers('a', 'b') })

    const first = await chain.text({ user: 'hi' })
    assert.equal(first.provider, 'b')
    assert.deepEqual(chain.report().down, [], 'a 500 is not a reason to drop a provider')

    const second = await chain.text({ user: 'hi again' })
    assert.equal(second.provider, 'a')
  })

  it('moves to the next provider when the answer is not usable JSON', async () => {
    fresh()
    queue('/a/chat/completions', { status: 200, body: completion('I am afraid I cannot do that') })
    queue('/b/chat/completions', { status: 200, body: completion('```json\n{"verdict":"yes"}\n```') })
    const chain = new LlmChain({ providers: providers('a', 'b') })

    const result = await chain.json<{ verdict: string }>({ user: 'hi' })

    assert.equal(result.provider, 'b')
    assert.equal(result.value.verdict, 'yes')
    assert.deepEqual(chain.report().down, [], 'bad output is the model being unhelpful, not the provider being down')
  })

  it('counts tokens and spend across providers', async () => {
    fresh()
    const chain = new LlmChain({ providers: providers('a') })
    await chain.text({ user: 'hi' })
    await chain.text({ user: 'hi' })

    const { usage } = chain.report()
    assert.equal(usage.input, 200)
    assert.equal(usage.output, 100)
    // 200 input at 1 USD/Mtok plus 100 output at 2 USD/Mtok
    assert.equal(usage.usd.toFixed(6), (400 / 1_000_000).toFixed(6))
  })

  it('stops the run once the budget is reached', async () => {
    fresh()
    const expensive = providers('a').map((p) => ({ ...p, price: { input: 10_000, output: 10_000 } }))
    const chain = new LlmChain({ providers: expensive, budgetUsd: 1 })

    await chain.text({ user: 'first call is allowed' })
    await assert.rejects(() => chain.text({ user: 'second is not' }), BudgetError)
    assert.equal(hits.length, 1)
  })

  it('reports every reason once the chain is exhausted', async () => {
    fresh()
    queue('/a/chat/completions', { status: 429, body: 'daily limit' })
    queue('/b/chat/completions', { status: 429, body: 'daily limit' })
    const chain = new LlmChain({ providers: providers('a', 'b') })

    await assert.rejects(() => chain.text({ user: 'hi' }), (e: unknown) => {
      assert.ok(e instanceof ChainExhaustedError)
      assert.equal(e.reasons.length, 2)
      return true
    })
  })

  it('filters the pool without dropping anyone', async () => {
    fresh()
    const pool: Provider[] = [
      { id: 'plain', baseUrl: `http://127.0.0.1:${port}/plain`, model: 'plain' },
      { id: 'searching', baseUrl: `http://127.0.0.1:${port}/searching`, model: 'searching', tags: ['web'] },
    ]
    const chain = new LlmChain({ providers: pool })

    const result = await chain.text({ user: 'who runs this company' }, { filter: (p) => p.tags?.includes('web') === true })

    assert.equal(result.provider, 'searching')
    assert.deepEqual(chain.report().alive, ['plain', 'searching'])
  })

  it('drops a provider that times out', async () => {
    fresh()
    queue('/a/chat/completions', { status: 200, body: completion('too late'), delayMs: 200 })
    const slow = providers('a').map((p) => ({ ...p, timeoutMs: 40 }))
    const chain = new LlmChain({ providers: [...slow, ...providers('b')] })

    const result = await chain.text({ user: 'hi' })

    assert.equal(result.provider, 'b')
    assert.deepEqual(chain.report().alive, ['b'])
  })

  it('reports each failed attempt to the caller', async () => {
    fresh()
    queue('/a/chat/completions', { status: 429, body: 'nope' })
    const seen: { provider: string; dropped: boolean }[] = []
    const chain = new LlmChain({ providers: providers('a', 'b') })

    await chain.text({ user: 'hi' }, { onAttempt: (a) => seen.push({ provider: a.provider, dropped: a.dropped }) })

    assert.deepEqual(seen, [{ provider: 'a', dropped: true }])
  })

  it('reset brings the dropped providers back', async () => {
    fresh()
    queue('/a/chat/completions', { status: 429, body: 'nope' })
    const chain = new LlmChain({ providers: providers('a', 'b') })

    await chain.text({ user: 'hi' })
    assert.deepEqual(chain.report().alive, ['b'])

    chain.reset()
    assert.deepEqual(chain.report().alive, ['a', 'b'])
    assert.equal(chain.report().usage.usd, 0)
  })

  it('refuses a pool with duplicate ids', () => {
    assert.throws(() => new LlmChain({ providers: [...providers('a'), ...providers('a')] }), /duplicate provider id: a/)
  })
})
