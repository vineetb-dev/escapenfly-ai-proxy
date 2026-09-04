// ═══════════════════ FROZEN CONTEXT RESOLUTION ═══════════════════
// Mirrors mayaTurn's context-resolution block (server.js, the code between
// "chat.msgs.push({ role: 'user', ... })" and "const parsed = await
// callMayaJSON(...)" — roughly lines 2528-2589 as of commit b435bc9,
// 2026-08-13) SEQUENCE-FOR-SEQUENCE, using the same exported helper
// functions, so this harness never re-implements the underlying Supabase
// lookups themselves — only the ordering/fallback logic around them.
//
// Hunk C (extracting mayaTurn's block into a shared resolveMayaContext()
// function) was explicitly rejected for V1 — see conversation record. This
// file is the accepted alternative: re-implement the sequencing, with the
// real block quoted verbatim directly above the mirrored line so a drift
// check is a visual diff, not a re-read of server.js. If server.js's block
// ever changes, re-paste it here and diff by eye.
//
// ONE DELIBERATE SIMPLIFICATION (the only one — documented, not hidden):
// mayaTurn's fallback uses `chat.known.destination` / `chat.known.intent`,
// which in production is populated from each model's OWN parsed.lead
// output from earlier turns. Using a model's own extraction here would
// make the frozen context diverge per model (exactly what freezing is
// meant to prevent). Instead this harness derives the fallback destination
// from the SCENARIO SCRIPT's own prior customer messages (re-run through
// the same allFounderDestinationKeyMatches/allVisaIntelDestinationKeyMatches
// functions used in production) — deterministic, identical for every model,
// and a faithful stand-in since chat.known.destination in practice just
// reflects what was actually said in the conversation so far.
//
// `phone` is always a synthetic, clearly-non-real string ('modeltest-<id>')
// so validPhone() rejects it and loadEnquiryStatus/loadPastDestinations/
// loadCustomerProfile all resolve to empty — no real CRM data is read for
// any test scenario, by construction, not by convention.

const maya = require('../../../server.js');

/**
 * @param {object} args
 * @param {string} args.message              - this turn's customer message
 * @param {string} args.priorKnownDestination - the destination "known" so far
 *                                              from turns BEFORE this one only
 *                                              (never derived from this
 *                                              turn's own extraction — see
 *                                              note below). '' on turn 0,
 *                                              exactly like chat.known.destination
 *                                              is always empty on turn 0 in
 *                                              production.
 * @param {number} args.turnIndex             - 0-based turn number
 * @param {string} args.phone                 - synthetic test phone
 * @returns {Promise<object>} frozen context, passed unchanged into every
 *          model's callMayaJSON() call for this turn
 */
async function resolveFrozenContext({ message, priorKnownDestination, turnIndex, phone, syntheticReturningProfile }) {
  // ── mirrors: const messageDestKey = guessDestinationKeyFromMessage(message); ──
  const messageDestKey = maya.guessDestinationKeyFromMessage(message);

  // ── mirrors: messageFounderKeys / knownFounderKeys / founderDestKeys / founderNotesList ──
  //   const messageFounderKeys = await allFounderDestinationKeyMatches(message);
  //   const knownFounderKeys = await allFounderDestinationKeyMatches(chat.known?.destination || '');
  //   const founderDestKeys = messageFounderKeys.length ? messageFounderKeys : knownFounderKeys;
  //   const founderNotesList = founderDestKeys.length
  //     ? (await Promise.all(founderDestKeys.map(k => loadFounderNotes(k)))).filter(Boolean)
  //     : [];
  const messageFounderKeys = await maya.allFounderDestinationKeyMatches(message);
  const priorFounderKeys = await maya.allFounderDestinationKeyMatches(priorKnownDestination || '');
  const founderDestKeys = messageFounderKeys.length ? messageFounderKeys : priorFounderKeys;
  const founderNotesList = founderDestKeys.length
    ? (await Promise.all(founderDestKeys.map(k => maya.loadFounderNotes(k)))).filter(Boolean)
    : [];

  // ── mirrors: messageVisaKeys / knownVisaKeys / visaDestKeys / visaIntelList ──
  const messageVisaKeys = await maya.allVisaIntelDestinationKeyMatches(message);
  const priorVisaKeys = await maya.allVisaIntelDestinationKeyMatches(priorKnownDestination || '');
  const visaDestKeys = messageVisaKeys.length ? messageVisaKeys : priorVisaKeys;
  const visaIntelList = visaDestKeys.length
    ? (await Promise.all(visaDestKeys.map(k => maya.loadVisaIntelligence(k)))).filter(Boolean)
    : [];

  // ── mirrors: destInfo / liveWeather / forexRate ──
  //   const destInfo = messageDestKey ? lookupDestinationInfo(messageDestKey)
  //     : (chat.known?.destination ? lookupDestinationInfo(chat.known.destination) : lookupDestinationInfo(message));
  // BUG FIXED before any model was called (caught by the pre-run smoke test):
  // this used to fall back to THIS turn's own founderDestKeys/visaDestKeys,
  // which don't exist yet at this point in real production timing (on turn
  // 0, chat.known.destination is always '' — it's only ever populated FROM
  // a prior turn's parsed output). Now uses priorKnownDestination only,
  // which the caller threads forward strictly from completed turns.
  const destInfo = messageDestKey
    ? maya.lookupDestinationInfo(messageDestKey)
    : (priorKnownDestination ? maya.lookupDestinationInfo(priorKnownDestination) : maya.lookupDestinationInfo(message));
  const [liveWeather, forexRate] = destInfo
    ? await Promise.all([maya.loadLiveWeather(destInfo.city), maya.loadForexRate(destInfo.currency)])
    : [null, null];

  // ── mirrors: effectiveIntent ──
  //   const effectiveIntent = chat.known?.intent || guessIntentFromMessage(message);
  // SIMPLIFICATION: always guesses fresh from this message rather than a
  // stored known.intent — lower stakes than the destination fallback above
  // (it only affects STAGE_LOGIC branching, not injected data), documented
  // here rather than silently approximated.
  const effectiveIntent = maya.guessIntentFromMessage(message);

  // ── mirrors: statusLookupPhone / enquiryStatus / pastDestinations / isNewSession / returningProfile ──
  //   const statusLookupPhone = validPhone(phone) ? phone : (message.match(/\b[6-9]\d{9}\b/) || [])[0];
  //   const enquiryStatus = await loadEnquiryStatus(statusLookupPhone);
  //   const pastDestinations = await loadPastDestinations(statusLookupPhone);
  //   const isNewSession = !chat.known?.name && !chat.known?.destination;
  //   const returningProfile = (isNewSession && validPhone(statusLookupPhone)) ? await loadCustomerProfile(statusLookupPhone) : {};
  const statusLookupPhone = maya.validPhone(phone) ? phone : (message.match(/\b[6-9]\d{9}\b/) || [])[0];
  const enquiryStatus = await maya.loadEnquiryStatus(statusLookupPhone);
  const pastDestinations = await maya.loadPastDestinations(statusLookupPhone);
  // SIMPLIFICATION: isNewSession approximated as "turn 0 of the scenario"
  // rather than chat.known.name/.destination — correct for all pilot
  // scenarios (none open with a name already known).
  const isNewSession = turnIndex === 0;
  // Harness-only override: the frozen-context phone is always synthetic/
  // invalid (validPhone() rejects it by design — see the file header), so
  // loadCustomerProfile() would always return {}. When a scenario declares
  // syntheticReturningProfile (e.g. existing_04_repeat_customer_new_trip),
  // use it directly INSTEAD of the real Supabase lookup — no real
  // customer_profile row is ever read or written by this harness.
  const returningProfile = syntheticReturningProfile
    ? syntheticReturningProfile
    : (isNewSession && maya.validPhone(statusLookupPhone))
      ? await maya.loadCustomerProfile(statusLookupPhone) : {};

  return {
    founderDestKeys, founderNotesList,
    visaDestKeys, visaIntelList,
    effectiveIntent, liveWeather, forexRate,
    statusLookupPhone, enquiryStatus, pastDestinations, returningProfile,
    // What THIS turn established, for the caller to pass as the NEXT turn's
    // priorKnownDestination. Never used within this same call — see the
    // destInfo fix above for exactly why that distinction matters.
    newKnownDestination: messageDestKey || founderDestKeys[0] || visaDestKeys[0] || priorKnownDestination || ''
  };
}

module.exports = { resolveFrozenContext };
