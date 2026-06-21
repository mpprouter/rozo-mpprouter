/**
 * Single source of truth for the MPP Router provider E2E suite.
 *
 * Each entry is one *target* provider the operator cares about, split
 * into two families per the goal:
 *   - "ai"    — AI inference: openai, anthropic, openrouter, gemini, deepseek, groq
 *   - "data"  — blockchain / market data: alchemy, dune, coingecko, quicknode
 *
 * `publicPath` is the stable router path an agent calls. `body` is the
 * lightest payload that still produces a real upstream call (so a true
 * 200 proves the *whole* chain, not just the quote layer). `mode` is
 * the upstream payment method the router uses today (charge | session).
 *
 * Keep the `body` minimal — small token counts, cheapest model — so
 * real-money tests cost fractions of a cent. The probe step (402) never
 * spends; only the charge step does.
 */

export const ROUTER_BASE = 'https://apiserver.mpprouter.dev'

export const PROVIDERS = [
  // ---- AI inference ----
  {
    id: 'openai',
    family: 'ai',
    publicPath: '/v1/services/openai/chat',
    method: 'POST',
    mode: 'session',
    body: { model: 'gpt-4o-mini', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    okCheck: (j) => Boolean(j?.choices?.[0]?.message ?? j?.choices?.[0]?.text),
  },
  {
    id: 'anthropic',
    family: 'ai',
    publicPath: '/v1/services/anthropic/messages',
    method: 'POST',
    mode: 'session',
    body: { model: 'claude-3-5-haiku-20241022', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    okCheck: (j) => Boolean(j?.content?.[0]?.text ?? j?.choices),
  },
  {
    id: 'openrouter',
    family: 'ai',
    publicPath: '/v1/services/openrouter/chat',
    method: 'POST',
    mode: 'session',
    body: { model: 'openai/gpt-4o-mini', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    okCheck: (j) => Boolean(j?.choices?.[0]?.message),
  },
  {
    id: 'gemini',
    family: 'ai',
    publicPath: '/v1/services/gemini/generate',
    method: 'POST',
    mode: 'session',
    body: { contents: [{ parts: [{ text: 'hi' }] }] },
    okCheck: (j) => Boolean(j?.candidates?.[0]?.content),
  },
  {
    id: 'deepseek',
    family: 'ai',
    publicPath: '/v1/services/deepseek/chat',
    method: 'POST',
    mode: 'charge',
    body: { model: 'deepseek-chat', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    okCheck: (j) => Boolean(j?.choices?.[0]?.message),
  },
  {
    id: 'groq',
    family: 'ai',
    publicPath: '/v1/services/groq/chat',
    method: 'POST',
    mode: 'charge',
    body: { model: 'llama-3.1-8b-instant', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    okCheck: (j) => Boolean(j?.choices?.[0]?.message),
  },

  // ---- Blockchain / data ----
  {
    id: 'alchemy',
    family: 'data',
    publicPath: '/v1/services/alchemy/rpc',
    method: 'POST',
    mode: 'charge',
    body: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
    okCheck: (j) => typeof j?.result === 'string' && j.result.startsWith('0x'),
  },
  {
    id: 'dune',
    family: 'data',
    publicPath: '/v1/services/dune/execute',
    method: 'POST',
    mode: 'session',
    // query_id 1215383 is Dune's "block number" sample; cheapest real exec
    body: { query_id: 1215383 },
    okCheck: (j) => Boolean(j?.execution_id ?? j?.state),
  },
  {
    id: 'coingecko',
    family: 'data',
    publicPath: '/v1/services/coingecko/simple-price',
    method: 'POST',
    mode: 'charge',
    body: { ids: 'bitcoin', vs_currencies: 'usd' },
    okCheck: (j) => Boolean(j?.bitcoin?.usd),
  },
  {
    id: 'quicknode',
    family: 'data',
    // overlay defaults network=ethereum-mainnet; pass ?network=base-mainnet etc
    publicPath: '/v1/services/quicknode/rpc',
    method: 'POST',
    mode: 'charge',
    body: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
    okCheck: (j) => typeof j?.result === 'string' && j.result.startsWith('0x'),
  },
]
