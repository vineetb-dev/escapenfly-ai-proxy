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
- `CHAT_MODEL` = Haiku 4.5 — Maya's actual conversational replies. Fast,
  cheap, REPLY-FIRST.
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
- Tier 2: a cheap Haiku classifier call, checking for **any** unhedged
  visa/authorization-scheme claim anywhere in the reply — runs on every
  Layer-0-eligible turn (there is deliberately **no keyword pre-filter**
  gating this; one existed, it created a blind spot that let the Canada
  eTA case through, it was removed).
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
cheap-model check on ambiguous cases. Don't confuse this with the visa
backstop's enforce-and-block behavior — they're deliberately different
severity responses to different classes of problem.

## AI-assisted internal costing audit (13 Aug 2026)
Admin/Manager only, never customer-facing, never touches a costing, markup,
quotation, visa record, or booking — reviews a consultant's costing after
they save it and reports concerns a human should look at, nothing more.
Fire-and-forget from escapenfly-crm (its own direct Supabase write already
completed before `/internal/costing-audit` is ever hit) — `runCostingAudit()`
fetches the entity fresh itself rather than trusting the browser's payload,
builds five grounding blocks (COSTING_DATA, MARKUP_DEFAULTS, FOUNDER_NOTES,
VISA_INTELLIGENCE, CONSULTANT_HISTORY), and calls `COSTING_AUDIT_MODEL`
(claude-sonnet-5 — quality over latency, this is async) with forced tool-use.

**The anti-hallucination rule is the entire point of this feature** —
`COSTING_AUDIT_SYSTEM_PROMPT` deliberately reuses CHAT_CORE's visa-category-
confidence banner's structural pattern and forcefulness (including the "even
when you feel confident about it" phrase verbatim) because that is the exact
wording that already survived two real-world gaps on the visa rule. If you
touch this prompt, re-read that banner first — don't write a softer version.

Two triggers from the CRM, both fire-and-forget, both gated by
`costingAuditAuthOk()` (its own secret, `COSTING_AUDIT_SECRET` —
**deliberately not `CRON_SECRET`**, since this secret is shipped into
escapenfly-crm's client JS and reusing CRON_SECRET there would leak the
ability to trigger the real cron-only endpoints too): the "Done" button
(only if the costing was actually edited this session) and the "Client
Quote" export button (unconditional — the literal moment a costing heads to
a customer). A server-side `grounding_hash` (destination/dates/pax/line
items, deliberately excluding `updated_at`) skips re-spending a Claude call
on an unchanged costing.

`costing_audits` is the one table in this project with RLS enabled from
creation (anon: SELECT only; writes via a dedicated
`SUPABASE_SERVICE_ROLE_KEY`, never shipped to any repo, used ONLY for this
table's inserts) — see the RLS gap below. **This is the template for any new
table going forward**, not a retrofit of the existing gap.

## Team/routing
`TEAM` object still exists here (separate from the CRM's `team_members`
migration — these are two different repos, keep that distinction clear).
`DEPARTED_KEYS` is a hard guard preventing routing to anyone who's left,
independent of whatever the AI router itself returns — defense in depth,
added after a departed employee was still receiving new customer leads
via the fallback pool.

## Debug endpoints (all `CRON_SECRET`-gated, none hardcode the secret)
`/debug/webhook-sig-log`, `/debug/stacked-question-log`,
`/debug/visa-safety-block-log`, `/debug/visa-refresh-log`,
`/debug/costing-audit-log` — ring buffers, self-verifiable without Render
dashboard log access. Add a new one for any new fire-and-forget check rather
than assuming Render logs will be checked (they typically aren't, in this
workflow).

## Known, deliberate, NOT-yet-fixed gaps
- RLS disabled on all Supabase tables except `costing_audits` (see above —
  same as the CRM repo for every other table) — deferred, needs a real
  design pass, not a quick flip.
- **Deploy step still pending as of 13 Aug 2026**: `SUPABASE_SERVICE_ROLE_KEY`
  and `COSTING_AUDIT_SECRET` need to be set in Render's env vars (and
  `COSTING_AUDIT_SECRET`'s value copied into escapenfly-crm's
  `COSTING_AUDIT_SECRET` JS constant) before the costing audit feature above
  actually writes anything — until then it fails closed (RLS rejects the
  insert, logged to `/debug/costing-audit-log`, the costing itself is
  unaffected either way).
- AiSensy platform-side issues (webhook toggling inactive, old Flow
  fallbacks firing) have caused real incidents more than once — these
  aren't code bugs, check the AiSensy dashboard (Developer > Webhooks,
  Flows) before assuming a code fix is needed for a "Maya isn't
  responding" report.
