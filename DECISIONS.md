# DECISIONS

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
