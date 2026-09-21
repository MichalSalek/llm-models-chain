import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseJsonLoose } from '../src/parse.ts'

describe('parseJsonLoose', () => {
  it('reads a bare object', () => {
    assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 })
  })

  it('reads an object out of a fenced block', () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })
  })

  it('reads an object wrapped in prose', () => {
    assert.deepEqual(parseJsonLoose('Sure, here it is: {"a":1} Let me know if you need more.'), { a: 1 })
  })

  it('drops a reasoning block before the answer', () => {
    assert.deepEqual(parseJsonLoose('<think>the user wants {"b":2}</think>{"a":1}'), { a: 1 })
  })

  it('keeps nested objects whole', () => {
    assert.deepEqual(parseJsonLoose('noise {"a":{"b":[1,2]}} noise'), { a: { b: [1, 2] } })
  })

  it('throws when there is no object at all', () => {
    assert.throws(() => parseJsonLoose('I cannot help with that'), /no JSON object in response/)
  })
})
