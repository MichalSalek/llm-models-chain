/**
 * Pull a JSON value out of a completion.
 *
 * Models wrap JSON in prose, in ```json fences, or put a reasoning block in front of it, and that block has
 * braces of its own. So this does not try to clean the text up: it walks the opening brackets left to right
 * and returns the first one that parses all the way to the last matching closing bracket. Prose before the
 * answer, a fence around it and a stray brace in the explanation all fall out of that on their own, and
 * nothing rewrites the inside of a string value.
 *
 * An answer that is a top level array is returned as an array, not silently unwrapped.
 */
export function parseJsonLoose(text: string): unknown {
  for (let index = 0; index < text.length; index++) {
    const open = text[index]
    if (open !== '{' && open !== '[') continue
    const end = text.lastIndexOf(open === '{' ? '}' : ']')
    if (end <= index) continue
    try {
      return JSON.parse(text.slice(index, end + 1))
    } catch {
      // This bracket started something else, for example a brace in the prose. Try the next one.
    }
  }
  throw new Error(`no JSON value in response: ${text.slice(0, 160)}`)
}
