# escapenfly-ai-proxy

See `CLAUDE.md` for the real architecture notes — this file only tracks the
cron-job.org setup, which didn't exist as a repo doc before this file.

## cron-job.org setup

This service is deployed on Render; cron-job.org is the external scheduler
that hits its `/cron/*` and some `/internal/*` endpoints on a timer (Render's
own Cron Jobs feature isn't used for these — check Render's dashboard
directly if that ever changes).

Every job below sends the shared secret either as `?secret=...` or the
route's own header (see each route's auth function in `server.js`) —
`CRON_SECRET` for `/cron/*` routes, `ADMIN_WRITE_SECRET` for the two
`/internal/*` ones listed here.

### New (16 Sept 2026) — publish-social.js

| Time (IST) | Method | URL | Secret |
|---|---|---|---|
| 09:20 daily | POST | `/internal/team-daily-content` | `ADMIN_WRITE_SECRET` |
| 09:30 daily | POST | `/cron/fb-safety-crosspost` | `CRON_SECRET` |

- **09:20 `team-daily-content`** — runs after Cowork's 09:00 Windsor.ai
  posting run so the WhatsApp message carries today's already-live links.
  Sends every active team member (`team_members.is_active` with a non-null
  `phone`) one AiSensy template message with today's content. Test a single
  number first with `?to=<phone>&dry=1`, then `?to=<phone>` for a real send,
  before ever removing `?dry=1` from the scheduled job.
- **09:30 `fb-safety-crosspost`** — the everyday path is Cowork calling
  `/internal/publish-fb?publish_id=...` itself right after each row posts;
  this cron only catches rows that fell through (Cowork skipped or failed
  the call). It finds today's `marketing_publishes` rows with an `ig:` id
  and no `fb:` id yet and cross-posts each one, capped at
  `PUBLISH_MAX_PER_RUN` (env var, defaults to 20) per run.

Both were verified locally against real production Supabase data with
`?dry=1` (see the PR description for the exact commands and output) — not
yet verified against real Meta/AiSensy credentials, which don't exist in
this environment. Do that with Vineet once this deploys, the same way the
Meta/Google sync endpoints above were signed off.

### Existing cron jobs (schedules per CLAUDE.md / Render's dashboard, not
### independently re-verified when this file was written)

| Route | Purpose |
|---|---|
| `/cron/daily-digest` | ~10am team lead-count digest |
| `/cron/stale-check` | stale-lead alert batch (~4x/day) |
| `/cron/visa-appointments` | visa appointment reminders |
| `/cron/booking-check` | founder booking-confirmation digest (~every 15-30 min) |
| `/cron/eod-summary` | end-of-day summary |
| `/cron/refresh-exchange-rates` | quotation-system FX rate refresh |
| `/cron/visa-intelligence-refresh` | monthly `visa_intelligence` refresh |

If you're touching cron-job.org's dashboard for any of these, confirm the
actual configured schedule there first — this table is a pointer to what
exists, not a guaranteed-current mirror of cron-job.org's own settings.
