const https = require('https');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const money = n => '£' + Math.round(n).toLocaleString('en-GB');

function buildDealSavedEmail({ postcode, devType, gdv, buildCost, profit, margin, verdict, avalorScore }) {
  const subject = `Deal saved: ${postcode} — ${devType}`;
  const html = `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto">
      <h2 style="margin-bottom:4px">${postcode} — ${devType}</h2>
      <p style="color:#555;margin-top:0">Your appraisal has been saved to your Avalor pipeline.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:6px 0;color:#555">GDV</td><td style="padding:6px 0;text-align:right;font-weight:600">${money(gdv)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Total build cost</td><td style="padding:6px 0;text-align:right;font-weight:600">${money(buildCost)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Profit</td><td style="padding:6px 0;text-align:right;font-weight:600">${money(profit)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Margin</td><td style="padding:6px 0;text-align:right;font-weight:600">${margin}%</td></tr>
        <tr><td style="padding:6px 0;color:#555">Verdict</td><td style="padding:6px 0;text-align:right;font-weight:600">${verdict}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Avalor Score</td><td style="padding:6px 0;text-align:right;font-weight:600">${avalorScore}/100</td></tr>
      </table>
      <p><a href="https://avalor.co.uk" style="color:#1a7f37;font-weight:600;text-decoration:none">View your deals on Avalor →</a></p>
    </div>`;
  return { subject, html };
}

function sendViaResend(apiKey, { to, subject, html }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from: 'onboarding@resend.dev', to: [to], subject, html });
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${apiKey}`,
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Resend responded ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(JSON.stringify({ error: 'Method not allowed' })); }

  try {
    const buf = await readBody(req);
    const { postcode, devType, gdv, buildCost, profit, margin, verdict, avalorScore, toEmail } = JSON.parse(buf.toString());

    if (!toEmail) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing toEmail' })); }

    const { subject, html } = buildDealSavedEmail({ postcode, devType, gdv, buildCost, profit, margin, verdict, avalorScore });
    await sendViaResend(process.env.RESEND_API_KEY, { to: toEmail, subject, html });

    res.writeHead(200);
    res.end(JSON.stringify({ sent: true }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
};
