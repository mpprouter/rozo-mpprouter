# Security audit index

This directory is the stable entry point for security reviewers. It separates
machine-generated pre-audit evidence from the independent report that satisfies
SCF #44.

## SCF #44

- Engagement scope and focus areas: [`scope.md`](scope.md). This is the
  document to hand an auditor first.
- Audit target: the Soroban contracts in `mpprouter/one-way-channel`,
  branch `v1` (channel + channel-factory forked from
  `stellar-experimental/one-way-channel` at `25dea1b` with our
  modifications, plus our new `account` and `account-factory` crates).
  The commit is pinned at code freeze; see `scope.md` for the current value.
- The off-chain router in this repository is a deferred second engagement.
- Pre-audit status and reproducible commands:
  [`pre-audit-2026-08-09.md`](pre-audit-2026-08-09.md).
- Independent report: **HackenProof Private Security Audit, final report
  2026-09-11** (audit window 2026-09-02 to 2026-09-08, target commit
  `a2eb837`). 10 findings: 0 critical, 0 high, 1 medium, 3 low,
  6 informational, all resolved before the final report. The 29 MB PDF is
  attached to the `v0.2.1-tranche2` release rather than committed:
  <https://github.com/mpprouter/rozo-mpprouter/releases/download/v0.2.1-tranche2/HackenProof.Audit.Report.for.MPP.Router.ROZO.pdf>.
  The independent audit, not the automated tools, satisfies the tranche's
  independent-review deliverable.

## Continuous AI review

The two selected AI services are:

1. **Almanax** for repository-wide business-logic analysis, threat modeling,
   automated pull-request review, and patch suggestions.
2. **Semgrep AppSec Platform + Assistant** for continuous SAST, secrets and
   supply-chain findings, AI-assisted triage, and remediation suggestions.

Both services require a one-time GitHub App authorization by a repository
administrator. After that authorization, scans and pull-request feedback are
automatic. The token-free Semgrep Community Edition workflow in
`.github/workflows/security-semgrep.yml` provides an immediate baseline even
before the hosted Semgrep organization is connected.

Never commit service tokens, source-wallet keys, signed transaction envelopes,
or unpublished vendor reports to this directory.
