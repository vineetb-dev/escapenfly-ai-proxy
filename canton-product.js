/**
 * canton-product.js
 * ---------------------------------------------------------------------------
 * Maya product knowledge: 140th Canton Fair, Guangzhou (October 2026).
 * Source: "3 CANTON FINAL FILE.pdf" (Escapenfly product deck, Sept 2026).
 * ---------------------------------------------------------------------------
 */

'use strict';

/** Bookings close end of 15 Oct 2026 IST (18:30 UTC on 15 Oct). */
const CANTON_EXPIRES_AT = new Date('2026-10-15T18:30:00Z');

const CANTON_KEYWORDS = [
  'canton', 'canton fair', 'cantonfair', 'guangzhou', 'kanton',
  'china fair', 'china import and export fair', 'import export fair',
  'trade fair china', 'china sourcing', 'sourcing trip', 'china trip for business',
  'foshan', '140th canton'
];

const CANTON_CAMPAIGN_CODES = ['CANTON-OCT26'];
const CANTON_BROADCAST_CODES = ['CANTON'];

function isCantonEnquiry(ctx = {}) {
  const now = ctx.now || new Date();
  if (now > CANTON_EXPIRES_AT) return false;

  const code = String(ctx.campaignCode || '').toUpperCase();
  if (CANTON_CAMPAIGN_CODES.includes(code)) return true;

  const bcast = String(ctx.broadcastCode || '').toUpperCase();
  if (CANTON_BROADCAST_CODES.includes(bcast)) return true;

  const haystack = `${ctx.text || ''} ${ctx.adReferral || ''}`.toLowerCase();
  if (!haystack.trim()) return false;

  return CANTON_KEYWORDS.some((k) => haystack.includes(k));
}

const PHASE_INDEX = {
  1: {
    fairDates: '15-19 October 2026',
    travelDates: '13-19 October 2026 (6N/7D)',
    hasPackage: true,
    label: 'Electronics, machinery and industrial',
    categories: [
      'consumer electronics', 'information products', 'household electrical appliances',
      'industrial automation', 'intelligent manufacturing', 'processing machinery',
      'power machinery', 'electric power', 'general machinery', 'mechanical basic parts',
      'construction machinery', 'agricultural machinery', 'new materials',
      'chemical products', 'new energy vehicles', 'smart mobility', 'new energy resources',
      'motorcycles', 'bicycles', 'vehicle spare parts', 'auto parts', 'electronic products',
      'electrical products', 'lighting equipment', 'lighting', 'hardware', 'tools',
      'solar', 'batteries', 'ev charger', 'inverter', 'compressor', 'pump', 'generator',
      'welding', 'bearings', 'cnc', 'robots', 'sensors'
    ]
  },
  2: {
    fairDates: '23-27 October 2026',
    travelDates: '23-29 October 2026 (6N/7D)',
    hasPackage: true,
    label: 'Home, decor, gifts and consumer goods',
    categories: [
      'ceramics', 'art ceramics', 'glass artware', 'kitchenware', 'tableware',
      'cookware', 'household items', 'housewares', 'home decoration', 'home decor',
      'gardening', 'festival products', 'christmas', 'gifts', 'premiums', 'clocks',
      'watches', 'optical instruments', 'weaving', 'rattan', 'iron products',
      'building materials', 'decorative materials', 'sanitary', 'bathroom equipment',
      'furniture', 'stone decoration', 'outdoor spa', 'vases', 'candles', 'photo frames'
    ]
  },
  3: {
    fairDates: '31 October - 4 November 2026',
    travelDates: null,
    hasPackage: false,
    label: 'Textiles, clothing, toys, food and medical',
    categories: [
      'toys', 'baby products', 'maternity', 'kids wear', 'clothing', 'garments',
      'underwear', 'sports wear', 'casual wear', 'furs', 'leather', 'downs',
      'fashion accessories', 'textile', 'fabrics', 'shoes', 'footwear', 'cases',
      'bags', 'luggage', 'home textiles', 'carpets', 'tapestries', 'office supplies',
      'medicines', 'health products', 'medical devices', 'food', 'toiletries',
      'personal care', 'pet products', 'stationery'
    ]
  }
};

function matchPhase(productText = '') {
  const t = String(productText).toLowerCase();
  if (!t.trim()) return null;
  for (const phase of [1, 2, 3]) {
    const p = PHASE_INDEX[phase];
    if (p.categories.some((c) => t.includes(c))) {
      return {
        phase,
        label: p.label,
        fairDates: p.fairDates,
        travelDates: p.travelDates,
        hasPackage: p.hasPackage
      };
    }
  }
  return null;
}

const CANTON_KNOWLEDGE = `
=== VERIFIED PRODUCT: 140th CANTON FAIR, GUANGZHOU (October 2026) ===
These are verified Escapenfly facts. They override anything you think you know
about Canton Fair or about travel to China. If something a customer asks is not
answered here, say you will check and route them to a human. Do not improvise.

THE FAIR
The 140th Canton Fair (China Import and Export Fair), held in Guangzhou, China
at the China Import & Export Complex. Running since 1957. Over 1.8 million square
metres, 60,000+ exhibitors, delegates from 220+ countries. The full fair runs
15 October to 4 November 2026.

THREE PHASES, DIFFERENT EXHIBITORS IN EACH
  Phase 1 - fair 15-19 Oct 2026 - electronics, machinery, industrial
  Phase 2 - fair 23-27 Oct 2026 - home, decor, gifts, consumer goods
  Phase 3 - fair 31 Oct - 4 Nov 2026 - textiles, clothing, toys, food, medical

THE ESCAPENFLY PACKAGE - escorted group, ex-Delhi, 6 nights / 7 days
  Phase 1 travel: 13 October - 19 October 2026
  Phase 2 travel: 23 October - 29 October 2026
  Phase 3: NO Escapenfly package exists. If their category is Phase 3, tell them
  so honestly and offer to have a consultant look at alternatives. Never push a
  Phase 3 buyer onto a Phase 1 or Phase 2 departure - they would see almost
  nothing they can source.

ONE BOOKING COVERS
  - Round-trip airfare
  - 06 nights, 4-star hotel
  - Daily breakfast + Indian dinner
  - China entry documentation arranged by Escapenfly's China DMC
  - Travel insurance
  - Hong Kong city tour
  - Guangzhou / Foshan city tour
  - Transport to and from the fairground each day
  - Tour co-ordinator with the group throughout

THE ENTRY ROUTE - HANDLED BY OUR CHINA DMC
Escapenfly's China DMC arranges the China entry documentation for the whole
group - the traveller does not deal with it themselves, and you may say so.
The group flies into Hong Kong and continues to Guangzhou from there. The
traveller only needs to provide a passport copy and a return ticket; the DMC
arranges the rest.
DO NOT say the trip is visa-free or that no China visa is needed - it is NOT
visa-free for an Indian passport. DO NOT say there is no visa wait or quote
any processing time. DO NOT name a visa type or category.
HARD LIMIT: never promise entry approval. Final admission is the border
officer's decision, not Escapenfly's. Any question about eligibility,
documents, whether a particular passport qualifies, timing, or refusal risk
goes to Damini on the visa desk. Say the visa desk will confirm. Do not guess
and do not reassure.

WHY THIS PACKAGE EXISTS
Most Indian importers never make it to Canton Fair because the visa, the flights,
the hotel, the daily commute to the fairground and the language all have to be
solved separately first. This solves all of it in one booking.

HOW TO RUN THE CONVERSATION
1. Ask what they source. This is the first question, every time - it decides
   their phase, and the wrong phase wastes the whole trip.
2. Tell them their phase, its fair dates and its travel dates.
3. Ask their city and how many people are travelling.
4. Hand to a human consultant to quote and book.

HARD RULES
  - NEVER quote, estimate, confirm or hint at a price. Not per person, not a
    range, not "around". Pricing comes from a human consultant only.
  - NEVER confirm a booking or hold a seat.
  - NEVER promise visa or entry approval.
  - NEVER invent departure dates, discounts or urgency. Do not say "only X seats
    left" or "price rising" unless Escapenfly has given you that fact here.
  - Bookings close 15 October 2026.
  - Category lists are subject to change; the official Canton Fair website is
    the final word.
=== END CANTON FAIR ===
`.trim();

module.exports = {
  CANTON_KNOWLEDGE,
  CANTON_EXPIRES_AT,
  CANTON_KEYWORDS,
  CANTON_CAMPAIGN_CODES,
  CANTON_BROADCAST_CODES,
  PHASE_INDEX,
  isCantonEnquiry,
  matchPhase
};
