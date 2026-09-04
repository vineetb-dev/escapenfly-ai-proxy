#!/usr/bin/env node
// ═══════════════════ SCENARIO ASSEMBLY (build step, not the runner) ═══════════════════
// Assembles the full 65-scenario tests/model-lab/scenarios.json from three sources:
//   1. The 37 existing scenarios in tests/test-cases.json — copied VERBATIM (not
//      modified in place; that file is untouched), with expectedLead appended.
//   2. The 8 pilot scenarios already in this file (read before being overwritten) —
//      same treatment.
//   3. 20 new scenarios, defined below.
//
// Every expectedLead value in this file was derived by READING each scenario's
// customerTurns text and reasoning about what a correct extraction should contain —
// NOT by looking at tests/model-lab/results/*/raw-results.json (the pilot's actual
// model output). That file was deliberately not opened while writing this. Fields
// are included only where the customerTurns make them unambiguous; omitted fields
// are not asserted either way (not "expected empty").
//
// Run: node tests/model-lab/build-scenarios.js
// Idempotent — re-running regenerates scenarios.json from these definitions.

const fs = require('fs');
const path = require('path');

const EXISTING_PATH = path.join(__dirname, '../test-cases.json');
const CURRENT_SCENARIOS_PATH = path.join(__dirname, 'scenarios.json');
const OUTPUT_PATH = path.join(__dirname, 'scenarios.json');

// ── expectedLead for the 37 existing scenarios, keyed by id ──
// Derived from tests/test-cases.json's own customerTurns text only.
const EXISTING_LEAD = {
  visa_01_basic_tourist: { name: 'Vineet', destination: 'France', travel_month: 'September', pax: '2', type: 'visa' },
  visa_02_dubai_uae: { name: 'Vineet Bansal', destination: 'Dubai', travel_month: 'December', pax: '2', budget: '2 lakh' },
  visa_03_no_destination_yet: { type: 'visa' },
  visa_04_schengen_general: { destination: 'Europe', type: 'visa' },
  visa_05_visa_plus_holiday: { destination: 'Thailand', budget: '1.5 lakh', type: 'holiday' },
  visa_06_refusal_history: { destination: 'UK', type: 'visa' },
  holiday_01_basic_qualify: { destination: 'Bali', type: 'holiday' },
  holiday_02_itinerary_request: { destination: 'Singapore', type: 'holiday' },
  holiday_03_full_qualify_to_handover: { name: 'Vineet', destination: 'Dubai', travel_month: 'December', pax: '2', budget: '2 lakh', type: 'holiday' },
  holiday_04_honeymoon: { destination: 'Maldives', departure_city: 'Chandigarh', travel_style: 'honeymoon', pax: '2', type: 'holiday' },
  holiday_05_family_with_kids: { destination: 'Thailand', pax: '4', travel_style: 'family', type: 'holiday' },
  holiday_06_senior_citizens: { destination: 'Europe', pax: '2', type: 'holiday' },
  holiday_07_group_booking: { destination: 'Vietnam', pax: '15', travel_style: 'group', type: 'holiday' },
  holiday_08_price_sensitive: { destination: 'Goa', pax: '4', type: 'holiday' },
  holiday_09_luxury: { destination: 'Maldives', pax: '2', type: 'holiday' },
  holiday_10_destination_switch: { destination: 'Vietnam', type: 'holiday' },
  flights_01_basic: { destination: 'Dubai', departure_city: 'Delhi', travel_month: 'November', type: 'flights' },
  flights_02_cabin_class: { destination: 'London', departure_city: 'Mumbai', travel_month: 'March', pax: '2', cabin_class: 'business', type: 'flights' },
  flights_03_flexible_dates: { destination: 'Bangkok', travel_month: 'February', type: 'flights' },
  flights_04_no_outbound_link: { destination: 'Singapore', departure_city: 'Delhi', pax: '2', cabin_class: 'economy', travel_month: 'December', type: 'flights' },
  hotel_01_basic: { destination: 'Goa', type: 'hotel' },
  hotel_02_category_given: { destination: 'Dubai', hotel_category: '4-star', check_in: '10th December', check_out: '15th December', pax: '2', type: 'hotel' },
  hotel_03_no_outbound_link: { destination: 'Bangkok', hotel_category: '3-star', check_in: '12th January', check_out: '16th January', pax: '2', type: 'hotel' },
  existing_01_reference_first: { type: 'existing_booking' },
  existing_02_cancellation: { booking_reference: 'ENF-12345', type: 'existing_booking' },
  existing_03_upset_customer: {},
  cross_01_multi_question: { destination: 'Japan', pax: '2', type: 'holiday' },
  cross_02_incomplete_info: {},
  cross_03_advice_only_no_intent_to_buy: { destination: 'Japan' },
  cross_04_difficult_question: { destination: 'USA', type: 'visa' },
  cross_05_off_topic: {},
  cross_06_solo_traveller: { destination: 'Vietnam', pax: '1', travel_style: 'solo', type: 'holiday' },
  cross_07_first_time_vs_experienced: { destination: 'Bali', travel_month: 'March', pax: '2', budget: '1.5 lakh', type: 'holiday' },
  cross_08_conversation_length: { name: 'Vineet', destination: 'Dubai', travel_month: 'December', pax: '2', budget: '2 lakh', type: 'holiday' },
  consultative_01_budget_question: { destination: 'Thailand', travel_month: 'December', pax: '2', type: 'holiday' },
  consultative_02_travel_style_question: { destination: 'Vietnam', type: 'holiday' },
  consultative_03_no_stacked_form_ask: { destination: 'Bali', pax: '4', travel_style: 'family', type: 'holiday' }
};

// ── expectedLead for the 8 pilot scenarios, keyed by id ──
// Derived from their customerTurns text only, NOT from raw-results.json.
const PILOT_LEAD = {
  pilot_honeymoon_maldives: { destination: 'Maldives', travel_style: 'honeymoon', pax: '2', budget: '3 lakh', type: 'holiday' },
  pilot_changing_nights_bali: { destination: 'Bali', pax: '4', travel_style: 'family', type: 'holiday' },
  pilot_changing_budget_thailand: { destination: 'Thailand', pax: '2', budget: '3 lakh', type: 'holiday' },
  pilot_unrealistic_budget_switzerland: { destination: 'Switzerland', pax: '2', budget: '60,000', type: 'holiday' },
  pilot_seasonal_iceland: { destination: 'Iceland', travel_month: 'July', type: 'holiday' },
  pilot_destination_comparison_bali_vietnam: { pax: '2', type: 'holiday' },
  pilot_destination_redirect_maldives_budget: { destination: 'Maldives', pax: '2', budget: '50,000', type: 'holiday' },
  pilot_visa_schengen_uk: { destination: 'France', type: 'visa' }
};

// ── 20 new scenarios — 8 kept/revised from the original 12-sketch, 12 fresh ──
// (4 of the original 12 sketched IDs were dropped as redundant with pilot
// coverage — holiday_11/12/13/15 — see the coverage matrix in chat.)
const NEW_SCENARIOS = [
  {
    id: 'holiday_14_itinerary_change', category: 'itinerary_changes',
    description: 'Customer revises the shape of the trip, not the destination/budget/dates',
    customerTurns: [
      'Kerala trip for 6 nights, backwaters and hill stations, 2 of us',
      "Actually, less hill station time — we'd rather do more beach and relaxation instead"
    ],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Kerala', pax: '2', type: 'holiday' },
    notes: 'KEY TEST: itinerary change, not destination/budget/date change — does she genuinely revise the shape of the trip (more beach, less hill station) or just acknowledge and repeat the original plan?'
  },
  {
    id: 'holiday_16_seasonal_monsoon', category: 'seasonal_timing',
    description: 'Monsoon-season mismatch — a different judgment than the Iceland "impossible" case',
    customerTurns: ['Thinking Kerala in July for a relaxed beach holiday, 2 of us.'],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Kerala', travel_month: 'July', pax: '2', type: 'holiday' },
    notes: "July is peak monsoon in Kerala — genuinely different judgment than Iceland's binary case: monsoon doesn't rule out the trip, but changes what's enjoyable and needs itinerary adjustment, not a flat no. KEY TEST: does she frame this as an adjustment, not a blanket refusal or a blanket ignore?"
  },
  {
    id: 'holiday_17_luxury_family', category: 'luxury',
    description: 'Luxury with a family (teenagers), distinct from the existing childless-honeymoon luxury test',
    customerTurns: ["Looking for a proper luxury holiday for our family — 2 adults, 2 teenagers — Maldives or somewhere similar. Budget isn't really a constraint, we just want the best."],
    expectedIntent: 'holiday',
    mustNotSay: ['cheap', 'budget option', 'affordable'],
    expectedLead: { destination: 'Maldives', pax: '4', travel_style: 'family', type: 'holiday' },
    notes: "Distinct from the existing luxury test (childless honeymoon) — luxury WITH kids is a different planning problem. KEY TEST: does the response genuinely reflect BOTH 'luxury' and 'family with teenagers' together, or default to a generic high-end pitch that ignores the family angle?"
  },
  {
    id: 'visa_07_feasibility_judgment', category: 'visa',
    description: 'Visa feasibility judgment after a prior rejection with a different country',
    customerTurns: ['I have a previous visa rejection from Canada, want to try Australia this time — realistic chances?'],
    expectedIntent: 'visa',
    mustNotSay: ['guaranteed', '100%', 'definitely approved', 'no problem at all'],
    expectedLead: { destination: 'Australia', type: 'visa' },
    notes: "KEY TEST: does she decline to predict odds (matching the existing 'never guarantee' rule) while still being useful, without conflating a Canada rejection with Australia's own separate process?"
  },
  {
    id: 'visa_08_disagrees_with_maya', category: 'objections',
    description: 'Customer directly challenges a correct visa fact',
    customerTurns: [
      'Do I need a visa for Sri Lanka as an Indian?',
      'My friend went last year without any visa at all, are you sure?'
    ],
    expectedIntent: 'visa',
    expectedLead: { destination: 'Sri Lanka', type: 'visa' },
    notes: "Sri Lanka requires an ETA for Indian passport holders — a lightweight online process a friend might casually describe as 'no visa.' KEY TEST: when directly challenged with 'are you sure', does she hold the correct fact without being defensive, wavering into false agreement, or restating something wrong to avoid conflict?"
  },
  {
    id: 'cross_09_conflicting_requirements_across_turns', category: 'conflicting_requirements',
    description: 'Headcount changes drastically while budget stays fixed, across turns',
    customerTurns: [
      'Want a Bali trip, 2 of us, budget around 1.5 lakh.',
      'Actually make it a group of 8 — my whole friend circle is coming too.',
      'Same budget though, 1.5 lakh total still.'
    ],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Bali', pax: '8', budget: '1.5 lakh', type: 'holiday' },
    notes: 'Budget staying fixed while headcount jumps 2→8 is a genuine internal conflict. KEY TEST: does she catch and gently surface this rather than silently accepting both contradictory facts as if they still both hold?'
  },
  {
    id: 'cross_10_objects_to_recommendation', category: 'objections',
    description: 'Customer pushes back on a specific recommendation, not a fact',
    customerTurns: [
      'Family trip to Thailand, 2 adults 2 kids, budget 1.5 lakh, want somewhere with a good beach.',
      "I don't love your Phuket idea, we did that already, give me something else."
    ],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Thailand', pax: '4', travel_style: 'family', budget: '1.5 lakh', type: 'holiday' },
    notes: "Distinct from visa_08's factual disagreement — this is pushback on a RECOMMENDATION. KEY TEST: does she offer a genuinely different, well-reasoned alternative (not Phuket again with different wording), without being defensive?"
  },
  {
    id: 'existing_04_repeat_customer_new_trip', category: 'repeat_customer',
    description: 'Returning customer starting a fresh enquiry',
    customerTurns: ['Hi, thinking about a trip to Japan this time.'],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Japan', type: 'holiday' },
    // Harness-only mechanism (tests/model-lab, not production): the frozen-context
    // phone is always synthetic/invalid, so loadCustomerProfile() would always
    // return {} — this scenario needs a genuine returning-customer profile to be
    // meaningful. syntheticReturningProfile is injected directly by the harness
    // INSTEAD of the real Supabase lookup for this one scenario only — no real
    // customer_profile row is read or written anywhere.
    syntheticReturningProfile: { name: 'Priya', destination: 'Bali', travelMonth: 'March' },
    notes: 'REQUIRES a synthetic returningProfile override — see syntheticReturningProfile above. KEY TEST: does she use the returning-customer context naturally (greet by name, not assume same-trip continuity) without forcing it or ignoring it?'
  },
  {
    id: 'new_changing_dates_01', category: 'changing_dates',
    description: 'Clean month swap due to a stated real-world constraint',
    customerTurns: [
      'Planning a Dubai trip for December, 2 of us.',
      "Actually my leave got approved for January instead, let's shift to that."
    ],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Dubai', pax: '2', travel_month: 'January', type: 'holiday' },
    notes: 'KEY TEST: does she cleanly update to January (not append it alongside December, not silently keep planning around December-specific things)?'
  },
  {
    id: 'new_changing_dates_02', category: 'changing_dates',
    description: 'Vaguer date shift — a range, not a clean swap',
    customerTurns: [
      'Looking at a Europe trip, thinking early April, 2 people.',
      'We might actually need to push it to late April or even May — work is uncertain right now.'
    ],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Europe', pax: '2', type: 'holiday' },
    notes: 'A vaguer date shift than new_changing_dates_01. KEY TEST: does she handle the uncertainty gracefully (acknowledge flexibility) rather than demanding a single locked-in month?'
  },
  {
    id: 'new_lead_extraction_dense_01', category: 'lead_extraction',
    description: 'All lead fields given at once, in a single dense message',
    customerTurns: ["Hi, I'm Rohan, want to plan a honeymoon to Bali for me and my wife, sometime in November, budget around 2.5 lakh."],
    expectedIntent: 'holiday',
    expectedLead: { name: 'Rohan', destination: 'Bali', travel_style: 'honeymoon', pax: '2', travel_month: 'November', budget: '2.5 lakh', type: 'holiday' },
    notes: 'Pure extraction-accuracy stress test — name, destination, style, implied pax, month, and budget all in one message. KEY TEST: does the very first parsed.lead capture all of this correctly in one shot?'
  },
  {
    id: 'new_lead_extraction_fragmented_01', category: 'lead_extraction',
    description: 'Same total information as the dense case, spread across 7 short fragments',
    customerTurns: ['Hi', 'Thinking of a trip somewhere', 'Maybe Vietnam', 'Around March', 'Just me and my partner', 'Budget wise maybe 1.2 lakh', "My name's Ananya by the way"],
    expectedIntent: 'holiday',
    expectedLead: { name: 'Ananya', destination: 'Vietnam', travel_month: 'March', pax: '2', budget: '1.2 lakh', type: 'holiday' },
    notes: 'KEY TEST: cumulative extraction accuracy over many turns — does the FINAL parsed.lead correctly hold everything by the last turn, with nothing dropped as fragments arrive?'
  },
  {
    id: 'new_family_teenagers_01', category: 'family_travel',
    description: 'Family with teenagers, not young kids',
    customerTurns: ['Family trip, me and my husband plus our two teenagers, 15 and 17. Thinking Thailand.'],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Thailand', pax: '4', travel_style: 'family', type: 'holiday' },
    notes: "Teenagers need different planning than young kids (activity/independence-friendly, not kid-proofing). KEY TEST: does the response actually differentiate teenager-appropriate suggestions, or treat all 'family' the same regardless of kids' ages?"
  },
  {
    id: 'new_family_multigenerational_01', category: 'family_travel',
    description: 'Three generations travelling together',
    customerTurns: ['Planning a trip with my parents (both 68), my wife and me, and our 6-year-old — 3 generations travelling together. Thinking Singapore.'],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Singapore', pax: '5', travel_style: 'family', type: 'holiday' },
    notes: 'Senior mobility needs + a young child at once is genuinely harder than either alone. KEY TEST: does she acknowledge and plan around BOTH constraints together, not just one?'
  },
  {
    id: 'new_destination_comparison_food_01', category: 'destination_comparison',
    description: 'A different comparison axis (food) than the pilot\'s "no adventure" framing',
    customerTurns: ['Trying to decide between Japan and South Korea for a 8-day trip, just the two of us — food is honestly the main priority.'],
    expectedIntent: 'holiday',
    expectedLead: { pax: '2', type: 'holiday' },
    notes: "KEY TEST: does the comparison actually engage with 'food' specifically (street food culture, dining style, cost), rather than defaulting to a generic sightseeing comparison?"
  },
  {
    id: 'new_objections_contact_info_01', category: 'objections',
    description: 'Customer objects to being asked for contact info',
    customerTurns: [
      'Thailand trip, 2 of us, December, budget 1.2 lakh.',
      "Why do you need my phone number, can't you just tell me the price here?"
    ],
    expectedIntent: 'holiday',
    mustNotSay: ['mandatory', 'required to proceed', 'cannot help without'],
    expectedLead: { destination: 'Thailand', pax: '2', travel_month: 'December', budget: '1.2 lakh', type: 'holiday' },
    notes: 'A real, common objection pattern. KEY TEST: does she explain the value exchange naturally and respectfully, without being pushy, evasive, or making the phone number sound mandatory?'
  },
  {
    id: 'new_conflicting_requirements_single_turn_01', category: 'conflicting_requirements',
    description: 'Conflict stated within ONE turn, not built up across turns',
    customerTurns: ['Want a 5-star luxury Maldives honeymoon but our budget is only 70,000 total for both of us.'],
    expectedIntent: 'holiday',
    mustNotSay: ['not possible', 'impossible', 'cannot do'],
    expectedLead: { destination: 'Maldives', travel_style: 'honeymoon', pax: '2', budget: '70,000', type: 'holiday' },
    notes: 'KEY TEST: does she surface the 5-star-vs-70k mismatch honestly and redirect constructively, rather than pretending both are compatible or bluntly refusing?'
  },
  {
    id: 'new_incomplete_named_destination_only_01', category: 'incomplete_information',
    description: 'Destination given, everything else explicitly not yet decided',
    customerTurns: ['Interested in Vietnam. Not sure about anything else yet.'],
    expectedIntent: 'holiday',
    expectedLead: { destination: 'Vietnam', type: 'holiday' },
    notes: "Distinct incompleteness flavor from cross_02's near-blank 'hi'. KEY TEST: does she ask ONE natural next question, given the customer already signaled they're still figuring things out?"
  },
  {
    id: 'new_existing_booking_plus_new_trip_01', category: 'existing_booking',
    description: 'Booking-support conversation that pivots into a new enquiry',
    customerTurns: [
      'Hi, I have a booking with you already, reference ENF-98765, wanted to check the status.',
      'Also separately, we\'re thinking of planning another trip, maybe Vietnam next year.'
    ],
    expectedIntent: 'existing_booking',
    mustNotAsk: ['destination', 'budget'],
    expectedLead: { booking_reference: 'ENF-98765', type: 'existing_booking' },
    notes: 'KEY TEST: does she handle the reference/status request properly first, then transition naturally into the new enquiry, rather than conflating the two or dropping one?'
  },
  {
    id: 'new_couple_anniversary_01', category: 'honeymoon_couple',
    description: 'Anniversary trip for an established couple, distinct from a honeymoon',
    customerTurns: ['Planning our 5th anniversary trip, thinking somewhere in Europe. Just my wife and me.'],
    expectedIntent: 'holiday',
    mustNotAsk: ['how many people', 'number of travellers'],
    expectedLead: { destination: 'Europe', pax: '2', type: 'holiday' },
    notes: "Distinct from the honeymoon test — an established couple, not newlyweds. KEY TEST: does she correctly infer 2 travellers without asking, and does the tone genuinely fit 'anniversary' rather than defaulting to honeymoon-flavored language?"
  }
];

function main() {
  const existing = JSON.parse(fs.readFileSync(EXISTING_PATH, 'utf8'));
  const pilot = JSON.parse(fs.readFileSync(CURRENT_SCENARIOS_PATH, 'utf8'));

  const existingWithLead = existing.map(s => {
    const lead = EXISTING_LEAD[s.id];
    if (lead === undefined) throw new Error(`Missing expectedLead mapping for existing scenario: ${s.id}`);
    return { ...s, expectedLead: lead };
  });
  const pilotWithLead = pilot.map(s => {
    const lead = PILOT_LEAD[s.id];
    if (lead === undefined) throw new Error(`Missing expectedLead mapping for pilot scenario: ${s.id}`);
    return { ...s, expectedLead: lead };
  });

  const all = [...existingWithLead, ...pilotWithLead, ...NEW_SCENARIOS];

  const ids = all.map(s => s.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new Error(`Duplicate scenario id(s): ${[...new Set(dupes)].join(', ')}`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(all, null, 2));

  const totalTurns = all.reduce((s, c) => s + c.customerTurns.length, 0);
  console.log(`Wrote ${all.length} scenarios (${existingWithLead.length} existing + ${pilotWithLead.length} pilot + ${NEW_SCENARIOS.length} new) to ${OUTPUT_PATH}`);
  console.log(`Total turns: ${totalTurns} | avg turns/scenario: ${(totalTurns / all.length).toFixed(3)}`);
  console.log(`expectedLead coverage: ${all.filter(s => s.expectedLead).length}/${all.length}`);
}

main();
