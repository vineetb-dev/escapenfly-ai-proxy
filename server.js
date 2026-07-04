const express = require('express');
const cors = require('cors');
const crypto = require('crypto'); // FIX: was used but never imported — needed for randomUUID() to work reliably
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── CONFIG ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SB_URL = 'https://zkhbaisggymbmurqxejk.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_cXjJKnSOprBxp4CO0wQTsg_azzuBFTi';
const AISENSY_KEY = process.env.AISENSY_KEY;
const WA_NUM = '919851739851';

// ── TEAM ASSIGNMENT — FIXED to match real CRM emails (confirmed by Vineet 2 Jul 2026) ──
// ⚠️ Previous version used lalit@escapenfly.com etc. — WRONG, did not match the CRM's
// actual Admin panel emails. Fixed below. If any of the `wa` numbers are wrong/placeholder,
// update them — they're used to send the WhatsApp notification to the assigned person.
const TEAM = {
  lalit:   { name: 'Lalit Mehta',     email: 'sales6@escapenfly.com',   wa: '916283285244', dept: 'Domestic & Short Haul' },
  divya:   { name: 'Divya Nigam',     email: 'sales1@escapenfly.com',   wa: '917888871148', dept: 'Short Haul & Island' },
  anjan:   { name: 'Anjan Pramanick', email: 'sales3@escapenfly.com',   wa: '919875903349', dept: 'Long Haul' },
  shubham: { name: 'Shubham',         email: 'sales7@escapenfly.com',   wa: '919875921281', dept: 'Short Haul & Long Haul' },
  prabhjot:{ name: 'Prabhjot Singh',  email: 'support2@escapenfly.com', wa: '919569933206', dept: 'Air Tickets, Corporate & Catch-All' },
  damini:  { name: 'Damini',          email: 'support3@escapenfly.com', wa: '919888002635', dept: 'Visa' },
  admin:   { name: 'Vineet Bansal',   email: 'vineet.b@escapenfly.com', wa: '919851739851', dept: 'Admin' }
};

// Destination keyword lists — used only as a FALLBACK if the Claude call fails
const ISLAND     = ['maldives','mauritius','seychelles','bali','lakshadweep'];
const SHORT_HAUL = ['dubai','uae','thailand','bangkok','phuket','singapore','malaysia','sri lanka','nepal','bhutan','myanmar','middle east'];
const LONG_HAUL  = ['usa','america','canada','australia','new zealand','japan','south korea','china','kenya','tanzania','africa','brazil','peru','argentina','europe','france','paris','italy','rome','switzerland','spain','greece','germany','uk','london','amsterdam','portugal','croatia','turkey'];
const DOMESTIC   = ['india','kashmir','goa','rajasthan','himachal','kerala','ladakh','uttarakhand','northeast','andaman'];

// Round-robin state (resets on server restart — fine for current volume)
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
- If genuinely unclear or doesn't fit anywhere → Prabhjot Singh

ENQUIRY:
Name: ${data.name || 'Unknown'}
Destination: ${data.destination || 'Not specified'}
Travel Month: ${data.travelMonth || 'Not specified'}
Pax: ${data.pax || 'Not specified'}
Budget: ${data.budget || 'Not specified'}
Query/Type: ${data.query || data.type || 'Not specified'}

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

// ── KEYWORD FALLBACK (only used if Claude call fails) ──
function assignTeamFallback(data) {
  const text = (data.destination + ' ' + data.query + ' ' + data.type).toLowerCase();

  if (text.includes('visa')) return TEAM.damini;
  if (text.includes('flight') || text.includes('ticket') || text.includes('air')) return TEAM.prabhjot;
  if (text.includes('corporate') || text.includes('group')) return TEAM.prabhjot;
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
  return TEAM.prabhjot; // unclear enquiry → catch-all
}

// ── SUPABASE ──
// v2.3: TWO-STAGE CAPTURE. The flow now fires the webhook twice — once early
// (after month question: name/phone/destination/month) and once at the end
// (with travellers/budget). First call CREATES the lead + notifies the team.
// Second call MERGES the extra details into the same lead — no duplicates,
// no double notifications. Dedupe memory is per-phone with a 24h window.
const recentLeads = new Map(); // phone -> { id, at }
const DEDUPE_MS = 24 * 60 * 60 * 1000;

function rememberLead(phone, id) {
  recentLeads.set(phone, { id, at: Date.now() });
  // light cleanup so the map never grows unbounded
  if (recentLeads.size > 500) {
    for (const [k, v] of recentLeads) {
      if (Date.now() - v.at > DEDUPE_MS) recentLeads.delete(k);
    }
  }
}

function findRecentLead(phone) {
  const e = recentLeads.get(phone);
  return (e && Date.now() - e.at < DEDUPE_MS) ? e.id : null;
}

// Shared: build the updatable field set from lead data (used by create + merge)
function buildLeadFields(data) {
  const paxNum = parseInt(String(data.pax || '').match(/\d+/)?.[0], 10);
  // Parse Indian budget notation: "2 lakh"/"2L" → 200000, "50k" → 50000, "1.5 cr" → 15000000
  const bStr = String(data.budget || '').toLowerCase();
  let budgetNum = parseFloat(bStr.replace(/[^0-9.]/g, ''));
  if (Number.isFinite(budgetNum)) {
    if (/crore|cr\b/.test(bStr)) budgetNum *= 10000000;
    else if (/lakh|lac|\bl\b|[0-9]l\b/.test(bStr)) budgetNum *= 100000;
    else if (/[0-9]k\b|thousand/.test(bStr)) budgetNum *= 1000;
  }

  const notesText =
    `Auto-captured via ${data.source || 'whatsapp'}\n` +
    `Destination: ${data.destination || '-'}\n` +
    `Travel: ${data.travelMonth || '-'}\n` +
    `Pax: ${data.pax || '-'}\n` +
    `Budget: ${data.budget || '-'}\n` +
    `Query: ${data.query || '-'}`;

  return {
    enquiry_type: data.type || 'international',
    pax_adults: Number.isFinite(paxNum) ? paxNum : 2,
    budget_max: Number.isFinite(budgetNum) && budgetNum > 0 ? budgetNum : null,
    notes: notesText,
    internal_notes: notesText,
    original_message_text: JSON.stringify({
      name: data.name || 'Unknown (WhatsApp)',
      phone: data.phone || '',
      email: data.email || '',
      dest: data.destination || '',
      dep: '', ret: '', nights: '',
      hotelCat: '', isRepeat: 'no',
      travelMonth: data.travelMonth || '',
      pax: data.pax || '', budget: data.budget || '',
      query: data.query || ''
    }),
    updated_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString()
  };
}

// Merge fresh details into an existing lead (second webhook call)
async function updateLead(existingId, data) {
  try {
    const fields = buildLeadFields(data);
    const r = await fetch(`${SB_URL}/rest/v1/enquiries?id=eq.${existingId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(fields)
    });
    if (r.ok) {
      console.log('🔄 Lead enriched with final details:', existingId, r.status);
    } else {
      console.error('❌ Lead update FAILED:', existingId, r.status, '—', await r.text());
    }
  } catch (e) {
    console.error('Supabase update error:', e);
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
      history: [{ s: 'new', by: 'AutoBot', at: now, note: `Auto-assigned to ${assigned.name}` }],
      created_by: 'AutoBot',
      created_at: now,
      is_deleted: false,
      ...fields
    };
    const r = await fetch(`${SB_URL}/rest/v1/enquiries`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(body)
    });
    if (r.ok) {
      console.log('✅ Lead saved successfully:', id, r.status);
      return id;
    }
    const errText = await r.text();
    console.error('❌ Lead save FAILED:', id, r.status, '—', errText);
    return null;
  } catch (e) {
    console.error('Supabase error:', e);
    return null;
  }
}

// ── SEND WHATSAPP via AiSensy ──
async function sendWA(phone, templateName, params) {
  if (!AISENSY_KEY) return;
  try {
    await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
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
  } catch (e) {
    console.error('WA send error:', e);
  }
}

// ── NOTIFY TEAM ──
async function notifyTeam(assigned, leadData, leadId) {
  const msg = `🔔 *New Lead Assigned to You*\n\n` +
    `👤 *Name:* ${leadData.name || 'Unknown'}\n` +
    `📱 *Phone:* ${leadData.phone}\n` +
    `✈️ *Destination:* ${leadData.destination || 'TBD'}\n` +
    `📅 *Travel:* ${leadData.travelMonth || 'TBD'}\n` +
    `👥 *Pax:* ${leadData.pax || 'TBD'}\n` +
    `💰 *Budget:* ${leadData.budget || 'TBD'}\n` +
    `📋 *Source:* ${leadData.source || 'WhatsApp'}\n\n` +
    `🔗 Open CRM: https://escapenfly-crm.netlify.app\n\n` +
    `⚡ Please respond within 15 minutes!`;

  if (assigned.wa && assigned.wa !== '919XXXXXXXXX') {
    await sendWA(assigned.wa, 'team_lead_notification', [assigned.name, leadData.name, leadData.destination, 'https://escapenfly-crm.netlify.app']);
  }
  await sendWA(WA_NUM, 'team_lead_notification', ['Vineet', leadData.name, leadData.destination, assigned.name]);
  console.log(`Team notified: ${assigned.name} for lead from ${leadData.phone}`);
}

// ── MAIN AI ENDPOINT (website, CRM) ──
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

// ── CONVERSATIONAL AI CHAT (v2.5) ──
// Free-flowing Claude-powered WhatsApp assistant. AiSensy loop: Question block
// captures the user's message → API Request POSTs {phone, message} here →
// response {"reply": "..."} is mapped to an attribute → next Question shows it →
// loops back to the API Request. Claude chats naturally, quietly extracts lead
// details, and the moment it has enough, the lead is saved + routed + notified
// using the same proven machinery as the scripted flow.
const chats = new Map(); // phone -> { msgs: [], at }
const CHAT_TTL_MS = 24 * 60 * 60 * 1000;

function getChat(phone) {
  let c = chats.get(phone);
  if (!c || Date.now() - c.at > CHAT_TTL_MS) {
    c = { msgs: [], at: Date.now() };
    chats.set(phone, c);
  }
  c.at = Date.now();
  if (chats.size > 300) {
    for (const [k, v] of chats) {
      if (Date.now() - v.at > CHAT_TTL_MS) chats.delete(k);
    }
  }
  return c;
}

const CHAT_SYSTEM = `You are Maya, the expert AI travel consultant for EscapeNFly Travel Agency, chatting with a customer on WhatsApp.

ABOUT ESCAPENFLY: Chandigarh-based travel agency since 2016, 4.8★ rated, 90%+ repeat clients. Services: holiday packages (domestic + international), visa services, flight bookings. Phone: +91 98517 39851.

STYLE:
- Warm, helpful, concise. 2-4 short sentences per reply, WhatsApp style. Light emoji use is fine.
- Answer travel questions genuinely and knowledgeably (best season, visa basics, destination ideas, rough budget guidance).
- Never invent specific prices, availability, or visa guarantees — for specifics, say our travel expert will call them.
- Reply in the language the customer writes in (English, Hindi, Hinglish all fine).

YOUR QUIET MISSION: across the conversation, naturally learn: their name, destination, travel month, number of travellers, budget, and whether they need a holiday package, visa only, or flights only. Weave questions in naturally, ONE at a time — never interrogate, never list questions.

OUTPUT FORMAT — respond ONLY with a JSON object, no other text, no markdown fences:
{"reply": "<your WhatsApp message to the customer>", "lead": {"name": "", "destination": "", "travel_month": "", "pax": "", "budget": "", "type": "holiday|visa|flights"}, "ready": false}

Fill lead fields with everything learned so far (empty string if unknown). Set "ready": true once you know at least name AND destination AND travel month, OR the customer asks to be called / talk to an expert. After ready, keep chatting and keep filling remaining fields.`;

app.post('/webhook/chat', async (req, res) => {
  const phone = cleanAttr(req.body.phone || req.body.waId || req.body.mobile || '') || '';
  const message = cleanAttr(req.body.message || req.body.text || '') || 'Hi';

  const FALLBACK_REPLY = 'Thanks for your message! Our travel expert will call you shortly. You can also reach us directly at +91 98517 39851. 😊';

  try {
    console.log(`AI chat [${phone}]: ${String(message).slice(0, 120)}`);
    const chat = getChat(phone || 'unknown');
    chat.msgs.push({ role: 'user', content: message });
    if (chat.msgs.length > 24) chat.msgs = chat.msgs.slice(-24);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // v2.7: faster replies (1-2s) to stay inside AiSensy's API timeout
        max_tokens: 400,
        system: CHAT_SYSTEM,
        messages: chat.msgs
      })
    });
    const d = await r.json();
    const raw = d.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    chat.msgs.push({ role: 'assistant', content: raw });

    // Reply to AiSensy FIRST so the customer isn't kept waiting
    console.log(`AI reply [${phone}]: ${String(parsed.reply || '').slice(0, 100)}`);
    res.json({ reply: parsed.reply || FALLBACK_REPLY });

    // Then handle lead capture in the background
    if (parsed.ready && phone && parsed.lead) {
      const leadData = {
        name: parsed.lead.name || 'Unknown (WhatsApp)',
        phone: phone,
        destination: parsed.lead.destination || '',
        travelMonth: parsed.lead.travel_month || '',
        pax: parsed.lead.pax || '',
        budget: parsed.lead.budget || '',
        type: parsed.lead.type || '',
        query: message,
        source: 'whatsapp-ai-chat'
      };
      const existingId = findRecentLead(phone);
      if (existingId) {
        await updateLead(existingId, leadData);
        console.log(`AI chat lead enriched: ${leadData.name} → ${existingId}`);
      } else {
        const assigned = await assignTeamWithClaude(leadData);
        const leadId = await saveLead(leadData, assigned);
        if (leadId) rememberLead(phone, leadId);
        await notifyTeam(assigned, leadData, leadId);
        console.log(`AI chat lead captured: ${leadData.name} → ${assigned.name}`);
      }
    }
  } catch (e) {
    console.error('AI chat error:', e.message);
    if (!res.headersSent) res.json({ reply: FALLBACK_REPLY });
  }
});

// ── AISENSY WEBHOOK (WhatsApp flow completion) ──
// Guard (v2.2): if AiSensy ever fails to interpolate an attribute, the literal
// string "$attribute_name" arrives. Treat any value starting with "$" as empty
// so placeholder junk never lands in the CRM.
const cleanAttr = v => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t.startsWith('$') ? '' : t;
};

const attrsOf = body => body.attributes || body.customAttributes || {};

app.post('/webhook/aisensy', async (req, res) => {
  res.json({ status: 'ok' }); // Respond immediately

  try {
    const body = req.body;
    console.log('AiSensy webhook received:', JSON.stringify(body).slice(0, 300));

    const phone = cleanAttr(body.waId || body.phone || body.mobile || attrsOf(body).phone);
    const attrs = attrsOf(body);

    // v2.4: AiSensy's flow API Request node sends fields FLAT at the top level
    // ({"name":..,"destination":..}), while other senders may nest them under
    // "attributes". Read both — attributes first, then top-level fallback.
    const leadData = {
      name: cleanAttr(attrs.name || attrs.customer_name || body.name || body.customer_name || body.userName) || 'Unknown (WhatsApp)',
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
      console.error('⚠️ Webhook had no usable phone number (waId/phone/mobile all empty or uninterpolated $placeholders) — lead NOT saved. Raw body logged above.');
      return;
    }

    // v2.3 TWO-STAGE: if this phone already created a lead in the last 24h,
    // this is the completion webhook — merge details, don't duplicate/re-notify.
    const existingId = findRecentLead(phone);
    if (existingId) {
      await updateLead(existingId, leadData);
      console.log(`Lead enriched: ${leadData.name} (${phone}) → existing lead ${existingId}`);
      return;
    }

    const assigned = await assignTeamWithClaude(leadData);
    const leadId = await saveLead(leadData, assigned);
    if (leadId) rememberLead(phone, leadId);
    await notifyTeam(assigned, leadData, leadId);

    console.log(`Lead processed: ${leadData.name} → ${assigned.name}`);
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

          const leadData = {
            name: fields.full_name || fields.name || '',
            phone: fields.phone_number || fields.mobile || '',
            email: fields.email || '',
            destination: fields.destination || fields.travel_destination || '',
            budget: fields.budget || '',
            query: fields.message || '',
            source: 'meta-ads'
          };

          const assigned = await assignTeamWithClaude(leadData);
          await saveLead(leadData, assigned);
          await notifyTeam(assigned, leadData, null);

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
    const leadData = { ...req.body, source: 'website-form' };
    const assigned = await assignTeamWithClaude(leadData);
    const leadId = await saveLead(leadData, assigned);
    await notifyTeam(assigned, leadData, leadId);

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
  version: '2.7',
  endpoints: ['/ai', '/webhook/aisensy', '/webhook/chat', '/webhook/meta', '/webhook/website']
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EscapeNFly AI Engine running on port ${PORT}`));
