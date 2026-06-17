// Avalor — Saved deals + comparison logic

async function saveCurrentAppraisal() {
  if (!currentAppraisal) return;
  if (!currentUser) { toast('Please sign in to save deals', 'error'); return; }

  const btn = document.getElementById('save-btn');
  btn.innerHTML = '<span class="loading-spinner"></span> Saving…';
  btn.disabled = true;

  try {
    const dealName = currentAppraisal.postcode + ' — ' + currentAppraisal.devType;
    const { error } = await sb.from('saved_deals').insert({
      user_id: currentUser.id,
      postcode: currentAppraisal.postcode,
      name: dealName,
      dev_type: currentAppraisal.devType,
      prop_type: currentAppraisal.propType || 'Semi-detached house',
      region: currentAppraisal.region,
      purchase: currentAppraisal.purchase,
      floor_area: currentAppraisal.area,
      units: currentAppraisal.units,
      gdv: Math.round(currentAppraisal.gdv),
      build_cost: Math.round(currentAppraisal.buildMid),
      sdlt: Math.round(currentAppraisal.sdlt),
      finance: Math.round(currentAppraisal.finance),
      profit: Math.round(currentAppraisal.profit),
      margin: parseFloat(currentAppraisal.margin.toFixed(1)),
      rlv: Math.round(currentAppraisal.rlv),
      growth_rate: currentAppraisal.growth,
      verdict: currentAppraisal.margin >= 20 ? 'viable' : currentAppraisal.margin >= 12 ? 'marginal' : 'not-viable',
      appraisal_data: JSON.stringify(currentAppraisal)
    });

    if (error) throw error;

    toast('Deal saved successfully', 'success');
    btn.innerHTML = '<i class="ti ti-check"></i> Saved';
    markOnboardingStep(2);

    setTimeout(() => {
      btn.innerHTML = '<i class="ti ti-bookmark"></i> Save appraisal';
      btn.disabled = false;
    }, 2000);

  } catch (err) {
    console.error('Save error:', err);
    toast('Could not save deal — please try again', 'error');
    btn.innerHTML = '<i class="ti ti-bookmark"></i> Save appraisal';
    btn.disabled = false;
  }
}

async function loadSavedDeals() {
  if (!currentUser) return;

  const container = document.getElementById('saved-list');
  container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-secondary);font-size:14px"><span class="loading-spinner" style="border-color:rgba(0,0,0,0.1);border-top-color:var(--green);display:inline-block;margin-right:8px"></span>Loading deals…</div>';

  try {
    const { data, error } = await sb
      .from('saved_deals')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    document.getElementById('saved-subtitle').textContent = `${data.length} saved deal${data.length !== 1 ? 's' : ''}`;

    if (data.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="ti ti-bookmark"></i>
          <h3>No saved deals yet</h3>
          <p>Run an appraisal and save it to build your deal pipeline</p>
          <button class="btn btn-primary" onclick="showPage('appraisal', document.getElementById('tab-appraisal'))">
            <i class="ti ti-plus"></i>New appraisal
          </button>
        </div>`;
      return;
    }

    let html = '';
    data.forEach(deal => {
      const marginClass = deal.margin >= 20 ? 'green' : deal.margin >= 12 ? 'amber' : 'red';
      const flagClass = deal.verdict === 'viable' ? 'flag-safe' : deal.verdict === 'marginal' ? 'flag-warn' : 'flag-risk';
      const flagText = deal.verdict === 'viable' ? 'Viable' : deal.verdict === 'marginal' ? 'Marginal' : 'Not viable';
      const gdvK = deal.gdv >= 1000000 ? (deal.gdv / 1000000).toFixed(1) + 'm' : Math.round(deal.gdv / 1000) + 'k';

      html += `
        <div class="deal-card">
          <div class="deal-info">
            <div class="deal-address">${deal.name}</div>
            <div class="deal-meta">${deal.dev_type} · ${deal.units} unit${deal.units !== 1 ? 's' : ''} · ${deal.region}</div>
          </div>
          <div class="deal-stat">
            <div class="deal-stat-label">GDV</div>
            <div class="deal-stat-value">£${gdvK}</div>
          </div>
          <div class="deal-stat">
            <div class="deal-stat-label">Margin</div>
            <div class="deal-stat-value ${marginClass}">${deal.margin}%</div>
          </div>
          <div class="deal-stat">
            <div class="deal-stat-label">Verdict</div>
            <div class="deal-stat-value" style="font-size:12px">
              <span class="flag ${flagClass}">${flagText}</span>
            </div>
          </div>
          <div class="deal-actions">
            <button class="btn btn-sm" onclick="viewDeal(${deal.id})" title="View"><i class="ti ti-eye"></i></button>
            <button class="btn btn-sm" onclick="deleteDeal(${deal.id})" title="Delete" style="color:var(--text-tertiary)"><i class="ti ti-trash"></i></button>
          </div>
        </div>`;
    });

    container.innerHTML = html;

  } catch (err) {
    console.error('Load deals error:', err);
    container.innerHTML = '<div class="empty-state"><i class="ti ti-alert-triangle"></i><h3>Could not load deals</h3><p>Please refresh the page and try again</p></div>';
  }
}

async function deleteDeal(id) {
  if (!confirm('Delete this saved deal? This cannot be undone.')) return;

  const { error } = await sb.from('saved_deals').delete().eq('id', id).eq('user_id', currentUser.id);

  if (error) {
    toast('Could not delete deal', 'error');
  } else {
    toast('Deal deleted');
    loadSavedDeals();
  }
}

function viewDeal(id) {
  toast('Opening deal… (full view coming soon)');
}

async function loadCompare() {
  if (!currentUser) return;

  const container = document.getElementById('compare-content');

  const { data, error } = await sb
    .from('saved_deals')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error || !data || data.length < 2) {
    container.innerHTML = `
      <div class="pro-lock">
        <i class="ti ti-arrows-left-right"></i>
        <h3>Save at least 2 deals to compare</h3>
        <p>Run appraisals and save them to your pipeline, then come back here to compare them side-by-side</p>
        <button class="btn btn-primary" onclick="showPage('appraisal', document.getElementById('tab-appraisal'))">Run an appraisal</button>
      </div>`;
    return;
  }

  const d1 = data[0];
  const d2 = data[1];

  const better = (v1, v2, higherIsBetter = true) => {
    if (higherIsBetter) return v1 > v2 ? 'compare-better' : v1 < v2 ? 'compare-worse' : '';
    return v1 < v2 ? 'compare-better' : v1 > v2 ? 'compare-worse' : '';
  };

  const f = (n) => '£' + Math.round(n).toLocaleString('en-GB');
  const verdictFlag = (v) => {
    const map = { viable: ['flag-safe', 'Viable'], marginal: ['flag-warn', 'Marginal'], 'not-viable': ['flag-risk', 'Not viable'] };
    const [cls, txt] = map[v] || ['flag-safe', 'Viable'];
    return `<span class="flag ${cls}">${txt}</span>`;
  };

  container.innerHTML = `
    <table class="compare-table">
      <colgroup><col style="width:36%"><col style="width:32%"><col style="width:32%"></colgroup>
      <thead>
        <tr>
          <th class="compare-label-col" style="font-size:12px;font-weight:600;color:var(--text-secondary)">Metric</th>
          <th class="compare-head-1">${d1.name}<br><span style="font-size:11px;font-weight:400;opacity:0.8">${d1.dev_type} · ${d1.units} unit${d1.units !== 1 ? 's' : ''}</span></th>
          <th class="compare-head-2">${d2.name}<br><span style="font-size:11px;font-weight:400;opacity:0.8">${d2.dev_type} · ${d2.units} unit${d2.units !== 1 ? 's' : ''}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr class="compare-section-row"><th colspan="3">Financials</th></tr>
        <tr><td class="compare-label-col">GDV</td><td class="compare-deal-col ${better(d1.gdv, d2.gdv)}">${f(d1.gdv)}</td><td class="compare-deal-col-2 ${better(d2.gdv, d1.gdv)}">${f(d2.gdv)}</td></tr>
        <tr><td class="compare-label-col">Build cost</td><td class="compare-deal-col ${better(d1.build_cost, d2.build_cost, false)}">${f(d1.build_cost)}</td><td class="compare-deal-col-2 ${better(d2.build_cost, d1.build_cost, false)}">${f(d2.build_cost)}</td></tr>
        <tr><td class="compare-label-col">SDLT</td><td class="compare-deal-col ${better(d1.sdlt, d2.sdlt, false)}">${f(d1.sdlt)}</td><td class="compare-deal-col-2 ${better(d2.sdlt, d1.sdlt, false)}">${f(d2.sdlt)}</td></tr>
        <tr><td class="compare-label-col">Profit</td><td class="compare-deal-col ${better(d1.profit, d2.profit)}">${f(d1.profit)}</td><td class="compare-deal-col-2 ${better(d2.profit, d1.profit)}">${f(d2.profit)}</td></tr>
        <tr><td class="compare-label-col">Margin on GDV</td><td class="compare-deal-col ${better(d1.margin, d2.margin)}" style="font-size:16px;font-weight:600">${d1.margin}%</td><td class="compare-deal-col-2 ${better(d2.margin, d1.margin)}" style="font-size:16px;font-weight:600">${d2.margin}%</td></tr>
        <tr><td class="compare-label-col">Residual land value</td><td class="compare-deal-col ${better(d1.rlv, d2.rlv)}">${f(d1.rlv)}</td><td class="compare-deal-col-2 ${better(d2.rlv, d1.rlv)}">${f(d2.rlv)}</td></tr>
        <tr class="compare-section-row"><th colspan="3">Market</th></tr>
        <tr><td class="compare-label-col">Region</td><td class="compare-deal-col">${d1.region}</td><td class="compare-deal-col-2">${d2.region}</td></tr>
        <tr><td class="compare-label-col">5yr price growth</td><td class="compare-deal-col ${better(d1.growth_rate, d2.growth_rate)}">+${d1.growth_rate}% p/a</td><td class="compare-deal-col-2 ${better(d2.growth_rate, d1.growth_rate)}">+${d2.growth_rate}% p/a</td></tr>
        <tr class="compare-section-row"><th colspan="3">Verdict</th></tr>
        <tr><td class="compare-label-col">Overall</td><td class="compare-deal-col">${verdictFlag(d1.verdict)}</td><td class="compare-deal-col-2">${verdictFlag(d2.verdict)}</td></tr>
      </tbody>
    </table>
    <div style="margin-top:1rem;font-size:13px;color:var(--text-secondary)">
      <i class="ti ti-info-circle" style="vertical-align:-2px;margin-right:4px"></i>
      Comparing your two most recently saved deals. Save more deals to compare different combinations.
    </div>`;

  markOnboardingStep(3);
}
