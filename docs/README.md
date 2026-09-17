# MPP Router docs

| Read this when | File |
| --- | --- |
| You want to know what the router is and how independent providers plug in | [multi-operator-report.md](multi-operator-report.md) |
| You want the protocol itself (402 dialects, sessions, receipts, refunds, catalog, provider registration, public ledger) | [spec/](spec/README.md) |
| You want to integrate from an agent framework | [guides/vercel-ai-sdk.md](guides/vercel-ai-sdk.md) |
| You want to know which catalog services were verified with real paid calls, and when | [verified-services.md](verified-services.md) · machine-readable [verified-runs.json](verified-runs.json) |
| You want the browser playground design | [playground.md](playground.md) |
| You operate the router (E2E suite, provider re-verification SOP) | [operations/](operations/) |
| You operate the UPI invoice payment channel with MuggleLink (routes, secret, state machine, cross-channel claim) | [operations/upi-invoice-payment.md](operations/upi-invoice-payment.md) |
| You need the history: design notes, root causes, review notes, dated results | [archive/](archive/) |

Live surfaces: catalog `https://apiserver.mpprouter.dev/services` · metrics `https://www.mpprouter.dev/stats` · onboarding `https://www.mpprouter.dev/onboard/x402`.
