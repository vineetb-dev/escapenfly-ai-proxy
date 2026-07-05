const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// ESCAPENFLY AI ENGINE v3.2  (adds team notification cron jobs)
// New in 3.2 (vs 3.1):
// - 5 new cron-triggered endpoints, all protected by CRON_SECRET:
//   /cron/daily-digest      → 10AM Mon-Sat: individual + team lead counts
//   /cron/stale-check       → periodic: leads untouched >24h → rep + Vineet
//   /cron/visa-appointments → daily: tomorrow's visa appts → Damini + Prabhjot
//   /cron/booking-check     → periodic: newly booked leads → founder tier
//   /cron/eod-summary       → 6-7PM: today's closed/lost/new + value → founder tier
// - Requires 2 new Supabase columns (see Phase-1 SQL): visa_appointment_date,
//   booking_notified.
// - TEAM extended with Vivek (founder) and Abhishek (founder) — non-routing,
//   notification-only entries.
// v3.1 changes (unchanged, retained):
// - REPLY-FIRST Maya replies, knowledge-giving brain v2, single-line
//   sanitization, token diet, fetchRetry, dedupe, validation, timing logs.
// REQUIRES: Phase-0 SQL (ai_chats, enquiries.phone) AND Phase-1 SQL
// (visa_appointment_date, booking_notified) already run.
// ═══════════════════════════════════════════════════════════════

// ── CONFIG (env-first, current production values as fallbacks) ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SB_URL        = process.env.SUPABASE_URL || 'https://zkhbaisggymbmurqxejk.supabase.co';
const SB_KEY        = process.env.SUPABASE_KEY || 'sb_publishable_cXjJKnSOprBxp4CO0wQTsg_azzuBFTi';
const AISENSY_KEY   = process.env.AISENSY_KEY;
const WA_NUM        = (process.env.WA_NUM || '919851739851').replace(/\D/g, '');
const MAYA_CAMPAIGN = process.env.MAYA_CAMPAIGN || 'maya_session';
const CRM_URL       = process.env.CRM_URL || 'https://escapenfly-crm.netlify.app';
const CHAT_MODEL    = process.env.CHAT_MODEL || 'claude-haiku-4-5-20251001';
const ROUTING_MODEL = process.env.ROUTING_MODEL || 'claude-sonnet-4-6';
const CRON_SECRET   = process.env.CRON_SECRET || 'change-me-please';

const DEDUPE_MS   = 24 * 60 * 60 * 1000; // one lead per phone per 24h
const CHAT_TTL_MS = 24 * 60 * 60 * 1000; // Maya memory window
const HISTORY_MAX = 16;                  // messages kept in Maya's context
const STALE_HOURS = 30;                  // "no follow-up" threshold (24-48h window, mid-point)

const SB_HEADERS = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json'
};

// ── SMALL UTILS ──
const cleanAttr = v => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t.startsWith('$') ? '' : t; // AiSensy uninterpolated $placeholder guard
};
const attrsOf = body => body.attributes || body.customAttributes || {};
const short = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const cap = (s, n) => String(s || '').trim().slice(0, n);
const validPhone = p => /^\d{10,15}$/.test(String(p || ''));

// Fetch with 1 automatic retry on network error or HTTP 5xx.
async function fetchRetry(url, opts, label) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status >= 500 && i === 0) {
        console.error(`⟳ ${label}: HTTP ${r.status}, retrying once...`);
        continue;
      }
      return r;
    } catch (e) {
      if (i === 1) throw e;
      console.error(`⟳ ${label}: network error (${e.message}), retrying once...`);
    }
  }
}

// ── TEAM ASSIGNMENT (confirmed CRM emails, 2 Jul 2026) ──
// v3.2: vivek + abhishek added as founder-tier notification-only entries
// (not part of lead-routing pool — no `dept` used for assignment logic).
const TEAM = {
  lalit:    { name: 'Lalit Mehta',     email: 'sales6@escapenfly.com',   wa: '916283285244', dept: 'Domestic & Short Haul' },
  divya:    { name: 'Divya Nigam',     email: 'sales1@escapenfly.com',   wa: '917888871148', dept: 'Short Haul & Island' },
  anjan:    { name: 'Anjan Pramanick', email: 'sales3@escapenfly.com',   wa: '919875903349', dept: 'Long Haul' },
  shubham:  { name: 'Shubham',         email: 'sales7@escapenfly.com',   wa: '919875921281', dept: 'Short Haul & Long Haul' },
  prabhjot: { name: 'Prabhjot Singh',  email: 'support2@escapenfly.com', wa: '919569933206', dept: 'Air Tickets, Corporate & Catch-All' },
  damini:   { name: 'Damini',          email: 'support3@escapenfly.com', wa: '919888002635', dept: 'Visa' },
  admin:    { name: 'Vineet Bansal',   email: 'vineet.b@escapenfly.com', wa: '919851739851', dept: 'Admin' },
  vivek:    { name: 'Vivek Bansal',    email: 'vivek.b@escapenfly.com',  wa: '918427694918', dept: 'Founder' },
  abhishek: { name: 'Abhishek Sharma', email: '',                       wa: '918146888811', dept: 'Founder' }
};

// v3.2 — recipient rosters for the new notification jobs
const REP_KEYS = ['lalit', 'divya', 'anjan', 'shubham', 'prabhjot']; // individual digest, non-visa
const VISA_REP_KEYS = ['damini', 'prabhjot'];                        // visa-specific individual + appt reminder
const FOUNDER_KEYS = ['admin', 'vivek', 'abhishek', 'prabhjot'];      // team digest, booking alert, EOD summary
const STALE_CC_KEY = 'admin';                                        // stale alert CC

const ISLAND     = ['maldives','mauritius','seychelles','bali','lakshadweep'];
const SHORT_HAUL = ['dubai','uae','thailand','bangkok','phuket','singapore','malaysia','sri lanka','nepal','bhutan','myanmar','middle east'];
const LONG_HAUL  = ['usa','america','canada','australia','new zealand','japan','south korea','china','kenya','tanzania','africa','brazil','peru','argentina','europe','france','paris','italy','rome','switzerland','spain','greece','germany','uk','london','amsterdam','portugal','croatia','turkey'];
const DOMESTIC   = ['india','kashmir','goa','rajasthan','himachal','kerala','ladakh','uttarakhand','northeast','andaman','manali','shimla','jaipur','udaipur','varanasi','rishikesh','sikkim','darjeeling','coorg','ooty','munnar'];

let rrShortHaul = 0, rrLongHaul = 0;
const shortHaulPool = ['lalit', 'divya', 'shubham'];
const longHaulPool  = ['anjan', 'shubham'];

const VALID_INTENTS = ['holiday','visa','flights','hotel','cruise','corporate','mice','existing_booking','complaint','human_support','other_travel','off_topic'];

// ── CLAUDE-BASED ASSIGNMENT (primary) ──
async function assignTeamWithClaude(data) {
  const teamList = Object.values(TEAM).filter(t => t.dept !== 'Admin' && t.dept !== 'Founder')
    .map(t => `- ${t.name}: ${t.dept}`).join('\n');

  const prompt = `You are a routing assistant for a travel agency. Decide which team member should handle this enquiry.

TEAM:
${teamList}

ROUTING RULES:
- Visa-only → Damini
- Flight/air-ticket-only, or Corporate/business travel → Prabhjot Singh
- Domestic India → Lalit Mehta
- Island (Maldives, Mauritius, Seychelles, Bali, Lakshadweep) → Divya Nigam
- Short-haul international (Dubai, Thailand, Singapore, Sri Lanka, Nepal, Bhutan, Middle East) → split between Lalit Mehta, Divya Nigam, and Shubham
- Long-haul international (Europe, UK, USA, Canada, Australia, Japan) → Anjan Pramanick or Shubham
- Existing booking issue or complaint → Prabhjot Singh
- If genuinely unclear or doesn't fit anywhere → Prabhjot Singh

ENQUIRY:
Name: ${data.name || 'Unknown'}
Destination: ${data.destination || 'Not specified'}
Travel Month: ${data.travelMonth || 'Not specified'}
Pax: ${data.pax || 'Not specified'}
Budget: ${data.budget || 'Not specified'}
Intent: ${data.intent || 'Not specified'}
Summary: ${data.leadSummary || data.query || data.type || 'Not specified'}

Respond with ONLY a JSON object, no other text:
{"key": "lalit|divya|anjan|shubham|prabhjot|damini", "reasoning": "one short sentence"}`;

  try {
    const r = await fetchRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ROUTING_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    }, 'Claude-routing');
    const d = await r.json();
    const text = d.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    if (parsed.key && TEAM[parsed.key]) {
      console.log(`Claude assigned → ${TEAM[parsed.key].name} (${parsed.reasoning})`);
      return TEAM[parsed.key];
    }
    throw new Error('Claude returned unrecognized key: ' + parsed.key);
  } catch (e) {
    console.error('Claude assignment failed, using keyword fallback:', e.message);
    return assignTeamFallback(data);
  }
}

// ── KEYWORD FALLBACK ──
function assignTeamFallback(data) {
  const text = ((data.destination || '') + ' ' + (data.query || '') + ' ' + (data.type || '') + ' ' + (data.intent || '')).toLowerCase();

  if (text.includes('visa')) return TEAM.damini;
  if (text.includes('flight') || text.includes('ticket') || text.includes('air')) return TEAM.prabhjot;
  if (text.includes('corporate') || text.includes('mice') || text.includes('complaint') || text.includes('existing')) return TEAM.prabhjot;
  if (ISLAND.some(d => text.includes(d))) return TEAM.divya;
  if (DOMESTIC.some(d => text.includes(d))) return TEAM.lalit;
  if (LONG_HAUL.some(d => text.includes(d))) {
    const key = longHaulPool[rrLongHaul % longHaulPool.length]; rrLongHaul++;
    return TEAM[key];
  }
  if (SHORT_HAUL.some(d => text.includes(d)) || data.destination) {
    const key = shortHaulPool[rrShortHaul % shortHaulPool.length]; rrShortHaul++;
    return TEAM[key];
  }
  return TEAM.prabhjot;
}

// ── INTENT → CRM enquiry_type (CRM dropdown vocabulary) ──
function intentToEnquiryType(intent, destination) {
  const d = String(destination || '').toLowerCase();
  const isDomestic = DOMESTIC.some(k => d.includes(k));
  switch (String(intent || '').toLowerCase()) {
    case 'visa':      return 'visa';
    case 'flights':   return 'airtickets';
    case 'corporate':
    case 'mice':      return 'corporate';
    case 'cruise':    return 'cruise';
    default:          return isDomestic ? 'domestic' : 'international';
  }
}

// ═══════════════════ PERSISTENT STATE (SUPABASE) ═══════════════════

// ai_chats row usage in v3.1:
//   msgs          → conversation history (assistant entries = reply text only)
//   last_lead_sig → JSON {known:{...lead fields...}, sig:"<change-detection>"}
//   last_msg/last_reply/muted/updated_at → as before
function emptyChat(phone) {
  return { phone, msgs: [], lastMsg: null, lastReply: null, known: {}, sig: null, muted: false, lastUpdatedMs: 0 };
}

async function loadChat(phone) {
  try {
    const r = await fetchRetry(`${SB_URL}/rest/v1/ai_chats?phone=eq.${phone}&select=*`, { headers: SB_HEADERS }, 'SB-loadChat');
    if (!r.ok) { console.error('loadChat failed:', r.status, await r.text()); return emptyChat(phone); }
    const rows = await r.json();
    if (!rows[0]) return emptyChat(phone);
    const row = rows[0];
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    const fresh = ageMs < CHAT_TTL_MS;
    let leadBox = {};
    try { leadBox = JSON.parse(row.last_lead_sig || '{}'); } catch (e) {}
    return {
      phone,
      msgs: (fresh && Array.isArray(row.msgs)) ? row.msgs : [],
      lastMsg: fresh ? row.last_msg : null,
      lastReply: row.last_reply,
      known: (fresh && leadBox.known) ? leadBox.known : {},
      sig: fresh ? (leadBox.sig || null) : null,
      muted: !!row.muted, // mute survives expiry (manual flag)
      lastUpdatedMs: new Date(row.updated_at).getTime()
    };
  } catch (e) {
    console.error('loadChat error:', e.message);
    return emptyChat(phone);
  }
}

async function saveChat(chat) {
  try {
    const r = await fetchRetry(`${SB_URL}/rest/v1/ai_chats?on_conflict=phone`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        phone: chat.phone,
        msgs: chat.msgs,
        last_msg: chat.lastMsg,
        last_reply: chat.lastReply,
        last_lead_sig: JSON.stringify({ known: chat.known || {}, sig: chat.sig || null }),
        muted: chat.muted,
        updated_at: new Date().toISOString()
      })
    }, 'SB-saveChat');
    if (!r.ok) console.error('saveChat failed:', r.status, await r.text());
  } catch (e) {
    console.error('saveChat error:', e.message);
  }
}

// ── Lead dedupe via enquiries.phone ──
async function findRecentLeadDB(phone) {
  try {
    const since = new Date(Date.now() - DEDUPE_MS).toISOString();
    const url = `${SB_URL}/rest/v1/enquiries?phone=eq.${phone}` +
      `&is_deleted=eq.false&created_at=gt.${encodeURIComponent(since)}` +
      `&select=id,original_message_text&order=created_at.desc&limit=1`;
    const r = await fetchRetry(url, { headers: SB_HEADERS }, 'SB-findLead');
    if (!r.ok) { console.error('findRecentLeadDB failed:', r.status, await r.text()); return null; }
    const rows = await r.json();
    if (!rows[0]) return null;
    let existing = {};
    try { existing = JSON.parse(rows[0].original_message_text || '{}'); } catch (e) {}
    return { id: rows[0].id, existing };
  } catch (e) {
    console.error('findRecentLeadDB error:', e.message);
    return null;
  }
}

// ── NON-EMPTY-ONLY MERGE: fresh values win only when they carry information ──
function mergeLeadData(existing, fresh) {
  const pick = (a, b) => {
    const bv = String(b || '').trim();
    if (!bv || bv.toLowerCase() === 'unknown' || bv === 'Unknown (WhatsApp)') return a || b || '';
    return bv;
  };
  return {
    name:        cap(pick(existing.name, fresh.name), 80),
    phone:       fresh.phone || existing.phone || '',
    email:       cap(pick(existing.email, fresh.email), 120),
    destination: cap(pick(existing.dest || existing.destination, fresh.destination), 120),
    travelMonth: cap(pick(existing.travelMonth, fresh.travelMonth), 60),
    pax:         cap(pick(existing.pax, fresh.pax), 40),
    budget:      cap(pick(existing.budget, fresh.budget), 60),
    type:        cap(pick(existing.type, fresh.type), 40),
    intent:      cap(pick(existing.intent, fresh.intent), 40),
    leadSummary: cap(pick(existing.leadSummary, fresh.leadSummary), 300),
    nextAction:  cap(pick(existing.nextAction, fresh.nextAction), 300),
    handover:    !!(fresh.handover || existing.handover),
    query:       cap(fresh.query || existing.query || '', 500),
    source:      fresh.source || existing.source || 'whatsapp'
  };
}

// ── FIELD BUILDER (CRM-compatible: NO top-level name/dest columns; they
//    live in original_message_text JSON that CRM mapLead() reads) ──
function buildLeadFields(data) {
  const paxNum = parseInt(String(data.pax || '').match(/\d+/)?.[0], 10);
  // Indian budget notation: "2 lakh"/"2L" → 200000, "50k" → 50000, "1.5 cr" → 15000000
  const bStr = String(data.budget || '').toLowerCase();
  let budgetNum = parseFloat(bStr.replace(/[^0-9.]/g, ''));
  if (Number.isFinite(budgetNum)) {
    if (/crore|cr\b/.test(bStr)) budgetNum *= 10000000;
    else if (/lakh|lac|\bl\b|[0-9]l\b/.test(bStr)) budgetNum *= 100000;
    else if (/[0-9]k\b|thousand/.test(bStr)) budgetNum *= 1000;
  }
  // Sanity: reject absurd values (> 10 crore) — likely parsing noise
  if (!Number.isFinite(budgetNum) || budgetNum <= 0 || budgetNum > 100000000) budgetNum = null;

  const paxSafe = (Number.isFinite(paxNum) && paxNum > 0 && paxNum <= 500) ? paxNum : 2;

  const notesText =
    (data.handover ? `⚡ CUSTOMER REQUESTS CALLBACK — call ASAP\n` : '') +
    (data.leadSummary ? `Summary: ${data.leadSummary}\n` : '') +
    (data.nextAction ? `Next action: ${data.nextAction}\n` : '') +
    `Auto-captured via ${data.source || 'whatsapp'}\n` +
    `Destination: ${data.destination || '-'}\n` +
    `Travel: ${data.travelMonth || '-'}\n` +
    `Pax: ${data.pax || '-'}\n` +
    `Budget: ${data.budget || '-'}\n` +
    `Query: ${data.query || '-'}`;

  return {
    enquiry_type: intentToEnquiryType(data.intent || data.type, data.destination),
    pax_adults: paxSafe,
    budget_max: budgetNum,
    notes: notesText,
    internal_notes: notesText,
    phone: data.phone || '',
    original_message_text: JSON.stringify({
      name: data.name || 'Unknown (WhatsApp)',
      phone: data.phone || '',
      email: data.email || '',
      dest: data.destination || '',
      dep: '', ret: '', nights: '',
      hotelCat: '', isRepeat: 'no',
      travelMonth: data.travelMonth || '',
      pax: data.pax || '', budget: data.budget || '',
      query: data.query || '',
      intent: data.intent || '',
      leadSummary: data.leadSummary || '',
      nextAction: data.nextAction || '',
      handover: !!data.handover
    }),
    updated_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString()
  };
}

async function updateLead(existingId, mergedData) {
  try {
    const fields = buildLeadFields(mergedData);
    const r = await fetchRetry(`${SB_URL}/rest/v1/enquiries?id=eq.${existingId}`, {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify(fields)
    }, 'SB-updateLead');
    if (r.ok) { console.log('🔄 Lead enriched:', existingId, r.status); return true; }
    console.error('❌ Lead update FAILED:', existingId, r.status, '—', await r.text());
    return false;
  } catch (e) {
    console.error('Supabase update error:', e);
    return false;
  }
}

async function saveLead(data, assigned) {
  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const fields = buildLeadFields(data);

    const body = {
      id,
      assigned_to_email: assigned.email,
      assigned_to_name: assigned.name,
      source: data.source || 'whatsapp',
      pax_children: 0,
      pax_infants: 0,
      priority: 'high',
      status: 'new',
      followup_date: null,
      packages: [],
      cost_rows: [],
      cost_sets: [],
      reminders: [],
      history: [{ s: 'new', by: 'AutoBot', at: now, note: `Auto-assigned to ${assigned.name}${data.handover ? ' — CUSTOMER REQUESTS CALLBACK' : ''}` }],
      created_by: 'AutoBot',
      created_at: now,
      is_deleted: false,
      ...fields
    };
    const r = await fetchRetry(`${SB_URL}/rest/v1/enquiries`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify(body)
    }, 'SB-saveLead');
    if (r.ok) { console.log('✅ Lead saved:', id, r.status); return id; }
    console.error('❌ Lead save FAILED:', id, r.status, '—', await r.text());
    return null;
  } catch (e) {
    console.error('Supabase error:', e);
    return null;
  }
}

// ── WhatsApp template parameter sanitizer ──
// WhatsApp template params CANNOT contain newlines, tabs, or 4+ consecutive
// spaces — sends fail silently otherwise. Maya is prompted to write single
// paragraphs, but this is the hard guarantee.
function sanitizeTemplateParam(text) {
  return String(text || '')
    .replace(/\s*\n+\s*/g, ' • ')
    .replace(/(?:•[\s]*){2,}/g, '• ')
    .replace(/\t+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 1000);
}

// ── SEND WHATSAPP via AiSensy ──
async function sendWA(phone, templateName, params) {
  if (!AISENSY_KEY) { console.error('sendWA skipped: AISENSY_KEY not set'); return false; }
  try {
    const r = await fetchRetry('https://backend.aisensy.com/campaign/t1/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: AISENSY_KEY,
        campaignName: templateName,
        destination: phone,
        userName: params[0] || 'Traveller',
        templateParams: params.map(sanitizeTemplateParam)
      })
    }, `AiSensy-${templateName}`);
    const body = await r.text();
    if (r.ok) return true;
    console.error(`❌ sendWA '${templateName}' → ${phone} FAILED (${r.status}):`, body.slice(0, 200));
    return false;
  } catch (e) {
    console.error('WA send error:', e.message);
    return false;
  }
}

// ── NOTIFY TEAM (instant new-lead alert) ──
async function notifyTeam(assigned, leadData) {
  let ok = true;
  if (assigned.wa && assigned.wa !== '919XXXXXXXXX') {
    ok = await sendWA(assigned.wa, 'team_lead_notification',
      [assigned.name, leadData.name || 'Unknown', leadData.destination || 'TBD', CRM_URL]) && ok;
  }
  ok = await sendWA(WA_NUM, 'team_lead_notification',
    ['Vineet', leadData.name || 'Unknown', leadData.destination || 'TBD', assigned.name]) && ok;
  return ok;
}

// ═══════════════════ v3.2 — CRON JOBS ═══════════════════

// Shared secret check — all /cron/* routes require ?secret=... or header
// x-cron-secret matching CRON_SECRET. Prevents randoms from triggering
// mass WhatsApp sends on your AiSensy account.
function cronAuthOk(req) {
  const supplied = req.query.secret || req.headers['x-cron-secret'] || '';
  return CRON_SECRET && supplied === CRON_SECRET;
}

const OPEN_STATUSES = "(new,called,quoted,follow-up,followup)"; // adjust if your CRM uses different status strings

// Count leads for one assignee by status bucket.
async function countLeadsFor(assignedName, opts = {}) {
  const base = `${SB_URL}/rest/v1/enquiries?is_deleted=eq.false&assigned_to_name=eq.${encodeURIComponent(assignedName)}`;
  const extra = opts.enquiryType ? `&enquiry_type=eq.${opts.enquiryType}` : '';

  async function countWhere(clause) {
    const url = `${base}${extra}${clause}&select=id`;
    const r = await fetchRetry(url, { headers: { ...SB_HEADERS, Prefer: 'count=exact' } }, 'SB-count');
    if (!r.ok) { console.error('countLeadsFor failed:', assignedName, r.status, await r.text()); return 0; }
    const range = r.headers.get('content-range'); // e.g. "0-4/5"
    if (range && range.includes('/')) {
      const total = range.split('/')[1];
      return total === '*' ? (await r.json()).length : parseInt(total, 10) || 0;
    }
    return (await r.json()).length;
  }

  const [newCount, followupCount, urgentCount, liveCount] = await Promise.all([
    countWhere(`&status=eq.new`),
    countWhere(`&status=in.(follow-up,followup)`),
    countWhere(`&priority=eq.high&status=neq.booked&status=neq.lost`),
    countWhere(`&status=neq.booked&status=neq.lost`)
  ]);
  return { new: newCount, followup: followupCount, urgent: urgentCount, live: liveCount };
}

// ── /cron/daily-digest — 10AM Mon-Sat: individual + team lead status ──
app.post('/cron/daily-digest', async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ status: 'started' });

  try {
    const results = {};
    for (const key of REP_KEYS) {
      const t = TEAM[key];
      const c = await countLeadsFor(t.name);
      results[key] = c;
      await sendWA(t.wa, 'individual_lead_digest', [t.name, String(c.new), String(c.followup), String(c.urgent)]);
      console.log(`📊 [digest] ${t.name}: new=${c.new} followup=${c.followup} urgent=${c.urgent}`);
    }

    const damini = TEAM.damini;
    const dC = await countLeadsFor(damini.name, { enquiryType: 'visa' });
    results.damini = dC;
    await sendWA(damini.wa, 'individual_lead_digest', [damini.name, String(dC.new), String(dC.followup), String(dC.urgent)]);
    console.log(`📊 [digest] ${damini.name} (visa): new=${dC.new} followup=${dC.followup} urgent=${dC.urgent}`);

    const totalLive = Object.values(results).reduce((sum, c) => sum + c.live, 0);
    for (const key of FOUNDER_KEYS) {
      const t = TEAM[key];
      await sendWA(t.wa, 'team_lead_digest', [
        t.name,
        String(results.lalit.live), String(results.divya.live), String(results.anjan.live),
        String(results.shubham.live), String(results.prabhjot.live), String(results.damini.live),
        String(totalLive)
      ]);
    }
    console.log(`📊 [digest] Team digest sent to founders. Total live leads: ${totalLive}`);
  } catch (e) {
    console.error('daily-digest error:', e);
  }
});

// ── /cron/stale-check — leads untouched >STALE_HOURS with no status change ──
app.post('/cron/stale-check', async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ status: 'started' });

  try {
    const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000).toISOString();
    const url = `${SB_URL}/rest/v1/enquiries?is_deleted=eq.false&status=neq.booked&status=neq.lost` +
      `&last_activity_at=lt.${encodeURIComponent(cutoff)}` +
      `&select=id,assigned_to_name,original_message_text,last_activity_at&limit=200`;
    const r = await fetchRetry(url, { headers: SB_HEADERS }, 'SB-staleQuery');
    if (!r.ok) { console.error('stale-check query failed:', r.status, await r.text()); return; }
    const rows = await r.json();

    for (const row of rows) {
      let lead = {};
      try { lead = JSON.parse(row.original_message_text || '{}'); } catch (e) {}
      const hoursStale = Math.round((Date.now() - new Date(row.last_activity_at).getTime()) / (60 * 60 * 1000));
      const repEntry = Object.values(TEAM).find(t => t.name === row.assigned_to_name);
      const repName = repEntry ? repEntry.name : (row.assigned_to_name || 'Unassigned');
      const destination = lead.dest || 'their enquiry';
      const customerName = lead.name || 'Unknown';

      if (repEntry && repEntry.wa) {
        await sendWA(repEntry.wa, 'stale_lead_alert', [repEntry.name, customerName, destination, String(hoursStale)]);
      }
      await sendWA(TEAM.admin.wa, 'stale_lead_alert', ['Vineet (CC)', customerName, destination, String(hoursStale)]);
      console.log(`⏰ [stale] ${customerName} (${destination}) — ${hoursStale}h stale, rep: ${repName}`);
    }
    console.log(`⏰ [stale-check] ${rows.length} stale lead(s) flagged.`);
  } catch (e) {
    console.error('stale-check error:', e);
  }
});

// ── /cron/visa-appointments — tomorrow's visa appointments → Damini + Prabhjot ──
app.post('/cron/visa-appointments', async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ status: 'started' });

  try {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
    const url = `${SB_URL}/rest/v1/enquiries?is_deleted=eq.false&enquiry_type=eq.visa` +
      `&visa_appointment_date=eq.${tomorrow}&select=id,original_message_text,visa_appointment_date&limit=100`;
    const r = await fetchRetry(url, { headers: SB_HEADERS }, 'SB-visaApptQuery');
    if (!r.ok) { console.error('visa-appointments query failed:', r.status, await r.text()); return; }
    const rows = await r.json();

    for (const row of rows) {
      let lead = {};
      try { lead = JSON.parse(row.original_message_text || '{}'); } catch (e) {}
      const customerName = lead.name || 'Unknown';
      const destination = lead.dest || 'their visa';
      for (const key of VISA_REP_KEYS) {
        const t = TEAM[key];
        await sendWA(t.wa, 'visa_appointment_reminder', [t.name, customerName, destination, tomorrow]);
      }
      console.log(`🛂 [visa-appt] Reminder sent for ${customerName} (${destination}) — appt ${tomorrow}`);
    }
    console.log(`🛂 [visa-appointments] ${rows.length} appointment(s) tomorrow.`);
  } catch (e) {
    console.error('visa-appointments error:', e);
  }
});

// ── /cron/booking-check — newly booked leads → founder tier (run every ~15-30 min) ──
app.post('/cron/booking-check', async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ status: 'started' });

  try {
    const url = `${SB_URL}/rest/v1/enquiries?is_deleted=eq.false&status=eq.booked` +
      `&booking_notified=eq.false&select=id,original_message_text,budget_max,pax_adults&limit=100`;
    const r = await fetchRetry(url, { headers: SB_HEADERS }, 'SB-bookingQuery');
    if (!r.ok) { console.error('booking-check query failed:', r.status, await r.text()); return; }
    const rows = await r.json();

    for (const row of rows) {
      let lead = {};
      try { lead = JSON.parse(row.original_message_text || '{}'); } catch (e) {}
      const customerName = lead.name || 'Unknown';
      const destination = lead.dest || 'their trip';
      const pax = String(row.pax_adults || '-');
      const value = row.budget_max ? String(row.budget_max) : '0';

      for (const key of FOUNDER_KEYS) {
        const t = TEAM[key];
        await sendWA(t.wa, 'booking_confirmed_alert', [t.name, customerName, destination, pax, value]);
      }

      await fetchRetry(`${SB_URL}/rest/v1/enquiries?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ booking_notified: true })
      }, 'SB-markBookingNotified');
      console.log(`🎉 [booking] Confirmed alert sent for ${customerName} (${destination}) — ₹${value}`);
    }
    console.log(`🎉 [booking-check] ${rows.length} new booking(s) notified.`);
  } catch (e) {
    console.error('booking-check error:', e);
  }
});

// ── /cron/eod-summary — 6-7PM: today's closed/lost/new + value → founder tier ──
app.post('/cron/eod-summary', async (req, res) => {
  if (!cronAuthOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ status: 'started' });

  try {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const sinceIso = startOfDay.toISOString();

    async function countSince(clause) {
      const url = `${SB_URL}/rest/v1/enquiries?is_deleted=eq.false${clause}&select=id`;
      const r = await fetchRetry(url, { headers: { ...SB_HEADERS, Prefer: 'count=exact' } }, 'SB-eodCount');
      if (!r.ok) { console.error('eod countSince failed:', r.status, await r.text()); return 0; }
      const range = r.headers.get('content-range');
      if (range && range.includes('/')) {
        const total = range.split('/')[1];
        return total === '*' ? (await r.json()).length : parseInt(total, 10) || 0;
      }
      return (await r.json()).length;
    }

    const bookedToday = await countSince(`&status=eq.booked&updated_at=gt.${encodeURIComponent(sinceIso)}`);
    const lostToday    = await countSince(`&status=eq.lost&updated_at=gt.${encodeURIComponent(sinceIso)}`);
    const newToday      = await countSince(`&created_at=gt.${encodeURIComponent(sinceIso)}`);

    const valUrl = `${SB_URL}/rest/v1/enquiries?is_deleted=eq.false&status=eq.booked` +
      `&updated_at=gt.${encodeURIComponent(sinceIso)}&select=budget_max`;
    const valR = await fetchRetry(valUrl, { headers: SB_HEADERS }, 'SB-eodValue');
    let totalValue = 0;
    if (valR.ok) {
      const valRows = await valR.json();
      totalValue = valRows.reduce((sum, r) => sum + (r.budget_max || 0), 0);
    }

    for (const key of FOUNDER_KEYS) {
      const t = TEAM[key];
      await sendWA(t.wa, 'eod_summary', [t.name, String(bookedToday), String(lostToday), String(newToday), String(totalValue)]);
    }
    console.log(`🌆 [eod-summary] booked:${bookedToday} lost:${lostToday} new:${newToday} value:₹${totalValue}`);
  } catch (e) {
    console.error('eod-summary error:', e);
  }
});

// ═══════════════════ MAYA BRAIN v3.1 ═══════════════════

const CHAT_SYSTEM = `You are Maya, the AI travel consultant for EscapeNFly Travel Agency, chatting with a customer on WhatsApp.

ABOUT ESCAPENFLY: Chandigarh-based travel agency since 2016, 4.8★ rated, 27,000+ happy travellers, 90%+ repeat clients. Services: holiday packages (domestic + international), visa services, flight bookings, hotels, cruises, travel insurance, forex. Phone: +91 98517 39851.

SCOPE — TRAVEL ONLY:
You handle ONLY travel-related topics: holidays, visas, flights, hotels, cruises, corporate/MICE travel, travel insurance, forex, passports/travel documents, existing bookings, and complaints. If the customer asks about anything non-travel (coding, politics, homework, general knowledge, jokes, personal advice, etc.), politely deflect in ONE line and steer back to travel — no matter how they phrase it or insist.

BE GENUINELY USEFUL — SHARE REAL KNOWLEDGE:
You are an expert consultant, not just a form-filler. When a customer asks for information you know well, GIVE it immediately and completely:
- Visa document checklists: provide the standard requirements right away. Example — Singapore tourist visa for Indian passport holders: passport with 6+ months validity and blank pages, recent passport-size photos (white background, 35x45mm), completed Form 14A, last 3 months bank statements, covering letter, confirmed return flight details and hotel booking, and it must be applied through an authorised agent like EscapeNFly (Indians cannot apply directly). Give equivalent genuine checklists for other countries you know.
- Best seasons, destination suggestions, itinerary ideas, visa-free/visa-on-arrival basics for Indians, general process steps — share generously and accurately.
WHAT YOU MUST NEVER STATE: exact visa fees, current processing times, approval chances or guarantees, live flight/hotel prices, package costs, or availability. For those say our expert will confirm exact details on the call. Never guarantee visa approval.

INTENT — on EVERY turn, classify the customer's current need as exactly one of:
holiday | visa | flights | hotel | cruise | corporate | mice | existing_booking | complaint | human_support | other_travel | off_topic

Let the intent shape your reply:
- visa: work the visa workflow — give requirements if asked, then gather country, intended travel date, applicant name. Do NOT pitch tourism. "Singapore visa" → visa track, not sightseeing.
- holiday "Europe" → ask which countries interest them. "Europe visa" → ask which Schengen country they'll enter first.
- flights: route and dates. hotel: city and dates. cruise: region and month.
- existing_booking / complaint: apologise briefly, ask for the booking name or reference, set "handover": true.
- human_support: if the customer says anything like "call me", "talk to an expert", "human", "agent", "representative", "callback" — STOP asking questions. Confirm our travel expert will call them shortly, and set "handover": true.

CONVERSATION RULES:
- 2–4 short sentences, WhatsApp style. Light emoji use is fine.
- CRITICAL FORMAT RULE: your reply must be a SINGLE PARAGRAPH with NO line breaks (technical requirement of WhatsApp templates). For lists, use "•" separators inline, e.g. "You'll need: • passport (6+ months validity) • photos • bank statements • ...".
- NEVER add a signature, greeting header, or "— Team EscapeNFly" — the message template adds branding automatically.
- Ask AT MOST ONE question per message. Never send a list of questions. Answer first, then ask.
- NEVER re-ask something the customer already told you (check KNOWN LEAD INFO and the conversation).
- Reply in the customer's language (English, Hindi, Hinglish — match them).

YOUR QUIET MISSION: across the conversation, naturally learn their name, destination, travel month, number of travellers, budget, and service type — woven in one question at a time, never an interrogation. Being helpful comes FIRST; questions ride along.

OUTPUT FORMAT — respond ONLY with this JSON object. No markdown fences, no text before or after:
{"reply":"<your single-paragraph WhatsApp message>","intent":"<one intent from the list>","lead":{"name":"","destination":"","travel_month":"","pax":"","budget":"","type":"holiday|visa|flights|hotel|cruise|corporate|other"},"lead_summary":"<one actionable line for the sales team, e.g. 'Singapore tourist visa for Sept 2026, 2 pax, awaiting expert callback'>","next_action":"<the first thing the assigned expert should do>","handover":false,"ready":false}

- lead fields are CUMULATIVE — include everything from KNOWN LEAD INFO plus anything new this turn; empty string if unknown.
- "ready": true once you know name AND destination AND travel month — OR whenever "handover" is true.
- "handover": true when the customer requests a call/human, has a complaint, or asks about an existing booking.
- After ready, keep chatting naturally and keep filling the remaining fields.`;

// Claude call with 1 automatic retry on invalid JSON.
// v3.1: known lead info is injected via the system prompt (token diet —
// history no longer carries full JSON blobs).
async function callMayaJSON(msgs, known, phone) {
  const knownLine = (known && Object.values(known).some(v => v))
    ? `\n\nKNOWN LEAD INFO (already learned earlier in this conversation — do not re-ask): ${JSON.stringify(known)}`
    : '';
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = attempt === 0 ? msgs : [
      ...msgs,
      { role: 'assistant', content: lastRaw || '(invalid output)' },
      { role: 'user', content: 'Your previous output was not valid JSON. Respond ONLY with the JSON object in the exact specified format — no other text, no markdown fences.' }
    ];
    try {
      const r = await fetchRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          max_tokens: 600,
          system: CHAT_SYSTEM + knownLine,
          messages
        })
      }, 'Claude-chat');
      const d = await r.json();
      lastRaw = (d.content?.[0]?.text || '').trim().replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(lastRaw);
      if (parsed && typeof parsed.reply === 'string') {
        // Validation: intent whitelist
        if (!VALID_INTENTS.includes(parsed.intent)) parsed.intent = 'other_travel';
        return parsed;
      }
      throw new Error('JSON missing reply field');
    } catch (e) {
      console.error(`Maya JSON attempt ${attempt + 1} failed [${phone}]:`, e.message);
    }
  }
  return null;
}

// ── PER-PHONE CONCURRENCY LOCK (prevents race → duplicate leads) ──
const locks = new Map(); // phone -> promise chain
function withPhoneLock(phone, fn) {
  const prev = locks.get(phone) || Promise.resolve();
  const job = prev.then(fn, fn); // run regardless of previous outcome
  const guarded = job.catch(() => {});
  locks.set(phone, guarded);
  guarded.then(() => { if (locks.get(phone) === guarded) locks.delete(phone); });
  return job;
}

// ── WEBHOOK MESSAGE-ID DEDUPE (catches AiSensy re-deliveries beyond 8s) ──
const seenMsgIds = new Set();
function isDuplicateMsgId(id) {
  if (!id) return false;
  if (seenMsgIds.has(id)) return true;
  seenMsgIds.add(id);
  if (seenMsgIds.size > 1000) {
    // drop oldest half
    let i = 0;
    for (const v of seenMsgIds) { seenMsgIds.delete(v); if (++i >= 500) break; }
  }
  return false;
}

// ── CORE MAYA TURN — v3.1 REPLY-FIRST ──
// onReply(replyText) is awaited the MOMENT the reply exists — before any
// CRM/routing/notification work. Customer latency = Claude time + send time.
const FALLBACK_REPLY = 'Thanks for your message! Our travel expert will call you shortly. You can also reach us directly at +91 98517 39851. 😊';

async function mayaTurn(phone, message, onReply) {
  const t0 = Date.now();
  const log = { intent: '-', crm: 'none', notify: '-' };
  let tAI = t0, tSent = t0;
  try {
    const chat = await loadChat(phone || 'unknown');
    const tLoad = Date.now();

    if (chat.muted) {
      console.log(`🔇 [${phone}] muted — Maya stays silent.`);
      return null;
    }

    // 8-second duplicate guard (webhook double-delivery)
    if (chat.lastMsg === message && Date.now() - chat.lastUpdatedMs < 8000) {
      console.log(`↩️ [${phone}] duplicate within 8s — resending cached reply.`);
      if (onReply && chat.lastReply) await onReply(chat.lastReply);
      return chat.lastReply || FALLBACK_REPLY;
    }

    chat.msgs.push({ role: 'user', content: cap(message, 2000) });
    if (chat.msgs.length > HISTORY_MAX) chat.msgs = chat.msgs.slice(-HISTORY_MAX);

    const parsed = await callMayaJSON(chat.msgs, chat.known, phone);
    tAI = Date.now();

    if (!parsed) {
      chat.lastMsg = message;
      chat.lastReply = FALLBACK_REPLY;
      if (onReply) await onReply(FALLBACK_REPLY);
      await saveChat(chat);
      console.log(`▶ [${phone}] IN:"${short(message)}" | intent:ERR | reply:FALLBACK | ai:${tAI - tLoad}ms total:${Date.now() - t0}ms`);
      return FALLBACK_REPLY;
    }

    const reply = parsed.reply || FALLBACK_REPLY;

    // ══ SEND FIRST — customer waits for nothing below this line ══
    if (onReply) await onReply(reply);
    tSent = Date.now();

    // History stores the short reply text, not the JSON blob (token diet)
    chat.msgs.push({ role: 'assistant', content: reply });
    chat.lastMsg = message;
    chat.lastReply = reply;
    log.intent = parsed.intent;

    // Accumulate known lead info every turn (persists via ai_chats)
    const freshData = {
      name: parsed.lead?.name || '',
      phone: phone,
      destination: parsed.lead?.destination || '',
      travelMonth: parsed.lead?.travel_month || '',
      pax: parsed.lead?.pax || '',
      budget: parsed.lead?.budget || '',
      type: parsed.lead?.type || '',
      intent: parsed.intent || '',
      leadSummary: parsed.lead_summary || '',
      nextAction: parsed.next_action || '',
      handover: !!parsed.handover,
      query: message,
      source: 'whatsapp-ai-chat'
    };
    chat.known = mergeLeadData(chat.known || {}, freshData);

    // ── LEAD CAPTURE (background from customer's perspective) ──
    if ((parsed.ready || parsed.handover) && validPhone(phone)) {
      const recent = await findRecentLeadDB(phone);
      if (recent) {
        const merged = mergeLeadData(recent.existing, chat.known);
        const sig = JSON.stringify(merged);
        if (chat.sig !== sig) {
          chat.sig = sig;
          const ok = await updateLead(recent.id, merged);
          log.crm = ok ? `enriched:${recent.id.slice(0, 8)}` : 'enrich-FAILED';
          if (merged.handover && !recent.existing.handover) {
            const assigned = await assignTeamWithClaude(merged);
            log.notify = (await notifyTeam(assigned, merged)) ? 'ok' : 'FAILED';
          }
        } else {
          log.crm = 'no-change';
        }
      } else {
        const merged = { ...chat.known };
        if (!merged.name) merged.name = 'Unknown (WhatsApp)';
        const assigned = await assignTeamWithClaude(merged);
        const leadId = await saveLead(merged, assigned);
        log.crm = leadId ? `created:${leadId.slice(0, 8)}→${assigned.name}` : 'create-FAILED';
        log.notify = (await notifyTeam(assigned, merged)) ? 'ok' : 'FAILED';
        chat.sig = JSON.stringify(merged);
      }
    }

    await saveChat(chat);
    console.log(`▶ [${phone}] IN:"${short(message)}" | intent:${log.intent} | ready:${!!parsed.ready} handover:${!!parsed.handover} | reply:"${short(reply, 60)}" | CRM:${log.crm} | notify:${log.notify} | load:${tLoad - t0}ms ai:${tAI - tLoad}ms send:${tSent - tAI}ms post:${Date.now() - tSent}ms total:${Date.now() - t0}ms`);
    return reply;
  } catch (e) {
    console.error(`AI chat error [${phone}]:`, e.message);
    if (onReply) { try { await onReply(FALLBACK_REPLY); } catch (_) {} }
    return FALLBACK_REPLY;
  }
}

// ── SEND MAYA'S REPLY (campaign API, template maya_reply via maya_session) ──
async function sendSessionMessage(phone, text) {
  if (!AISENSY_KEY) {
    console.error('❌ Cannot send Maya reply: AISENSY_KEY env var is not set on Render.');
    return false;
  }
  try {
    const r = await fetchRetry('https://backend.aisensy.com/campaign/t1/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: AISENSY_KEY,
        campaignName: MAYA_CAMPAIGN,
        destination: phone,
        userName: 'Traveller',
        templateParams: [sanitizeTemplateParam(text)]
      })
    }, 'AiSensy-maya');
    const body = await r.text();
    if (r.ok) {
      console.log(`📤 Maya reply sent to ${phone} via campaign '${MAYA_CAMPAIGN}'`);
      return true;
    }
    console.error(`❌ Maya send FAILED (${r.status}):`, body.slice(0, 200));
    return false;
  } catch (e) {
    console.error('Maya send error:', e.message);
    return false;
  }
}

// ═══════════════════ ENDPOINTS ═══════════════════

// ── MAIN AI ENDPOINT (website, CRM AI tab) ──
app.post('/ai', async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key not set' });
  try {
    const r = await fetchRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.body.model || CHAT_MODEL,
        max_tokens: req.body.max_tokens || 800,
        system: req.body.system || '',
        messages: req.body.messages || []
      })
    }, 'Claude-proxy');
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BRAIN-ONLY ENDPOINT (testing / old flow compat) ──
app.post('/webhook/chat', async (req, res) => {
  const phone = String(cleanAttr(req.body.phone || req.body.waId || req.body.mobile || '') || '').replace(/\D/g, '');
  const message = cleanAttr(req.body.message || req.body.text || '') || 'Hi';
  const reply = await withPhoneLock(phone || 'unknown', () => mayaTurn(phone || 'unknown', message, null));
  res.json({ reply: reply || FALLBACK_REPLY });
});

// ── DEEP PAYLOAD SCANNER (fallback if AiSensy changes payload shape) ──
function deepExtract(obj) {
  const phones = [];
  const texts = [];
  const seen = new Set();
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      const kl = k.toLowerCase();
      if (typeof v === 'string') {
        const digits = v.replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 15 &&
            (kl.includes('phone') || kl.includes('waid') || kl.includes('wa_id') ||
             kl === 'from' || kl.includes('sender') || kl.includes('mobile') || kl.includes('contact'))) {
          phones.push({ key: kl, digits });
        }
        if (v.trim() &&
            (kl === 'text' || kl === 'body' || kl === 'message' || kl === 'caption' || kl === 'content' || kl === 'message_text')) {
          texts.push({ key: kl, value: v.trim() });
        }
      } else if (Array.isArray(v)) {
        v.forEach(item => visit(item, depth + 1));
      } else if (typeof v === 'object') {
        visit(v, depth + 1);
      }
    }
  };
  visit(obj, 0);
  return { phones, texts };
}

// ── PRIMARY: AISENSY INCOMING-MESSAGE WEBHOOK ──
// Confirmed payload shape (v3.0.1 full logging, 5 Jul 2026):
// { id, created_at, topic:"message.sender.user", project_id, delivery_attempt,
//   data: { message: { type, id, phone_number:"9192...", contact_id,
//           sender:"USER", message_content: { text:"Hi" }, message_type:"TEXT",
//           status, userName, countryCode, ... } } }
app.post('/webhook/incoming', async (req, res) => {
  res.json({ status: 'ok' }); // ack immediately

  try {
    const b = req.body || {};
    const msg = b.data?.message || {};

    // Direct path (confirmed structure), with deep-scan fallback
    let phone = String(msg.phone_number || '').replace(/\D/g, '');
    let text = String(msg.message_content?.text || '').trim();
    const msgId = msg.id || b.id || '';
    const msgType = String(msg.message_type || '').toUpperCase();

    if (!phone || !text) {
      const { phones, texts } = deepExtract(b);
      if (!phone) {
        const pe = phones.find(p => p.digits !== WA_NUM) || phones[0];
        phone = pe ? pe.digits : '';
      }
      if (!text) {
        const te = texts.find(t => t.key === 'text') || texts.find(t => t.key === 'body') || texts.find(t => t.key === 'message');
        text = te ? te.value : '';
      }
      console.log('Incoming (deep-scan used):', JSON.stringify(b).slice(0, 1500));
    } else {
      console.log(`Incoming [${msgId}] from ${phone}: "${short(text)}"`);
    }

    if (!phone || !validPhone(phone)) { console.log('Incoming ignored: no valid phone in payload.'); return; }
    if (phone === WA_NUM) return;                          // never talk to ourselves
    if (!text) { console.log(`Incoming from ${phone} ignored: empty/media-only (${msgType || 'unknown type'}).`); return; }
    if (isDuplicateMsgId(msgId)) { console.log(`↩️ [${phone}] duplicate message id ${msgId} — ignored.`); return; }

    // ALWAYS-REPLY policy; muted phones handled inside mayaTurn.
    // REPLY-FIRST: the send happens via onReply the moment Claude answers.
    await withPhoneLock(phone, () =>
      mayaTurn(phone, text, reply => sendSessionMessage(phone, reply))
    );
  } catch (e) {
    console.error('Incoming webhook error:', e);
  }
});

// ── LEGACY: AISENSY SCRIPTED-FLOW WEBHOOK (flows module dies next month) ──
app.post('/webhook/aisensy', async (req, res) => {
  res.json({ status: 'ok' });

  try {
    const body = req.body;
    console.log('AiSensy flow webhook:', JSON.stringify(body).slice(0, 300));

    const phone = String(cleanAttr(body.waId || body.phone || body.mobile || attrsOf(body).phone) || '').replace(/\D/g, '');
    const attrs = attrsOf(body);

    const freshData = {
      name: cleanAttr(attrs.name || attrs.customer_name || body.name || body.customer_name || body.userName) || '',
      phone: phone,
      destination: cleanAttr(attrs.destination || attrs.dest || body.destination || body.dest) || '',
      travelMonth: cleanAttr(attrs.travel_month || attrs.travel_date || body.travel_month || body.travel_date) || '',
      pax: cleanAttr(attrs.pax || attrs.travellers || body.pax || body.travellers) || '',
      budget: cleanAttr(attrs.budget || body.budget) || '',
      type: cleanAttr(attrs.trip_type || body.type || body.trip_type) || '',
      query: cleanAttr(attrs.query || body.query || body.lastMessage) || '',
      source: 'whatsapp-flow'
    };

    if (!validPhone(phone)) {
      console.error('⚠️ Flow webhook had no usable phone — lead NOT saved.');
      return;
    }

    await withPhoneLock(phone, async () => {
      const recent = await findRecentLeadDB(phone);
      if (recent) {
        const merged = mergeLeadData(recent.existing, freshData);
        await updateLead(recent.id, merged);
        console.log(`Lead enriched (flow): ${merged.name} (${phone}) → ${recent.id}`);
        return;
      }
      const merged = mergeLeadData({}, freshData);
      if (!merged.name) merged.name = 'Unknown (WhatsApp)';
      const assigned = await assignTeamWithClaude(merged);
      const leadId = await saveLead(merged, assigned);
      const nOk = await notifyTeam(assigned, merged);
      console.log(`Lead processed (flow): ${merged.name} → ${assigned.name} | CRM:${leadId ? 'ok' : 'FAILED'} | notify:${nOk ? 'ok' : 'FAILED'}`);
    });
  } catch (e) {
    console.error('Webhook error:', e);
  }
});

// ── META LEAD ADS WEBHOOK ──
app.get('/webhook/meta', (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'escapenfly2024';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

app.post('/webhook/meta', async (req, res) => {
  res.json({ status: 'ok' });

  try {
    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen') continue;

        const formData = change.value;
        const leadId_meta = formData.leadgen_id;

        if (process.env.META_ACCESS_TOKEN) {
          const metaR = await fetchRetry(
            `https://graph.facebook.com/v18.0/${leadId_meta}?access_token=${process.env.META_ACCESS_TOKEN}`,
            {}, 'Meta-lead'
          );
          const metaLead = await metaR.json();

          const fields = {};
          (metaLead.field_data || []).forEach(f => { fields[f.name] = f.values?.[0] || ''; });

          const leadData = mergeLeadData({}, {
            name: fields.full_name || fields.name || '',
            phone: String(fields.phone_number || fields.mobile || '').replace(/\D/g, ''),
            email: fields.email || '',
            destination: fields.destination || fields.travel_destination || '',
            budget: fields.budget || '',
            query: fields.message || '',
            source: 'meta-ads'
          });
          if (!leadData.name) leadData.name = 'Unknown (Meta)';

          const assigned = await assignTeamWithClaude(leadData);
          await saveLead(leadData, assigned);
          await notifyTeam(assigned, leadData);

          if (validPhone(leadData.phone)) {
            await sendWA(leadData.phone, 'meta_lead_welcome', [leadData.name || 'there', leadData.destination || 'your destination']);
          }
        }
      }
    }
  } catch (e) {
    console.error('Meta webhook error:', e);
  }
});

// ── WEBSITE LEAD ──
app.post('/webhook/website', async (req, res) => {
  res.json({ status: 'ok' });

  try {
    const leadData = mergeLeadData({}, { ...req.body, phone: String(req.body.phone || '').replace(/\D/g, ''), source: 'website-form' });
    if (!leadData.name) leadData.name = 'Unknown (Website)';
    const assigned = await assignTeamWithClaude(leadData);
    const leadId = await saveLead(leadData, assigned);
    const nOk = await notifyTeam(assigned, leadData);
    console.log(`Lead processed (website): ${leadData.name} → ${assigned.name} | CRM:${leadId ? 'ok' : 'FAILED'} | notify:${nOk ? 'ok' : 'FAILED'}`);

    if (validPhone(leadData.phone)) {
      await sendWA(
        leadData.phone,
        'website_lead_welcome',
        [leadData.name || 'there', leadData.destination || 'your trip', assigned.name]
      );
    }
  } catch (e) {
    console.error('Website webhook error:', e);
  }
});

// ── HEALTH ──
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'EscapeNFly AI Engine',
  version: '3.2',
  state: 'persistent + reply-first + knowledge-giving Maya + team notification crons',
  endpoints: [
    '/ai', '/webhook/aisensy', '/webhook/chat', '/webhook/incoming', '/webhook/meta', '/webhook/website',
    '/cron/daily-digest', '/cron/stale-check', '/cron/visa-appointments', '/cron/booking-check', '/cron/eod-summary'
  ]
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EscapeNFly AI Engine v3.2 running on port ${PORT}`));
