/**
 * Pull the outermost JSON object out of a completion.
 *
 * Models wrap JSON in prose, in ```json fences, or prefix it with a <think> block even when asked not to.
 * Taking the first { and the last } survives all three without a real parser.
 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`no JSON object in response: ${text.slice(0, 160)}`)
  return JSON.parse(cleaned.slice(start, end + 1))
}
