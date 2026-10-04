# Audit follow-up: v1.1.6 / 5112d904

This change follows the complete **07_X-Twitter-Following-Manager_v1.1.6_5112d904.md** report (28,494 bytes, 368 lines), dated 2026-10-01–02. Its sole baseline is `5112d90425cc48c0f8345c0c35adcb4de7fa9b99`. The remote default branch was still `main` at that commit and had no pull requests when work began on 2026-10-04. Older audit summaries are not the basis for these fixes.

Task configuration: **GPT-6 Astra · Max** (`gpt-6-astra`, `max`), as confirmed by the parent task's creation parameters; this is not an assertion about internal model routing.

## Changes and regression evidence

The first run against unchanged production sources passed the original 29 core tests and failed exactly six added correct-behavior assertions: R1–R5 and C1. Those same assertions remain in the suite.

| Finding | Resulting behavior | Regression coverage |
| --- | --- | --- |
| R1 | Parse complete numeric spans; accept comma and ordinary/NBSP/narrow-NBSP groups, preserve compact decimal precision, reject ambiguous or broken groups without retrying at their tail. | `audit-integrity.test.mjs`, real profile DOM → worker cache → manager CSV |
| R2 | One validity model governs merge, cache freshness, CSV import/export, formatting and manager missing selection. Zero is valid; placeholders, negative/noninteger raw counts and nonfinite/unsafe numbers are missing. Precision hints cannot make an invalid or abbreviated count exact. | Invalid/partial/zero/legacy/precision-spoof cases; import UI and missing selection |
| R3 | Different explicit stable IDs do not share metadata, sources, stats or posts. Retain previous identities in `identityHistory`; show them in a manager row disclosure and export their complete stored records as JSON. Same stable ID with a newer handle becomes one active record, including while the list is locked. | Both merge orders, stale tabs, worker restart, rename, reclaimed handle, row disclosure and JSON/CSV exports |
| R4 | Fetch/XHR requests carry a document ID, generation and increasing request sequence. Persist capture order and request start time separately from reception time. A late response cannot renew or overwrite a newer snapshot. Legitimate count decreases still update. | Both delivery orders, same millisecond, duplicates, delayed Fetch clone, clear generations, persisted/reloaded worker records and real MV3 hook |
| R5 | Import and ordinary cache merge preserve the minimum valid first-seen time and maximum valid last-seen time within one identity. Import processing time is kept separately in `updatedAt`. | Old/new CSV in both orders, repeated import, missing/invalid dates, identity boundaries and worker paths |
| C1 | Reject non-HTTP(S) profile protocols, credentials and nondefault ports. Keep normal HTTP(S) X/Twitter and relative profile links compatible. Validate stored links again at render, export, batch-open and sequential-update boundaries; reject unsafe/non-post tweet links. | Dangerous schemes, credentials/ports, ordinary links, legacy malicious cache and real batch-open UI |

## Compatibility and arbitration

The cache key/schema and CSV's existing columns remain usable. Fields for identity history and snapshot ordering are additive. Reads normalize legacy cache records; the next successful write persists that normalization. Existing clear generations, serialized worker writes, metadata field timestamps, capacity rejection, spreadsheet escaping and manual list-lock settings remain covered by their original regressions.

Only supported full numeric syntax is accepted. Ungrouped integers, comma groups, three-digit space groups and compact K/M/B/百/千/万/亿 forms are supported. Decimal comma is accepted for compact values (`1,2 K` → approximate `1.2K`). Bare decimals and mixed grouping are treated as missing rather than guessing a locale. The old biography fixture now has a visible separator between a contact number and its following count; its original ambiguous adjacent-number shape is explicitly rejected by the new regression. The old cached display-only integer assertions now expect exact integer values, matching direct observations and R1's requirements.

Within a document/generation, request sequence wins. Across documents or sources, snapshot time wins, with completeness/precision and stable snapshot content breaking exact ties. This is client-observed ordering, not a claim that X provides a server snapshot version. A later DOM approximation may replace an older API snapshot and remains marked approximate.

Identity assertions have their own persisted time/order, so later ID-less DOM activity in an old tab cannot promote its old stable ID. Missing IDs alone do not reset identity. When an archived stable ID returns, only its own history is restored. Already-mixed legacy posts cannot be retrospectively attributed without provenance; these fixes prevent known conflicts from being merged going forward and preserve stored conflicting identities instead of deleting them.

The ordinary CSV/Markdown exports still represent the active identity and latest post, not a full cache backup. The row's identity-history JSON preserves all stored archived fields/posts and is an inspection/export format, not an additional import mode. Popup cache clear clears these histories too; export them first when needed. Existing capacity checks reject growth rather than silently deleting history.

## Validation

Validation uses a fresh clone, isolated Chromium profiles and synthetic X pages/network responses. No real account, follow/unfollow action, release, deployment or merge is involved.

The new manager fixture explicitly adapts tab creation to Playwright's supported `context.newPage()` path. With this Mac/Chromium/Playwright combination, native `chrome.tabs.create` created a tab with the correct pending URL but its first navigation did not reach the mock request route. The adapter records and checks the requested URL; all manager logic, content scripts, worker persistence, DOM interaction and downloads remain real. This does **not** certify the native tab-creation/navigation path. The existing browser suite uses its original setup without this adapter.

Final validation on 2026-10-04, macOS arm64, Node.js **v26.10.0**, npm **11.19.1**, Playwright **1.62.1**, actual Chromium **151.0.7922.34**:

| Command/check | Result |
| --- | --- |
| `npm ci --ignore-scripts --registry https://registry.npmjs.org` (task-local npm cache) | Locked dependencies installed; install-time advisory check reported 0 vulnerabilities |
| `npm audit --json` (official registry; one bounded retry) | Could not complete: TLS connection to the advisory endpoint disconnected on both attempts; no final advisory result is claimed |
| `npm run test:core` | **45/45 passed**, no skipped/cancelled tests |
| `npm test` | **66/66 passed**: 45 core, 19 original browser, 2 new browser; no skipped/cancelled tests |
| `node --check` for all changed production JavaScript files | Passed |
| `git diff --check` | Passed |
| Manager screenshot | Inspected: current identity and old-ID disclosure/export visible, no unsafe profile/post navigation links |

Chromium could not start within the filesystem/process sandbox. The supported tool permission path allowed the same isolated tests to run; no system DNS, proxy, credential or browser security configuration was changed. The final browser suite takes about 14 seconds on this host.

Real logged-in X compatibility, native updater tab creation under this interception setup, and Web Store packaging remain unverified. The extension version remains 1.1.6; this is a code/test PR, not a release.
