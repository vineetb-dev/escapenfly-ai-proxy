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

## team_lead_digest → team_lead_digest_v2 (18 Aug 2026) — the actual root-cause fix for the Shubham/Riya digest bug
The investigation above (Riya/Shubham) concluded the "Shubham has 1, no
Riya" text was correct code producing a correct NUMBER against a stale
LABEL baked into `team_lead_digest`'s pre-approved static body text —
not fixable in `server.js` alone, since WhatsApp templates need
Meta/AiSensy re-approval to edit body copy, not a code deploy.
`team_lead_digest_v2` is that re-approved template — genuinely dynamic
now: `{{1}}` = recipient name (unchanged), `{{2}}` = one multi-line
free-form block built fresh at send time.

`buildTeamDigestBlock(results, damini, totalLive)` builds that block from
`TEAM`/`REP_KEYS` directly — one `Name: count` line per rep (skipping
anyone in `DEPARTED_KEYS`, since there's no more fixed-slot reason to
show a departed name), then Damini's visa count, then a total. This is
the structural fix that stops this exact bug class recurring: the next
seat change is a `TEAM`-object-only edit again, no template resubmission
ever needed for a name change specifically (a genuinely NEW slot — e.g.
an additional rep — would still need the template's line count/shape
touched, but a same-shape name swap now needs nothing on AiSensy's side).

**Verified against real current data** (not synthetic): ran the actual,
unmodified `/cron/daily-digest` handler locally against real production
Supabase (read-only — this cron never writes anything) with no
`AISENSY_KEY` configured locally, so `sendWA` safely no-ops before any
network call — real code path, zero risk of an unverified send. Real
output:
```
Lalit Mehta: 14
Divya Nigam: 5
Anjan Pramanick: 5
Riya Negi: 2
Prabhjot Singh: 9
Damini: 0
Total: 35
```
Cross-checked Lalit (14), Prabhjot (9), Anjan (5) directly against
Supabase independently of the app's own computation — exact match.
Riya's 2 also independently confirmed by checking her two enquiries'
`created_at` timestamps directly. Arithmetic self-consistent
(14+5+5+2+9+0=35, matches `totalLive`). No "Shubham" anywhere.

**Real AiSensy delivery — NOT verified, stating plainly rather than
implying otherwise**: there is no real `AISENSY_KEY` available in this
environment (not in local `.env`, no Render access), so no actual
network call to AiSensy's API happened for `team_lead_digest_v2` —
only the constructed request (`campaignName`, `destination`,
`templateParams`) was confirmed correct via the real `sendWA()` code
path up to the point it safely no-ops on the missing key. **The one
thing genuinely unconfirmed is whether AiSensy's live API recognizes
the exact string `team_lead_digest_v2`** and will actually deliver
against it — that can only be confirmed once this is live: check
Render's runtime logs for the `❌ sendWA 'team_lead_digest_v2' → ...
FAILED` error line (would mean a name/approval mismatch) after the next
`/cron/daily-digest` run, or manually trigger that cron once with the
real `CRON_SECRET` and check for it immediately rather than waiting for
10am.

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

## Marketing data sync — meta-sync.js / google-sync.js (19 Aug 2026)
`/internal/sync-meta` and `/internal/sync-google` call `runSync()` in
`meta-sync.js`/`google-sync.js` respectively — direct Meta Graph API and
Google Ads/GA4 API integrations, replacing Windsor.ai's connectors for
`marketing_performance` (see escapenfly-crm's Marketing Command Center
section for that table's read side). Both files were authored outside
this session and placed here verbatim except for one fix applied to
both: their `getSupabase()` referenced `SUPABASE_SERVICE_KEY`, which
doesn't exist anywhere in this repo — the real shared variable name is
`SUPABASE_SERVICE_ROLE_KEY` (same one `SB_SERVICE_HEADERS` uses). Fixed
in both files before ever writing them to disk, not after.

Gated by `MARKETING_SYNC_SECRET` (`x-sync-secret` header only, no
query-param fallback — these are meant to be called by a scheduler, not
a browser, so there's no reason to risk the secret landing in an access
log). Same empty-string fail-closed fallback as `ADMIN_WRITE_SECRET`/
`VENDOR_CREDS_SECRET`, deliberately not `CRON_SECRET`/
`COSTING_AUDIT_SECRET`'s older `'change-me-please'` pattern — see the
security incident above for exactly why that fallback is unsafe for a
secret gating a live endpoint.

**`@supabase/supabase-js` was not a dependency of this repo before
today** — every other Supabase call in `server.js` goes through raw REST
+ `fetchRetry`, never the SDK. Both new files `require()` it. Since
`server.js` now `require()`s these two files at module load (not
lazily), a missing SDK package would have crashed the **entire server**
at startup, not just the sync endpoints — added `@supabase/supabase-js`
and `google-auth-library` to `package.json` and confirmed with a real
local `npm install` + server start before this shipped, not assumed.

**Verified locally, real behavior not just code review**: server starts
clean with both files required. Auth gate: no secret → 401, wrong
secret → 401. Correct secret with Meta/Google env vars still unset →
clean `500` with a real error message (`Missing required env var: ...`),
full stack trace logged, server stays up for the next request — proven
by hitting both endpoints back to back successfully. **This test also
surfaced a real pending-config item**: `meta-sync.js`/`google-sync.js`
each call `requireEnv('SUPABASE_URL')` directly with no fallback,
unlike this file's own `SB_URL` constant which has a hardcoded default
— so `SUPABASE_URL` needs to be an actual Render env var for these two
endpoints specifically, not just relying on whatever makes the rest of
`server.js` work today.

**Not yet verified — genuinely can't be from here**: whether the real
Meta/Google credentials work end-to-end (`META_ACCESS_TOKEN`,
`META_PAGE_ID`, `META_IG_BUSINESS_ID`, `META_AD_ACCOUNT_ID`,
`GOOGLE_ADS_*`, `GA4_PROPERTY_ID`, `GA4_SERVICE_ACCOUNT_JSON`,
`SUPABASE_URL`, `MARKETING_SYNC_SECRET` all need to be set in Render).
Real test with real production credentials against real Meta/Google
APIs and a real `marketing_performance` write is the next step, done
with Vineet once this deploys.

## Attribution persistence + Meta campaign capture (3 Sep 2026)
`enquiries` has 17 nullable attribution columns (`medium`, `campaign_code`,
`platform_campaign_id`, `platform_adset_id`, `platform_ad_id`,
`utm_source/medium/campaign/content/term`, `gclid`, `fbclid`,
`landing_page`, `referrer`, `first_touch_source`,
`first_touch_campaign_code`, `whatsapp_broadcast_code`) that nothing wrote
to before this. `ATTRIBUTION_KEYS` (defined just above `mergeLeadData`) is
the whitelist of the 12 that this code path actually carries: website query
params (`utm_*`, `gclid`, `fbclid`, `landing_page`, `referrer`) and Meta
Lead Form platform IDs. `medium`, `campaign_code`, `first_touch_campaign_code`,
and `whatsapp_broadcast_code` are deliberately NOT written here — they stay
for a human or a later feature. `campaign_code` in particular is never
derived from `utm_campaign` — that mapping is a human decision per campaign.

**First-touch, existing wins — the opposite of every other field.**
`mergeLeadData()` merges most fields fresh-wins (a later, more specific
answer overwrites an earlier vague one). Attribution is the opposite: once
an `ATTRIBUTION_KEYS` field is set on a lead, it is never overwritten by a
later turn or a later visit inside the dedupe window — a customer who first
arrived via a Google ad and later returns direct still reads as the Google
ad's lead. Implemented as a second pass after the normal fresh-wins merge:
`existing[k] || fresh[k]`, existing first.

**THE TRAP — column AND blob, both, always.** `findRecentLeadDB()` rebuilds
a lead's `existing` state by parsing the `original_message_text` JSON blob,
**not** the real table columns. `buildLeadFields()` therefore writes every
`ATTRIBUTION_KEYS` field to BOTH the real column (top-level, spread into the
returned object) AND inside the `original_message_text` JSON. Miss the blob
half and it looks correct on the insert, then gets silently wiped the moment
the customer sends a second message inside the dedupe window — the merge
that produces the UPDATE reads `existing` from the blob, sees nothing there,
and the subsequent `buildLeadFields()` call blanks the column. Any test that
only checks the insert will pass while this is broken; the real verification
must include a follow-up message.

**`first_touch_source` is `isNew`-gated.** `buildLeadFields(data, isNew)` —
`isNew` defaults `false` and is passed `true` only from `saveLead()`'s insert
call site; `updateLead()` still calls it with one argument. Only on `isNew`
does it derive `first_touch_source` (`utm_source` if present, else the
referrer's hostname, else `'direct'`) and set it. This gates it so an
enrich-pass UPDATE can never relabel where an existing lead originally came
from — the same reasoning as the first-touch merge above, enforced a second
way at the point where the row is actually written.

**Threading through `mayaTurn` / website chat.** `mayaTurn()` takes a sixth
parameter, `attribution` — a plain object, whitelist-filtered against
`ATTRIBUTION_KEYS` before it's folded into `freshData` (never the raw
request body spread directly — a crafted POST must not be able to inject
arbitrary columns). `/webhook/website-chat` builds that object off
`req.body` through the existing `cleanAttr()` sanitizer and passes it as the
sixth argument. Because `chat.known` is persisted by `saveChat()` and merged
every turn, attribution captured on turn 1 survives to whichever later turn
actually creates the lead (usually several turns later, once a phone number
appears) — confirmed `graduateSessionToPhone()` does NOT rebuild `chat.known`
from scratch on the session-key → phone handoff, it only reassigns
`chat.phone` and re-saves the same chat object, so nothing extra was needed
there.

**`/webhook/meta` — Graph API version, flagged not changed.** The Graph
lead-detail call now requests `fields=id,created_time,field_data,ad_id,
adset_id,campaign_id,form_id` explicitly (it previously took Meta's
defaults, which never included the ad/adset/campaign IDs, so that data was
silently discarded before it ever reached `mergeLeadData`). IDs are read
preferring the Graph response, falling back to the webhook payload
(`change.value`, i.e. `formData.adgroup_id`/`formData.ad_id`) which carries
them even when the Graph call returns partial data. Separately, and
deliberately NOT changed here: this URL is pinned to Graph API `v18.0`,
while `meta-sync.js` in this repo uses `v21.0`. `v18.0` is past Meta's
~2-year version lifetime — Meta auto-upgrades calls to expired versions, so
this may be working by accident rather than by design. Bumping to `v21.0`
is almost certainly right, but it touches a live lead-capture path, so this
was surfaced for an explicit decision rather than changed unilaterally.

**Verified against real Supabase, not mocks** — see the verification log
kept alongside this change; a synthetic website-chat conversation was run
end-to-end (insert → same-window follow-up → different-attribution
follow-up → cleanup), not just a single insert check, specifically because
THE TRAP above only shows up on the second message.

## WhatsApp broadcast attribution (3 Sep 2026)
Closes the last attribution gap — website and Meta were handled by the
section above, WhatsApp broadcasts previously produced leads
indistinguishable from walk-ins. `whatsapp_broadcast_code` is now the 13th
entry in `ATTRIBUTION_KEYS`, so it gets the same first-touch merge and the
same column-AND-blob persistence as every other attribution field, with no
second code path — `mergeLeadData()`/`buildLeadFields()` needed zero changes
beyond the one array entry.

**Link format.** A broadcast links to `https://wa.me/919851739851?text=Hi%20%5BBALI25%5D`
— the customer taps it, WhatsApp opens with `Hi [BALI25]` already typed in
the compose box, they hit send. That literal bracketed code is what arrives
as the first inbound message.

**Stripped before Maya ever sees it, deliberately.** `extractBroadcastCode()`
(next to `deepExtract`, just above `/webhook/incoming`) pulls the code via
`BROADCAST_CODE_RE` and returns the text with it removed. `/webhook/incoming`
overwrites `text` with the stripped version before Maya is called — Maya
receives `Hi`, never `Hi [BALI25]`. This isn't just cosmetic: if she saw the
raw code she could echo it back, ask the customer what it means, or treat it
as part of their actual travel question, none of which a customer expects
from a marketing tag they never consciously typed.

**Runs after the spam guard, on purpose.** The extraction happens after the
`validPhone`/self-number/`looksLikeSpam`/DMC-vendor guards, but before the
empty-text check and before `mayaTurn()` is called. Specifically AFTER
`looksLikeSpam`, not before — so the spam classifier still sees the original
bracketed text. Stripping first would let a spam message launder itself into
something cleaner-looking before the spam check ever ran.

**Never mapped to `campaign_code`**, same rule as `utm_campaign`: a broadcast
code is a raw tag marketing chose, and turning it into a `campaign_code` is a
human decision made once per campaign, not something this code path decides
for them. Stored raw, as typed on the broadcast link (uppercased for
consistency).

**Empty-after-strip case.** A message that was ONLY the code (`Hi [BALI25]`
strips to nothing once "Hi" is also absent from some link variants) would
otherwise reach Maya empty and trip the media-only fallback path incorrectly
— `extractBroadcastCode()` substitutes a plain `'Hi'` opener in that case so
the conversation starts normally.

**Verified against real Supabase, not unit tests** — see the verification log
kept alongside this change: a synthetic AiSensy-shaped `/webhook/incoming`
payload carrying `Hi [TESTCODE1]` was posted to a local server instance
against real production Supabase. Confirmed via logs that the code was
extracted and Maya received the stripped `Hi`; confirmed her reply never
mentioned the code; confirmed the resulting lead held `TESTCODE1` in both the
`whatsapp_broadcast_code` column and inside `original_message_text`; a
same-window follow-up with no code left it unchanged; a same-window message
carrying `[TESTCODE2]` did NOT overwrite it (first-touch holds for broadcast
codes exactly as it does for the other `ATTRIBUTION_KEYS` fields); a normal
bracket-free message left the field null; `campaign_code` stayed null
throughout; test rows deleted after.

## Graph API version bump — v18.0/v21.0 → v25.0 (3 Sep 2026)
The v18.0-vs-v21.0 discrepancy flagged in the attribution-persistence section
above turned out worse than it looked: **both were expired**. "Bump
`/webhook/meta` to match `meta-sync.js`'s v21.0" — the advice given when this
was first flagged — was wrong, because v21.0 was itself past Meta's ~2-year
version lifetime. As of Q2 2026: **v25.0 is current** (released 18 Feb 2026),
**v24.0 is the oldest supported** (v23.0 reached end of life 9 Jun 2026). Both
`server.js` and `meta-sync.js` now pin `v25.0`.

**Why this is not cosmetic.** A Graph API call to an expired version does
**not error** — it silently reroutes to the next oldest supported version,
with no 4xx, no warning, nothing in the logs. The response shape can change
underneath you with zero signal. Two live consequences were riding on this:
`/webhook/meta`'s `campaign_id`/`adset_id`/`ad_id` fields (BRIEF-2's
attribution fix) were being requested against a rerouted, unspecified
version; and `meta-sync.js` writes to `marketing_performance`, where a
silently reshaped response means quietly wrong marketing numbers — worse
than an outage, because nothing looks broken.

**Named constants, not inline literals — that's how this drifted.** The
inline `v18.0` string in `/webhook/meta`'s fetch URL is what let it drift
three versions behind `meta-sync.js` without anyone noticing. `server.js` now
defines `META_GRAPH_VERSION` (in the CONFIG block, near the top of the file);
`meta-sync.js` keeps its own `GRAPH_VERSION`. **These two must move together**
— there's no shared import between the two files (`meta-sync.js` is required
by `server.js` but nothing here re-exports its `GRAPH_VERSION`), so bumping
one without the other reintroduces the exact discrepancy this fix closes.
Check Meta's changelog before the next bump, and update the version comment
in both places.

**Metric-name check, not just a version-string bump.** Before assuming the
version bump alone was sufficient, checked Meta's live docs for every metric
`meta-sync.js` requests, since retired/renamed metrics fail silently (return
nothing, not an error) — same silent-failure shape as the version drift
itself. Checked directly against Meta's official docs (Graph API Page
Insights reference, Instagram Media Insights reference, Marketing API
breakdowns reference), not from memory:
- `page_views_total`, `page_post_engagements` (`fetchPageOrganicInsights`) —
  both confirmed **current, not deprecated**. Meta deprecated ~85 legacy
  Page Insights metrics effective 15 Jun 2026 (Page/Paid/Viral/Nonviral
  Reach, Page Posts Impressions, Page/Post Video Views Unique, Reels Unique
  Impressions — replaced by new Views/Viewers metrics), but neither of these
  two is in that list.
- `reach`, `likes`, `comments`, `saved`, `shares`, `total_interactions`
  (`fetchInstagramMediaInsights`) — all confirmed **current**. The
  `impressions`/`plays` family was deprecated (Apr 2025 onward, views
  replacing impressions everywhere), but this file never requested those.
  One caveat worth knowing, not a deprecation: `total_interactions` is
  marked "Currently in development status" in Meta's own docs — usable, but
  less stable than a GA metric. Separately (not version-related, pre-existing
  either way): `likes` and `saved` are documented as FEED-post-and-REELS-only,
  not valid for STORY — `fetchInstagramMediaInsights` only branches its
  metric string on `isReel` vs not, so if the `/media` edge it queries ever
  returned a STORY item, requesting `likes`/`saved` for it could fail. Not
  fixed here since it's outside what this bump touched and Instagram Stories
  don't normally appear on the regular `/media` edge — flagged for whoever
  looks at this function next.
- `post_engagement`/`page_engagement` action types on the plain `actions`
  field (`fetchAdsInsights`) — confirmed **current**. Meta deprecated 100+
  metrics from Ads Insights on 30 Oct 2024, but that hit `unique_actions`/
  `cost_per_unique_action_type` specifically; the plain `actions`/
  `cost_per_action_type` fields this file actually uses were explicitly
  unaffected.

**Verification — what could and couldn't be done from here.** Confirmed
locally: both files syntax-check clean; the server starts clean with the
edited `meta-sync.js` still required non-lazily (a break there would crash
the whole server at startup, not just the sync endpoint — see the Marketing
data sync section above); `/internal/sync-meta` still 401s with no/wrong
secret and, with a local-only test secret, reaches the same pre-existing
`Missing required env var: SUPABASE_URL` 500 already documented above —
confirming the `GRAPH_VERSION` edit didn't break module load or execution.
**Not verified from here, genuinely can't be**: the brief's own two real
tests — firing Meta's Lead Ads Testing Tool against the real form/webhook,
and calling `/internal/sync-meta` with the real `MARKETING_SYNC_SECRET`
against real Meta credentials — both need real Meta Developer account access
and real Render-configured secrets, neither available in this environment
(same gap already noted in the Marketing data sync section: no real
`META_ACCESS_TOKEN`/`MARKETING_SYNC_SECRET` locally, no Render access). Real
verification of the actual v25.0 Graph API responses is the next step, done
with Vineet once this deploys — check whether `campaign_id`/`adset_id`/
`ad_id` come back populated on a real test lead, and diff `/internal/sync-meta`'s
summary against a pre-bump run for any metric that drops to 0.

## tests/model-lab/ — what's tracked, what isn't, and why (3 Sep 2026)
**This repo is public** (confirmed: `server.js`/`meta-sync.js` are fetchable
anonymously from `raw.githubusercontent.com`). That fact governs everything
below — it's not a general tidiness preference, it's the actual reason for
the split.

The harness code and scenario definitions ARE tracked: `build-scenarios.js`,
`run-model-lab.js`, `run-triage.js`, `validate-triage.js`,
`replay-visa-safety.js`, `lib/{ai-triage,context-snapshot,cost,
objective-scorer,report}.js`, and `scenarios.json`. Checked every one of
these directly, line by line, before tracking any of them: all synthetic —
fictional customer messages, generic test-authoring notes, public Anthropic
pricing, pure logic. No founder_notes/consultant_tips text, no real customer
data, no API keys (`lib/ai-triage.js`'s only key reference is
`process.env.ANTHROPIC_API_KEY`, same pattern as `server.js` — never a
hardcoded value). This is what makes the model-switch reasoning in "The
two-model split" above reproducible — clone the repo, run the harness
yourself, get the same shape of numbers.

**`tests/model-lab/results/` is deliberately, permanently gitignored — do
NOT add exceptions for individual files in it, however tempting.** This
directory is what running the harness above actually produces: per-turn
`snapshots/*.json` (a live capture of real `founder_notes`/
`visa_intelligence` rows at run time — actual consultant-authored content
like specific hotel-area advice, not descriptions of it), full model
transcripts (`raw-results.json`), and generated reports (`report.md`,
`triage-summary.md`, `all-flags.json`). The specific numbers cited in "The
two-model split" (26/47/59 triage flags, 57/47/55 pass rates, the quoted
Opus/Haiku examples) all live in this directory — genuinely useful to keep
around locally, genuinely not safe to publish. Committing any of it,
including just the "headline" report files, would publish EscapeNFly's
proprietary consultant knowledge to anyone who fetches this public repo
anonymously. `tests/last-run-results.json` (the sibling `run-tests.js`
harness's own output) was already gitignored on this same reasoning before
today — `tests/model-lab/results/` is the same pattern, not a new one.
Re-running the harness regenerates this directory locally at zero
information loss; there is no "helpfully" re-adding it that doesn't leak
something.

## Known, deliberate, NOT-yet-fixed gaps
- RLS disabled on all Supabase tables except `costing_audits` (see above —
  same as the CRM repo for every other table) — deferred, needs a real
  design pass, not a quick flip. **In progress as of 18 Aug 2026** for the
  two highest-exposure tables specifically — see the RLS rollout section
  below.
- **Deploy step still pending as of 18 Aug 2026 (RLS rollout)**:
  `ADMIN_WRITE_SECRET` and `VENDOR_CREDS_SECRET` need to be set in
  Render's env vars, and the SAME values copied into escapenfly-crm's
  matching JS constants (once those exist — CRM side not deployed yet as
  of this endpoint's own deploy). Same fail-closed shape as
  `COSTING_AUDIT_SECRET` below: until both sides are set, every
  `/internal/roles-write`, `/internal/staff-roles-write`,
  `/internal/portal-credentials-read`, and `/internal/portal-credentials-
  write` call returns 401. Real generated values are NOT committed to
  this repo — Vineet has them from the session that generated them.
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

## RLS rollout — roles/staff_roles + portal_credentials (18 Aug 2026)
**The real architectural finding first, confirmed directly in code, not
assumed**: this system has NO real Supabase Auth anywhere. Checked both
repos for any `.auth.*()` call — zero. escapenfly-crm's `getSB()` always
creates its client with the same static anon/publishable key regardless
of who's "logged into" the CRM's own fake login screen (`doLogin()` is
pure local JS — hardcoded shared password + optional per-browser
localStorage password, never touches Supabase). This repo's own Supabase
calls are the same shape, one static key per table except `costing_audits`
(service_role). **Consequence: `auth.uid()`/per-person RLS policies are
not achievable without a real auth migration** — Postgres cannot tell
which staff member is asking, because no request ever carries one. What
RLS CAN do without that migration is the coarser "anon key holder" vs.
"trusted server process that never ships its key to a browser" boundary —
that's what this rollout targets, deliberately not proposing anything
finer-grained than that.

Verified directly (not assumed) before designing anything: all 32 public
tables enumerated via `pg_class`/`information_schema`/`pg_policies`. Only
`costing_audits` has RLS on. `roles`/`staff_roles` have full anon
SELECT/INSERT/UPDATE/DELETE grants and **no policy of any kind** — RLS
enabled with zero policies would default-deny everything, including the
app's own legitimate reads. `portal_credentials` also has full anon
grants AND an existing **dormant `anon_all` policy** (`cmd: ALL,
qual: true`) — flipping RLS on this table without also dropping that
policy is a pure no-op, not a fix; this is the sharpest footgun in the
whole rollout and is called out explicitly wherever this table comes up.

**Sequencing, and why it's sequential not atomic**: build the
service-role-gated proxy endpoint, deploy it alone, verify with real
disposable data, THEN switch the CRM's direct `sb.from(...)` calls to use
it, deploy that alone, verify via real UI, THEN and only then enable RLS.
Never ship the proxy and the RLS flip together. Reason: once the CRM's
code depends on the new endpoint, a bug there breaks the write/read
regardless of RLS's state — but the ROLLBACK differs enormously. With RLS
still off, a broken endpoint's fix is a pure CRM code revert (old direct
`sb.from()` calls still work, since anon can still write/read directly) —
fast, single-repo, no coordination needed. With RLS already on, that same
revert does nothing, because the reverted code hits a database that now
denies anon — recovery needs a SECOND, uncoordinated Supabase-side change
under time pressure. `portal_credentials` makes this materially worse
than `roles`/`staff_roles`: its read (`syncPortalCreds()`) runs on every
single session load, not just an occasional admin action, so a broken
proxy there is instantly company-wide-on-next-refresh, not a bounded
inconvenience for whoever happens to be editing permissions. Checked
directly: `syncPortalCreds()`'s own `try/catch` means a broken read
degrades to `rVnd()`'s `"No matches"` empty state, not a crashed app or
broken CRM — the blast radius is real but bounded to that one tab, which
is exactly why fast, RLS-still-off rollback is worth protecting.

**Separate secrets, deliberately**: `ADMIN_WRITE_SECRET` (roles/
staff_roles) and `VENDOR_CREDS_SECRET` (portal_credentials) are two more
values in the same family as `COSTING_AUDIT_SECRET` — never `CRON_SECRET`
(shipped to a browser), and also never EACH OTHER or `COSTING_AUDIT_SECRET`
(different-sensitivity capabilities; one leaked secret shouldn't hand over
all of them). Same honest limit as `costing_audits` applies to both new
proxies: a valid secret proves the request came from the CRM app, not
which staff member is behind it. That's not solved here and isn't
pretended to be.

### Status as of tonight — final
- `/internal/roles-write`, `/internal/staff-roles-write`,
  `/internal/portal-credentials-read`, `/internal/portal-credentials-write`
  — built, deployed, and the CRM switched over to all four. Verified
  twice: once locally against real Supabase with disposable test data
  before the CRM deploy, once more via real UI actions in the live CRM
  after (create/delete a test role, set/clear a test permission override,
  add a test vendor + update its password) — every write confirmed at
  the DB level independent of the endpoint's own success response, every
  test row cleaned up after. Negative-tested: missing secret and wrong
  secret both correctly return 401.
- **`roles`/`staff_roles`: RLS is ON.** `ENABLE ROW LEVEL SECURITY` +
  `anon_select_only` policy (mirrors `costing_audits` exactly) applied
  to both tables. Verified with real, unauthenticated anon-key requests
  against production (not assumed): a plain anon SELECT on `roles` still
  returns real data (200); a raw anon INSERT on `roles` and a raw anon
  UPSERT on `staff_roles` attempting to grant an arbitrary email the
  `partner` role both now fail with `42501 row-level security policy`
  violations (401) — zero residue from either attempt. The service-role
  proxy endpoints above were re-tested AFTER this change specifically to
  confirm they still write successfully (service_role bypasses RLS by
  design — confirmed empirically, not assumed) — real disposable test
  role created and cleaned up post-RLS. `loadPermSystem()` re-verified
  live against the now-RLS-protected tables — real session, 5 roles / 16
  staff_roles entries loaded correctly.
- **`portal_credentials`: RLS is now ON too** (follow-up session, still
  18 Aug 2026). Dropped the dormant `anon_all` policy and enabled RLS in
  the same migration — no replacement policy, full deny for anon on all
  four operations, since the CRM no longer needs any direct access at
  all. Verified with real anon-key requests against production: SELECT
  now returns `[]` (not an error — RLS just filters every row out for
  that role), INSERT returns `42501 row-level security policy`, and a
  targeted UPDATE against one specific real row's `id` returned 200 with
  an empty result (0 rows matched) — confirmed directly that the real
  row's `login_password` was genuinely untouched afterward, not just
  that the response looked right. Service-role proxy re-verified working
  post-RLS.

## SECURITY INCIDENT, found and fixed same night (18 Aug 2026)
While re-verifying `portal_credentials` after enabling its RLS, testing
the real production endpoint against `secret=change-me-please` (the
literal fallback both `ADMIN_WRITE_SECRET` and `VENDOR_CREDS_SECRET`
shipped with) returned **all 80 real `portal_credentials` rows,
plaintext passwords included**, and separately, the same guessed secret
successfully wrote a row to the real `roles` table. Root cause: both
secrets copied `CRON_SECRET`/`COSTING_AUDIT_SECRET`'s
`process.env.X || 'change-me-please'` pattern, but those two have
always had their real Render values set *before* their gated endpoint
ever went live — these two didn't, because the CRM-side deploy (which
depends on the real secret existing) happened before Render's env vars
were configured, and the endpoints themselves were reachable the whole
time with a public, already-committed guessable default.

Found via this repo's own tonight-of-the-fact re-verification, not an
external report. Immediate response: deleted the one test row this
investigation itself created via the guessed secret, confirmed no other
unexpected data existed, shipped a fix within the same session rather
than waiting — fallback changed to `''` for both secrets, so
`SECRET && supplied===SECRET` is false with NO usable value until
Render's real env var is actually set, genuinely failing closed.
Verified post-fix: the same guessed secret, and an explicitly empty
one, both now 401 against all four endpoints.

**Standing lesson, not just a one-off fix**: never give a secret gating
a service-role (RLS-bypassing) endpoint a fallback value that's
non-empty AND already committed to this repo's own history. `''` is the
only fallback that can't be turned into a working credential by reading
this file. `CRON_SECRET`/`COSTING_AUDIT_SECRET` were not changed by this
fix (their real values are confirmed already set in Render — checked
`COSTING_AUDIT_SECRET` directly the same way, `change-me-please`
correctly 401s against `/internal/costing-audit`; `CRON_SECRET` was
deliberately NOT tested this way since a successful guess would trigger
a real mass WhatsApp send, too risky to probe) — but if either is ever
re-deployed to a fresh environment before its Render var is set, the
same exposure window would reopen. Worth migrating both to the `''`
pattern proactively rather than waiting for that to happen for real.
