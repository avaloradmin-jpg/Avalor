// Avalor — Appraisal calculation engine

const BCIS = {
  'Loft conversion':      { low: 1200, mid: 1600, high: 2100 },
  'Flat conversion':      { low: 1400, mid: 1800, high: 2400 },
  'HMO conversion':       { low: 1300, mid: 1700, high: 2200 },
  'Light refurbishment':  { low: 600,  mid: 900,  high: 1300 },
  'Full refurbishment':   { low: 900,  mid: 1300, high: 1800 },
  'New build':            { low: 1800, mid: 2400, high: 3200 }
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

// End-product property type for each dev type — used to filter comps
const DEV_TYPE_TO_PPD_TYPE = {
  'Flat conversion':     'flat-maisonette',
  'Loft conversion':     'flat-maisonette',
  'HMO conversion':      'flat-maisonette',
  'Light refurbishment': null,
  'Full refurbishment':  null,
  'New build':           null
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
const FLOOD_LABEL_RANK = { 'Very High': 4, 'High': 3, 'Medium': 2, 'Low': 1 };

async function fetchFloodRisk(uprn) {
  const resp = await fetch(`${HOMEDATA_PROXY}?path=${encodeURIComponent('risks/flood/')}&uprn=${uprn}`, {
    signal: AbortSignal.timeout(6000)
  });
  if (!resp.ok) throw new Error('Flood risk lookup failed: ' + resp.status);
  const data = await resp.json();
  return data.results ?? [];
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

function worstFloodLabel(results) {
  if (!results.length) return null;
  return results.reduce((worst, r) => {
    const rank = FLOOD_LABEL_RANK[r.label] ?? 0;
    return rank > (FLOOD_LABEL_RANK[worst] ?? 0) ? r.label : worst;
  }, null);
}

async function fetchLandRegistryComps(postcode, devType) {
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

  // Filter by end-product property type
  const typeFilter = DEV_TYPE_TO_PPD_TYPE[devType];
  const filtered = typeFilter
    ? transactions.filter(t => t.type === typeFilter)
    : transactions;

  return { transactions: filtered, district, lat: pcData.result.latitude, lng: pcData.result.longitude };
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function calcSDLT(price) {
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
  sdlt += price * 0.03; // Additional dwelling surcharge
  return Math.round(sdlt);
}

function fmt(n) {
  return '£' + Math.round(n).toLocaleString('en-GB');
}

function fmtPct(n) {
  return (Math.round(n * 10) / 10) + '%';
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
  let district = '';
  let usedFallback = false;
  let fallbackReason = '';
  let epcResult = null;
  let floodResults = null;
  let planwireResult = null;
  let conservationArea = null;

  // Land Registry and Homedata address lookup run in parallel
  const [lrOutcome, addrOutcome] = await Promise.allSettled([
    fetchLandRegistryComps(postcode, devType),
    resolveHomedataAddresses(postcode)
  ]);

  if (lrOutcome.status === 'fulfilled') {
    comps = lrOutcome.value.transactions;
    district = lrOutcome.value.district;
  } else {
    usedFallback = true;
    fallbackReason = 'The Land Registry API could not be reached. GDV and area statistics are based on regional averages, not live market data.';
  }

  // EPC, flood, and PlanWire all fire in parallel
  const addresses = addrOutcome.status === 'fulfilled' ? addrOutcome.value : [];
  const uprn = addresses[0]?.uprn;
  const lrCoords = lrOutcome.status === 'fulfilled' ? lrOutcome.value : null;

  const [epcOutcome, floodOutcome, planwireOutcome, conservationOutcome] = await Promise.allSettled([
    addresses.length ? fetchEpcData(addresses) : Promise.reject('No addresses'),
    uprn ? fetchFloodRisk(uprn) : Promise.reject('No UPRN'),
    lrCoords ? fetchPlanwireData(lrCoords.lat, lrCoords.lng) : Promise.reject('No coords'),
    lrCoords ? fetchConservationArea(lrCoords.lat, lrCoords.lng) : Promise.reject('No coords')
  ]);

  if (epcOutcome.status === 'fulfilled') epcResult = epcOutcome.value;
  if (floodOutcome.status === 'fulfilled') floodResults = floodOutcome.value;
  if (planwireOutcome.status === 'fulfilled') planwireResult = planwireOutcome.value;
  if (conservationOutcome.status === 'fulfilled') conservationArea = conservationOutcome.value;

  // Split into last 12 months and prior 12 months for YoY growth
  const now = new Date();
  const twelveMonthsAgo = new Date(now); twelveMonthsAgo.setFullYear(now.getFullYear() - 1);
  const last12 = comps.filter(t => t.date >= twelveMonthsAgo);
  const prior12 = comps.filter(t => t.date < twelveMonthsAgo);

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

  // GDV: median comp × units × 0.85 (refurb discount vs new/prime)
  const gdv = medianPrice * units * 0.85;

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

  currentAppraisal = {
    postcode, devType, region, purchase, area, units,
    gdv, buildMid, sdlt, finance, profit, margin, rlv,
    bcis, growth, ppm, compCount: last12.length, district, usedFallback
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

  // SDLT breakdown
  const band1 = Math.min(purchase, 250000) * 0.03;
  const band2 = Math.max(0, Math.min(purchase, 925000) - 250000) * 0.08;
  const addl = purchase * 0.03;
  document.getElementById('s1').textContent = fmt(band1);
  document.getElementById('s2').textContent = fmt(band2);
  document.getElementById('s3').textContent = fmt(addl);
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
    verdictDesc.textContent = 'Profit margin exceeds 20% threshold — deal stacks up at current assumptions.';
    marginEl.style.color = 'var(--green)';
  } else if (margin >= 12) {
    verdictBox.className = 'verdict marginal';
    verdictIcon.className = 'ti ti-alert-triangle';
    verdictTitle.textContent = 'Marginal';
    verdictDesc.textContent = 'Profit margin between 12–20% — review assumptions carefully before committing.';
    marginEl.style.color = 'var(--amber)';
  } else {
    verdictBox.className = 'verdict not-viable';
    verdictIcon.className = 'ti ti-circle-x';
    verdictTitle.textContent = 'Not viable';
    verdictDesc.textContent = 'Profit margin below 12% — deal unlikely to work at current purchase price.';
    marginEl.style.color = 'var(--red)';
  }

  buildResilienceSection(gdv, buildMid, purchase, sdlt, finance, margin);
  buildSensTable(gdv, buildMid, purchase, sdlt, finance);
  buildAreaSnapshot(postcode, district, region, growth, last12, medianPrice, usedFallback, epcResult, floodResults, planwireResult, conservationArea);

  const growthWidth = Math.min(90, Math.max(10, (Math.abs(growth) / 10) * 100));
  document.getElementById('growth-fill').style.width = growthWidth + '%';
  document.getElementById('growth-pct').textContent = (growth >= 0 ? '+' : '') + growth.toFixed(1) + '% p/a';

  document.getElementById('results').style.display = 'block';
  document.getElementById('save-btn').style.display = 'inline-flex';
  document.getElementById('export-btn').style.display = 'inline-flex';

  markOnboardingStep(1);

  document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildResilienceSection(gdv, buildMid, purchase, sdlt, finance, baseMargin) {
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

function buildSensTable(gdv, buildMid, purchase, sdlt, finance) {
  const gdvVars = [-0.20, -0.10, 0, 0.10, 0.20];
  const buildVars = [-0.20, -0.10, 0, 0.10, 0.20];
  const labels = ['-20%', '-10%', 'Base', '+10%', '+20%'];

  let html = '';
  buildVars.forEach((bv, bi) => {
    html += `<tr><td style="font-size:12px;color:var(--text-secondary);background:var(--bg-secondary);padding:7px 9px;text-align:left">${labels[bi]} build</td>`;
    gdvVars.forEach(gv => {
      const m = getMargin(gdv, buildMid, purchase, sdlt, finance, gv, bv);
      const cls = m >= 20 ? 'cell-green' : m >= 12 ? 'cell-amber' : 'cell-red';
      html += `<td class="${cls}">${fmtPct(m)}</td>`;
    });
    html += '</tr>';
  });
  document.getElementById('sens-body').innerHTML = html;
}

function buildAreaSnapshot(postcode, district, region, growth, last12Comps, medianPrice, usedFallback, epcResult, floodResults, planwireResult, conservationArea) {
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
    if (floodResults === null) {
      floodEl.className = 'flag flag-warn';
      floodEl.textContent = 'Not available';
    } else {
      const worst = worstFloodLabel(floodResults);
      if (!worst) {
        floodEl.className = 'flag flag-safe';
        floodEl.textContent = 'Zone 1 — very low risk';
      } else if (worst === 'Low') {
        floodEl.className = 'flag flag-warn';
        floodEl.textContent = 'Zone 2 — low risk';
      } else if (worst === 'Medium') {
        floodEl.className = 'flag flag-warn';
        floodEl.textContent = 'Zone 3 — medium risk';
      } else {
        // High or Very High
        floodEl.className = 'flag flag-risk';
        floodEl.textContent = `Zone 3 — ${worst.toLowerCase()} risk`;
      }
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
    } else {
      const { total, granted, refused, mostRecentRefusalYear } = planwireResult;
      if (total === 0) {
        planningEl.className = 'flag flag-safe';
        planningEl.textContent = 'No decisions nearby';
        refusalsEl.className = 'flag flag-safe';
        refusalsEl.textContent = 'None found';
      } else {
        const approvalRate = granted / total;
        planningEl.className = approvalRate >= 0.7 ? 'flag flag-safe' : approvalRate >= 0.4 ? 'flag flag-warn' : 'flag flag-risk';
        planningEl.textContent = `${granted} of ${total} approved`;
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
    } else if (conservationArea) {
      conservationEl.className = 'flag flag-risk';
      conservationEl.textContent = 'Yes — additional controls apply';
    } else {
      conservationEl.className = 'flag flag-safe';
      conservationEl.textContent = 'No';
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

  // Force the sensitivity table open so it prints
  const sensWrap = document.getElementById('sens-wrap');
  const sensWasHidden = sensWrap.style.display === 'none';
  if (sensWasHidden) sensWrap.style.display = 'block';

  window.print();

  // Restore state after print dialog closes
  document.title = prevTitle;
  document.body.classList.remove('pdf-watermark');
  if (sensWasHidden) sensWrap.style.display = 'none';
}

function toggleSens() {
  const wrap = document.getElementById('sens-wrap');
  const icon = document.getElementById('sens-icon');
  const btn = document.getElementById('sens-toggle');
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? 'block' : 'none';
  icon.className = open ? 'ti ti-chevron-up' : 'ti ti-chevron-down';
  btn.childNodes[1].textContent = open ? ' Hide full sensitivity table' : ' Show full sensitivity table';
}
