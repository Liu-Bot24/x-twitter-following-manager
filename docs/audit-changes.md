# 1.1.6 review scope

Baseline: `db969e7b8489ba7eceead5591ce17af943947150` (1.1.4). The previously local-only 3-day refresh adjustment from `1b0e8b6` is included, as requested, in the same review candidate.

## Fixes and evidence

| Original finding | Candidate behavior | Verification |
| --- | --- | --- |
| Native DOM deletion | Updates/removals target extension pills; native tweet/user rows remain | Failing original fixture, passing `audit-dom` and full extension test |
| Self-triggered scan loop | Idempotent placement/text and observer filtering | Original idle fixture: 9 mutations during sampling; candidate: 0 |
| Mixed statistics snapshots | Display/numeric data, precision, source and time follow one winning observation | `audit-core` display-only, exact and approximate round trips |
| Wrong profile/hover owner | Only owner statistics links outside bio/timeline/user rows are candidates | Positive links and negative decoys in `audit-dom` |
| Lost API metadata | A complete user and its `legacy` member form one observation; absent optional metadata stays absent | Both collectors tested against expected ID and verification values |
| Markdown corruption | Structured top-level account recognition and escaped text | Special-character and embedded-profile-link round trips |
| Storage errors/capacity | 9 MiB growth limit, visible failure status, existing data retained | Quota/capacity failure tests plus manager/Popup UI |
| Concurrent import overwrite | All cache writes are serialized by one service worker; pages send changed records | Original concurrent path retained only Bob; new concurrent imports retain Alice and Bob, including full MV3 test |
| Temporary lock persisted as preference | Connection-owned run locks; independent manual preference; restart clears stale runs | Overlap/disconnect tests and real manager-page closure |
| CSV formula text | Spreadsheet mode and explicit raw mode; precision/source fields preserved | Formula-prefix, raw mode and import round trips |
| Special account dictionary keys | Null-prototype maps in canonicalization and reconciliation | `__proto__` round trip without changing ordinary object prototypes |
| Fetch/XHR coverage | URL/Request/string support; JSON XHR and reused-XHR handling | `audit-network` contracts |
| Language-dependent counts | Numeric counts formatted in the current UI language; formatters reused | Core formatting tests and real bilingual extension behavior |

## Performance decisions

- Adopted: eliminate idle DOM churn, coalesce capture persistence, send dirty account records, update DOM only for changed users, 100-row pagination, checkbox updates without row rebuilding, cached search strings, viewport-gated hover work, stale-target checks and bounded Fetch clone reads.
- Deferred: a new UI framework, virtual-scrolling dependency, username-to-DOM index and per-account storage migration. Pagination bounds rendered rows; changed-user updates avoid querying for every cached account. A schema migration would add compatibility and recovery risk before a workload demonstrates the remaining bottleneck. The service worker still writes a single bounded cache value; this limitation is explicit.
- Rejected automatic eviction of imported/previously collected accounts: it risks silent data loss. Capacity failures are visible and leave persisted records intact; users choose when to export and clear.

## Test limits

Core/worker tests execute production scripts with documented Chrome API substitutes. DOM fixtures execute the entire content script with a test-only exposure of internal functions. The MV3 test loads the actual manifest, service worker, isolated/main-world scripts, manager and Popup in Chromium, intercepting X traffic with deterministic fixtures. No logged-in live X end-to-end acceptance is claimed.

Run instructions: [testing.md](testing.md). This document records review scope and tradeoffs; a passing local suite is not an independent reviewer verdict.
