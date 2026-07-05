const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// ESCAPENFLY AI ENGINE v3.0  (Phase 0 + Phase 1)
// - Persistent Maya memory in Supabase (ai_chats table) — survives restarts
// - Lead dedupe via enquiries.phone column — survives restarts
// - Always-reply policy (TRIGGER_WORDS gate removed)
// - New Maya brain: travel-only, intent classification, lead_summary,
//   next_action, human handover, one-question-at-a-time, anti-hallucination
// - JSON retry, per-phone concurrency lock, non-empty-only lead merge
// - Structured per-turn logging
// REQUIRES: Phase-0 SQL already run in Supabase (ai_chats table + enquiries.phone)
// ═══════════════════════════════════════════════════════════════

// ── CONFIG ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SB_URL = 'https://zkhbaisggymbmurqxejk.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_cXjJKnSOprBxp4CO0wQTsg_azzuBFTi';
const AISENSY_KEY = process.env.AISENSY_KEY;
const WA_NUM = '919851739851';
const MAYA_CAMPAIGN = process.env.MAYA_CAMPAIGN || 'maya_session';

const DEDUPE_MS = 24 * 60 * 60 * 1000; // one lead per phone per 24h
const CHAT_TTL_MS = 24 * 60 * 60 * 1000; // Maya memory window

const SB_HEADERS = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json'
};

// ── SMALL UTILS (defined FIRST — v2.x had cleanAttr defined after first use) ──
const cleanAttr = v => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t.startsWith('$') ? '' : t; // AiSensy uninterpolated $placeholder guard
};
const attrsOf = body => body.attributes || body.customAttributes || {};
const short = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// ── TEAM ASSIGNMENT (confirmed CRM emails, 2 Jul 2026) ──
const TEAM = {
  lalit:   { name: 'Lalit Mehta',     email: 'sales6@escapenfly.com',   wa: '916283285244', dept: 'Domestic & Short Haul' },
  divya:   { name: 'Divya Nigam',     email: 'sales1@escapenfly.com',   wa: '917888871148', dept: 'Short Haul & Island' },
  anjan:   { name: 'Anjan Pramanick', email: 'sales3@escapenfly.com',   wa: '919875903349', dept: 'Long Haul' },
  shubham: { name: 'Shubham',         email: 'sales7@escapenfly.com',   wa: '919875921281', dept: 'Short Haul & Long Haul' },
  prabhjot:{ name: 'Prabhjot Singh',  email: 'support2@escapenfly.com', wa: '919569933206', dept: 'Air Tickets, Corporate & Catch-All' },
  damini:  { name: 'Damini',          email: 'support3@escapenfly.com', wa: '919888002635', dept: 'Visa' },
  admin:   { name: 'Vineet Bansal',   email: 'vineet.b@escapenfly.com', wa: '919851739851', dept: 'Admin' }
};

const ISLAND     = ['maldives','mauritius','seychelles','bali','lakshadweep'];
const SHORT_HAUL = ['dubai','uae','thailand','bangkok','phuket','singapore','malaysia','sri lanka','nepal','bhutan','myanmar','middle east'];
const LONG_HAUL  = ['usa','america','canada','australia','new zealand','japan','south korea','china','kenya','tanzania','africa','brazil','peru','argentina','europe','france','paris','italy','rome','switzerland','spain','greece','germany','uk','london','amsterdam','portugal','croatia','turkey'];
const DOMESTIC   = ['india','kashmir','goa','rajasthan','himachal','kerala','ladakh','uttarakhand','northeast','andaman','manali','shimla','jaipur','udaipur','varanasi','rishikesh','sikkim','darjeeling','coorg','ooty','munnar'];

let rrShortHaul = 0, rrLongHaul = 0;
const shortHaulPool = ['lalit', 'divya', 'shubham'];
const longHaulPool  = ['anjan', 'shubham'];

// ── CLAUDE-BASED ASSIGNMENT (primary) ──
async function assignTeamWithClaude(data) {
  const teamList = Object.values(TEAM).filter(t => t.name !== 'Vineet Bansal')
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
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });
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

// ── ai_chats: Maya's memory (replaces in-memory chats Map) ──
function emptyChat(phone) {
  return { phone, msgs: [], lastMsg: null, lastReply: null, lastLeadSig: null, muted: false, lastUpdatedMs: 0 };
}

async function loadChat(phone) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/ai_chats?phone=eq.${phone}&select=*`, { headers: SB_HEADERS });
    if (!r.ok) { console.error('loadChat failed:', r.status, await r.text()); return emptyChat(phone); }
    const rows = await r.json();
    if (!rows[0]) return emptyChat(phone);
    const row = rows[0];
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    const fresh = ageMs < CHAT_TTL_MS;
    return {
      phone,
      msgs: (fresh && Array.isArray(row.msgs)) ? row.msgs : [],   // expired memory → start fresh
      lastMsg: fresh ? row.last_msg : null,
      lastReply: row.last_reply,
      lastLeadSig: fresh ? row.last_lead_sig : null,
      muted: !!row.muted,                                         // mute survives expiry (manual flag)
      lastUpdatedMs: new Date(row.updated_at).getTime()
    };
  } catch (e) {
    console.error('loadChat error:', e.message);
    return emptyChat(phone);
  }
}

async function saveChat(chat) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/ai_chats?on_conflict=phone`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        phone: chat.phone,
        msgs: chat.msgs,
        last_msg: chat.lastMsg,
        last_reply: chat.lastReply,
        last_lead_sig: chat.lastLeadSig,
        muted: chat.muted,
        updated_at: new Date().toISOString()
      })
    });
    if (!r.ok) console.error('saveChat failed:', r.status, await r.text());
  } catch (e) {
    console.error('saveChat error:', e.message);
  }
}

// ── Lead dedupe via enquiries.phone (replaces in-memory recentLeads Map) ──
// Returns { id, existing } where existing = parsed original_message_text of the
// most recent lead for this phone in the last 24h — or null if none.
async function findRecentLeadDB(phone) {
  try {
    const since = new Date(Date.now() - DEDUPE_MS).toISOString();
    const url = `${SB_URL}/rest/v1/enquiries?phone=eq.${phone}` +
      `&is_deleted=eq.false&created_at=gt.${encodeURIComponent(since)}` +
      `&select=id,original_message_text,enquiry_type&order=created_at.desc&limit=1`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) { console.error('findRecentLeadDB failed:', r.status, await r.text()); return null; }
    const rows = await r.json();
    if (!rows[0]) return null;
    let existing = {};
    try { existing = JSON.parse(rows[0].original_message_text || '{}'); } catch (e) {}
    return { id: rows[0].id, existing, enquiryType: rows[0].enquiry_type };
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
    name:        pick(existing.name, fresh.name),
    phone:       fresh.phone || existing.phone || '',
    email:       pick(existing.email, fresh.email),
    destination: pick(existing.dest || existing.destination, fresh.destination),
    travelMonth: pick(existing.travelMonth, fresh.travelMonth),
    pax:         pick(existing.pax, fresh.pax),
    budget:      pick(existing.budget, fresh.budget),
    type:        pick(existing.type, fresh.type),
    intent:      pick(existing.intent, fresh.intent),
    leadSummary: pick(existing.leadSummary, fresh.leadSummary),
    nextAction:  pick(existing.nextAction, fresh.nextAction),
    handover:    !!(fresh.handover || existing.handover),
    query:       fresh.query || existing.query || '',
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
    pax_adults: Number.isFinite(paxNum) ? paxNum : 2,
    budget_max: Number.isFinite(budgetNum) && budgetNum > 0 ? budgetNum : null,
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
    const r = await fetch(`${SB_URL}/rest/v1/enquiries?id=eq.${existingId}`, {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify(fields)
    });
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
    const r = await fetch(`${SB_URL}/rest/v1/enquiries`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify(body)
    });
    if (r.ok) { console.log('✅ Lead saved:', id, r.status); return id; }
    console.error('❌ Lead save FAILED:', id, r.status, '—', await r.text());
    return null;
  } catch (e) {
    console.error('Supabase error:', e);
    return null;
  }
}

// ── SEND WHATSAPP via AiSensy (now logs the response — v2.x fired blind) ──
async function sendWA(phone, templateName, params) {
  if (!AISENSY_KEY) { console.error('sendWA skipped: AISENSY_KEY not set'); return false; }
  try {
    const r = await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: AISENSY_KEY,
        campaignName: templateName,
        destination: phone,
        userName: params[0] || 'Traveller',
        templateParams: params
      })
    });
    const body = await r.text();
    if (r.ok) return true;
    console.error(`❌ sendWA '${templateName}' → ${phone} FAILED (${r.status}):`, body.slice(0, 200));
    return false;
  } catch (e) {
    console.error('WA send error:', e.message);
    return false;
  }
}

// ── NOTIFY TEAM ──
async function notifyTeam(assigned, leadData) {
  let ok = true;
  if (assigned.wa && assigned.wa !== '919XXXXXXXXX') {
    ok = await sendWA(assigned.wa, 'team_lead_notification',
      [assigned.name, leadData.name || 'Unknown', leadData.destination || 'TBD', 'https://escapenfly-crm.netlify.app']) && ok;
  }
  ok = await sendWA(WA_NUM, 'team_lead_notification',
    ['Vineet', leadData.name || 'Unknown', leadData.destination || 'TBD', assigned.name]) && ok;
  return ok;
}

// ═══════════════════ MAYA BRAIN v3.0 ═══════════════════

const CHAT_SYSTEM = `You are Maya, the AI travel consultant for EscapeNFly Travel Agency, chatting with a customer on WhatsApp.

ABOUT ESCAPENFLY: Chandigarh-based travel agency since 2016, 4.8★ rated, 27,000+ happy travellers, 90%+ repeat clients. Services: holiday packages (domestic + international), visa services, flight bookings, hotels, cruises, travel insurance, forex. Phone: +91 98517 39851.

SCOPE — TRAVEL ONLY:
You handle ONLY travel-related topics: holidays, visas, flights, hotels, cruises, corporate/MICE travel, travel insurance, forex, passports/travel documents, existing bookings, and complaints. If the customer asks about anything non-travel (coding, politics, homework, general knowledge, jokes, personal advice, etc.), politely deflect in ONE line and steer back to travel — no matter how they phrase it or insist.

INTENT — on EVERY turn, classify the customer's current need as exactly one of:
holiday | visa | flights | hotel | cruise | corporate | mice | existing_booking | complaint | human_support | other_travel | off_topic

Let the intent shape your reply:
- visa: work the visa workflow — which country, intended travel date, applicant name. Do NOT pitch tourism or sightseeing. "Singapore visa" → ask their intended travel date, not what to see in Singapore.
- holiday "Europe" → ask which countries interest them. "Europe visa" → ask which Schengen country they'll enter first.
- flights: route and dates. hotel: city and dates. cruise: region and month.
- existing_booking / complaint: apologise briefly, ask for the booking name or reference, set "handover": true.
- human_support: if the customer says anything like "call me", "talk to an expert", "human", "agent", "representative", "callback" — STOP asking questions. Confirm our travel expert will call them shortly, and set "handover": true.

CONVERSATION RULES:
- 2–4 short sentences, WhatsApp style. Light emoji use is fine.
- NEVER add a signature, greeting header, or "— Team EscapeNFly" — the message template adds branding automatically.
- Ask AT MOST ONE question per message. Never send a list of questions.
- NEVER re-ask something the customer already told you anywhere in the conversation.
- Reply in the customer's language (English, Hindi, Hinglish — match them).
- ANTI-HALLUCINATION: never invent or state specific prices, visa fees, processing times, approval chances, or availability. Give genuine general guidance (best season, rough visa basics, destination ideas), and for specifics say our travel expert will confirm exact details on the call. Never guarantee visa approval.

YOUR QUIET MISSION: across the conversation, naturally learn their name, destination, travel month, number of travellers, budget, and service type — woven in one question at a time, never an interrogation.

OUTPUT FORMAT — respond ONLY with this JSON object. No markdown fences, no text before or after:
{"reply":"<your WhatsApp message>","intent":"<one intent from the list>","lead":{"name":"","destination":"","travel_month":"","pax":"","budget":"","type":"holiday|visa|flights|hotel|cruise|corporate|other"},"lead_summary":"<one actionable line for the sales team, e.g. 'Singapore tourist visa for Sept 2026, 2 pax, awaiting expert callback'>","next_action":"<the first thing the assigned expert should do>","handover":false,"ready":false}

- lead fields are CUMULATIVE — everything learned so far in the whole conversation; empty string if unknown.
- "ready": true once you know name AND destination AND travel month — OR whenever "handover" is true.
- "handover": true when the customer requests a call/human, has a complaint, or asks about an existing booking.
- After ready, keep chatting naturally and keep filling the remaining fields.`;

// Claude call with 1 automatic retry on invalid JSON
async function callMayaJSON(msgs, phone) {
  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = attempt === 0 ? msgs : [
      ...msgs,
      { role: 'assistant', content: lastRaw || '(invalid output)' },
      { role: 'user', content: 'Your previous output was not valid JSON. Respond ONLY with the JSON object in the exact specified format — no other text, no markdown fences.' }
    ];
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          system: CHAT_SYSTEM,
          messages
        })
      });
      const d = await r.json();
      lastRaw = (d.content?.[0]?.text || '').trim().replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(lastRaw);
      if (parsed && typeof parsed.reply === 'string') return { parsed, raw: lastRaw };
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

// ── CORE MAYA TURN — persistent memory edition ──
const FALLBACK_REPLY = 'Thanks for your message! Our travel expert will call you shortly. You can also reach us directly at +91 98517 39851. 😊';

async function mayaTurn(phone, message) {
  const log = { in: short(message), intent: '-', reply: '-', crm: 'none', notify: '-' };
  try {
    const chat = await loadChat(phone || 'unknown');

    // Muted chat (agent handling / manual flag in ai_chats.muted) → stay silent
    if (chat.muted) {
      console.log(`🔇 [${phone}] muted — Maya stays silent.`);
      return null;
    }

    // 8-second duplicate guard (webhook double-delivery)
    if (chat.lastMsg === message && Date.now() - chat.lastUpdatedMs < 8000) {
      console.log(`↩️ [${phone}] duplicate within 8s — returning cached reply.`);
      return chat.lastReply || FALLBACK_REPLY;
    }

    chat.msgs.push({ role: 'user', content: message });
    if (chat.msgs.length > 24) chat.msgs = chat.msgs.slice(-24);

    const result = await callMayaJSON(chat.msgs, phone);
    if (!result) {
      // Both attempts failed → fallback, but still persist the user message
      chat.lastMsg = message;
      chat.lastReply = FALLBACK_REPLY;
      await saveChat(chat);
      console.log(`▶ [${phone}] IN:"${log.in}" | intent:ERR | reply:FALLBACK | CRM:none`);
      return FALLBACK_REPLY;
    }

    const { parsed, raw } = result;
    chat.msgs.push({ role: 'assistant', content: raw });
    chat.lastMsg = message;
    chat.lastReply = parsed.reply || FALLBACK_REPLY;
    log.intent = parsed.intent || '-';
    log.reply = short(parsed.reply, 60);

    // ── LEAD CAPTURE ──
    if ((parsed.ready || parsed.handover) && phone && parsed.lead) {
      const freshData = {
        name: parsed.lead.name || '',
        phone: phone,
        destination: parsed.lead.destination || '',
        travelMonth: parsed.lead.travel_month || '',
        pax: parsed.lead.pax || '',
        budget: parsed.lead.budget || '',
        type: parsed.lead.type || '',
        intent: parsed.intent || '',
        leadSummary: parsed.lead_summary || '',
        nextAction: parsed.next_action || '',
        handover: !!parsed.handover,
        query: message,
        source: 'whatsapp-ai-chat'
      };

      const recent = await findRecentLeadDB(phone);
      if (recent) {
        const merged = mergeLeadData(recent.existing, freshData);
        const sig = JSON.stringify(merged);
        if (chat.lastLeadSig !== sig) {
          chat.lastLeadSig = sig;
          const ok = await updateLead(recent.id, merged);
          log.crm = ok ? `enriched:${recent.id.slice(0, 8)}` : 'enrich-FAILED';
          // Handover on an existing lead → re-notify so the team calls NOW
          if (freshData.handover && !recent.existing.handover) {
            const assigned = await assignTeamWithClaude(merged);
            log.notify = (await notifyTeam(assigned, merged)) ? 'ok' : 'FAILED';
          }
        } else {
          log.crm = 'no-change';
        }
      } else {
        const merged = mergeLeadData({}, freshData);
        if (!merged.name) merged.name = 'Unknown (WhatsApp)';
        const assigned = await assignTeamWithClaude(merged);
        const leadId = await saveLead(merged, assigned);
        log.crm = leadId ? `created:${leadId.slice(0, 8)}→${assigned.name}` : 'create-FAILED';
        log.notify = (await notifyTeam(assigned, merged)) ? 'ok' : 'FAILED';
        chat.lastLeadSig = JSON.stringify(merged);
      }
    }

    await saveChat(chat);
    console.log(`▶ [${phone}] IN:"${log.in}" | intent:${log.intent} | ready:${!!parsed.ready} handover:${!!parsed.handover} | reply:"${log.reply}" | CRM:${log.crm} | notify:${log.notify}`);
    return chat.lastReply;
  } catch (e) {
    console.error(`AI chat error [${phone}]:`, e.message);
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
    const r = await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: AISENSY_KEY,
        campaignName: MAYA_CAMPAIGN,
        destination: phone,
        userName: 'Traveller',
        templateParams: [text]
      })
    });
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
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.body.model || 'claude-haiku-4-5-20251001',
        max_tokens: req.body.max_tokens || 800,
        system: req.body.system || '',
        messages: req.body.messages || []
      })
    });
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
  const reply = await withPhoneLock(phone || 'unknown', () => mayaTurn(phone || 'unknown', message));
  res.json({ reply: reply || FALLBACK_REPLY });
});

// ── DEEP PAYLOAD SCANNER (v3.0.1) ──
// AiSensy's incoming-message payload is nested ({data:{message:{phone_number:...}}})
// and its exact structure was never confirmed (300-char log truncation hid it).
// Instead of guessing field names, recursively scan the whole payload:
// - phone: any 10–15 digit value under a key containing phone/waid/from/sender/mobile/contact
// - text:  any non-empty string under a key named text/body/message/caption/content
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

// ── PRIMARY: AISENSY INCOMING-MESSAGE WEBHOOK (v3.0.1: ALWAYS-REPLY policy) ──
app.post('/webhook/incoming', async (req, res) => {
  res.json({ status: 'ok' }); // ack immediately

  try {
    const b = req.body || {};
    // v3.0.1: log the FULL payload (was 300 chars — truncation hid the structure)
    console.log('Incoming webhook FULL:', JSON.stringify(b).slice(0, 2000));

    const { phones, texts } = deepExtract(b);

    // Phone: prefer any number that is NOT our own business number
    const own = WA_NUM.replace(/\D/g, '');
    const phoneEntry = phones.find(p => p.digits !== own) || phones[0];
    const phone = phoneEntry ? phoneEntry.digits : '';

    // Text: prefer explicit text/body keys over generic 'message'
    const textEntry =
      texts.find(t => t.key === 'text') ||
      texts.find(t => t.key === 'body') ||
      texts.find(t => t.key === 'message_text') ||
      texts.find(t => t.key === 'caption' || t.key === 'content') ||
      texts.find(t => t.key === 'message');
    const text = textEntry ? textEntry.value : '';

    console.log(`Extracted → phone:"${phone}" (via ${phoneEntry ? phoneEntry.key : 'none'}) | text:"${short(text)}" (via ${textEntry ? textEntry.key : 'none'})`);

    if (!phone) { console.log('Incoming ignored: no phone number found anywhere in payload.'); return; }
    if (phone === WA_NUM.replace(/\D/g, '')) return;      // never talk to ourselves
    if (!text) { console.log(`Incoming from ${phone} ignored: empty/media-only message.`); return; }

    // v3.0: NO trigger-word gate. Every customer message gets a reply
    // (muted phones are handled inside mayaTurn via ai_chats.muted).
    await withPhoneLock(phone, async () => {
      const reply = await mayaTurn(phone, text);
      if (reply) await sendSessionMessage(phone, reply);
    });
  } catch (e) {
    console.error('Incoming webhook error:', e);
  }
});

// ── LEGACY: AISENSY SCRIPTED-FLOW WEBHOOK (kept; flows module dies next month) ──
app.post('/webhook/aisensy', async (req, res) => {
  res.json({ status: 'ok' });

  try {
    const body = req.body;
    console.log('AiSensy webhook received:', JSON.stringify(body).slice(0, 300));

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

    if (!phone) {
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
          const metaR = await fetch(
            `https://graph.facebook.com/v18.0/${leadId_meta}?access_token=${process.env.META_ACCESS_TOKEN}`
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

          if (leadData.phone) {
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

    if (leadData.phone) {
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
  version: '3.0.1',
  state: 'persistent (Supabase ai_chats + enquiries.phone) + deep webhook parser',
  endpoints: ['/ai', '/webhook/aisensy', '/webhook/chat', '/webhook/incoming', '/webhook/meta', '/webhook/website']
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EscapeNFly AI Engine v3.0.1 running on port ${PORT}`));
