// Avalor — Appraisal calculation engine

const BCIS = {
  'Loft conversion':      { low: 1200, mid: 1600, high: 2100 },
  'Flat conversion':      { low: 1400, mid: 1800, high: 2400 },
  'HMO conversion':       { low: 1300, mid: 1700, high: 2200 },
  'Light refurbishment':  { low: 600,  mid: 900,  high: 1300 },
  'Full refurbishment':   { low: 900,  mid: 1300, high: 1800 },
  'New build':            { low: 1800, mid: 2400, high: 3200 }
};

const PRICE_PER_SQM = {
  'London':     6500,
  'South East': 4200,
  'South West': 3600,
  'Midlands':   2800,
  'North West': 2600,
  'North East': 2200,
  'Yorkshire':  2500
};

// Land Registry historic price growth by region (approximate annualised 5yr)
const PRICE_GROWTH = {
  'London':     5.8,
  'South East': 6.2,
  'South West': 5.9,
  'Midlands':   6.8,
  'North West': 7.1,
  'North East': 5.4,
  'Yorkshire':  6.5
};

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
  // Additional dwelling surcharge (3%)
  sdlt += price * 0.03;
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

let currentAppraisal = null;

function runAppraisal() {
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

  setTimeout(() => {
    btn.innerHTML = 'Run appraisal';
    btn.disabled = false;

    const bcis = BCIS[devType] || BCIS['Flat conversion'];
    const ppm = PRICE_PER_SQM[region] || 4200;
    const growth = PRICE_GROWTH[region] || 6.0;

    const gdv = area * ppm * units * 0.85;
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

    // Store for saving
    currentAppraisal = {
      postcode, devType, region, purchase, area, units,
      gdv, buildMid, sdlt, finance, profit, margin, rlv,
      bcis, growth, ppm
    };

    // Populate financials
    document.getElementById('r-gdv').textContent = fmt(gdv);
    document.getElementById('r-build').textContent = fmt(buildMid);
    document.getElementById('r-sdlt').textContent = fmt(sdlt);
    document.getElementById('r-finance').textContent = fmt(finance);
    document.getElementById('r-profit').textContent = fmt(profit);
    document.getElementById('r-margin').textContent = fmtPct(margin);
    document.getElementById('r-rlv').textContent = fmt(rlv);
    document.getElementById('r-bcis').textContent = `£${bcis.low.toLocaleString()} – £${bcis.high.toLocaleString()}/m²`;

    // SDLT breakdown
    const s1 = Math.min(purchase, 125000) * 0.00 + Math.max(0, Math.min(purchase, 250000) - 125000) * 0.00;
    const s1b = Math.min(purchase, 250000) * 0.03;
    const s2b = Math.max(0, Math.min(purchase, 925000) - 250000) * 0.08;
    const s3b = purchase * 0.03;
    document.getElementById('s1').textContent = fmt(Math.min(purchase, 250000) * 0.00 + s1b - (Math.min(purchase, 250000) * 0.03 - s1b));

    // Simplified SDLT display
    const band1 = Math.min(purchase, 250000) * 0.03;
    const band2 = Math.max(0, Math.min(purchase, 925000) - 250000) * 0.08;
    const band3 = Math.max(0, Math.min(purchase, 1500000) - 925000) * 0.13;
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

    // Deal resilience
    buildResilienceSection(gdv, buildMid, purchase, sdlt, finance, margin);

    // Sensitivity table
    buildSensTable(gdv, buildMid, purchase, sdlt, finance);

    // Area snapshot
    buildAreaSnapshot(postcode, region, growth, ppm, units);

    // Price growth bar
    const growthWidth = Math.min(90, Math.max(10, (growth / 10) * 100));
    document.getElementById('growth-fill').style.width = growthWidth + '%';
    document.getElementById('growth-pct').textContent = '+' + growth.toFixed(1) + '% p/a';

    // Show results
    document.getElementById('results').style.display = 'block';
    document.getElementById('save-btn').style.display = 'inline-flex';

    // Mark onboarding step 1 done
    markOnboardingStep(1);

    // Scroll to results
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });

  }, 800); // Simulate API call time
}

function buildResilienceSection(gdv, buildMid, purchase, sdlt, finance, baseMargin) {
  const gdvVars = [-0.20, -0.10, 0, 0.10, 0.20];
  const buildVars = [-0.20, -0.10, 0, 0.10, 0.20];

  // Find max build overrun that stays viable at base GDV
  let maxBuildOverrun = -0.20;
  for (const bv of buildVars) {
    const m = getMargin(gdv, buildMid, purchase, sdlt, finance, 0, bv);
    if (m >= 12) maxBuildOverrun = bv;
  }

  // Find max GDV drop that stays viable at base build
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

function buildAreaSnapshot(postcode, region, growth, ppm, units) {
  const areaCode = postcode.split(' ')[0];
  document.getElementById('snapshot-postcode').textContent = areaCode;

  // Derive realistic area stats from our region data
  const basePrice = ppm * 90; // approx avg from £/sqm
  const tx = Math.round(150 + Math.random() * 300);
  const dom = Math.round(25 + Math.random() * 25);

  document.getElementById('snap-avg').textContent = fmt(basePrice);
  document.getElementById('snap-tx').textContent = tx;
  document.getElementById('snap-growth').textContent = '+' + growth.toFixed(1) + '%';
  document.getElementById('snap-dom').textContent = dom + ' days';

  // Build 5-year price bars
  const years = ['2021', '2022', '2023', '2024', '2025'];
  const annualRate = growth / 100;
  const prices = years.map((y, i) => Math.round(basePrice * Math.pow(1 - annualRate, 4 - i)));
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

  // Property type breakdown
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
    const price = Math.round(basePrice * t.mult);
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

function toggleSens() {
  const wrap = document.getElementById('sens-wrap');
  const icon = document.getElementById('sens-icon');
  const btn = document.getElementById('sens-toggle');
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? 'block' : 'none';
  icon.className = open ? 'ti ti-chevron-up' : 'ti ti-chevron-down';
  btn.childNodes[1].textContent = open ? ' Hide full sensitivity table' : ' Show full sensitivity table';
}
