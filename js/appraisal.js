// Avalor — Appraisal calculation engine

const BCIS = {
  'Loft conversion':      { low: 1200, mid: 1600, high: 2100 },
  'Flat conversion':      { low: 1400, mid: 1800, high: 2400 },
  'HMO conversion':       { low: 1300, mid: 1700, high: 2200 },
  'Light refurbishment':  { low: 600,  mid: 900,  high: 1300 },
  'Full refurbishment':   { low: 900,  mid: 1300, high: 1800 },
  'New build':            { low: 1800, mid: 2400, high: 3200 }
};

// GDV multiplier — how the end-product type is expected to sell relative to
// the raw district median. Conversions produce lower-value stock, a good
// refurb should meet the median, new build commands a premium.
const GDV_MULTIPLIER = {
  'Loft conversion':     0.85,
  'Flat conversion':     0.85,
  'HMO conversion':      0.85,
  'Light refurbishment': 1.00,
  'Full refurbishment':  1.00,
  'New build':           1.05
};

const GDV_MULTIPLIER_REASON = {
  'Loft conversion':     'Refurbished or converted stock typically sells at a small discount to the local median',
  'Flat conversion':     'Refurbished or converted stock typically sells at a small discount to the local median',
  'HMO conversion':      'Refurbished or converted stock typically sells at a small discount to the local median',
  'Light refurbishment': 'A well-executed refurb should achieve close to the local median sold price',
  'Full refurbishment':  'A well-executed refurb should achieve close to the local median sold price',
  'New build':           'New build typically commands a premium over existing stock'
};

// Regional fallback prices (£/sqm) — used when Land Registry returns < 5 comps
const PRICE_PER_SQM_FALLBACK = {
  'London':     6500,
  'South East': 4200,
  'South West': 3600,
  'Midlands':   2800,
  'North West': 2600,
  'North East': 2200,
  'Yorkshire':  2500
};

const PRICE_GROWTH_FALLBACK = {
  'London':     5.8,
  'South East': 6.2,
  'South West': 5.9,
  'Midlands':   6.8,
  'North West': 7.1,
  'North East': 5.4,
  'Yorkshire':  6.5
};

// End-product property type for each dev type — used to filter comps.
// Conversions always produce flats regardless of what "Property type" the
// user selected, so this takes priority over PROP_TYPE_TO_PPD_TYPE below.
const DEV_TYPE_TO_PPD_TYPE = {
  'Flat conversion':     'flat-maisonette',
  'Loft conversion':     'flat-maisonette',
  'HMO conversion':      'flat-maisonette',
  'Light refurbishment': null,
  'Full refurbishment':  null,
  'New build':           null
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
const HOMEDATA_PROXY = '/api/homedata';

function epcScoreToBand(score) {
  if (score == null) return null;
  if (score >= 92) return 'A';
  if (score >= 81) return 'B';
  if (score >= 69) return 'C';
  if (score >= 55) return 'D';
  if (score >= 39) return 'E';
  if (score >= 21) return 'F';
  return 'G';
}

async function resolveHomedataAddresses(postcode) {
  const pcClean = postcode.replace(/\s+/g, '').toUpperCase();
  const resp = await fetch(`${HOMEDATA_PROXY}?path=${encodeURIComponent('address/postcode/' + pcClean + '/')}`, {
    signal: AbortSignal.timeout(6000)
  });
  if (!resp.ok) throw new Error('Homedata postcode lookup failed: ' + resp.status);
  const data = await resp.json();
  const addresses = Array.isArray(data) ? data : (data.addresses ?? data.results ?? []);
  if (!addresses.length) throw new Error('No addresses found for postcode');
  return addresses;
}

async function fetchEpcData(addresses) {
  // Try up to 5 UPRNs — not every property has a lodged EPC
  for (const addr of addresses.slice(0, 5)) {
    const uprn = addr.uprn;
    if (!uprn) continue;
    const resp = await fetch(`${HOMEDATA_PROXY}?path=${encodeURIComponent('epc-checker/' + uprn + '/')}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    const score = data.current_energy_efficiency ?? null;
    if (score == null) continue;
    return { band: epcScoreToBand(score), score };
  }
  throw new Error('No EPC data found for properties in this postcode');
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
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

async function fetchLandRegistryComps(postcode, devType, propType) {
  // Step 1: resolve postcode to district
  const pcClean = postcode.replace(/\s+/g, '');
  const pcResp = await fetch(POSTCODES_API + pcClean, { signal: AbortSignal.timeout(5000) });
  if (!pcResp.ok) throw new Error('Postcode lookup failed');
  const pcData = await pcResp.json();
  const district = pcData.result?.admin_district?.toUpperCase();
  if (!district) throw new Error('Could not resolve district for ' + postcode);

  // Step 2: fetch 24 months of PPD data for the district (allows YoY comparison)
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 24);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const url = `${PPD_API}?propertyAddress.district=${encodeURIComponent(district)}&min-transactionDate=${cutoffStr}&_pageSize=100&_sort=-transactionDate`;
  const ppdResp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!ppdResp.ok) throw new Error('PPD API error ' + ppdResp.status);
  const ppdData = await ppdResp.json();

  const allItems = ppdData.result?.items ?? [];

  // Parse each record
  const transactions = allItems.map(item => ({
    price: item.pricePaid,
    date: new Date(item.transactionDate),
    type: item.propertyType?.prefLabel?.[0]?._value ?? ''
  })).filter(t => t.price > 0 && !isNaN(t.date));

  // Filter by end-product property type: the dev type's forced type (conversions)
  // takes priority over the user-selected property type (refurb/new build).
  const devForcedType = DEV_TYPE_TO_PPD_TYPE[devType];
  const propTypeFilter = PROP_TYPE_TO_PPD_TYPE[propType] || null;
  const typeFilter = devForcedType || propTypeFilter;
  const filtered = typeFilter
    ? transactions.filter(t => t.type === typeFilter)
    : transactions;

  return {
    transactions: filtered,
    allTransactions: transactions,
    district,
    lat: pcData.result.latitude,
    lng: pcData.result.longitude,
    filterSource: devForcedType ? 'devType' : (propTypeFilter ? 'propType' : null)
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

  const areaLabel = a.district || a.postcode.split(' ')[0];
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

const PLANNING_REFURB_TYPES = ['Light refurbishment', 'Full refurbishment'];
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
  'Light refurbishment': 90,
  'Full refurbishment':  75,
  'Loft conversion':     70,
  'Flat conversion':     65,
  'HMO conversion':      55,
  'New build':           45
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
  const postcode = document.getElementById('postcode').value.trim().toUpperCase();
  const devType = document.getElementById('dev-type').value;
  const propType = document.getElementById('prop-type').value;
  const region = document.getElementById('region').value;
  const purchase = parseFloat(document.getElementById('purchase').value) || 320000;
  const area = parseFloat(document.getElementById('floorarea').value) || 110;
  const units = parseInt(document.getElementById('units').value) || 2;

  if (!postcode) {
    toast('Please enter a postcode', 'error');
    return;
  }

  const btn = document.getElementById('run-btn');
  btn.innerHTML = '<span class="loading-spinner"></span> Running…';
  btn.disabled = true;

  const bcis = BCIS[devType] || BCIS['Flat conversion'];
  const fallbackPpm = PRICE_PER_SQM_FALLBACK[region] || 4200;
  const fallbackGrowth = PRICE_GROWTH_FALLBACK[region] || 6.0;

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

  // Land Registry and Homedata address lookup run in parallel
  const [lrOutcome, addrOutcome] = await Promise.allSettled([
    fetchLandRegistryComps(postcode, devType, propType),
    resolveHomedataAddresses(postcode)
  ]);

  if (lrOutcome.status === 'fulfilled') {
    comps = lrOutcome.value.transactions;
    allComps = lrOutcome.value.allTransactions;
    filterSource = lrOutcome.value.filterSource;
    district = lrOutcome.value.district;
  } else {
    usedFallback = true;
    fallbackReason = 'The Land Registry API could not be reached. GDV and area statistics are based on regional averages, not live market data.';
  }

  // EPC, flood, and PlanWire all fire in parallel
  const addresses = addrOutcome.status === 'fulfilled' ? addrOutcome.value : [];
  const lrCoords = lrOutcome.status === 'fulfilled' ? lrOutcome.value : null;

  const [epcOutcome, floodOutcome, planwireOutcome, conservationOutcome, devTypePlanningOutcome] = await Promise.allSettled([
    addresses.length ? fetchEpcData(addresses) : Promise.reject('No addresses'),
    lrCoords ? fetchFloodRisk(lrCoords.lat, lrCoords.lng) : Promise.reject('No coords'),
    lrCoords ? fetchPlanwireData(lrCoords.lat, lrCoords.lng) : Promise.reject('No coords'),
    lrCoords ? fetchConservationArea(lrCoords.lat, lrCoords.lng) : Promise.reject('No coords'),
    lrCoords ? fetchDevTypePlanningIntel(lrCoords.lat, lrCoords.lng, devType) : Promise.reject('No coords')
  ]);

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

  // Require at least 5 comps in the last 12 months to trust the data
  if (!usedFallback && last12.length < 5) {
    usedFallback = true;
    const label = district || postcode.split(' ')[0];
    fallbackReason = `Only ${last12.length} sold comparable${last12.length === 1 ? '' : 's'} found in ${label} for the last 12 months. GDV and area statistics are based on regional averages, not live market data.`;
  }

  // --- Derive key figures ---
  let medianPrice, growth;

  if (!usedFallback) {
    medianPrice = median(last12.map(t => t.price));
    if (prior12.length >= 3) {
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

  const gdvBasisLabel = usedFallback ? 'regional avg' : 'median';
  document.getElementById('r-gdv-note').textContent = `${fmt(medianPrice)} ${gdvBasisLabel} × ${units} unit${units === 1 ? '' : 's'} × ${gdvMultiplier.toFixed(2)} = ${fmt(gdv)}`;

  renderGdvExplainer({
    usedFallback, usedPropTypeFallback, district, postcode, region, devType, propType,
    compCount: last12.length, propTypeFilteredCount, gdvMultiplier
  });

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
  buildAreaSnapshot(postcode, district, region, growth, last12, medianPrice, usedFallback, epcResult, floodZone, planwireResult, conservationArea);
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

function buildAreaSnapshot(postcode, district, region, growth, last12Comps, medianPrice, usedFallback, epcResult, floodZone, planwireResult, conservationArea) {
  const areaLabel = district || postcode.split(' ')[0];
  document.getElementById('snapshot-postcode').textContent = areaLabel;

  // Metrics tiles
  const txCount = usedFallback ? '—' : last12Comps.length.toString();
  document.getElementById('snap-avg').textContent = fmt(medianPrice);
  document.getElementById('snap-tx').textContent = txCount;
  document.getElementById('snap-growth').textContent = (growth >= 0 ? '+' : '') + growth.toFixed(1) + '%';

  // Update the transactions sub-label
  const txTile = document.getElementById('snap-tx').closest('.metric-tile');
  if (txTile) {
    const sub = txTile.querySelector('.metric-tile-sub');
    if (sub) sub.textContent = usedFallback ? 'No live data' : 'Last 12 months';
  }

  // EPC flag
  const epcEl = document.getElementById('flag-epc');
  if (epcEl) {
    if (epcResult && epcResult.band) {
      const band = epcResult.band.toUpperCase();
      const score = epcResult.score ? ` (${epcResult.score})` : '';
      const cls = 'AB'.includes(band) ? 'flag flag-safe'
                : 'CD'.includes(band) ? 'flag flag-warn'
                : 'flag flag-risk';
      epcEl.className = cls;
      epcEl.textContent = `${band}${score} — sample property`;
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
      floodEl.textContent = 'Not available';
      setRiskNote('flag-flood-note', '', "We couldn't confirm this from Environment Agency data — check the long-term flood risk report for this postcode before proceeding.");
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
      planningEl.textContent = 'Not available';
      refusalsEl.className = 'flag flag-warn';
      refusalsEl.textContent = 'Not available';
      setRiskNote('flag-planning-note', '', "No local planning history to hand — lean on a local planning consultant's read of this authority before you rely on precedent.");
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
      conservationEl.textContent = 'Not available';
      setRiskNote('flag-conservation-note', '', "Not confirmed — check the local authority's conservation area map before assuming either way.");
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

  // 5-year price bars using growth rate
  const years = ['2021', '2022', '2023', '2024', '2025'];
  const annualRate = growth / 100;
  const prices = years.map((y, i) => Math.round(medianPrice * Math.pow(1 - annualRate, 4 - i)));
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
  document.getElementById('price-bars').innerHTML = barsHtml;

  // Property type breakdown (relative multiples from median — PPD REST doesn't support per-type breakdown without extra queries)
  const types = [
    { name: 'Detached',      mult: 1.85, change: (growth * 1.1).toFixed(1) },
    { name: 'Semi-detached', mult: 1.20, change: growth.toFixed(1) },
    { name: 'Terraced',      mult: 0.95, change: (growth * 0.95).toFixed(1) },
    { name: 'Flat',          mult: 0.65, change: (growth * 0.25).toFixed(1) },
    { name: 'New build',     mult: 1.35, change: (growth * 0.85).toFixed(1) },
    { name: 'All types',     mult: 1.00, change: growth.toFixed(1) }
  ];

  let typesHtml = '';
  types.forEach(t => {
    const price = Math.round(medianPrice * t.mult);
    const changeNum = parseFloat(t.change);
    typesHtml += `
      <div class="type-tile">
        <div class="type-name">${t.name}</div>
        <div class="type-price">${fmt(price)}</div>
        <div class="type-change ${changeNum >= 3 ? 'up' : 'flat'}">+${t.change}% this year</div>
      </div>`;
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
    refurbNote.textContent = 'Planning application data is not available for this postcode right now.';
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
    const areaLabel = a.district || a.postcode.split(' ')[0];
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
