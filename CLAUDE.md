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

**When a seat changes hands (14 Aug 2026 finding), renaming `TEAM`'s key
is NOT optional/cosmetic — it's load-bearing.** Found during Riya Negi's
onboarding: the `sales7@escapenfly.com` seat moved from Shubham → Anurag
in the CRM's `team_members` around 26 Jun 2026, but this file's `TEAM`
entry was never touched — it sat as `shubham: {name:'Shubham', ...}` in
`DEPARTED_KEYS` the entire time. Net effect: Anurag received **zero**
AI-routed WhatsApp leads for ~2 months (confirmed — every enquiry under
his email in the CRM was manually sourced, not one AI-routed). Nothing
crashed and nothing logged an error; the seat just silently stopped
getting new leads. `assignTeamWithClaude`'s JSON-schema line
(`"key": "lalit|divya|anjan|riya|prabhjot|damini"`) is a second, separate
place that must list a key by name or Claude can never emit it as a
routing decision even if it's un-departed and present in the roster —
missing that update would have reproduced the exact same silent gap.
Next time this seat (or any seat) changes hands: rename the `TEAM` key,
remove it from `DEPARTED_KEYS`, update `REP_KEYS` and the
`team_lead_digest` `results.<key>` reference, AND add the new key to
that JSON-schema enum line — all four, in the same change.

## WhatsApp digest/alert accuracy and volume (17 Aug 2026)
Two real bugs found investigating a wrong lead-count report (Divya's digest
said 31 live leads, actual was 5):
- `countLeadsFor()`'s "live" and "urgent" queries excluded `booked`/`lost`
  but not `cancelled` — cancelled leads were silently counted as still
  live/urgent. Now excludes `cancelled` too, matching the CRM's own
  `["booked","lost","cancelled"].indexOf(status)<0` "Active" definition
  exactly (`index.html`'s `rCRM()`). If you add another "closed" status to
  either codebase, update both places — they're two independent
  reimplementations of the same concept, not shared code.
- `/cron/stale-check` used to unconditionally send Vineet the SAME approved
  `stale_lead_alert` template once **per lead**, every run. With the cron
  actually firing ~4x/day (confirmed from real `last_stale_alert_at`
  timestamp clusters — every ~6h, not the 2x/day it was assumed to be),
  that was N separate WhatsApp messages just for his CC, on top of every
  rep's own per-lead alert. Now batched into one free-text digest per run
  (skipped entirely if nothing new that run). **This uses
  `sendSessionMessage`, not `sendWA`** — the only mechanism in this file
  that can carry a variable-length list, since no approved multi-lead
  digest template exists. That means it's subject to WhatsApp's 24h
  session window (recipient must have messaged the business number
  recently) unlike template sends, which don't need one. Vineet is staff,
  not part of the customer inbound flow, so this could silently stop
  delivering if he has no open session at run time — check that first if
  Vineet reports the digest went quiet, don't assume a code regression.
  The durable fix is a real pre-approved batched-digest WhatsApp template,
  which needs external AiSensy/Meta approval — not something a code
  change alone can do.
- Reps' own per-lead `stale_lead_alert` sends are unchanged by either fix.

**18 Aug 2026 follow-up — the two items above that were flagged-not-fixed are now fixed:**
- `notifyTeam()`'s unconditional real-time Vineet CC on `team_lead_notification`
  is **removed**. He already gets the same information via the 10am
  `individual_lead_digest` + `team_lead_digest`, so this was pure
  duplication for him specifically. The assigned rep's own send is
  untouched. Verified against the real, unmodified function (not a
  rewrite/mock of the logic) by running the actual server locally and
  hitting `/notify/manual-lead` — with no `AISENSY_KEY` configured
  locally, `sendWA` no-ops before any network call, so this was safe to
  run for real: exactly one `sendWA skipped` log line appeared (the rep),
  zero for Vineet/`WA_NUM`.
- `/cron/booking-check` batches everything still `booking_notified=false`
  into **one digest per founder** instead of one `booking_confirmed_alert`
  template send per booking per founder (was near-real-time, ~every
  15-30 min). Query itself is unchanged (`booking_notified=eq.false`, not
  a "last 24h" time window) — deliberately kept as a flag-based selection
  rather than a rigid time window, since that's robust to a missed/delayed
  run (nothing gets silently dropped for being >24h old). Skips the send
  entirely if nothing's new. Same template-shape constraint as the
  stale-check fix applies here too — `booking_confirmed_alert` is a
  fixed single-booking template, so batching required switching to
  `sendSessionMessage` (free text), which means the same 24h-session-
  window caveat now applies to **all four `FOUNDER_KEYS` recipients**
  (Vineet, Vivek, Abhishek, Prabhjot), not just Vineet. Verified the real
  digest-construction code (unmodified) end-to-end with `node --require`
  preloading a `global.fetch` mock so the process could not reach the
  real network at all — 3 synthetic bookings correctly produced exactly
  4 sends (one per founder, not 12), correct running total (₹230000),
  correct per-line formatting.
- **Schedule change still needed on Render's side, separately from this
  code change** — same category as the stale-check schedule assumption
  found earlier. Render's Cron Jobs entry for `/cron/booking-check`
  currently triggers every ~15-30 min; nothing in this repo controls
  that. Until someone changes it in Render's dashboard, this endpoint
  still *runs* that often — it'll just send fewer, batched messages each
  time instead of one per booking (still correct, just not the intended
  once-daily cadence). Verify the current setting in Render before
  assuming this behaves as "once daily" in production.

## Prompt caching (18 Aug 2026)
`cache_control` breakpoints added to the two genuinely-large, genuinely-
static system prompts in this file. **Correction to how this was first
asked**: "server.js" was named as containing `genClientUpdate`/`sendAI`/
`aiWA`/`sendCommonAI` — those four actually live in `escapenfly-crm/
index.html`, not here. What IS here is `/ai`, the generic passthrough
those four all call, which forwards whatever `system` string it's given
straight to Anthropic with no structure at all.

- **`callMayaJSON`'s system prompt** (`buildChatSystem(channel, intent) +
  currentDateLine + knownLine + founderLine + visaLine + liveDataLine +
  statusLine + pastDestinationsLine + returningProfileLine`) was ONE
  concatenated string mixing a static part with several genuinely
  per-conversation parts (known lead info, founder notes, visa intel,
  live weather/forex, enquiry status, past destinations, returning-
  customer profile all vary call to call; only `buildChatSystem`'s output
  — one of a small fixed set keyed by channel × intent, not by customer —
  is actually static). Split into a 2-block `system` array: static block
  first with `cache_control: {type:'ephemeral'}`, dynamic tail second,
  unmarked. Order matters — caching only covers an unbroken prefix, so
  the static block MUST come first, exactly as it already did before this
  change (nothing to restructure there, just had to stop concatenating
  into one string). `tools: [MAYA_REPLY_TOOL]` needs no separate marker —
  it structurally precedes `system` in Anthropic's fixed prefix order, so
  it rides along in the same cached prefix for free.
- **`/ai`'s `system` field** is now wrapped in the same array+cache_control
  shape whenever non-empty. Confirmed safe to do unconditionally: every
  current caller (`sendAI`, `genClientUpdate`, `aiWA`, `sendCommonAI` —
  the only 4 things that hit `/ai`, confirmed by reading every fetch to
  this endpoint in `escapenfly-crm/index.html`) sends a hardcoded,
  zero-interpolation system string; all per-request content already goes
  into `messages`. If a future caller ever needs to send a system prompt
  with per-request content through this endpoint, it must not rely on
  this blanket cache_control as-is.

**Verified with real Anthropic API calls, not just code review** (via
`callMayaJSON`, the actual exported function `mayaTurn` calls — bypassed
`mayaTurn` itself so the test made zero Supabase writes and zero WhatsApp
sends):
- Call 1 (holiday intent): `cache_creation_input_tokens: 12118`,
  `cache_read: 0` — first-time write.
- Call 2 (identical call): `cache_read_input_tokens: 12118`,
  `cache_creation: 0` — real cache hit, exact size match.
- Call 3 (same intent — same static prefix — but different message/known
  lead info): still `cache_read_input_tokens: 12118`, while
  non-cached `input_tokens` differed from call 2 (348 vs 405) — proves
  the cache boundary is genuinely at the static/dynamic split, not just
  "identical whole request happened to repeat."
- Call 4 (different intent → different static prefix): fresh
  `cache_creation_input_tokens: 11239`, `cache_read: 0` — confirms
  different intents get independently cached, not incorrectly merged.
- Reply content/quality spot-checked on a 5th call (cache hit,
  `cache_read_input_tokens: 12118`) — coherent, on-brand, correctly
  followed STAGE_LOGIC's qualify-first holiday flow. Restructuring
  `system` from one string into a 2-block array produces a byte-identical
  effective prompt to Anthropic (blocks concatenate with no added
  separator) — confirmed by reply behavior, not just by reading the docs.

**Cost math from those real numbers** (Sonnet 5 intro pricing per the
model-split section above, $2/MTok input; cache write is 1.25× base,
cache read is 0.1× base, standard Anthropic pricing): the static prefix
alone (~12,118 tokens) costs $0.0242 as a plain uncached input every
single call under the old code. Under the new code: $0.0303 the first
time (write), then $0.0024 every subsequent call sharing that (channel,
intent) pair within the 5-min TTL — roughly 90% cheaper than uncached on
every reuse, ~32% cheaper already by the 2nd call, more with volume.
WhatsApp conversations routinely have several turns within minutes, and
concurrent customers in the same intent bucket share the same window —
real savings should be meaningfully higher than a single-conversation
number suggests.

**Explicitly checked and found NOT to work — don't assume this "just
works" for short prompts**: tested the same array+cache_control shape
directly against a real ~80-token system string (sendCommonAI's exact
text) with two back-to-back real calls. Both came back
`cache_creation_input_tokens: 0` and `cache_read_input_tokens: 0` —
**no caching occurred at all**. Anthropic requires a minimum cacheable
block size (1024 tokens for Sonnet models) and all four CRM-side system
prompts (`sendAI`/`genClientUpdate`/`aiWA`/`sendCommonAI`, ~30-70 tokens
each) are well under it. The `/ai` endpoint change is still correct to
keep — it's harmless, and correctly positioned if any of those prompts
ever grow past the threshold or get combined with enough static context
to clear it — but as of today it produces zero measurable savings. Don't
report this as "fixed" without that caveat.

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
