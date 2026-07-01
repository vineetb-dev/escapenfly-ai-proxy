const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── CONFIG ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SB_URL = 'https://zkhbaisggymbmurqxejk.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_cXjJKnSOprBxp4CO0wQTsg_azzuBFTi';
const AISENSY_KEY = process.env.AISENSY_KEY;
const WA_NUM = '919851739851';

// ── TEAM ASSIGNMENT LOGIC ──
const TEAM = {
  domestic:   { name: 'Lalit Mehta',    email: 'lalit@escapenfly.com',    wa: '919XXXXXXXXX' },
  shorthaul:  { name: 'Divya Nigam',    email: 'divya@escapenfly.com',    wa: '919XXXXXXXXX' },
  longhaul:   { name: 'Anjan Pramanik', email: 'anjan@escapenfly.com',    wa: '919XXXXXXXXX' },
  europe:     { name: 'Shubham',        email: 'shubham@escapenfly.com',   wa: '919XXXXXXXXX' },
  flights:    { name: 'Prabhjot Singh', email: 'prabhjot@escapenfly.com', wa: '919XXXXXXXXX' },
  visa:       { name: 'Damini',         email: 'damini@escapenfly.com',    wa: '919XXXXXXXXX' },
  admin:      { name: 'Vineet Bansal',  email: 'vineet.b@escapenfly.com', wa: '919851739851' }
};

// Short haul destinations
const SHORT_HAUL = ['dubai','uae','thailand','bangkok','phuket','bali','indonesia','singapore','malaysia','sri lanka','nepal','bhutan','maldives','mauritius','myanmar'];
const LONG_HAUL  = ['usa','america','canada','australia','new zealand','japan','south korea','china','kenya','tanzania','africa','brazil','peru','argentina'];
const EUROPE     = ['europe','france','paris','italy','rome','switzerland','spain','greece','germany','uk','london','amsterdam','portugal','croatia','turkey'];
const DOMESTIC   = ['india','kashmir','goa','rajasthan','himachal','kerala','ladakh','uttarakhand','northeast','andaman'];

function assignTeam(data) {
  const text = (data.destination + ' ' + data.query + ' ' + data.type).toLowerCase();
  
  if (text.includes('visa')) return TEAM.visa;
  if (text.includes('flight') || text.includes('ticket') || text.includes('air')) return TEAM.flights;
  if (EUROPE.some(d => text.includes(d))) return TEAM.europe;
  if (LONG_HAUL.some(d => text.includes(d))) return TEAM.longhaul;
  if (SHORT_HAUL.some(d => text.includes(d))) return TEAM.shorthaul;
  if (DOMESTIC.some(d => text.includes(d))) return TEAM.domestic;
  if (text.includes('group') || text.includes('corporate')) return TEAM.longhaul;
  if (text.includes('honeymoon')) return TEAM.shorthaul;
  
  // Default round robin between Lalit and Divya for unknown
  return Math.random() > 0.5 ? TEAM.domestic : TEAM.shorthaul;
}

// ── CLAUDE AI ──
async function callClaude(system, message, maxTokens = 500) {
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
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: message }]
      })
    });
    const d = await r.json();
    return d.content?.[0]?.text || '';
  } catch (e) {
    console.error('Claude error:', e);
    return '';
  }
}

// ── SUPABASE ──
async function saveLead(data, assigned) {
  try {
    const id = crypto.randomUUID();
    const body = {
      id,
      assigned_to_email: assigned.email,
      assigned_to_name: assigned.name,
      source: data.source || 'whatsapp',
      notes: `Name: ${data.name}\nPhone: ${data.phone}\nDestination: ${data.destination}\nBudget: ${data.budget}\nPax: ${data.pax}\nTravel: ${data.travelMonth}\nQuery: ${data.query}`,
      original_message_text: JSON.stringify(data),
      status: 'new',
      priority: 'high',
      created_by: 'AutoBot',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      is_deleted: false,
      packages: [], reminders: [],
      history: [{ s: 'new', by: 'AutoBot', at: new Date().toISOString(), note: `Auto-assigned to ${assigned.name}` }]
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
    console.log('Lead saved:', id, r.status);
    return id;
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

  // Send to assigned team member via AiSensy
  if (assigned.wa && assigned.wa !== '919XXXXXXXXX') {
    await sendWA(assigned.wa, 'team_lead_notification', [assigned.name, leadData.name, leadData.destination, 'https://escapenfly-crm.netlify.app']);
  }
  
  // Always notify Vineet too
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

// ── AISENSY WEBHOOK (WhatsApp flow completion) ──
app.post('/webhook/aisensy', async (req, res) => {
  res.json({ status: 'ok' }); // Respond immediately
  
  try {
    const body = req.body;
    console.log('AiSensy webhook received:', JSON.stringify(body).slice(0, 200));
    
    // Extract data from AI Sensy flow attributes
    const phone = body.waId || body.phone || body.mobile;
    const attrs = body.attributes || body.customAttributes || {};
    
    const leadData = {
      name: attrs.name || attrs.customer_name || body.userName || 'Unknown',
      phone: phone,
      destination: attrs.destination || attrs.dest || '',
      travelMonth: attrs.travel_month || attrs.travel_date || '',
      pax: attrs.pax || attrs.travellers || '',
      budget: attrs.budget || '',
      type: attrs.trip_type || '',
      query: attrs.query || body.lastMessage || '',
      source: 'whatsapp-flow'
    };
    
    if (!phone) return;
    
    // Assign team
    const assigned = assignTeam(leadData);
    
    // Save to CRM
    const leadId = await saveLead(leadData, assigned);
    
    // Notify team
    await notifyTeam(assigned, leadData, leadId);
    
    console.log(`Lead processed: ${leadData.name} → ${assigned.name}`);
  } catch (e) {
    console.error('Webhook error:', e);
  }
});

// ── META LEAD ADS WEBHOOK ──
app.get('/webhook/meta', (req, res) => {
  // Meta webhook verification
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
        
        // Fetch lead data from Meta Graph API
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
          
          const assigned = assignTeam(leadData);
          await saveLead(leadData, assigned);
          await notifyTeam(assigned, leadData, null);
          
          // Send immediate WhatsApp to the lead
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
    const assigned = assignTeam(leadData);
    const leadId = await saveLead(leadData, assigned);
    await notifyTeam(assigned, leadData, leadId);
    
    // Send welcome WhatsApp to customer
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
  version: '2.0',
  endpoints: ['/ai', '/webhook/aisensy', '/webhook/meta', '/webhook/website']
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EscapeNFly AI Engine running on port ${PORT}`));
