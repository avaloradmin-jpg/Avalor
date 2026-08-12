// Avalor — Appraisal calculation engine

// BCIS Q1 2026 benchmark rates, £/m², ex-VAT, UK national average — excludes
// professional fees and contingency. Adjusted per-appraisal by REGION_TIERS.
const BCIS = {
  'Loft conversion':          { low: 1150, mid: 1450, high: 1900 },
  'Flat conversion':          { low: 1150, mid: 1550, high: 2150 },
  'HMO conversion':           { low: 1150, mid: 1450, high: 1900 },
  'Cosmetic refurbishment':   { low: 150,  mid: 300,  high: 550  },
  'Light refurbishment':      { low: 600,  mid: 850,  high: 1150 },
  'Full refurbishment':       { low: 1150, mid: 1400, high: 1900 },
  'New build':                { low: 1400, mid: 1850, high: 2450 }
};

// Regional build cost tier vs UK national average (1.00) — labour, access and
// materials delivery costs vary well below national-region level, which is why
// London is split Inner/Outer, the South East is split Home Counties vs
// outer/coastal, and the old combined premium cluster is split into Oxford/
// Cambridge vs Bristol/Bath (different markets). Region is derived from the
// postcode (see resolveRegionTier below), not chosen by the user — this is
// also where the GDV regional fallback (ppm/growth) figures live, used when
// Land Registry data is sparse. ppm sourced from Plumplot (London, Jun 2026),
// Investropa (Manchester/NW metro, 2026) and ONS regional average house
// prices (NW/Yorkshire/W Mids/E Mids/NE/Wales/national); remaining tiers
// interpolated from those anchors. Growth rates are unchanged first-pass
// estimates carried over from the original 7-region split.
const REGION_TIERS = {
  'Inner London':                        { mult: 1.35, ppm: 9500, growth: 5.8 },
  'Outer London':                        { mult: 1.25, ppm: 6800, growth: 5.8 },
  'South East (Home Counties)':          { mult: 1.10, ppm: 4600, growth: 6.2 },
  'South East (outer/coastal)':          { mult: 1.05, ppm: 3900, growth: 6.2 },
  'Oxford & Cambridge':                  { mult: 1.12, ppm: 5200, growth: 6.0 },
  'Bristol & Bath':                      { mult: 1.05, ppm: 3900, growth: 6.0 },
  'East of England':                     { mult: 1.02, ppm: 3800, growth: 6.0 },
  'South West':                          { mult: 0.98, ppm: 3400, growth: 5.9 },
  'North West (Manchester, Liverpool)':  { mult: 0.96, ppm: 3000, growth: 7.1 },
  'Yorkshire & Humber':                  { mult: 0.95, ppm: 2700, growth: 6.5 },
  'West Midlands':                       { mult: 0.95, ppm: 2900, growth: 6.8 },
  'East Midlands':                       { mult: 0.94, ppm: 2850, growth: 6.8 },
  'Wales':                               { mult: 0.92, ppm: 2600, growth: 6.5 },
  'North West (rest)':                   { mult: 0.92, ppm: 2500, growth: 7.1 },
  'North East':                          { mult: 0.90, ppm: 2300, growth: 5.4 }
};

// Postcode areas (E, N, NW, SE, SW, W) that straddle Inner/Outer London need
// district-level resolution — e.g. SW1 (Chelsea, Inner) vs SW19 (Wimbledon,
// Outer) share an area but not a tier. Outcodes below are Inner London;
// anything else in these areas is Outer London.
const LONDON_SPLIT_AREAS = ['E', 'N', 'NW', 'SE', 'SW', 'W'];
const INNER_LONDON_OUTCODES = new Set([
  'E1', 'E2', 'E3', 'E5', 'E8', 'E9', 'E14',
  'N1', 'N4', 'N5', 'N7', 'N16', 'N19',
  'NW1', 'NW3', 'NW5', 'NW6', 'NW8',
  'SE1', 'SE5', 'SE8', 'SE11', 'SE14', 'SE15', 'SE16', 'SE17', 'SE24',
  'SW1', 'SW2', 'SW3', 'SW4', 'SW5', 'SW6', 'SW7', 'SW8', 'SW9', 'SW10', 'SW11', 'SW12',
  'W1', 'W2', 'W6', 'W8', 'W9', 'W10', 'W11', 'W12', 'W14'
]);
// Whole postcode areas that sit entirely inside Greater London (no district
// split needed) — EC/WC are Inner, the rest are the outer-borough areas.
const INNER_LONDON_WHOLE_AREAS = new Set(['EC', 'WC']);
const OUTER_LONDON_WHOLE_AREAS = new Set(['BR', 'CR', 'DA', 'EN', 'HA', 'IG', 'KT', 'RM', 'SM', 'TW', 'UB']);

// Non-London postcode areas only need area-level (not district-level)
// resolution, since these tiers are city/county-scale distinctions.
const AREA_TO_TIER = {
  OX: 'Oxford & Cambridge', CB: 'Oxford & Cambridge',
  BS: 'Bristol & Bath', BA: 'Bristol & Bath',

  GU: 'South East (Home Counties)', RH: 'South East (Home Counties)', SL: 'South East (Home Counties)',
  RG: 'South East (Home Counties)', HP: 'South East (Home Counties)', AL: 'South East (Home Counties)',
  SG: 'South East (Home Counties)', LU: 'South East (Home Counties)', WD: 'South East (Home Counties)',
  MK: 'South East (Home Counties)',

  BN: 'South East (outer/coastal)', TN: 'South East (outer/coastal)', ME: 'South East (outer/coastal)',
  CT: 'South East (outer/coastal)', PO: 'South East (outer/coastal)', SO: 'South East (outer/coastal)',

  CM: 'East of England', CO: 'East of England', IP: 'East of England', NR: 'East of England',
  PE: 'East of England', SS: 'East of England',

  EX: 'South West', PL: 'South West', TR: 'South West', TQ: 'South West', DT: 'South West',
  TA: 'South West', SN: 'South West', SP: 'South West', GL: 'South West', BH: 'South West',

  M: 'North West (Manchester, Liverpool)', L: 'North West (Manchester, Liverpool)',
  SK: 'North West (Manchester, Liverpool)', WA: 'North West (Manchester, Liverpool)',
  BL: 'North West (Manchester, Liverpool)', OL: 'North West (Manchester, Liverpool)',
  WN: 'North West (Manchester, Liverpool)',

  CH: 'North West (rest)', CW: 'North West (rest)', CA: 'North West (rest)', LA: 'North West (rest)',
  PR: 'North West (rest)', FY: 'North West (rest)', BB: 'North West (rest)',

  LS: 'Yorkshire & Humber', S: 'Yorkshire & Humber', HD: 'Yorkshire & Humber', HX: 'Yorkshire & Humber',
  BD: 'Yorkshire & Humber', YO: 'Yorkshire & Humber', HU: 'Yorkshire & Humber', WF: 'Yorkshire & Humber',
  DN: 'Yorkshire & Humber', HG: 'Yorkshire & Humber',

  B: 'West Midlands', CV: 'West Midlands', WV: 'West Midlands', WS: 'West Midlands', DY: 'West Midlands',
  ST: 'West Midlands', TF: 'West Midlands', SY: 'West Midlands', WR: 'West Midlands', HR: 'West Midlands',

  NG: 'East Midlands', LE: 'East Midlands', DE: 'East Midlands', NN: 'East Midlands', LN: 'East Midlands',

  CF: 'Wales', SA: 'Wales', NP: 'Wales', LD: 'Wales', LL: 'Wales',

  NE: 'North East', SR: 'North East', DH: 'North East', DL: 'North East', TS: 'North East'
};

// UK postcodes always have a 3-character inward code (digit + 2 letters) at
// the end, regardless of where the user puts (or omits) the space — so
// normalising means stripping all whitespace, uppercasing, then reinserting
// the space 3 characters from the end. Users shouldn't need to type the
// space correctly for lookups to work. Returns null for input that can't be
// a valid UK postcode (wrong length, or outward/inward shape doesn't match) —
// deliberately excludes the historical "GIR 0AA" format, which none of the
// live data sources resolve anything useful for anyway.
function normalizePostcode(raw) {
  const clean = (raw || '').replace(/\s+/g, '').toUpperCase();
  if (clean.length < 5 || clean.length > 7) return null;
  const inward = clean.slice(-3);
  const outward = clean.slice(0, -3);
  if (!/^[0-9][A-Z]{2}$/.test(inward)) return null;
  if (!/^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(outward)) return null;
  return outward + ' ' + inward;
}

// Outward code (postcode area + district, e.g. "BR1" from "BR1 2EQ") derived
// directly from the postcode string rather than split(' ')[0], so it still
// works if the input isn't already in normalised "space in the right place"
// form.
function postcodeOutward(postcode) {
  const clean = (postcode || '').replace(/\s+/g, '').toUpperCase();
  return clean.length > 3 ? clean.slice(0, -3) : clean;
}

// Postcodes outside the tiers above (Scotland, Northern Ireland, Channel
// Islands, Isle of Man, or anything unparseable) fall back to the UK national
// average rather than guessing — `matched: false` lets the UI flag this
// explicitly rather than silently applying a wrong region.
function resolveRegionTier(postcode) {
  const pcClean = (postcode || '').replace(/\s+/g, '').toUpperCase();
  const outcode = pcClean.length >= 5 ? pcClean.slice(0, -3) : '';
  const areaMatch = outcode.match(/^[A-Z]+/);
  const area = areaMatch ? areaMatch[0] : '';
  // Central London districts often carry a trailing sub-district letter
  // (SW1A, W1A, NW1W, N1C) — strip it so lookups match on area+number only.
  const districtMatch = outcode.match(/^([A-Z]+)(\d+)/);
  const district = districtMatch ? districtMatch[1] + districtMatch[2] : outcode;

  let tierName = null;
  if (area && LONDON_SPLIT_AREAS.includes(area)) {
    tierName = INNER_LONDON_OUTCODES.has(district) ? 'Inner London' : 'Outer London';
  } else if (area && INNER_LONDON_WHOLE_AREAS.has(area)) {
    tierName = 'Inner London';
  } else if (area && OUTER_LONDON_WHOLE_AREAS.has(area)) {
    tierName = 'Outer London';
  } else if (area && AREA_TO_TIER[area]) {
    tierName = AREA_TO_TIER[area];
  }

  if (!tierName) {
    return { name: 'Unmatched postcode', mult: 1.00, ppm: 4200, growth: 6.0, matched: false };
  }
  const tier = REGION_TIERS[tierName];
  return { name: tierName, mult: tier.mult, ppm: tier.ppm, growth: tier.growth, matched: true };
}

// GDV multiplier — how the end-product type is expected to sell relative to
// the raw district median. Conversions produce lower-value stock, a good
// refurb should meet the median, new build commands a premium.
const GDV_MULTIPLIER = {
  'Loft conversion':        0.85,
  'Flat conversion':        0.85,
  'HMO conversion':         0.85,
  'Cosmetic refurbishment': 1.00,
  'Light refurbishment':    1.00,
  'Full refurbishment':     1.00,
  'New build':              1.05
};

const GDV_MULTIPLIER_REASON = {
  'Loft conversion':        'Refurbished or converted stock typically sells at a small discount to the local median',
  'Flat conversion':        'Refurbished or converted stock typically sells at a small discount to the local median',
  'HMO conversion':         'Refurbished or converted stock typically sells at a small discount to the local median',
  'Cosmetic refurbishment': 'A well-executed refurb should achieve close to the local median sold price',
  'Light refurbishment':    'A well-executed refurb should achieve close to the local median sold price',
  'Full refurbishment':     'A well-executed refurb should achieve close to the local median sold price',
  'New build':              'New build typically commands a premium over existing stock'
};

// Dev types where a single property can genuinely become multiple sellable
// units. Everything else stays one unit — the units field is hidden and
// forced to 1 for those.
const MULTI_UNIT_DEV_TYPES = ['Flat conversion', 'HMO conversion', 'New build'];

function updateUnitsVisibility() {
  const devType = document.getElementById('dev-type').value;
  const field = document.getElementById('units-field');
  const input = document.getElementById('units');
  const isMultiUnit = MULTI_UNIT_DEV_TYPES.includes(devType);

  field.style.display = isMultiUnit ? '' : 'none';

  if (!isMultiUnit || devType === 'New build') {
    input.value = 1;
  }
}
updateUnitsVisibility();

// End-product property type for each dev type — used to filter comps.
// Conversions always produce flats regardless of what "Property type" the
// user selected, so this takes priority over PROP_TYPE_TO_PPD_TYPE below.
const DEV_TYPE_TO_PPD_TYPE = {
  'Flat conversion':        'flat-maisonette',
  'Loft conversion':        'flat-maisonette',
  'HMO conversion':         'flat-maisonette',
  'Cosmetic refurbishment': null,
  'Light refurbishment':    null,
  'Full refurbishment':     null,
  'New build':              null
};

// User-selected "Property type" — used to filter comps when the dev type
// doesn't already force an end-product type (refurb/new build, where the
// output type is whatever the user says it is). PPD prefLabel values.
const PROP_TYPE_TO_PPD_TYPE = {
  'Detached house':      'detached',
  'Semi-detached house': 'semi-detached',
  'Terraced house':      'terraced',
  'Flat':                'flat-maisonette'
};

// --- Development-type planning intelligence keyword map ---
// Case-insensitive substring match against PlanWire's `description` field.
// Starting point, not exhaustive — extend as real description patterns turn up.
// Refurbishment types intentionally have no entry here: most refurb work is
// permitted development and doesn't generate planning applications to match against.
const DEV_TYPE_KEYWORDS = {
  'HMO conversion': [
    'hmo', 'house in multiple occupation', 'c3 to c4', 'c4 use', 'class c4',
    'sui generis hmo', 'multiple occupation'
  ],
  'Flat conversion': [
    'conversion to flats', 'conversion into flats', 'convert to flats', 'subdivision',
    'self-contained flats', 'self contained flat', 'conversion of dwelling',
    'form 2 flats', 'form two flats', 'creation of flats', 'conversion to apartments',
    'conversion into apartments', '2 flats', 'two flats', 'residential units', 'x flats'
  ],
  'Loft conversion': [
    'loft conversion', 'dormer', 'roof extension', 'hip to gable',
    'mansard', 'attic conversion'
    // 'rooflight' / 'roof light' deliberately excluded — live-tested and found to
    // false-positive heavily on ordinary single-storey rear extensions with skylights,
    // which are unrelated to loft conversions
  ],
  'New build': [
    'new build', 'new dwelling', 'construction of dwelling', 'demolition and erection',
    'residential development', 'new residential', 'erection of dwelling',
    'erection of a dwelling', 'erection of a new dwelling'
  ]
};

const PPD_API = 'https://landregistry.data.gov.uk/data/ppi/transaction-record.json';
const POSTCODES_API = 'https://api.postcodes.io/postcodes/';

// 200 is the server-enforced ceiling on _pageSize — requesting more doesn't
// get you more. 20 pages (4,000 rows) is a safety valve, not a target: it
// comfortably covers a full 12 months even for Birmingham-sized districts
// (measured live), so it should only ever bind on freakishly high-volume
// districts. Correctness over speed — a slower load beats a wrong GDV.
const PPD_PAGE_SIZE = 200;
const PPD_MAX_PAGES = 20;

// The minimum sold comps required to trust a median as real rather than
// noise. Used both for the deal's GDV comps and for each Area Snapshot
// property-type tile — below this, show "insufficient data", not a guess.
const MIN_RELIABLE_COMPS = 5;

// Growth compares two medians, so it compounds whatever noise either window
// has — a higher bar than the median's own MIN_RELIABLE_COMPS. Applies to
// both windows being compared, not just the prior one.
const MIN_RELIABLE_GROWTH_COMPS = 8;

// Even with enough comps in both windows, a lopsided split (e.g. 9 sales this
// year vs 180 the year before) usually means one window is dominated by a
// single development that happened to be selling then — comparing their
// medians measures which development sold, not price movement. Require both
// windows within this ratio of each other before trusting a growth figure.
const MAX_GROWTH_COMP_RATIO = 3;

function growthComparable(lastCount, priorCount) {
  if (lastCount < MIN_RELIABLE_GROWTH_COMPS || priorCount < MIN_RELIABLE_GROWTH_COMPS) return false;
  return Math.max(lastCount, priorCount) / Math.min(lastCount, priorCount) <= MAX_GROWTH_COMP_RATIO;
}

// Attaches the caller's own Supabase access token to requests against our paid
// EPC/PlanWire proxies, which the server uses to check plan/trial status
// (see requireActiveAccess in serve.js). A 403 with { error: 'trial_expired' }
// is surfaced as a distinguishable error so runAppraisal() can show the
// trial-ended screen instead of a generic fetch-failed message.
async function authedFetch(url, opts = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const resp = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${session?.access_token || ''}` }
  });

  if (resp.status === 403) {
    let body = null;
    try { body = await resp.clone().json(); } catch (_) {}
    if (body && body.error === 'trial_expired') {
      const err = new Error('trial_expired');
      err.trialExpired = true;
      throw err;
    }
  }

  return resp;
}

const EPC_PROXY = '/api/epc';

// GOV.UK "Get energy performance of buildings data" API. The search endpoint
// only returns a summary (band + registration date) per certificate — floor
// area and potential band require a second call to the certificate-detail
// endpoint for whichever certificate we pick.
async function fetchEpcData(postcode) {
  const searchUrl = `${EPC_PROXY}?path=${encodeURIComponent('api/domestic/search')}&postcode=${encodeURIComponent(postcode)}`;
  const searchResp = await authedFetch(searchUrl, { signal: AbortSignal.timeout(6000) });
  if (!searchResp.ok) throw new Error('EPC search failed: ' + searchResp.status);
  const certificates = (await searchResp.json()).data;
  if (!Array.isArray(certificates) || !certificates.length) {
    throw new Error('No EPC data found for properties in this postcode');
  }

  // Most recent certificate for the postcode — there's no address field to
  // match against the specific property being appraised (see the "sample
  // property, not confirmed" caveat surfaced in the UI for this).
  const mostRecent = certificates.reduce((latest, cert) =>
    new Date(cert.registrationDate) > new Date(latest.registrationDate) ? cert : latest
  );

  const detailUrl = `${EPC_PROXY}?path=${encodeURIComponent('api/certificate')}&certificate_number=${encodeURIComponent(mostRecent.certificateNumber)}`;
  const detailResp = await authedFetch(detailUrl, { signal: AbortSignal.timeout(6000) });
  if (!detailResp.ok) throw new Error('EPC certificate lookup failed: ' + detailResp.status);
  const detail = (await detailResp.json()).data;

  return {
    band: detail.current_energy_efficiency_band ?? null,
    potentialBand: detail.potential_energy_efficiency_band ?? null,
    floorArea: detail.total_floor_area ?? null,
    lodgementDate: detail.registration_date ?? null
  };
}

const PLANWIRE_PROXY = '/api/planwire';

// Environment Agency Flood Zone (1/2/3) via planning.data.gov.uk — free, same source as conservation area
async function fetchFloodRisk(lat, lng) {
  const url = `https://www.planning.data.gov.uk/entity.json?dataset=flood-risk-zone&latitude=${lat}&longitude=${lng}&limit=10`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!resp.ok) throw new Error('Flood risk lookup failed: ' + resp.status);
  const data = await resp.json();
  const levels = (data.entities ?? [])
    .map(e => parseInt(e['flood-risk-level'], 10))
    .filter(n => !isNaN(n));
  return levels.length ? Math.max(...levels) : 1;
}

async function fetchConservationArea(lat, lng) {
  const url = `https://www.planning.data.gov.uk/entity.json?dataset=conservation-area&latitude=${lat}&longitude=${lng}&limit=1`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!resp.ok) throw new Error('Conservation area lookup failed: ' + resp.status);
  const data = await resp.json();
  return (data.count ?? 0) > 0;
}

async function fetchPlanwireData(lat, lng) {
  const url = `${PLANWIRE_PROXY}?path=${encodeURIComponent('v1/applications/nearby')}&lat=${lat}&lng=${lng}&radius_km=0.5&limit=10`;
  const resp = await authedFetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error('PlanWire API error ' + resp.status);
  const data = await resp.json();
  const apps = data.data ?? [];

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const recent = apps.filter(a => {
    const d = a.applicationDate ? new Date(a.applicationDate) : null;
    return d && d >= twoYearsAgo;
  });

  const decided = recent.filter(a => a.decision);
  const refused = decided.filter(a => /refus/i.test(a.decision));
  const granted = decided.filter(a => /grant|permit|approv|agreed/i.test(a.decision));

  const mostRecentRefusal = refused
    .map(a => new Date(a.applicationDate))
    .sort((a, b) => b - a)[0];

  return {
    total: decided.length,
    granted: granted.length,
    refused: refused.length,
    mostRecentRefusalYear: mostRecentRefusal ? mostRecentRefusal.getFullYear() : null
  };
}

// --- Development-type planning intelligence ---
// Reuses the same PlanWire proxy path as fetchPlanwireData above, just with a
// parameterised radius_km and no fixed 2-year window (the dev-type card works
// off whatever the current radius step returns).

async function fetchPlanwireApps(lat, lng, radiusKm) {
  const url = `${PLANWIRE_PROXY}?path=${encodeURIComponent('v1/applications/nearby')}&lat=${lat}&lng=${lng}&radius_km=${radiusKm}&limit=100`;
  const resp = await authedFetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error('PlanWire API error ' + resp.status);
  const data = await resp.json();
  return data.data ?? [];
}

function matchesDevType(description, devType) {
  const keywords = DEV_TYPE_KEYWORDS[devType];
  if (!keywords || !description) return false;
  const desc = description.toLowerCase();
  return keywords.some(k => desc.includes(k));
}

function classifyPlanningDecision(decision) {
  if (!decision) return 'pending';
  if (/refus/i.test(decision)) return 'refused';
  if (/grant|permit|approv|agreed/i.test(decision)) return 'approved';
  return 'pending';
}

function splitByDecision(apps) {
  let approved = 0, refused = 0, pending = 0;
  apps.forEach(a => {
    const c = classifyPlanningDecision(a.decision);
    if (c === 'approved') approved++;
    else if (c === 'refused') refused++;
    else pending++;
  });
  const decided = approved + refused;
  return { approved, refused, pending, decided, approvalRate: decided > 0 ? approved / decided : null };
}

const PLANWIRE_RADIUS_LADDER_KM = [0.5, 1, 2]; // tier max is 2km — going higher returns a 400

async function fetchDevTypePlanningIntel(lat, lng, devType) {
  if (PLANNING_REFURB_TYPES.includes(devType)) {
    const apps = await fetchPlanwireApps(lat, lng, PLANWIRE_RADIUS_LADDER_KM[0]);
    return { mode: 'refurb', radiusKm: PLANWIRE_RADIUS_LADDER_KM[0], ...splitByDecision(apps) };
  }

  let matches = [];
  let radiusUsed = PLANWIRE_RADIUS_LADDER_KM[0];

  for (const radiusKm of PLANWIRE_RADIUS_LADDER_KM) {
    const apps = await fetchPlanwireApps(lat, lng, radiusKm);
    matches = apps.filter(a => matchesDevType(a.description, devType));
    radiusUsed = radiusKm;
    if (matches.length >= 3) break;
  }

  return {
    mode: 'devtype',
    radiusKm: radiusUsed,
    radiusExpanded: radiusUsed !== PLANWIRE_RADIUS_LADDER_KM[0],
    totalMatched: matches.length,
    matches,
    ...splitByDecision(matches)
  };
}

// Resolves a postcode to its district and lat/lng in one fast call. Flood,
// conservation, planning and Land Registry all key off this — none of them
// need to wait on each other, only on this single lookup.
async function fetchPostcodeData(postcode) {
  const pcClean = postcode.replace(/\s+/g, '');
  const resp = await fetch(POSTCODES_API + pcClean, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error('Postcode lookup failed');
  const data = await resp.json();
  const district = data.result?.admin_district?.toUpperCase();
  if (!district) throw new Error('Could not resolve district for ' + postcode);
  return { district, lat: data.result.latitude, lng: data.result.longitude };
}

// Pages through PPD for a district, newest-first, until the data runs out or
// PPD_MAX_PAGES is hit. The Land Registry linked-data API is slow and
// inconsistent on larger districts, so each page gets a generous timeout of
// its own — this only feeds GDV/area stats, which already degrade gracefully
// to the regional fallback if it fails outright. `onPage(n)` fires after each
// page completes so the caller can surface a "this is taking a while"
// loading state on high-volume districts.
async function fetchDistrictTransactions(district, onPage) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 24);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let allItems = [];
  let page = 0;
  let lastPageFull = false;
  let pageFailed = false;

  do {
    const url = `${PPD_API}?propertyAddress.district=${encodeURIComponent(district)}&min-transactionDate=${cutoffStr}&_pageSize=${PPD_PAGE_SIZE}&_page=${page}&_sort=-transactionDate`;
    let items;
    try {
      // Measured live against Dartford (~7-10s/page) and Birmingham (spiked
      // to 70s+ on page 0 under load) — this API is genuinely slow on large
      // districts, not just inconsistent. 25s balances tolerating that
      // against not leaving the user staring at a spinner indefinitely.
      const resp = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!resp.ok) throw new Error('PPD API error ' + resp.status);
      const data = await resp.json();
      items = data.result?.items ?? [];
    } catch (e) {
      // A page failing (timeout, transient network error) shouldn't discard
      // pages already fetched — that would trade real comps for a rougher
      // regional estimate. If we have nothing at all yet, this is a genuine
      // API failure and should surface as one; otherwise stop here and use
      // what's real, same as hitting the page cap.
      if (page === 0) throw e;
      pageFailed = true;
      break;
    }
    allItems = allItems.concat(items);
    lastPageFull = items.length === PPD_PAGE_SIZE;
    page++;
    if (onPage) onPage(page);
  } while (lastPageFull && page < PPD_MAX_PAGES);

  // A genuine cap-out (page limit, or a later page failing mid-stream) rather
  // than the district simply running out of sales naturally.
  const hitCap = lastPageFull && (page >= PPD_MAX_PAGES || pageFailed);

  const transactions = allItems.map(item => ({
    price: item.pricePaid,
    date: new Date(item.transactionDate),
    type: item.propertyType?.prefLabel?.[0]?._value ?? '',
    newBuild: item.newBuild === true
  })).filter(t => t.price > 0 && !isNaN(t.date));

  const oldestCovered = transactions.length
    ? new Date(Math.min(...transactions.map(t => t.date.getTime())))
    : null;

  return { transactions, oldestCovered, hitCap };
}

// Resolves both the GDV-driving comps (filtered to the deal's actual
// end-product type) and the raw unfiltered pool the Area Snapshot needs, from
// one shared paginated fetch — so the snapshot's "All types" figure can never
// again be a devType-filtered median wearing the wrong label.
async function fetchLandRegistryData(district, devType, propType, onPage) {
  const { transactions: allTransactions, oldestCovered, hitCap } = await fetchDistrictTransactions(district, onPage);

  // Filter by end-product property type: the dev type's forced type (conversions)
  // takes priority over the user-selected property type (refurb/new build).
  const devForcedType = DEV_TYPE_TO_PPD_TYPE[devType];
  const propTypeFilter = PROP_TYPE_TO_PPD_TYPE[propType] || null;
  const typeFilter = devForcedType || propTypeFilter;
  const dealTransactions = typeFilter
    ? allTransactions.filter(t => t.type === typeFilter)
    : allTransactions;

  return {
    dealTransactions,
    allTransactions,
    filterSource: devForcedType ? 'devType' : (propTypeFilter ? 'propType' : null),
    oldestCovered,
    hitCap
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function calcSdltBanded(price) {
  let sdlt = 0;
  let remaining = price;
  const bands = [
    [125000, 0.00],
    [125000, 0.02],
    [675000, 0.05],
    [575000, 0.10],
    [Infinity, 0.12]
  ];
  for (const [band, rate] of bands) {
    const chunk = Math.min(remaining, band);
    sdlt += chunk * rate;
    remaining -= chunk;
    if (remaining <= 0) break;
  }
  return sdlt;
}

function calcSDLT(price) {
  const surcharge = price * 0.05; // Additional dwelling surcharge — 5% since 31 Oct 2024 (was 3%)
  return Math.round(calcSdltBanded(price) + surcharge);
}

function fmt(n) {
  return '£' + Math.round(n).toLocaleString('en-GB');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function fmtPct(n) {
  return (Math.round(n * 10) / 10) + '%';
}

function getRlvNote(rlv, purchase) {
  const cushion = purchase > 0 ? (rlv - purchase) / purchase : 0;
  if (cushion >= 0.10) {
    return { cls: '', text: "You're paying comfortably below what the site can support at a healthy margin — there's cushion here if costs run over." };
  } else if (cushion >= -0.05) {
    return { cls: '', text: "You're paying close to what this site is actually worth at a healthy margin — little room left to renegotiate." };
  } else {
    return { cls: 'risk', text: "You're paying more than the residual value supports — this is what's compressing your margin, not the build cost." };
  }
}

function getSdltNote(sdlt, purchase) {
  const pct = purchase > 0 ? (sdlt / purchase) * 100 : 0;
  return `That's ${fmtPct(pct)} of your purchase price — cash due at completion, on top of your deposit and fees. Includes the 5% additional dwelling surcharge, which applies when you already own a property — one of the most commonly overlooked costs in development finance.`;
}

function getFinanceNote(finance, gdv) {
  const pctOfGdv = gdv > 0 ? (finance / gdv) * 100 : 0;
  if (pctOfGdv > 6) {
    return { cls: 'warn', text: "That's a meaningful chunk of GDV — every month you cut from the build programme drops straight to profit." };
  }
  return { cls: '', text: 'Modest relative to GDV at this build period — a slipping timeline is a bigger risk to this figure than the interest rate is.' };
}

function renderGdvExplainer(a) {
  const el = document.getElementById('gdv-calc-body');
  if (!el) return;

  const areaLabel = a.district || postcodeOutward(a.postcode);
  const multiplierLine = `×${a.gdvMultiplier.toFixed(2)} — ${GDV_MULTIPLIER_REASON[a.devType]}`;

  let sourceLine, compsLine;
  if (a.usedFallback) {
    sourceLine = 'Regional estimate — not enough live Land Registry sales to use';
    compsLine = `0 usable comps in ${areaLabel} in the last 12 months`;
  } else if (a.usedPropTypeFallback) {
    sourceLine = 'Land Registry Price Paid comps, district-wide (not filtered by property type)';
    compsLine = `${a.compCount} sold comps across all property types — only ${a.propTypeFilteredCount} were ${a.propType.toLowerCase()}, too few to filter on their own`;
  } else {
    sourceLine = 'Land Registry Price Paid comps';
    compsLine = `${a.compCount} sold comp${a.compCount === 1 ? '' : 's'} in the last 12 months`;
  }

  el.innerHTML = `
    <div><strong>Data source:</strong> ${escapeHtml(sourceLine)}</div>
    <div><strong>Comparables used:</strong> ${escapeHtml(compsLine)}</div>
    <div><strong>District:</strong> ${escapeHtml(areaLabel)}</div>
    <div><strong>Multiplier:</strong> ${escapeHtml(multiplierLine)}</div>
  `;
}

function renderBuildCostExplainer(a) {
  const el = document.getElementById('build-calc-body');
  if (!el) return;

  const regionLine = !a.regionMatched
    ? `<div><strong>Region adjustment:</strong> None — postcode is outside our mapped UK regions (e.g. Scotland, Northern Ireland), so the UK national average rate is used</div>`
    : a.regionMultiplier !== 1
    ? `<div><strong>Region adjustment:</strong> £${a.bcisNational.mid.toLocaleString('en-GB')}/m² national average × ${a.regionMultiplier.toFixed(2)} (${escapeHtml(a.region)}) = £${a.bcis.mid.toLocaleString('en-GB')}/m²</div>`
    : `<div><strong>Region adjustment:</strong> None — ${escapeHtml(a.region)} is at the UK national average</div>`;

  el.innerHTML = `
    <div><strong>Data source:</strong> BCIS Q1 2026 benchmark rates, £/m², ex-VAT, UK national average</div>
    ${regionLine}
    <div><strong>Rate used:</strong> £${a.bcis.mid.toLocaleString('en-GB')}/m² (mid) × ${a.area}m² = ${fmt(a.buildMid)}</div>
    <div><strong>Range:</strong> £${a.bcis.low.toLocaleString('en-GB')} – £${a.bcis.high.toLocaleString('en-GB')}/m² for ${escapeHtml(a.devType)}</div>
    <div>Excludes professional fees and contingency — these are costed separately.</div>
  `;
}

function getMargin(gdv, buildMid, purchase, sdlt, finance, gdvVar, buildVar) {
  const g = gdv * (1 + gdvVar);
  const b = buildMid * (1 + buildVar);
  const agentFees = g * 0.015;
  const profFees = b * 0.12;
  const contingency = b * 0.10;
  const totalCosts = purchase + b + sdlt + agentFees + profFees + contingency + finance;
  const profit = g - totalCosts;
  return (profit / g) * 100;
}

// --- Avalor Score ---

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function scoreProfitability(margin) {
  return clamp((margin / 25) * 100, 0, 100);
}

const PLANNING_REFURB_TYPES = ['Cosmetic refurbishment', 'Light refurbishment', 'Full refurbishment'];
const CONSERVATION_SENSITIVE_TYPES = ['New build', 'Loft conversion', 'Flat conversion'];

function scorePlanningRisk(planwireResult, conservationArea, devType) {
  let score;
  if (planwireResult && planwireResult.total > 0) {
    score = (planwireResult.granted / planwireResult.total) * 100;
    score -= Math.min(30, planwireResult.refused * 10);
  } else {
    score = 60; // no local decisions to go on — neutral default
  }

  // New build almost always needs a full planning application, regardless of location.
  // HMO's real planning friction (Article 4 directions) is location-specific and is already
  // captured by the live approval/refusal rate above, so it doesn't get a second blanket penalty here.
  if (PLANNING_REFURB_TYPES.includes(devType)) score += 10;
  else if (devType === 'New build') score -= 10;

  if (conservationArea === true && CONSERVATION_SENSITIVE_TYPES.includes(devType)) score -= 10;

  return clamp(score, 0, 100);
}

function scoreFloodEnvironmental(floodZone) {
  if (floodZone === 1) return 100;
  if (floodZone === 2) return 55;
  if (floodZone === 3) return 15;
  return 60; // unknown — neutral default
}

const CONSTRUCTION_BASE_BY_TYPE = {
  'Cosmetic refurbishment': 95,
  'Light refurbishment':    90,
  'Full refurbishment':     75,
  'Loft conversion':        70,
  'Flat conversion':        65,
  'HMO conversion':         55,
  'New build':              45
};

function scoreConstructionRisk(devType, bcis, maxBuildOverrun) {
  const base = CONSTRUCTION_BASE_BY_TYPE[devType] ?? 65;
  const uncertaintyPenalty = ((bcis.high - bcis.low) / bcis.mid) * 25;
  const headroomBonus = (maxBuildOverrun ?? 0) * 100;
  return clamp(base - uncertaintyPenalty + headroomBonus, 0, 100);
}

function scoreMarketDemand(growth, compCount, usedFallback) {
  const growthScore = clamp(50 + growth * 5, 0, 100);
  const liquidityScore = clamp((compCount / 15) * 100, 0, 100);
  const combined = growthScore * 0.6 + liquidityScore * 0.4;
  return usedFallback ? Math.min(50, combined) : combined;
}

function scoreExitStrategy(maxGdvDrop, rlv, purchase, epcResult) {
  const survivableDrop = -(maxGdvDrop ?? 0); // positive = % GDV drop the deal survives
  const gdvScore = clamp((survivableDrop / 0.20) * 100, 0, 100);

  const cushionRatio = purchase > 0 ? (rlv - purchase) / purchase : 0;
  const rlvScore = clamp(50 + cushionRatio * 150, 0, 100);

  const band = epcResult?.band?.toUpperCase();
  let epcScore;
  if (!band) epcScore = 50;
  else if ('ABC'.includes(band)) epcScore = 100;
  else if (band === 'D') epcScore = 60;
  else if (band === 'E') epcScore = 30;
  else epcScore = 0; // F/G — largely unmortgageable without upgrade

  return clamp(gdvScore * 0.45 + rlvScore * 0.25 + epcScore * 0.30, 0, 100);
}

function computeAvalorScore({ margin, rlv, purchase, growth, compCount, usedFallback, floodZone, planwireResult, conservationArea, devType, bcis, maxBuildOverrun, maxGdvDrop, epcResult }) {
  const profitability = scoreProfitability(margin);
  const planningRisk = scorePlanningRisk(planwireResult, conservationArea, devType);
  const floodEnvironmental = scoreFloodEnvironmental(floodZone);
  const constructionRisk = scoreConstructionRisk(devType, bcis, maxBuildOverrun);
  const marketDemand = scoreMarketDemand(growth, compCount, usedFallback);
  const exitStrategy = scoreExitStrategy(maxGdvDrop, rlv, purchase, epcResult);

  const overall =
    profitability      * 0.30 +
    planningRisk       * 0.15 +
    floodEnvironmental * 0.15 +
    constructionRisk   * 0.15 +
    marketDemand        * 0.15 +
    exitStrategy        * 0.10;

  return {
    overall: Math.round(overall),
    categories: {
      profitability:      Math.round(profitability),
      planningRisk:       Math.round(planningRisk),
      floodEnvironmental: Math.round(floodEnvironmental),
      constructionRisk:   Math.round(constructionRisk),
      marketDemand:       Math.round(marketDemand),
      exitStrategy:       Math.round(exitStrategy)
    }
  };
}

const SCORE_CATEGORY_META = [
  { key: 'profitability',      label: 'Profitability' },
  { key: 'planningRisk',       label: 'Planning Risk' },
  { key: 'floodEnvironmental', label: 'Flood & Environmental Risk' },
  { key: 'constructionRisk',   label: 'Construction Risk' },
  { key: 'marketDemand',       label: 'Market Demand' },
  { key: 'exitStrategy',       label: 'Exit Strategy' }
];

function scoreColor(score) {
  if (score >= 70) return '#1D9E75';
  if (score >= 50) return '#BA7517';
  return '#A32D2D';
}

function renderAvalorScore(scoreResult) {
  const { overall, categories } = scoreResult;
  const color = scoreColor(overall);

  const ring = document.getElementById('score-ring');
  ring.style.setProperty('--score-pct', overall);
  ring.style.setProperty('--score-color', color);
  document.getElementById('score-overall').textContent = overall;

  const band = document.getElementById('score-band');
  const bandDesc = document.getElementById('score-band-desc');
  band.style.color = color;
  if (overall >= 70) {
    band.textContent = 'Strong deal';
    bandDesc.textContent = 'Scores well across profitability and risk factors, with limited exposure across the categories below.';
  } else if (overall >= 50) {
    band.textContent = 'Moderate deal';
    bandDesc.textContent = 'Workable, but one or more risk categories below need closer review before committing.';
  } else {
    band.textContent = 'Weak deal';
    bandDesc.textContent = 'Significant risk or profitability concerns across multiple categories — review carefully.';
  }

  document.getElementById('score-cat-list').innerHTML = SCORE_CATEGORY_META.map(meta => {
    const val = categories[meta.key];
    return `
      <div class="score-cat-row">
        <div class="score-cat-label">${meta.label}</div>
        <div class="score-cat-track"><div class="score-cat-fill" style="width:${val}%;background:${scoreColor(val)}"></div></div>
        <div class="score-cat-value">${val}</div>
      </div>`;
  }).join('');
}

function showDataBanner(msg) {
  const el = document.getElementById('data-banner');
  el.style.display = 'flex';
  if (msg) document.getElementById('data-banner-msg').textContent = msg;
}

function hideDataBanner() {
  document.getElementById('data-banner').style.display = 'none';
}

let currentAppraisal = null;

async function runAppraisal() {
  if (typeof trialExpired !== 'undefined' && trialExpired) {
    showTrialExpiredScreen();
    return;
  }

  const postcodeRaw = document.getElementById('postcode').value.trim();
  const devType = document.getElementById('dev-type').value;
  const propType = document.getElementById('prop-type').value;
  const purchase = parseFloat(document.getElementById('purchase').value) || 320000;
  const area = parseFloat(document.getElementById('floorarea').value) || 110;
  const units = MULTI_UNIT_DEV_TYPES.includes(devType)
    ? (parseInt(document.getElementById('units').value) || 2)
    : 1;

  if (!postcodeRaw) {
    toast('Please enter a postcode', 'error');
    return;
  }

  // Both dropdowns default to an unselected placeholder rather than a real
  // option — dev type forces a Land Registry comp filter (e.g. "Flat
  // conversion" silently restricts comps to flats), so an unconsidered
  // default would silently skew GDV for anything that isn't that type.
  if (!devType) {
    toast('Please select a development type', 'error');
    return;
  }
  if (!propType) {
    toast('Please select a property type', 'error');
    return;
  }

  // Normalise once, here, before any lookup fires — everything downstream
  // (Land Registry, postcodes.io, EPC, region tier resolution, storage
  // and display) works off this single canonically-formatted value.
  const postcode = normalizePostcode(postcodeRaw);
  if (!postcode) {
    toast('Please enter a valid UK postcode', 'error');
    return;
  }

  const btn = document.getElementById('run-btn');
  btn.innerHTML = '<span class="loading-spinner"></span> Running…';
  btn.disabled = true;

  const regionTier = resolveRegionTier(postcode);
  const region = regionTier.name;
  const regionMultiplier = regionTier.mult;
  const bcisNational = BCIS[devType] || BCIS['Flat conversion'];
  const bcis = {
    low:  Math.round(bcisNational.low  * regionMultiplier),
    mid:  Math.round(bcisNational.mid  * regionMultiplier),
    high: Math.round(bcisNational.high * regionMultiplier)
  };
  const fallbackPpm = regionTier.ppm;
  const fallbackGrowth = regionTier.growth;

  let comps = [];
  let allComps = [];
  let filterSource = null;
  let district = '';
  let usedFallback = false;
  let fallbackReason = '';
  let usedPropTypeFallback = false;
  let propTypeFilteredCount = 0;
  let epcResult = null;
  let floodZone = null;
  let planwireResult = null;
  let conservationArea = null;
  let devTypePlanningIntel = null;
  let oldestCovered = null;
  let hitPageCap = false;

  // Postcode → district + coordinates resolves once, up front, fast. Land
  // Registry, EPC, flood, conservation and planning intel all key off this
  // (or off the raw postcode, for EPC) rather than off each other, so they
  // can all fire in a single parallel batch — a slow/failed Land Registry
  // lookup no longer blocks or blanks out the others.
  let pc = null;
  try {
    pc = await fetchPostcodeData(postcode);
    district = pc.district;
  } catch (e) {
    usedFallback = true;
    fallbackReason = 'Could not resolve this postcode. GDV and area statistics are based on regional averages, not live market data.';
  }

  // Larger districts can take several pages to pull — surface that as a
  // distinct loading state after the first page, rather than leaving the
  // "Running…" spinner looking hung.
  const onLandRegistryPage = (page) => {
    if (page === 2) {
      btn.innerHTML = '<span class="loading-spinner"></span> Pulling comparable sales…';
    }
  };

  const [lrOutcome, epcOutcome, floodOutcome, planwireOutcome, conservationOutcome, devTypePlanningOutcome] = await Promise.allSettled([
    pc ? fetchLandRegistryData(pc.district, devType, propType, onLandRegistryPage) : Promise.reject('No district'),
    fetchEpcData(postcode),
    pc ? fetchFloodRisk(pc.lat, pc.lng) : Promise.reject('No coords'),
    pc ? fetchPlanwireData(pc.lat, pc.lng) : Promise.reject('No coords'),
    pc ? fetchConservationArea(pc.lat, pc.lng) : Promise.reject('No coords'),
    pc ? fetchDevTypePlanningIntel(pc.lat, pc.lng, devType) : Promise.reject('No coords')
  ]);

  if (lrOutcome.status === 'fulfilled') {
    comps = lrOutcome.value.dealTransactions;
    allComps = lrOutcome.value.allTransactions;
    filterSource = lrOutcome.value.filterSource;
    oldestCovered = lrOutcome.value.oldestCovered;
    hitPageCap = lrOutcome.value.hitCap;
  } else if (!usedFallback) {
    usedFallback = true;
    fallbackReason = 'The Land Registry API could not be reached. GDV and area statistics are based on regional averages, not live market data.';
  }

  // Defense in depth: the client-side gate at the top of this function should
  // catch an expired trial before any of this fires, but if the trial expired
  // mid-session (no page reload since it started), the server-side check in
  // requireActiveAccess (serve.js) will reject the proxy calls with a flagged
  // trial_expired error instead. Show the same paywall rather than a
  // degraded/broken appraisal.
  const hitTrialWall = [epcOutcome, planwireOutcome, devTypePlanningOutcome]
    .some(o => o.status === 'rejected' && o.reason && o.reason.trialExpired);
  if (hitTrialWall) {
    btn.innerHTML = 'Run appraisal';
    btn.disabled = false;
    showTrialExpiredScreen();
    return;
  }

  if (epcOutcome.status === 'fulfilled') epcResult = epcOutcome.value;
  if (floodOutcome.status === 'fulfilled') floodZone = floodOutcome.value;
  if (planwireOutcome.status === 'fulfilled') planwireResult = planwireOutcome.value;
  if (conservationOutcome.status === 'fulfilled') conservationArea = conservationOutcome.value;
  if (devTypePlanningOutcome.status === 'fulfilled') devTypePlanningIntel = devTypePlanningOutcome.value;

  // Split into last 12 months and prior 12 months for YoY growth
  const now = new Date();
  const twelveMonthsAgo = new Date(now); twelveMonthsAgo.setFullYear(now.getFullYear() - 1);
  let last12 = comps.filter(t => t.date >= twelveMonthsAgo);
  let prior12 = comps.filter(t => t.date < twelveMonthsAgo);

  // If filtering to the selected property type left too few comps, fall back to the
  // unfiltered district data (still real, still local) rather than jumping straight
  // to the regional £/sqm fallback.
  if (!usedFallback && filterSource === 'propType' && last12.length < 5) {
    propTypeFilteredCount = last12.length;
    const allLast12 = allComps.filter(t => t.date >= twelveMonthsAgo);
    if (allLast12.length >= 5) {
      usedPropTypeFallback = true;
      last12 = allLast12;
      prior12 = allComps.filter(t => t.date < twelveMonthsAgo);
    }
  }

  // Require at least 5 comps in the last 12 months to trust the data. Note
  // this is specifically about comps of the deal's end-product type — the
  // Area Snapshot below draws on the full unfiltered district pool
  // independently, and may still show real data even when GDV can't.
  if (!usedFallback && last12.length < 5) {
    usedFallback = true;
    const label = district || postcodeOutward(postcode);
    fallbackReason = `Only ${last12.length} sold comparable${last12.length === 1 ? '' : 's'} of this property type found in ${label} for the last 12 months. GDV is based on a regional average, not live market data.`;
  }

  // --- Area Snapshot data ---
  // Deliberately computed from allComps (unfiltered by devType/propType), not
  // from the GDV comps above — the snapshot must show the real district
  // market regardless of which end-product type this particular deal is
  // filtering for. A "Flat conversion" deal should never make the area's
  // "All types" figure look like a flats-only median.
  const snapshotLast12 = allComps.filter(t => t.date >= twelveMonthsAgo);
  const snapshotPrior12 = allComps.filter(t => t.date < twelveMonthsAgo);
  const snapshotUsedFallback = snapshotLast12.length < MIN_RELIABLE_COMPS;

  let snapshotMedianPrice = null, snapshotGrowth = null;
  if (!snapshotUsedFallback) {
    snapshotMedianPrice = median(snapshotLast12.map(t => t.price));
    if (growthComparable(snapshotLast12.length, snapshotPrior12.length)) {
      const medPrior = median(snapshotPrior12.map(t => t.price));
      snapshotGrowth = ((snapshotMedianPrice - medPrior) / medPrior) * 100;
    } else {
      // Not enough prior-year comps for a real YoY figure — the regional
      // trend rate is used for the historical chart's shape only; the
      // current price level above is still real, live comp data.
      snapshotGrowth = fallbackGrowth;
    }
  }

  // Real per-type medians, computed from the same unfiltered pool — no
  // hardcoded ratios. `newBuild` is a PPD flag independent of property type,
  // not one of the four house/flat categories, so it's matched separately.
  const medianAndGrowth = (subsetLast12, subsetPrior12) => {
    if (subsetLast12.length < MIN_RELIABLE_COMPS) {
      return { count: subsetLast12.length, median: null, growth: null };
    }
    const med = median(subsetLast12.map(t => t.price));
    let g = null;
    if (growthComparable(subsetLast12.length, subsetPrior12.length)) {
      const medPrior = median(subsetPrior12.map(t => t.price));
      g = ((med - medPrior) / medPrior) * 100;
    }
    return { count: subsetLast12.length, median: med, growth: g };
  };
  const SNAPSHOT_TYPES = [
    { name: 'Detached',      match: t => t.type === 'detached' },
    { name: 'Semi-detached', match: t => t.type === 'semi-detached' },
    { name: 'Terraced',      match: t => t.type === 'terraced' },
    { name: 'Flat',          match: t => t.type === 'flat-maisonette' },
    { name: 'New build',     match: t => t.newBuild }
  ];
  const typeBreakdown = SNAPSHOT_TYPES.map(({ name, match }) => ({
    name,
    ...medianAndGrowth(snapshotLast12.filter(match), snapshotPrior12.filter(match))
  }));
  typeBreakdown.push({
    name: 'All types',
    count: snapshotLast12.length,
    median: snapshotMedianPrice,
    growth: snapshotUsedFallback ? null : snapshotGrowth
  });

  // Pagination is capped, so on very high-volume districts "last 12 months"
  // may not be what was actually retrieved — say so rather than mislabel it.
  const got12MonthsCoverage = oldestCovered ? oldestCovered <= twelveMonthsAgo : false;
  const snapshotWindowLabel = !allComps.length
    ? 'No live data'
    : got12MonthsCoverage
      ? 'Last 12 months'
      : `Partial data — back to ${oldestCovered.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} (${hitPageCap ? 'very high sales volume' : 'limited history available'})`;

  // --- Derive key figures ---
  let medianPrice, growth;

  if (!usedFallback) {
    medianPrice = median(last12.map(t => t.price));
    if (growthComparable(last12.length, prior12.length)) {
      const medPrior = median(prior12.map(t => t.price));
      growth = ((medianPrice - medPrior) / medPrior) * 100;
    } else {
      growth = fallbackGrowth;
    }
  } else {
    medianPrice = fallbackPpm * 90; // approx avg from £/sqm
    growth = fallbackGrowth;
  }

  const ppm = Math.round(medianPrice / 90);

  // GDV: median comp × units × dev-type multiplier (see GDV_MULTIPLIER above)
  const gdvMultiplier = GDV_MULTIPLIER[devType] ?? 0.85;
  const gdv = medianPrice * units * gdvMultiplier;

  const buildMid = area * bcis.mid;
  const sdlt = calcSDLT(purchase);
  const agentFees = gdv * 0.015;
  const profFees = buildMid * 0.12;
  const contingency = buildMid * 0.10;
  const finance = (purchase + buildMid) * 0.065;
  const totalCosts = purchase + buildMid + sdlt + agentFees + profFees + contingency + finance;
  const profit = gdv - totalCosts;
  const margin = (profit / gdv) * 100;
  const rlv = gdv - buildMid - (gdv * 0.20) - agentFees - profFees;
  const resilience = computeResilience(gdv, buildMid, purchase, sdlt, finance);

  const score = computeAvalorScore({
    margin, rlv, purchase, growth, compCount: last12.length, usedFallback,
    floodZone, planwireResult, conservationArea, devType, bcis,
    maxBuildOverrun: resilience.maxBuildOverrun, maxGdvDrop: resilience.maxGdvDrop,
    epcResult
  });

  currentAppraisal = {
    postcode, devType, propType, region, purchase, area, units,
    gdv, gdvMultiplier, medianPrice, buildMid, sdlt, finance, profit, margin, rlv,
    bcis, growth, ppm, compCount: last12.length, district, usedFallback,
    usedPropTypeFallback, propTypeFilteredCount,
    epcResult, floodZone, planwireResult, conservationArea, devTypePlanningIntel,
    maxBuildOverrun: resilience.maxBuildOverrun, maxGdvDrop: resilience.maxGdvDrop,
    score
  };

  btn.innerHTML = 'Run appraisal';
  btn.disabled = false;

  // Banner
  usedFallback ? showDataBanner(fallbackReason) : hideDataBanner();

  // Financials
  document.getElementById('r-gdv').textContent = fmt(gdv);
  document.getElementById('r-build').textContent = fmt(buildMid);
  document.getElementById('r-sdlt').textContent = fmt(sdlt);
  document.getElementById('r-finance').textContent = fmt(finance);
  document.getElementById('r-profit').textContent = fmt(profit);
  document.getElementById('r-margin').textContent = fmtPct(margin);
  document.getElementById('r-rlv').textContent = fmt(rlv);
  document.getElementById('r-bcis').textContent = `£${bcis.low.toLocaleString()} – £${bcis.high.toLocaleString()}/m²`;

  document.getElementById('r-build-note').textContent = `£${bcis.mid.toLocaleString('en-GB')}/m² × ${area}m² = ${fmt(buildMid)}`;

  const regionNoteEl = document.getElementById('r-build-region-note');
  if (regionNoteEl) {
    if (!regionTier.matched) {
      regionNoteEl.textContent = `Postcode outside our mapped UK regions (e.g. Scotland, Northern Ireland) — UK national average build cost applied instead.`;
      regionNoteEl.classList.add('warn');
    } else {
      regionNoteEl.classList.remove('warn');
      const pct = Math.round((regionMultiplier - 1) * 100);
      regionNoteEl.textContent = pct !== 0
        ? `Adjusted for ${region} build costs (${pct > 0 ? '+' : ''}${pct}% vs UK national average).`
        : '';
    }
  }

  const gdvBasisLabel = usedFallback ? 'regional avg' : 'median';
  document.getElementById('r-gdv-note').textContent = `${fmt(medianPrice)} ${gdvBasisLabel} × ${units} unit${units === 1 ? '' : 's'} × ${gdvMultiplier.toFixed(2)} = ${fmt(gdv)}`;

  renderGdvExplainer({
    usedFallback, usedPropTypeFallback, district, postcode, region, devType, propType,
    compCount: last12.length, propTypeFilteredCount, gdvMultiplier
  });

  renderBuildCostExplainer({ bcis, bcisNational, regionMultiplier, region, regionMatched: regionTier.matched, area, buildMid, devType });

  document.getElementById('r-sdlt-note').textContent = getSdltNote(sdlt, purchase);

  const financeNote = getFinanceNote(finance, gdv);
  const financeNoteEl = document.getElementById('r-finance-note');
  financeNoteEl.className = 'metric-tile-sub' + (financeNote.cls ? ' ' + financeNote.cls : '');
  financeNoteEl.textContent = financeNote.text;

  const rlvNote = getRlvNote(rlv, purchase);
  const rlvNoteEl = document.getElementById('r-rlv-note');
  rlvNoteEl.className = 'metric-tile-sub' + (rlvNote.cls ? ' ' + rlvNote.cls : '');
  rlvNoteEl.textContent = rlvNote.text;

  // SDLT breakdown — split the real banded calculation at £250k so the rows sum to the actual total
  const bandedTo250k = calcSdltBanded(Math.min(purchase, 250000));
  const bandedAbove250k = calcSdltBanded(purchase) - bandedTo250k;
  const surcharge = purchase * 0.05;
  document.getElementById('s1').textContent = fmt(bandedTo250k);
  document.getElementById('s2').textContent = fmt(bandedAbove250k);
  document.getElementById('s3').textContent = fmt(surcharge);
  document.getElementById('s-total').textContent = fmt(sdlt);

  // Verdict
  const verdictBox = document.getElementById('verdict-box');
  const verdictIcon = document.getElementById('verdict-icon');
  const verdictTitle = document.getElementById('verdict-title');
  const verdictDesc = document.getElementById('verdict-desc');
  const marginEl = document.getElementById('r-margin');

  if (margin >= 20) {
    verdictBox.className = 'verdict viable';
    verdictIcon.className = 'ti ti-circle-check';
    verdictTitle.textContent = 'Viable';
    verdictDesc.textContent = "Healthy margin — you've got room to negotiate the purchase price down further, or absorb a cost overrun without the deal falling over.";
    marginEl.style.color = 'var(--green)';
  } else if (margin >= 12) {
    verdictBox.className = 'verdict marginal';
    verdictIcon.className = 'ti ti-alert-triangle';
    verdictTitle.textContent = 'Marginal';
    verdictDesc.textContent = 'This only works if the build and sale both go roughly to plan. Treat this margin as your walk-away point, not a buffer.';
    marginEl.style.color = 'var(--amber)';
  } else {
    verdictBox.className = 'verdict not-viable';
    verdictIcon.className = 'ti ti-circle-x';
    verdictTitle.textContent = 'Not viable';
    verdictDesc.textContent = "At this price you're financing a loss, not a project. Renegotiate the purchase price before you spend anything on this deal.";
    marginEl.style.color = 'var(--red)';
  }

  buildResilienceSection(gdv, buildMid, purchase, sdlt, finance, margin, resilience);
  buildWhatIfSection(gdv, buildMid, purchase);
  buildAreaSnapshot(postcode, district, region, {
    medianPrice: snapshotMedianPrice, growth: snapshotGrowth, usedFallback: snapshotUsedFallback,
    txCount: snapshotLast12.length, windowLabel: snapshotWindowLabel, typeBreakdown
  }, epcResult, floodZone, planwireResult, conservationArea);
  buildDevTypePlanningCard(devTypePlanningIntel, devType);
  renderAvalorScore(score);
  buildMissedItemsSection(currentAppraisal);

  const growthWidth = Math.min(90, Math.max(10, (Math.abs(growth) / 10) * 100));
  document.getElementById('growth-fill').style.width = growthWidth + '%';
  document.getElementById('growth-pct').textContent = (growth >= 0 ? '+' : '') + growth.toFixed(1) + '% p/a';

  document.getElementById('results').style.display = 'block';
  document.getElementById('save-btn').style.display = 'inline-flex';
  document.getElementById('export-btn').style.display = 'inline-flex';

  markOnboardingStep(1);

  document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function computeResilience(gdv, buildMid, purchase, sdlt, finance) {
  const gdvVars = [-0.20, -0.10, 0, 0.10, 0.20];
  const buildVars = [-0.20, -0.10, 0, 0.10, 0.20];

  let maxBuildOverrun = -0.20;
  for (const bv of buildVars) {
    const m = getMargin(gdv, buildMid, purchase, sdlt, finance, 0, bv);
    if (m >= 12) maxBuildOverrun = bv;
  }

  let maxGdvDrop = 0.20;
  for (const gv of gdvVars) {
    const m = getMargin(gdv, buildMid, purchase, sdlt, finance, gv, 0);
    if (m >= 12) maxGdvDrop = gv;
  }

  return { maxBuildOverrun, maxGdvDrop };
}

function buildResilienceSection(gdv, buildMid, purchase, sdlt, finance, baseMargin, resilience) {
  const { maxBuildOverrun, maxGdvDrop } = resilience;

  const box = document.getElementById('resilience-box');
  const icon = document.getElementById('resilience-icon');
  const headline = document.getElementById('resilience-headline');
  const detail = document.getElementById('resilience-detail');
  const buildBar = document.getElementById('build-headroom-bar');
  const gdvBar = document.getElementById('gdv-headroom-bar');
  const buildVal = document.getElementById('build-headroom-val');
  const gdvVal = document.getElementById('gdv-headroom-val');

  if (baseMargin >= 20 && maxBuildOverrun >= 0.10 && maxGdvDrop <= -0.10) {
    box.className = 'resilience-summary good';
    icon.className = 'ti ti-circle-check';
    headline.textContent = 'This deal has good headroom — it can absorb some bad luck.';
    detail.innerHTML = `It stays viable if build costs run up to <strong>+${Math.round(maxBuildOverrun * 100)}% over budget</strong> and sale prices come in up to <strong>${Math.round(maxGdvDrop * 100)}% below expectation</strong>. It only fails if both go badly wrong simultaneously.`;
  } else if (baseMargin >= 12) {
    box.className = 'resilience-summary ok';
    icon.className = 'ti ti-alert-triangle';
    headline.textContent = 'This deal is viable but tight — limited room for error.';
    detail.innerHTML = `It works at base assumptions but would fail if build costs overrun significantly or sale prices disappoint. Review your contingency carefully before committing.`;
  } else {
    box.className = 'resilience-summary bad';
    icon.className = 'ti ti-circle-x';
    headline.textContent = 'This deal does not stack up at current assumptions.';
    detail.innerHTML = `The margin is too thin even at base case. You would need to renegotiate the purchase price, reduce build scope, or achieve a higher sale price to make this viable.`;
  }

  const buildPct = Math.min(95, Math.max(5, ((maxBuildOverrun + 0.20) / 0.40) * 100));
  const gdvPct = Math.min(95, Math.max(5, ((-maxGdvDrop + 0.20) / 0.40) * 100));
  buildBar.style.width = Math.round(buildPct) + '%';
  gdvBar.style.width = Math.round(gdvPct) + '%';

  buildVal.textContent = maxBuildOverrun >= 0.20 ? 'Up to +20% overrun — still viable'
    : maxBuildOverrun >= 0.10 ? 'Up to +10% overrun — still viable'
    : maxBuildOverrun >= 0 ? 'Base cost only — no overrun buffer'
    : 'Fails at base assumptions';

  gdvVal.textContent = maxGdvDrop <= -0.20 ? 'Survives up to -20% price drop'
    : maxGdvDrop <= -0.10 ? 'Survives up to -10% price drop'
    : maxGdvDrop <= 0 ? 'Base GDV only — no price drop buffer'
    : 'Fails even at base GDV';
}

// --- What if...? interactive scenarios ---
// Replaces the old static sensitivity matrix with live sliders. Unlike getMargin()
// above (used by the resilience headroom bars), this recomputes SDLT and finance
// for the hypothetical purchase/build figures rather than holding them fixed —
// both are genuinely purchase/build-dependent, so freezing them would understate
// the effect of the purchase-price slider.

let whatIfBase = null;

function computeWhatIf(purchasePctLess, buildPctOver, gdvPctLess) {
  const { gdv, buildMid, purchase } = whatIfBase;
  const newPurchase = purchase * (1 - purchasePctLess / 100);
  const newBuild = buildMid * (1 + buildPctOver / 100);
  const newGdv = gdv * (1 - gdvPctLess / 100);
  const newSdlt = calcSDLT(newPurchase);
  const newFinance = (newPurchase + newBuild) * 0.065;
  const agentFees = newGdv * 0.015;
  const profFees = newBuild * 0.12;
  const contingency = newBuild * 0.10;
  const totalCosts = newPurchase + newBuild + newSdlt + agentFees + profFees + contingency + newFinance;
  const profit = newGdv - totalCosts;
  const margin = newGdv > 0 ? (profit / newGdv) * 100 : 0;
  return { newPurchase, newBuild, newGdv, profit, margin };
}

function buildWhatIfSection(gdv, buildMid, purchase) {
  whatIfBase = { gdv, buildMid, purchase };
  document.getElementById('whatif-purchase').value = 0;
  document.getElementById('whatif-build').value = 0;
  document.getElementById('whatif-gdv').value = 0;
  renderWhatIf();
}

function resetWhatIf() {
  document.getElementById('whatif-purchase').value = 0;
  document.getElementById('whatif-build').value = 0;
  document.getElementById('whatif-gdv').value = 0;
  renderWhatIf();
}

function renderWhatIf() {
  if (!whatIfBase) return;

  const purchasePctLess = parseFloat(document.getElementById('whatif-purchase').value);
  const buildPctOver = parseFloat(document.getElementById('whatif-build').value);
  const gdvPctLess = parseFloat(document.getElementById('whatif-gdv').value);

  const base = computeWhatIf(0, 0, 0);
  const scenario = computeWhatIf(purchasePctLess, buildPctOver, gdvPctLess);

  document.getElementById('whatif-purchase-val').textContent = purchasePctLess === 0
    ? `No change — ${fmt(whatIfBase.purchase)} purchase price`
    : `${fmt(whatIfBase.purchase - scenario.newPurchase)} less (${purchasePctLess}%) — ${fmt(scenario.newPurchase)} purchase price`;

  document.getElementById('whatif-build-val').textContent = buildPctOver === 0
    ? `No change — ${fmt(whatIfBase.buildMid)} build cost`
    : buildPctOver > 0
      ? `+${buildPctOver}% over budget — ${fmt(scenario.newBuild)} build cost`
      : `${buildPctOver}% under budget — ${fmt(scenario.newBuild)} build cost`;

  document.getElementById('whatif-gdv-val').textContent = gdvPctLess === 0
    ? `No change — ${fmt(whatIfBase.gdv)} GDV`
    : `${fmt(whatIfBase.gdv - scenario.newGdv)} less (${gdvPctLess}%) — ${fmt(scenario.newGdv)} GDV`;

  const marginEl = document.getElementById('whatif-result-margin');
  const verdictEl = document.getElementById('whatif-result-verdict');
  const detailEl = document.getElementById('whatif-result-detail');

  marginEl.textContent = fmtPct(scenario.margin);

  let verdictCls, verdictText, color;
  if (scenario.margin >= 20) { verdictCls = 'viable'; verdictText = 'Viable'; color = 'var(--green)'; }
  else if (scenario.margin >= 12) { verdictCls = 'marginal'; verdictText = 'Marginal'; color = 'var(--amber)'; }
  else { verdictCls = 'not-viable'; verdictText = 'Not viable'; color = 'var(--red)'; }

  marginEl.style.color = color;
  verdictEl.className = 'whatif-result-verdict ' + verdictCls;
  verdictEl.textContent = verdictText;

  const profitDelta = scenario.profit - base.profit;
  if (purchasePctLess === 0 && buildPctOver === 0 && gdvPctLess === 0) {
    detailEl.textContent = `Profit: ${fmt(scenario.profit)} — same as your base case.`;
  } else if (profitDelta < 0) {
    detailEl.textContent = `Profit: ${fmt(scenario.profit)} — ${fmt(Math.abs(profitDelta))} lower than your base case.`;
  } else {
    detailEl.textContent = `Profit: ${fmt(scenario.profit)} — ${fmt(profitDelta)} higher than your base case.`;
  }
}

function setRiskNote(id, cls, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'risk-item-note' + (cls ? ' ' + cls : '');
  el.textContent = text;
}

function buildAreaSnapshot(postcode, district, region, snap, epcResult, floodZone, planwireResult, conservationArea) {
  const areaLabel = district || postcodeOutward(postcode);
  document.getElementById('snapshot-postcode').textContent = areaLabel;

  // Metrics tiles — sourced from the district-wide, unfiltered comp pool
  // (snap), independent of whatever devType/propType this deal is using.
  document.getElementById('snap-avg').textContent = snap.usedFallback ? 'Insufficient data' : fmt(snap.medianPrice);
  document.getElementById('snap-tx').textContent = snap.txCount.toString();
  document.getElementById('snap-growth').textContent = snap.usedFallback
    ? '—'
    : (snap.growth >= 0 ? '+' : '') + snap.growth.toFixed(1) + '%';

  // Update the transactions sub-label — honest about the actual window
  // pagination retrieved, not a hardcoded "Last 12 months" claim.
  const txTile = document.getElementById('snap-tx').closest('.metric-tile');
  if (txTile) {
    const sub = txTile.querySelector('.metric-tile-sub');
    if (sub) sub.textContent = snap.windowLabel;
  }

  // EPC flag
  const epcEl = document.getElementById('flag-epc');
  if (epcEl) {
    if (epcResult && epcResult.band) {
      const band = epcResult.band.toUpperCase();
      const potential = epcResult.potentialBand ? `, potential ${epcResult.potentialBand.toUpperCase()}` : '';
      const area = epcResult.floorArea ? `, ${epcResult.floorArea}m²` : '';
      const lodged = epcResult.lodgementDate
        ? `, lodged ${new Date(epcResult.lodgementDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
        : '';
      const cls = 'AB'.includes(band) ? 'flag flag-safe'
                : 'CD'.includes(band) ? 'flag flag-warn'
                : 'flag flag-risk';
      epcEl.className = cls;
      epcEl.textContent = `${band}${potential}${area}${lodged} — sample property in this postcode`;
    } else {
      epcEl.className = 'flag flag-warn';
      epcEl.textContent = 'Not available';
    }
  }

  // Flood flag
  const floodEl = document.getElementById('flag-flood');
  if (floodEl) {
    if (floodZone === null) {
      floodEl.className = 'flag flag-warn';
      floodEl.textContent = "Couldn't check";
      setRiskNote('flag-flood-note', '', "We weren't able to look this up against Environment Agency data — this isn't a clean result, it's a failed lookup. Check the long-term flood risk report for this postcode before proceeding.");
    } else if (floodZone === 1) {
      floodEl.className = 'flag flag-safe';
      floodEl.textContent = 'Zone 1 — low probability of flooding';
      setRiskNote('flag-flood-note', '', 'Standard buildings insurance covers this without issue — no flood survey needed for lending.');
    } else if (floodZone === 2) {
      floodEl.className = 'flag flag-warn';
      floodEl.textContent = 'Zone 2 — medium probability of flooding';
      setRiskNote('flag-flood-note', 'warn', "Most lenders will still fund this, but expect a flood survey requirement and a higher insurance premium — get a quote before exchange, not after.");
    } else {
      floodEl.className = 'flag flag-risk';
      floodEl.textContent = 'Zone 3 — high probability of flooding';
      setRiskNote('flag-flood-note', 'risk', 'This will complicate both lending and insurance — get a flood risk assessment and an indicative insurance quote before you exchange, not after.');
    }
  }

  // Planning flags
  const planningEl = document.getElementById('flag-planning');
  const refusalsEl = document.getElementById('flag-refusals');
  if (planningEl && refusalsEl) {
    if (!planwireResult) {
      planningEl.className = 'flag flag-warn';
      planningEl.textContent = "Couldn't check";
      refusalsEl.className = 'flag flag-warn';
      refusalsEl.textContent = "Couldn't check";
      setRiskNote('flag-planning-note', '', "We weren't able to pull planning history for this site — this isn't an empty result, it's a failed lookup. Check the local authority's planning portal directly before relying on precedent.");
    } else {
      const { total, granted, refused, mostRecentRefusalYear } = planwireResult;
      if (total === 0) {
        planningEl.className = 'flag flag-safe';
        planningEl.textContent = 'No decisions nearby';
        refusalsEl.className = 'flag flag-safe';
        refusalsEl.textContent = 'None found';
        setRiskNote('flag-planning-note', '', "No planning history nearby to benchmark against — treat this as an unknown rather than a green light.");
      } else {
        const approvalRate = granted / total;
        planningEl.className = approvalRate >= 0.7 ? 'flag flag-safe' : approvalRate >= 0.4 ? 'flag flag-warn' : 'flag flag-risk';
        planningEl.textContent = `${granted} of ${total} approved`;
        if (approvalRate >= 0.7) {
          setRiskNote('flag-planning-note', '', 'This authority is granting most applications nearby — precedent is on your side.');
        } else if (approvalRate >= 0.4) {
          setRiskNote('flag-planning-note', 'warn', "Roughly a coin flip locally — don't treat planning consent as a given, build in time and a fallback scheme.");
        } else {
          setRiskNote('flag-planning-note', 'risk', 'This authority is refusing more applications nearby than it grants — get pre-application advice before you commit.');
        }
        if (refused === 0) {
          refusalsEl.className = 'flag flag-safe';
          refusalsEl.textContent = 'None in last 2 years';
        } else {
          refusalsEl.className = refused >= 2 ? 'flag flag-risk' : 'flag flag-warn';
          refusalsEl.textContent = mostRecentRefusalYear
            ? `${refused} refusal${refused > 1 ? 's' : ''} (${mostRecentRefusalYear})`
            : `${refused} refusal${refused > 1 ? 's' : ''}`;
        }
      }
    }
  }

  // Conservation area flag
  const conservationEl = document.getElementById('flag-conservation');
  if (conservationEl) {
    if (conservationArea === null) {
      conservationEl.className = 'flag flag-warn';
      conservationEl.textContent = "Couldn't check";
      setRiskNote('flag-conservation-note', '', "We weren't able to look this up — this isn't confirmation either way, it's a failed lookup. Check the local authority's conservation area map before assuming either way.");
    } else if (conservationArea) {
      conservationEl.className = 'flag flag-risk';
      conservationEl.textContent = 'Yes — additional controls apply';
      setRiskNote('flag-conservation-note', 'risk', 'Expect tighter constraints on materials and massing — budget extra design and consultation time.');
    } else {
      conservationEl.className = 'flag flag-safe';
      conservationEl.textContent = 'No';
      setRiskNote('flag-conservation-note', '', 'No extra conservation constraints here — standard permitted development rules apply.');
    }
  }

  // 5-year price bars — extrapolated backward from the real current-year
  // median using the real (or regional-trend, see above) YoY growth rate.
  // If even the all-types median is unreliable, there's nothing honest to
  // chart, so this shows a message instead of a fabricated history.
  const thisYear = new Date().getFullYear();
  const years = [4, 3, 2, 1, 0].map(i => String(thisYear - i));
  const priceBarsEl = document.getElementById('price-bars');
  if (snap.usedFallback) {
    priceBarsEl.innerHTML = `<div class="metric-tile-sub">Not enough sold comparables in ${escapeHtml(areaLabel)} to show price history.</div>`;
  } else {
    const annualRate = snap.growth / 100;
    const prices = years.map((y, i) => Math.round(snap.medianPrice * Math.pow(1 - annualRate, 4 - i)));
    const maxP = Math.max(...prices);
    let barsHtml = '';
    years.forEach((y, i) => {
      const pct = Math.round((prices[i] / maxP) * 78);
      const inside = pct > 28;
      barsHtml += `
        <div class="bar-row">
          <div class="bar-year">${y}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%">
              ${inside ? `<span class="bar-val">${fmt(prices[i])}</span>` : ''}
            </div>
            ${!inside ? `<span class="bar-val-out">${fmt(prices[i])}</span>` : ''}
          </div>
        </div>`;
    });
    priceBarsEl.innerHTML = barsHtml;
  }

  // Property type breakdown — real per-type medians from live PPD data
  // (computed in runAppraisal from the same unfiltered comp pool as "All
  // types" above). Below MIN_RELIABLE_COMPS, a type shows "insufficient
  // data" instead of a hardcoded multiplier standing in for a real figure.
  let typesHtml = '';
  snap.typeBreakdown.forEach(t => {
    if (t.median === null) {
      typesHtml += `
        <div class="type-tile">
          <div class="type-name">${escapeHtml(t.name)}</div>
          <div class="type-price">Insufficient data</div>
          <div class="type-change">${t.count} sale${t.count === 1 ? '' : 's'} in 12mo — too few to show a reliable median</div>
        </div>`;
    } else {
      const changeText = t.growth === null
        ? `${t.count} sold comp${t.count === 1 ? '' : 's'}`
        : `${t.growth >= 0 ? '+' : ''}${t.growth.toFixed(1)}% this year`;
      const changeCls = t.growth !== null && t.growth >= 3 ? 'up' : 'flat';
      typesHtml += `
        <div class="type-tile">
          <div class="type-name">${escapeHtml(t.name)}</div>
          <div class="type-price">${fmt(t.median)}</div>
          <div class="type-change ${changeCls}">${changeText}</div>
        </div>`;
    }
  });
  document.getElementById('type-grid').innerHTML = typesHtml;
}

function buildDevTypePlanningCard(result, devType) {
  const labelEl = document.getElementById('devtype-planning-label');
  const caveatBox = document.getElementById('devtype-planning-caveat');
  const metricsBox = document.getElementById('devtype-planning-metrics');
  const refurbNote = document.getElementById('devtype-planning-refurb-note');
  const limitedBox = document.getElementById('devtype-planning-limited');
  if (!labelEl) return;

  labelEl.textContent = devType;
  caveatBox.style.display = 'none';
  metricsBox.style.display = 'grid';
  refurbNote.style.display = 'none';
  limitedBox.style.display = 'none';

  if (!result) {
    metricsBox.style.display = 'none';
    refurbNote.style.display = 'block';
    refurbNote.textContent = "We weren't able to pull planning application data for this postcode — this isn't an empty result, it's a failed lookup. Try again shortly.";
    return;
  }

  if (result.mode === 'refurb') {
    metricsBox.style.display = 'none';
    refurbNote.style.display = 'block';
    const { decided, approved, refused, approvalRate } = result;
    const intro = "Refurbishment works typically fall under permitted development and don't require planning permission.";
    if (decided === 0) {
      refurbNote.textContent = `${intro} No planning applications of any type were found nearby to use as a wider reference point.`;
    } else if (decided < 3) {
      refurbNote.textContent = `${intro} For reference, only ${decided} planning application${decided === 1 ? '' : 's'} of any type ${decided === 1 ? 'has' : 'have'} been decided nearby — too few to show a reliable approval rate (${approved} approved, ${refused} refused).`;
    } else {
      refurbNote.textContent = `${intro} For reference, ${decided} planning applications of all types were decided nearby with a ${Math.round(approvalRate * 100)}% approval rate.`;
    }
    return;
  }

  // mode === 'devtype'
  document.getElementById('devtype-planning-radius').textContent = result.radiusKm + 'km';
  document.getElementById('devtype-planning-count').textContent = result.totalMatched;
  document.getElementById('devtype-planning-count-sub').textContent = `Within ${result.radiusKm}km`;

  const rateEl = document.getElementById('devtype-planning-rate');
  const rateSubEl = document.getElementById('devtype-planning-rate-sub');
  if (result.decided >= 3) {
    rateEl.textContent = Math.round(result.approvalRate * 100) + '%';
    rateSubEl.textContent = `${result.approved} of ${result.decided} decided`;
  } else {
    rateEl.textContent = '—';
    rateSubEl.textContent = result.decided > 0 ? `Only ${result.decided} decided — too few to rate` : 'No decisions yet';
  }

  if (result.radiusExpanded) {
    caveatBox.style.display = 'flex';
    document.getElementById('devtype-planning-caveat-msg').textContent =
      `Showing outcomes within ${result.radiusKm}km — not enough ${devType} applications were found closer to the property.`;
  }

  if (result.totalMatched < 3) {
    limitedBox.style.display = 'block';
    document.getElementById('devtype-planning-limited-msg').textContent =
      `Not enough ${devType} applications nearby to show a reliable approval pattern.`;
    document.getElementById('devtype-planning-list').innerHTML = result.matches.map(a => {
      const c = classifyPlanningDecision(a.decision);
      const label = c === 'approved' ? 'Approved' : c === 'refused' ? 'Refused' : 'Pending / other';
      const cls = c === 'approved' ? 'flag-safe' : c === 'refused' ? 'flag-risk' : 'flag-warn';
      return `<li class="risk-item"><div class="risk-item-row"><span>${escapeHtml(a.address) || 'Address not available'}</span><span class="flag ${cls}">${label}</span></div></li>`;
    }).join('');
  }
}

// --- Things You May Have Missed ---
// Evidence-based checks derived from cross-referencing appraisal fields against
// the actual scoring/calc logic above — not generic disclaimers.

const LONG_BUILD_DEVTYPES = ['New build', 'HMO conversion'];

function computeMissedItems(a) {
  const items = [];

  // A strong blended score can hide one seriously weak category
  if (a.score.overall >= 70) {
    SCORE_CATEGORY_META.forEach(meta => {
      const val = a.score.categories[meta.key];
      if (val < 40) {
        items.push({
          severity: 'warn',
          title: 'A strong score is masking a weak category',
          text: `Your overall score reads as a Strong deal, but ${meta.label} scores just ${val}/100. A good blended score can hide one seriously weak category — check the breakdown above before treating this as a green light across the board.`
        });
      }
    });
  }

  // EPC is from a sample property in the postcode, not the actual one — and it
  // directly weights the Exit Strategy score when the band isn't A/B/C
  if (a.epcResult && a.epcResult.band && !'ABC'.includes(a.epcResult.band.toUpperCase())) {
    items.push({
      severity: 'warn',
      title: 'EPC used is a sample, not confirmed for this property',
      text: `The EPC band used (${a.epcResult.band}) is from a sample property in this postcode, not the specific one you're appraising — and it currently feeds 30% of your Exit Strategy score (${a.score.categories.exitStrategy}/100). Confirm the real EPC before relying on that figure.`
    });
  }

  // Property type filter fell back to the unfiltered district median
  if (a.usedPropTypeFallback) {
    const areaLabel = a.district || postcodeOutward(a.postcode);
    const propLabel = a.propType.toLowerCase();
    items.push({
      severity: 'warn',
      title: `Not enough ${propLabel} sales to filter GDV by property type`,
      text: `Only ${a.propTypeFilteredCount} sold ${propLabel} comparable${a.propTypeFilteredCount === 1 ? '' : 's'} were found in ${areaLabel} in the last 12 months — too few to trust on their own. GDV instead uses the median sold price across all property types in ${areaLabel}, which may run higher or lower than ${propLabel} values specifically.`
    });
  }

  // Conservation area flag is shown regardless of dev type, but the score
  // deliberately doesn't penalise HMO conversion for it — Article 4 is the real risk
  if (a.conservationArea === true && a.devType === 'HMO conversion') {
    items.push({
      severity: 'risk',
      title: "Conservation area doesn't factor into your HMO planning score",
      text: "This site is in a conservation area, but that isn't factored into your Planning Risk score for HMO conversions. What actually matters here is whether an Article 4 Direction removes permitted development rights for C3-to-C4 use — conservation areas often overlap with these. Worth checking with the local authority directly."
    });
  }

  // New build in a flagged flood zone faces a national policy test, not just a local approval rate
  if (a.devType === 'New build' && a.floodZone >= 2) {
    items.push({
      severity: 'risk',
      title: `New build in a Flood Zone ${a.floodZone} area faces a planning policy test`,
      text: `New build in a Flood Zone ${a.floodZone} area has to pass the sequential/exception test under national planning policy — a materially higher bar than the local approval rate reflects, and it can block consent outright regardless of precedent nearby.`
    });
  }

  // Dev-type approval rate is confidently displayed just above the reliability cutoff
  const dtpi = a.devTypePlanningIntel;
  if (dtpi && dtpi.mode === 'devtype' && dtpi.decided >= 3 && dtpi.decided <= 5) {
    const rate = Math.round(dtpi.approvalRate * 100);
    const swing = Math.round((1 / dtpi.decided) * 100);
    items.push({
      severity: 'warn',
      title: 'Approval rate is based on a thin sample',
      text: `Your ${a.devType} approval rate (${rate}%) is based on just ${dtpi.decided} decided applications. One different outcome would swing that rate by ${swing}% — treat it as a signal, not a statistic.`
    });
  }

  // Multiple units exiting into a market that's only just cleared the fallback threshold
  if (!a.usedFallback && a.units >= 3 && a.compCount >= 5 && a.compCount <= 8) {
    items.push({
      severity: 'warn',
      title: 'Multiple units, thin resale market',
      text: `This exit relies on selling ${a.units} units into a market with only ${a.compCount} comparable sales in the last 12 months. Absorbing that many units at once could take longer, or need a price discount, versus what the assumed GDV reflects.`
    });
  }

  // Finance is a flat rate that doesn't account for build programme length
  if (LONG_BUILD_DEVTYPES.includes(a.devType)) {
    items.push({
      severity: 'warn',
      title: 'Finance cost assumes a flat rate, regardless of build duration',
      text: `Finance is calculated at a flat 6.5%, regardless of build duration. ${a.devType} schemes typically take significantly longer than a light refurbishment — if this build runs 12+ months, actual finance costs are likely higher than the ${fmt(a.finance)} shown.`
    });
  }

  return items;
}

function renderMissedItems(items) {
  const list = document.getElementById('missed-items-list');
  const empty = document.getElementById('missed-items-empty');
  if (!list || !empty) return;

  if (!items.length) {
    list.innerHTML = '';
    list.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  list.style.display = '';
  empty.style.display = 'none';
  list.innerHTML = items.map(item => {
    const icon = item.severity === 'risk' ? 'ti-alert-octagon' : 'ti-alert-triangle';
    const iconColor = item.severity === 'risk' ? 'var(--red)' : 'var(--amber)';
    return `
      <li class="risk-item">
        <div class="risk-item-row"><span style="display:flex;align-items:center;gap:8px;font-weight:500"><i class="ti ${icon}" style="color:${iconColor};flex-shrink:0"></i>${escapeHtml(item.title)}</span></div>
        <div class="risk-item-note ${item.severity}">${escapeHtml(item.text)}</div>
      </li>`;
  }).join('');
}

function buildMissedItemsSection(a) {
  renderMissedItems(computeMissedItems(a));
}

function exportPdf() {
  if (!currentAppraisal) return;

  if (typeof currentPlan !== 'undefined' && currentPlan === 'trial') {
    openUpgrade();
    return;
  }

  // Populate print header
  document.getElementById('pdf-meta-postcode').textContent = currentAppraisal.postcode;
  document.getElementById('pdf-meta-devtype').textContent = currentAppraisal.devType;
  document.getElementById('pdf-meta-date').textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Apply or remove watermark class based on plan
  if (typeof currentPlan !== 'undefined' && currentPlan === 'essential') {
    document.body.classList.add('pdf-watermark');
  } else {
    document.body.classList.remove('pdf-watermark');
  }

  // Set a descriptive document title so the browser save dialog defaults to a sensible filename
  const prevTitle = document.title;
  document.title = `Avalor Appraisal — ${currentAppraisal.postcode} — ${currentAppraisal.devType}`;

  window.print();

  // Restore state after print dialog closes
  document.title = prevTitle;
  document.body.classList.remove('pdf-watermark');
}
