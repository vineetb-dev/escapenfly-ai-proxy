# CLAUDE.md — escapenfly-ai-proxy

Read this before touching `server.js`. This runs Maya, Escapenfly's
WhatsApp AI — real customers see whatever this code produces, live.

## Architecture: REPLY-FIRST
The customer's reply is generated and sent **before** any CRM writes,
lead routing, or background checks happen. Nothing should be added to
the pre-send path unless it's genuinely safety-critical (see the visa
backstop below, the one deliberate exception). Everything else —
stacked-question detection, visa lookups, lead routing — runs
fire-and-forget **after** the reply is already sent.

## The two-model split
- `CHAT_MODEL` = claude-sonnet-5 — Maya's actual conversational replies.
  Switched from Haiku 4.5 on 2026-08-14 after a 65-scenario, 3-model
  comparison (tests/model-lab/) plus AI-triage review: Sonnet had the
  lowest triage flag count (26 vs Haiku 47, Opus 59), the cleanest
  objective pass rate (57/65 vs Haiku 47/65, Opus 55/65), zero fabricated
  business-history claims (unlike Opus — "we've planned hundreds of
  these," an identical invented "20-30%" savings figure in two unrelated
  scenarios), and zero incomplete lead-field extraction (Haiku left
  travel_style empty on 3 scenarios where it was clearly implied).
  Haiku's confirmed issues: re-asking already-known information,
  repeating its own question verbatim across turns, a literal
  "<UNKNOWN>" string leaking into structured lead output instead of an
  empty string. Pricing: Sonnet 5 is at intro pricing ($2/$10 per MTok)
  through 2026-08-31, reverting to standard ($3/$15) after — factored
  into the decision, not a deciding factor at current traffic volume.
  Before switching, the visa-safety backstop was replayed against the
  real mayaTurn path with CHAT_MODEL forced to Sonnet across the full
  known violation set (ESTA, Canada eTA, ETIAS, NZeTA, K-ETA) — 5/5
  produced a safe customer-facing reply (2 via the backstop firing, 3
  because Sonnet's own reply was already correctly hedged).
- `SAFETY_CLASSIFIER_MODEL` = Haiku 4.5, independent of CHAT_MODEL —
  the visa-safety and stacked-question Tier 2 classifiers. Decoupled
  2026-08-14 (previously both hardcoded CHAT_MODEL directly, which meant
  a reply-model change would have silently changed the classifier too).
- `VISA_SEARCH_MODEL` = claude-sonnet-5 — used only for the visa
  intelligence refresh/lookup, which needs the `web_search` tool.
  **Haiku 4.5 does not support `web_search_20260209`** — don't try to
  give Maya's main reply call live search directly; route through the
  visa_intelligence table instead.

## Visa safety backstop — the most load-bearing thing in this file
Maya used to state wrong visa facts confidently (a real customer was
told Indian passports qualify for US ESTA — they don't; another was
told Canada requires only an eTA — it doesn't). **Prompt-only fixes did
not hold, twice, on real replayed traffic**, even at highest-priority
banner formatting. The actual fix is a code-level, non-optional backstop:

- `applyVisaSafetyBackstop()` runs after every Maya reply, before
  `onReply` fires, when Layer 0's precondition holds (a destination was
  resolved this turn AND no `verified` `visa_intelligence` row exists).
- Tier 1a: instant regex block on near-unambiguous violating phrases.
- Tier 2: a cheap Haiku classifier call (`SAFETY_CLASSIFIER_MODEL`),
  checking for **any** unhedged visa/authorization-scheme claim anywhere
  in the reply — runs on every Layer-0-eligible turn (there is
  deliberately **no keyword pre-filter** gating this; one existed, it
  created a blind spot that let the Canada eTA case through, it was
  removed).
- On a confirmed violation: the entire reply is replaced with a fixed
  template ("Let me verify the latest visa requirement... before I
  advise you"), fail-closed on Tier 2 timeout/error.
- **If you touch this code**: re-validate against the full known
  violation set (ESTA, Canada eTA, ETIAS, NZeTA, K-ETA, "travel
  authorization," "pre-clearance" phrasings) before deploying, the same
  way it was built. This has already had two real gaps found and fixed
  by testing against live traffic, not just isolated unit tests — don't
  assume a prompt tweak here is safe without the same replay discipline.

## `visa_intelligence` table
Hybrid architecture: stable facts (category, docs, fee, processing time)
cached per destination, refreshed monthly (`/cron/visa-intelligence-refresh`)
plus on-demand when a customer asks about an unseeded/stale destination.
`consultant_tips` is founder-authored only — the refresh/upsert code
path never writes it. Never named to a customer — Maya speaks in
Escapenfly's own voice always ("we've verified", not any source name).

**Known sharp edges, already fixed once, could recur if touched carelessly:**
- The refresh job has a concurrency lock + a never-downgrade guard (a
  `needs_refresh` result cannot overwrite an existing `verified` row's
  content) — both added after a real production incident where two
  overlapping runs raced and silently clobbered good UK data with worse
  data. Don't remove either without understanding why they're there.
- `sanitizeVisaTextField()` strips stray quote characters and a
  placeholder blocklist from every free-text field on write — added
  after the model itself wrote garbage tokens (a literal
  `needs_refresh_placeholder` string, malformed escaped-empty-quotes)
  into real data fields. Apply this to any new free-text field this
  system writes.

## Stacked-question detector (lower stakes, same fire-and-forget pattern)
Separate from the visa backstop — this one is **detect-and-log only**,
not enforce, because a stacked question is a UX problem, not a
safety/financial one. Two tiers: regex heuristic, then a conditional
cheap-model check (`SAFETY_CLASSIFIER_MODEL`) on ambiguous cases. Don't
confuse this with the visa backstop's enforce-and-block behavior —
they're deliberately different severity responses to different classes
of problem.

## Team/routing
`TEAM` object still exists here (separate from the CRM's `team_members`
migration — these are two different repos, keep that distinction clear).
`DEPARTED_KEYS` is a hard guard preventing routing to anyone who's left,
independent of whatever the AI router itself returns — defense in depth,
added after a departed employee was still receiving new customer leads
via the fallback pool.

## Debug endpoints (all `CRON_SECRET`-gated, none hardcode the secret)
`/debug/webhook-sig-log`, `/debug/stacked-question-log`,
`/debug/visa-safety-block-log`, `/debug/visa-refresh-log` — ring
buffers, self-verifiable without Render dashboard log access. Add a new
one for any new fire-and-forget check rather than assuming Render logs
will be checked (they typically aren't, in this workflow).

## Known, deliberate, NOT-yet-fixed gaps
- RLS disabled on all Supabase tables (same as the CRM repo) — deferred,
  needs a real design pass, not a quick flip.
- AiSensy platform-side issues (webhook toggling inactive, old Flow
  fallbacks firing) have caused real incidents more than once — these
  aren't code bugs, check the AiSensy dashboard (Developer > Webhooks,
  Flows) before assuming a code fix is needed for a "Maya isn't
  responding" report.
