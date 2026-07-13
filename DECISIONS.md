# DECISIONS

## D4: PRO teaser buttons removed pre-launch (M6 follow-up)
The design handoff includes two non-functional teaser buttons in the results
toolbar, Export PDF (PRO) and AI summary (PRO). Both are removed for launch by
Alex's decision (2026-07). Reasons: non-functional buttons read as broken
rather than as roadmap, and AI summary as commonly implemented (server-side
inference) would contradict the product's core promise that nothing leaves the
browser. PRO affordances may return post-launch as deliberate features; any AI
feature must be consistent with the no-upload guarantee or clearly disclosed.
This entry supersedes the design handoff for these elements: future fidelity
checks against the design must treat the absence of these buttons (and of any
replacement in their place) as correct. The rest of the results toolbar keeps
the design layout exactly.

## D3: line-level search depth cap, MAX_D = 2048 (M4 review, 2026-07)
Supersedes D2's "documented, not capped" stance. Plain O(ND) Myers keeps a
per-round trace of sum(2d + 1 for d in 0..D) = D^2 words to recover the edit
path; uncapped, two unrelated 5 000-line inputs reach D near 10 000, about
10^8 words (roughly 400 MB in wasm32 linear memory), a tab crash. The forward
search now stops after MAX_D = 2048 rounds, chosen from the budget
D^2 * 8 bytes <= 32 MiB, so D <= sqrt(4 194 304) = 2048: the trace tops out
at 32 MiB (roughly 34 MB) at 8-byte words on 64-bit hosts and 16 MiB
(roughly 17 MB) on wasm32.
Semantics in the engine: prefix/suffix trimming applies first; any input
whose minimal line diff needs at most 2048 edits after trimming is unaffected
and stays minimal; past the cap the trimmed middle degrades to del-all then
ins-all, the reference LCS bailout's degradation mode, with added/removed
counts and byte-exact reconstructability intact (the diff is just not
minimal). Linear-space Myers (the middle-snake refinement) is the planned
post-launch replacement; it removes the trace and with it the need for the
cap.

## D2: line level has no bailout; worst case is documented, not capped (M4, 2026-07)
M4 replaces the line-level LCS DP with Myers O(ND) and removes the reference's
600 000-cell bailout at that level: the engine now always returns a minimal
line diff. The cost moves from output quality to resources on pathological
inputs: with the plain V-array trace, memory is O(D^2) words (D = deleted plus
inserted lines after prefix/suffix trimming), about 800 MB on 64-bit for two
completely unrelated 5 000-line inputs. Documented in src/myers.rs; the
linear-space middle-snake refinement is the known follow-up if production
inputs ever hit it. Two related calls: Myers output is canonicalized per hunk
to all deletions before all insertions (pure op ordering, required by the
unified-view contract, matches the reference), and the token-level intraline
pass keeps the LCS DP with its bailout, because the reference applies that
bailout inside intraDiff too and token streams are small.

## D1 — Whitespace semantics: Rust is canonical (M3, 2026-07)
The JS reference and Rust disagree on exotic whitespace: JS `trim()`/`\s` treat
U+FEFF (BOM) as whitespace, Rust `char::is_whitespace`/`str::trim` do not; the
inverse holds for U+0085 (NEL). These are JS string-model quirks with no user
value. The engine keeps Rust semantics; the reference defines behavior except
here. Consequence: a BOM-only input is "empty" to the reference but a one-line
diff to the engine; a BOM adjacent to whitespace may tokenize into different
segment boundaries. Not fixtured deliberately — fixtures pin behavior both
implementations share.
