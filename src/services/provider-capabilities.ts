/**
 * Explicit capability contracts — the only basis on which the router will
 * ever choose one provider's route over another's.
 *
 * ## Why a closed list
 *
 * "Quality-based routing" is only meaningful between services a buyer
 * would accept interchangeably. Two routes both called `search` are not
 * evidence of that; one may take `q` and return JSON, the other a POST
 * body and HTML. Inferring equivalence from names or descriptions would
 * let the router swap a buyer onto something that does not answer their
 * request, and then charge them for it. So equivalence is declared, by
 * the provider, against a contract written here, and nothing else counts.
 *
 * A declared contract is the provider's claim about its own route. The
 * router checks the method matches and nothing more; it does not certify
 * that the response conforms. The public selection response says so.
 *
 * ## Adding one
 *
 * Append an entry. The id is the public string providers put in
 * `routes[].capability`, so it is versioned (`.v1`) and never edited in
 * place — a changed contract is a new id, or every route already declared
 * against it silently means something different.
 */

export interface CapabilityContract {
  id: string
  method: 'GET' | 'POST'
  /** What a caller sends. Query parameters for GET, JSON body for POST. */
  input: string
  /** What a caller gets back on 200. */
  output: string
  summary: string
}

export const CAPABILITY_CONTRACTS: readonly CapabilityContract[] = [
  {
    id: 'web-search.v1',
    method: 'GET',
    input: 'query parameter `q` (string, required); optional `limit` (integer).',
    output: 'JSON object with `results[]`, each carrying at least `title` and `url`.',
    summary: 'Current web search results as structured JSON.',
  },
  {
    id: 'web-extract.v1',
    method: 'GET',
    input: 'query parameter `url` (absolute http(s) URL, required).',
    output: 'JSON object with `markdown` (string) for the page at `url`.',
    summary: 'Extract a public web page into Markdown.',
  },
  {
    id: 'pdf-to-markdown.v1',
    method: 'GET',
    input: 'query parameter `url` (absolute http(s) URL of a PDF, required).',
    output: 'JSON object with `markdown` (string).',
    summary: 'Convert a public PDF into Markdown.',
  },
  {
    id: 'chat-completions.openai.v1',
    method: 'POST',
    input: 'OpenAI-compatible chat completion request body (`model`, `messages[]`).',
    output: 'OpenAI-compatible chat completion response body.',
    summary: 'OpenAI-compatible chat completion.',
  },
]

const BY_ID = new Map(CAPABILITY_CONTRACTS.map(c => [c.id, c]))

export function isKnownCapability(id: string): boolean {
  return BY_ID.has(id)
}

export function getCapability(id: string): CapabilityContract | undefined {
  return BY_ID.get(id)
}

export function listCapabilityIds(): string[] {
  return CAPABILITY_CONTRACTS.map(c => c.id)
}

export function capabilityMethod(id: string): string {
  return BY_ID.get(id)?.method ?? 'unknown'
}

export function capabilityAcceptsRoute(id: string, method: string): boolean {
  const contract = BY_ID.get(id)
  return Boolean(contract && contract.method === method.toUpperCase())
}
