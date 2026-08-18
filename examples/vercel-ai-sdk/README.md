# MPP Router × Vercel AI SDK

A Vercel AI SDK agent that discovers pay-per-call APIs and pays for them in
Stellar USDC, one call at a time.

Full walkthrough: [`docs/guides/vercel-ai-sdk.md`](../../docs/guides/vercel-ai-sdk.md).

```bash
npm install

# free — catalog discovery + 402 challenge decoding. No wallet, $0.00.
npm run demo:free

# paid — the tools called directly, no model. Spends ~$0.002.
STELLAR_SECRET=S... npm run demo:paid

# full agent — the model decides what to buy.
OPENAI_API_KEY=sk-... STELLAR_SECRET=S... npm run demo:agent
```

| file | what it is |
| --- | --- |
| `src/mpp-x402.ts` | payment core: discover, parse 402, sign, retry. No framework imports. |
| `src/tools.ts` | the same thing as two AI SDK tools, with the spending ceiling in code |
| `src/demo-free.ts` | free verification |
| `src/demo-paid.ts` | paid verification without an LLM |
| `src/demo-agent.ts` | `generateText` with both tools |

`STELLAR_SECRET` is read from the environment and closed over inside the tool.
It is never a tool parameter, so the model can neither see it nor pick a
different one. Copy `.env.example` to `.env` (git-ignored) — do not hard-code a
key.
