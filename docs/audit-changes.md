# 1.1.6 review scope

Baseline: `db969e7b8489ba7eceead5591ce17af943947150` (1.1.4). The previously local-only 3-day refresh adjustment from `1b0e8b6` is included, as requested, in the same review candidate.

## Third candidate

The review of `e7a7f588995190ca0eb84d7ca26d53c2fe328909` accepted the original R1–R7 fixes but identified two remaining P2 capture defects, S1 and S2. Both were independently reproduced before repair.

- **S1 — initial cache generation:** a new document starts with an unknown storage generation (`null`) and adopts its first read without invalidating its document-local captures. Actual clear notifications and subsequent generation advances still invalidate captures; the clear timestamp still rejects older requests. Real MV3 tests delay the first read at historical generation 7, covering responses arriving both before and after that read. A separate content-state test clears during initialization and retains only the post-clear batch.
- **S2 — hover target invalidation:** both asynchronous target checks release the old attempt when the target becomes invalid. Activity-version checks run first, so an obsolete callback does not remove a reservation created after cancellation or clear. Chromium tests cover automatic background/fallback attempts, removal and reappearance of the same account, and recycled rows whose old hover results must be discarded.

## Second candidate, after independent Pro review

The first review of audit commit `0384d1323b7b72bb28015b6a9a796dcd304991cd` returned **not approved** with R1–R7. All seven findings were independently reproduced locally and addressed:

| Finding | Follow-up change and behavioral verification |
| --- | --- |
| R1: obsolete failure and recovery read erase new data | Success, failure and read completion respect cache generations. Same-generation reads merge current observations; reads predating a second clear are ignored. Tests retain and then save Bob across delayed failures/reads, and preserve a local unsaved-data error when another writer succeeds. |
| R2: owner closes while lock is being saved | Both failed delivery and disconnect synchronize persisted locks with the live run map. A write barrier closes the owner before readiness can be delivered. |
| R3/R3b: absent metadata becomes a clear | Missing CSV columns stay absent. Bio, website and verification observations carry per-field timestamps through full cached records, so later nickname/post observations neither clear newer metadata nor restore old metadata after an explicit clear. Legacy synthesized empty/false values are treated as unknown. Worker-level merge/import tests cover both paths. |
| R4: approximate counts lose displayed precision | Content and manager share `formatStatsCount`; approximate display text is preserved and the tooltip labels approximation instead of presenting an exact parenthesized count. Tested through real Chromium rendering with actual i18n code. |
| R5: old network request acquires new save generation | Fetch and XHR retain a capture generation and start time through clone reads, buffered batches and delivery. Clearing invalidates captures and records a cutoff for startup/recovery. A live MV3 test delays the real response until after clear, verifies it is discarded, then verifies a new request is accepted. Native response data remains readable. |
| R6: hover-success attempt flag prevents TTL refresh | Successful card/API/cache collection releases the attempt marker. A Chromium test advances the clock beyond three days and verifies automatic work starts again. |
| R7: empty statistics compete using profile timestamps | Empty records have no statistics timestamp and cannot win over actual counts. Legacy profile timestamps are used as a statistics fallback only when complete statistics exist. Tests cover core and actual worker import paths. |

Additional local findings were reproduced before repair: single-count imports lost their known count; valid sibling wrappers were rejected as a statistics block; and closing a page during the persistence debounce lost captured counts. Partial observations now retain their known side without inventing the missing side, nearby owner links can use separate wrappers without a whole-main fallback, and page-hide dispatches the newest dirty snapshot even while an earlier write callback is pending.

Partial but real observations may carry an explicit statistics time for ordering; they still fail the complete-statistics freshness check. This preserves partial import data while keeping empty profile metadata out of statistical comparisons.

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
