const express = require('express');
const cfc = require('./cfc-scraper');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({origin:'*'}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function formatTime(t) {
  const parts = t.split(':');
  const h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return h12 + ':' + String(m).padStart(2,'0') + ' ' + ampm;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')
    .replace(/&amp;/g,'&')
    .replace(/&nbsp;/g,' ')
    .replace(/&#\d+;/g,'')
    .trim();
}

function excerpt(text, maxLen) {
  if (!text) return '';
  const clean = stripHtml(text);
  const limit = maxLen || 200;
  return clean.length > limit ? clean.slice(0, limit) + '...' : clean;
}

async function fetchTides() {
  const today = new Date();
  const pad = function(n) { return String(n).padStart(2,'0'); };
  const dateStr = today.getFullYear() + pad(today.getMonth()+1) + pad(today.getDate());
  try {
    const base = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?application=sf_fishing&begin_date=' + dateStr + '&end_date=' + dateStr + '&datum=MLLW&station=9414290&time_zone=lst_ldt&units=english&format=json';
    const hiloRes = await fetch(base + '&product=predictions&interval=hilo');
    const hourlyRes = await fetch(base + '&product=predictions&interval=h');
    const hiloData = await hiloRes.json();
    const hourlyData = await hourlyRes.json();
    const events = (hiloData.predictions || []).map(function(p) {
      return {
        type: p.type === 'H' ? 'High' : 'Low',
        time: formatTime(p.t.split(' ')[1]),
        ft: parseFloat(parseFloat(p.v).toFixed(1))
      };
    });
    const hourly = hourlyData.predictions || [];
    const now = new Date();
    let closest = null;
    let minDiff = Infinity;
    for (let i = 0; i < hourly.length; i++) {
      const diff = Math.abs(new Date(hourly[i].t.replace(' ','T')) - now);
      if (diff < minDiff) { minDiff = diff; closest = hourly[i]; }
    }
    const tideNow = closest ? parseFloat(parseFloat(closest.v).toFixed(1)) : null;
    let tideLabel = '';
    if (closest) {
      const idx = hourly.indexOf(closest);
      if (idx > 0) {
        tideLabel = parseFloat(closest.v) > parseFloat(hourly[idx-1].v) ? 'incoming' : 'outgoing';
      }
    }
    return { events: events, tide_now_ft: tideNow, tide_now_label: tideLabel };
  } catch(e) {
    console.error('Tide error:', e.message);
    return { events: [], tide_now_ft: null, tide_now_label: '' };
  }
}

async function fetchCurrents() {
  const today = new Date();
  const pad = function(n) { return String(n).padStart(2,'0'); };
  const dateStr = today.getFullYear() + pad(today.getMonth()+1) + pad(today.getDate());
  try {
    const [predRes, obsRes, hourlyRes] = await Promise.all([
      fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=sf_fishing&begin_date=' + dateStr + '&end_date=' + dateStr + '&station=PUG1515&time_zone=lst_ldt&interval=MAX_SLACK&units=english&format=json'),
      fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents&application=sf_fishing&begin_date=' + dateStr + '&end_date=' + dateStr + '&station=PUG1515&time_zone=lst_ldt&units=english&format=json'),
      fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=sf_fishing&begin_date=' + dateStr + '&end_date=' + dateStr + '&station=PUG1515&time_zone=lst_ldt&interval=6&units=english&format=json')
    ]);
    const predData = await predRes.json();
    const obsData = await obsRes.json();
    const hourlyData = await hourlyRes.json();
    const cp = (predData.current_predictions && predData.current_predictions.cp) ? predData.current_predictions.cp : [];
    const cpHourly = (hourlyData.current_predictions && hourlyData.current_predictions.cp) ? hourlyData.current_predictions.cp : [];
    const events = cp.map(function(p) {
      const spd = parseFloat(parseFloat(p.Velocity_Major || p.Speed || 0).toFixed(1));
      const type = p.Type === 'ebb' ? 'Ebb' : p.Type === 'flood' ? 'Flood' : (Math.abs(spd) < 0.2 ? 'Slack' : (p.Type || 'Slack'));
      return { type: type, time: formatTime(p.Time.split(' ')[1]), speed: Math.abs(spd) };
    });
    const obs = obsData.current_observations || obsData.data || [];
    let currentNow = null;
    let currentDir = null;
    if (obs.length) {
      const now = new Date();
      let closest = null;
      let minDiff = Infinity;
      for (let i = 0; i < obs.length; i++) {
        const t = new Date((obs[i].t || obs[i].time || '').replace(' ','T'));
        const diff = Math.abs(t - now);
        if (diff < minDiff) { minDiff = diff; closest = obs[i]; }
      }
      if (closest) {
        currentNow = Math.abs(parseFloat((closest.s || closest.Speed || 0).toFixed(1)));
        const vel = parseFloat(closest.v || closest.Velocity_Major || (closest.s || 0));
        currentDir = vel > 0.1 ? 'flood' : vel < -0.1 ? 'ebb' : 'slack';
      }
    }
    // Build hourly velocity array for chart (signed: + = flood, - = ebb)
    const hourlyVelocity = cpHourly.map(function(p) {
      const vel = parseFloat(p.Velocity_Major || 0);
      const timeParts = (p.Time || '').split(' ');
      const t = timeParts.length > 1 ? timeParts[1] : timeParts[0];
      const hm = t.split(':');
      return { hour: parseInt(hm[0]), min: parseInt(hm[1]||0), vel: parseFloat(vel.toFixed(2)) };
    });

    return { current_events: events, current_now_kts: currentNow, current_now_dir: currentDir, current_hourly: hourlyVelocity };
  } catch(e) {
    console.error('Currents error:', e.message);
    return { current_events: [], current_now_kts: null, current_now_dir: null, current_hourly: [] };
  }
}

async function fetchWeather() {
  try {
    const res = await fetch('https://forecast.weather.gov/shmrn.php?mz=PZZ540', {
      headers: { 'User-Agent': 'SFBayFishingApp/1.0 (fishing@example.com)' }
    });
    const html = await res.text();

    // Strip scripts and styles first, then tags
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');

    let windKts = null, windDir = null, swellFt = null, summary = '';

    // Wind: "NW wind 10 to 15 kt"
    const wm = clean.match(/(N|NE|NNE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\s+wind\s+(\d+)\s*(?:to\s*(\d+))?\s*(?:kt|knots?)/i);
    if (wm) {
      windDir = wm[1].toUpperCase();
      windKts = wm[3] ? Math.round((parseInt(wm[2])+parseInt(wm[3]))/2) : parseInt(wm[2]);
    }

    // Swell: cut at "Wave Detail" then find "Seas X to Y ft"
    const forecastBody = clean.split(/Wave\s+Detail/i)[0];
    const sm = forecastBody.match(/Seas\s+(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/i);
    if (sm) {
      swellFt = sm[2]
        ? Math.round((parseFloat(sm[1]) + parseFloat(sm[2])) / 2 * 10) / 10
        : parseFloat(sm[1]);
    }

    // Summary: find the .PZZ540 section or TODAY block in the actual forecast text
    // The NWS text forecast is embedded in a <pre> or after a known marker
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (preMatch) {
      const preText = preMatch[1].replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
      const todayMatch = preText.match(/\.(?:TODAY|PZZ540)[^.]*\.([^.]{20,300}(?:wind|seas?|kt)[^.]{0,200})/i);
      if (todayMatch) {
        summary = todayMatch[1].replace(/Wave\s+Detail[\s\S]*/i,'').replace(/\s+/g,' ').trim().slice(0,280);
      } else {
        summary = preText.slice(0, 280);
      }
    } else {
      // Fallback: first sentence mentioning wind or seas
      const sentMatch = clean.match(/((?:N|NE|NW|S|SE|SW|W|E)[\s\w]+wind[^.]{10,150}\.)/i);
      summary = sentMatch ? sentMatch[1].trim() : '';
    }

    // Detect NWS marine warnings/advisories
    const warnings = [];
    const warningPatterns = [
      { re: /GALE\s+WARNING/i, label: 'Gale Warning', nogo: true },
      { re: /STORM\s+WARNING/i, label: 'Storm Warning', nogo: true },
      { re: /HURRICANE\s+(?:FORCE\s+)?WIND\s+WARNING/i, label: 'Hurricane Force Wind Warning', nogo: true },
      { re: /SMALL\s+CRAFT\s+ADVISORY/i, label: 'Small Craft Advisory', nogo: false },
      { re: /DENSE\s+FOG\s+ADVISORY/i, label: 'Dense Fog Advisory', nogo: false },
      { re: /SPECIAL\s+MARINE\s+WARNING/i, label: 'Special Marine Warning', nogo: true },
    ];
    for (const wp of warningPatterns) {
      if (wp.re.test(clean)) warnings.push({ label: wp.label, nogo: wp.nogo });
    }

    return { wind_kts: windKts, wind_dir: windDir, swell_ft: swellFt, forecast_summary: summary, warnings: warnings };
  } catch(e) {
    console.error('Weather error:', e.message);
    return { wind_kts: null, wind_dir: null, swell_ft: null, forecast_summary: '', warnings: [] };
  }
}

async function fetchReportFromUrl(url, headers) {
  // Fetch a NorCal report page and extract content from og:description meta tag
  // This is reliable because NorCal puts the full report text there even when body is JS-rendered
  const res = await fetch(url, { headers: headers });
  const html = await res.text();
  // og:description has the actual report text
  const ogMatch = html.match(/property="og:description"\s+content="([^"]{60,1000})"/i)
    || html.match(/name="description"\s+content="([^"]{60,1000})"/i)
    || html.match(/content="([^"]{60,1000})"\s+property="og:description"/i);
  // Author/source name
  const authorMatch = html.match(/name="author"\s+content="([^"]{3,60})"/i)
    || html.match(/meta-author:\s*(.+)/i);
  // Title for fallback source name
  const titleMatch = html.match(/<title>([^<]{5,80})<\/title>/i);
  const source = (authorMatch ? authorMatch[1].trim() : null)
    || (titleMatch ? titleMatch[1].split(' - ')[0].trim() : 'NorCal Fish Reports');
  const snippet = ogMatch ? ogMatch[1].replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\*/g,'').replace(/\s+/g,' ').trim() : null;
  return snippet && snippet.length > 50 ? { source: source, snippet: snippet.slice(0,400), url: url } : null;
}

async function fetchReports(species) {
  const results = [];
  const headers = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

  // 1. Get recent report links from the saltwater index page
  const indexUrls = [
    'https://www.norcalfishreports.com/fish_reports/saltwater_reports.php',
    'https://www.norcalfishreports.com/spots/1233/san-francisco-bay.php'
  ];

  const allLinks = [];
  for (const indexUrl of indexUrls) {
    try {
      const res = await fetch(indexUrl, { headers: headers });
      const html = await res.text();
      // Extract report links: /fish_reports/[digits]/[slug].php
      const matches = html.match(/href="(\/fish_reports\/\d+\/[^"]+\.php)"/gi) || [];
      for (const m of matches) {
        const link = 'https://www.norcalfishreports.com' + m.match(/href="([^"]+)"/)[1];
        if (!allLinks.includes(link)) allLinks.push(link);
      }
    } catch(e) { console.error('Index fetch:', e.message); }
  }

  // 2. Fetch up to 8 individual reports, extract from og:description
  const seen = new Set();
  for (const link of allLinks.slice(0, 8)) {
    if (results.length >= 4) break;
    try {
      const report = await fetchReportFromUrl(link, headers);
      if (report && !seen.has(report.snippet)) {
        seen.add(report.snippet);
        results.push(report);
      }
    } catch(e) { /* skip */ }
  }

  // 3. Tuna — use saltwater index but search for tuna-specific reports
  if (species === 'tuna') {
    try {
      const res = await fetch('https://www.norcalfishreports.com/fish_reports/saltwater_reports.php', { headers: headers });
      const html = await res.text();
      const matches = html.match(/href="(\/fish_reports\/\d+\/[^"]+\.php)"/gi) || [];
      const tunaLinks = [];
      for (const m of matches) {
        const link = 'https://www.norcalfishreports.com' + m.match(/href="([^"]+)"/)[1];
        if (link.toLowerCase().includes('tuna') || link.toLowerCase().includes('albacore') || link.toLowerCase().includes('bluefin')) {
          tunaLinks.push(link);
        }
      }
      // Also check og:description of recent reports for tuna mentions
      for (const link of allLinks.slice(0, 10)) {
        if (results.length >= 3) break;
        try {
          const report = await fetchReportFromUrl(link, headers);
          if (report && report.snippet && (report.snippet.toLowerCase().includes('tuna') || report.snippet.toLowerCase().includes('albacore') || report.snippet.toLowerCase().includes('bluefin'))) {
            if (!seen.has(report.snippet)) { seen.add(report.snippet); results.push(report); }
          }
        } catch(e) {}
      }
      for (const link of tunaLinks.slice(0, 3)) {
        if (results.length >= 3) break;
        try {
          const report = await fetchReportFromUrl(link, headers);
          if (report && !seen.has(report.snippet)) { seen.add(report.snippet); results.push(report); }
        } catch(e) {}
      }
    } catch(e) { console.error('Tuna reports:', e.message); }
  }

  // 4. CDFW Dungeness crab status
  if (species === 'crab') {
    try {
      const res = await fetch('https://wildlife.ca.gov/Fishing/Ocean/Crab/Dungeness', { headers: headers });
      const html = await res.text();
      const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      if (mainMatch) {
        const snip = excerpt(mainMatch[1], 400);
        if (snip && snip.length > 50) results.unshift({ source: 'CDFW Dungeness Crab', snippet: snip, url: 'https://wildlife.ca.gov/Fishing/Ocean/Crab/Dungeness' });
      }
    } catch(e) { console.error('CDFW crab:', e.message); }
  }

  return results.filter(function(r) { return r.snippet && r.snippet.length > 30; }).slice(0, 4);
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', time: new Date().toISOString(), port: PORT });
});

app.get('/conditions', async function(req, res) {
  try {
    const results = await Promise.all([fetchTides(), fetchWeather(), fetchCurrents()]);
    res.json(Object.assign({}, results[0], results[1], results[2], { fetched_at: new Date().toISOString() }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/reports', async function(req, res) {
  const species = req.query.species || 'salmon';
  try {
    const reports = await fetchReports(species);
    // Generate a summary if we have reports and an API key
    let summary = null;
    if (reports.length && process.env.ANTHROPIC_API_KEY) {
      try {
        const reportText = reports.map(function(r) { return r.source + ': ' + r.snippet; }).join(' | ');
        const prompt = 'Here are recent SF Bay Area fishing reports: ' + reportText + ' Summarize the key fishing intel in 3-4 sentences. Focus on: what species are biting, where, and any notable catch numbers or techniques mentioned. Be specific and direct. No fluff.';
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
        });
        const d = await resp.json();
        summary = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : null;
      } catch(e) { console.error('Summary error:', e.message); }
    }
    res.json({ reports: reports, summary: summary, fetched_at: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/analyze-cfc', async function(req, res) {
  const species = req.body.species || 'salmon';
  const location = req.body.location || 'ocean';
  const report = req.body.report || '';
  if (!report) return res.status(400).json({ error: 'No report provided' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API key not configured' });
  const spotCtx = species === 'Salmon' ? ' Key local spots: channel buoys, west buoy, middle grounds, Rocky Point, Muir Beach, Duxbury Reef, Pacifica, Gulf of the Farallones, Pt. Reyes.' : '';
  const locCtx = location === 'bay' ? ' Focus on inside-the-Bay catches if mentioned.' : '';
  const prompt = 'I fish ' + species.toLowerCase() + ' out of the Golden Gate on a 26ft Glacier Bay catamaran. Go/no-go: max 5ft swell, 20kt wind ocean (25kt Bay), never south wind outside.' + spotCtx + locCtx + '\n\nCFC report:\n' + report + '\n\nSummarize in 3-4 sentences: (1) where they have been catching, (2) depth/conditions, (3) bait/technique, (4) recommendation for my next trip.';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    const text = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : 'Could not analyze.';
    res.json({ result: text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/cfc-debug', async function(req, res) {
  if (!process.env.CFC_USERNAME) return res.json({ error: 'No credentials' });
  try {
    const result = await cfc.debugFetch('https://forums.coastsidefishingclub.com/forums/saltwater-fishing-reports.5/');
    res.json(result);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/cfc-reports', async function(req, res) {
  if (!process.env.CFC_USERNAME || !process.env.CFC_PASSWORD) {
    return res.json({ reports: [], error: 'CFC credentials not configured' });
  }
  try {
    const reports = await cfc.getRecentReports();
    res.json({ reports: reports, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('CFC reports error:', e.message);
    res.json({ reports: [], error: e.message });
  }
});

app.get('/cfc-historical', async function(req, res) {
  if (!process.env.CFC_USERNAME || !process.env.CFC_PASSWORD || !process.env.ANTHROPIC_API_KEY) {
    return res.json({ summary: null, error: 'Credentials not configured' });
  }
  try {
    const summary = await cfc.getHistoricalSummary(process.env.ANTHROPIC_API_KEY);
    res.json({ summary: summary, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('CFC historical error:', e.message);
    res.json({ summary: null, error: e.message });
  }
});

app.post('/briefing', async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Add ANTHROPIC_API_KEY to Railway variables to enable briefings.' });
  const species = req.body.species || 'salmon';
  const location = req.body.location || 'ocean';
  let conditions, reports;
  try {
    const results = await Promise.all([
      Promise.all([fetchTides(), fetchWeather(), fetchCurrents()]).then(function(r) { return Object.assign({}, r[0], r[1], r[2]); }),
      fetchReports(species)
    ]);
    conditions = results[0];
    reports = results[1];
  } catch(e) {
    return res.status(500).json({ error: 'Could not fetch live data: ' + e.message });
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true });
  const month = now.toLocaleString('en-US', { month:'long' });
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(),0,0)) / 86400000);

  const tideStr = (conditions.events || []).map(function(e) { return e.type + ' ' + e.time + ' (' + e.ft + ' ft)'; }).join(', ') || 'unavailable';
  const currentStr = (conditions.current_events || []).map(function(e) { return e.type + ' ' + e.time + ' (' + e.speed + ' kts)'; }).join(', ') || 'unavailable';
  const reportStr = reports.length ? reports.map(function(r) { return r.source + ': ' + r.snippet; }).join('\n\n') : 'No recent reports available.';

  let migrationNote;
  if (dayOfYear < 120) migrationNote = 'fish staging offshore, beginning to move toward coast as water warms';
  else if (dayOfYear < 180) migrationNote = 'fish moving toward the coast, following anchovy schools. Season opens June 27 south of Pt. Arena for SF/San Mateo coast.';
  else if (dayOfYear < 240) migrationNote = 'peak season - fish actively feeding near structure and bait schools along the coast';
  else if (dayOfYear < 300) migrationNote = 'late season - fish beginning to move toward river mouths, staging near nearshore structure';
  else migrationNote = 'fish moving toward rivers, season winding down';

  const prompt = 'You are an expert SF Bay Area sport fishing advisor with deep knowledge of Chinook salmon, halibut, rockfish, lingcod, Dungeness crab, and white seabass fishing in the waters outside the Golden Gate and inside SF Bay. You know every local spot intimately.\n\nToday is ' + dateStr + ', current time ' + timeStr + ' Pacific.\nThe angler has a 26-foot Glacier Bay catamaran. Go/No-Go thresholds: max 5 ft swell, max 20 kt wind, never in south wind. Bay fishing threshold: max 25 kt wind, swell irrelevant.\n\nLIVE CONDITIONS:\n- Tide now: ' + (conditions.tide_now_ft !== null ? conditions.tide_now_ft + ' ft (' + (conditions.tide_now_label||'') + ')' : 'unavailable') + '\n- Tides today: ' + tideStr + '\n- GG Bridge current: ' + (conditions.current_now_kts !== null ? conditions.current_now_kts + ' kts ' + (conditions.current_now_dir||'') : 'unavailable') + '\n- Current events today: ' + currentStr + '\n- Wind: ' + (conditions.wind_kts !== null ? conditions.wind_kts + ' kts from ' + (conditions.wind_dir||'?') : 'unavailable') + '\n- Ocean swell: ' + (conditions.swell_ft !== null ? conditions.swell_ft + ' ft (note: if this seems high, use the NWS forecast text to determine actual combined seas)' : 'unavailable') + '\n- NWS Forecast: ' + (conditions.forecast_summary || 'unavailable') + '\n\nRECENT FISHING REPORTS:\n' + reportStr + (cfcStr ? ' CFC MEMBER REPORTS THIS WEEK: ' + cfcStr : '') + (historicalStr ? ' CFC HISTORICAL PATTERNS: ' + historicalStr : '') + '\n\nKNOWLEDGE BASE:\n\nSEASONS & REGULATIONS:\n- SF Chinook salmon 2026: opens June 27 south of Pt. Arena (SF/San Mateo coastline). CURRENTLY CLOSED for SF ocean waters.\n- Halibut: open year-round, 22 inch minimum, 5 fish limit.\n- Rockfish/lingcod: complex depth and seasonal restrictions, CCAs in effect. Always verify at wildlife.ca.gov.\n- Dungeness crab: check CDFW for season status and domoic acid closures before every trip.\n- White seabass: 28 inch minimum, 3 fish limit. Best Aug-Nov.\n\nMIGRATION & PATTERNS:\n- Chinook migration status for ' + month + ': ' + migrationNote + '\n- Chinook prefer 52-58F water, best bite 1-2 hrs before/after high tide, troll 90-180 ft.\n- Halibut: sandy bottom 20-60 ft, slack water around high tide is prime, drift slowly.\n- Rockfish/lingcod: hard bottom 60-300 ft, incoming tide most active.\n- Dungeness crab: 60-120 ft, strong tidal flow ideal.\n- White seabass: kelp bed edges at dawn/dusk, live squid, incoming tide.\n\nBAR CROSSING:\n- Stay in ship channel unless swells under 6 ft. Never cross on large ebb + swell.\n- Bonita Channel (Marin side, 50-60 ft) good up to 10 ft swell.\n- South Bar has NO channel - avoid entirely, dangerous first-generation breakers.\n- Ebb current steepens bar waves significantly. Flood flattens bar but roughens Pt. Lobos and Pt. Bonita.\n- Pt. Lobos on flood: pass outside Mile Rock. Pt. Bonita: washing machine effect on both tides.\n- Lose power on bar: anchor immediately - current takes you across South Bar fast.\n\nSPOTS:\n- Channel buoys/middle grounds/west buoy: salmon, best on incoming tide, 3-12 mi out.\n- Rocky Point/Muir Beach: near-shore salmon structure, 3-5 mi.\n- Duxbury Reef/Bolinas: salmon and rockfish, fishes well in most conditions, ~10 mi.\n- Pacifica/Pedro Point: accessible salmon year-round, ~10 mi south.\n- Gulf of the Farallones: big salmon and rockfish, needs under 4 ft swell, ~27 mi.\n- Pt. Reyes/Drakes Bay: salmon and seabass, ~20 mi north, check conditions.\n- Potato Patch: halibut prime spot, sandy bottom outside Gate, ~5 mi.\n- Raccoon Strait/Angel Island: Bay halibut, tidal current flats, protected.\n- Treasure Island flats: Bay halibut, sandy bottom mid-Bay.\n- Farallon Islands rocky bottom: best rockfish/lingcod structure, ~27 mi.\n- Pt. Bonita/Marin Headlands reefs: closer rockfish option, ~5 mi.\n\nProvide a comprehensive daily fishing briefing covering ALL species. Structure it exactly as follows:\n\n**OVERALL GO / NO-GO: [GO FISH / CAUTION / NO-GO]**\nOne sentence on overall conditions for getting out today.\n\n**CONDITIONS SUMMARY**\n2-3 sentences on wind, swell (use NWS forecast text for actual sea height), tides, and current. What do they mean practically for getting out and crossing the bar today?\n\n**BEST TIME WINDOWS TODAY**\nList 1-3 specific time windows (e.g. 7:00-9:30am) with tide/current reasoning. Be specific.\n\n**SPECIES BREAKDOWN**\nFor each species, one line verdict and recommendation:\n- SALMON: [open/closed + go/no-go + best spot if applicable]\n- HALIBUT: [go/no-go + best spot today - ocean or Bay]\n- ROCKFISH/LINGCOD: [go/no-go + best spot today]\n- DUNGENESS CRAB: [season status + go/no-go]\n- WHITE SEABASS: [seasonal note + go/no-go]\n\n**WHERE TO FISH**\nRank the top 3 spots for today across all species. Number each one. Format: "1. [Spot name]: [why it makes sense today - conditions + recent reports + species]. 2. ..." Include any spots mentioned in recent reports even if not on the usual list. If a spot should be avoided today say so and why.\n\n**TOP RECOMMENDATION TODAY**\nOne clear answer: specific species, spot, time window, technique. Be direct.\n\n**WHAT TO USE**\nSpecific bait and technique for the top recommendation.\n\n**INTEL FROM RECENT REPORTS**\n2-3 sentences on what reports are saying. Be specific, note if data is limited.\n\n**OUTLOOK**\n1-2 sentences. Is today worth it, or wait for better conditions/season opener?\n\nBe direct, specific, and practical. Use local spot names. This is a knowledgeable local guide, not a liability disclaimer.';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    if (d.error) return res.status(500).json({ error: d.error.message });
    const text = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : 'Could not generate briefing.';
    res.json({ briefing: text, generated_at: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/forecast', async function(req, res) {
  try {
    const pad = function(n) { return String(n).padStart(2,'0'); };
    const today = new Date();
    const startDate = today.getFullYear() + pad(today.getMonth()+1) + pad(today.getDate());
    const endDay = new Date(today); endDay.setDate(today.getDate() + 6);
    const endDate = endDay.getFullYear() + pad(endDay.getMonth()+1) + pad(endDay.getDate());
    const headers = { 'User-Agent': 'SFBayFishingApp/1.0 (fishing@example.com)' };

    // Use NWS gridpoint forecast for a point just outside the Golden Gate
    // This gives a full 7-day forecast with daytime/nighttime periods
    const forecastUrl = 'https://api.weather.gov/gridpoints/MTR/84,128/forecast';
    const nwsRes = await fetch(forecastUrl, { headers: headers });
    const nwsData = await nwsRes.json();
    const periods = (nwsData.properties && nwsData.properties.periods) ? nwsData.properties.periods : [];

    // Fetch 7-day tide predictions (hilo)
    const tideRes = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=sf_fishing&begin_date=' + startDate + '&end_date=' + endDate + '&datum=MLLW&station=9414290&time_zone=lst_ldt&interval=hilo&units=english&format=json');
    const tideData = await tideRes.json();
    const tidePreds = tideData.predictions || [];

    // Fetch 7-day current predictions
    const currentRes = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=sf_fishing&begin_date=' + startDate + '&end_date=' + endDate + '&station=PUG1515&time_zone=lst_ldt&interval=MAX_SLACK&units=english&format=json');
    const currentData = await currentRes.json();
    const currentPreds = (currentData.current_predictions && currentData.current_predictions.cp) ? currentData.current_predictions.cp : [];

    function formatTime12(t) {
      if (!t) return '';
      const timePart = t.includes(' ') ? t.split(' ')[1] : (t.includes('T') ? t.split('T')[1].slice(0,5) : t);
      const hm = timePart.split(':');
      const h = parseInt(hm[0]), mn = parseInt(hm[1]||0);
      const ampm = h >= 12 ? 'pm' : 'am';
      const h12 = h > 12 ? h-12 : (h===0?12:h);
      return h12 + ':' + String(mn).padStart(2,'0') + ampm;
    }

    // Group tides by date
    const tidesByDate = {};
    for (const t of tidePreds) {
      const d = t.t.split(' ')[0];
      if (!tidesByDate[d]) tidesByDate[d] = [];
      tidesByDate[d].push(t);
    }

    // Group currents by date
    const currentsByDate = {};
    for (const c of currentPreds) {
      const d = (c.Time || '').split(' ')[0];
      if (!currentsByDate[d]) currentsByDate[d] = [];
      currentsByDate[d].push(c);
    }

    // Parse wind/swell from NWS period
    function parseWind(period) {
      // NWS gridpoint API has windSpeed and windDirection as separate fields
      if (period.windSpeed) {
        const spd = period.windSpeed.replace(/[^0-9 to]/gi,'').trim();
        const m = spd.match(/(\d+)\s*(?:to\s*(\d+))?/);
        const kts = m ? (m[2] ? Math.round((parseInt(m[1])+parseInt(m[2]))/2) : parseInt(m[1])) : null;
        // Convert mph to kts (NWS uses mph in gridpoint forecast)
        return { kts: kts ? Math.round(kts * 0.868976) : null, dir: period.windDirection || null };
      }
      return { kts: null, dir: null };
    }

    function parseSwell(txt) {
      const sm = (txt||'').match(/(?:combined\s+)?[Ss]eas\s+(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/);
      if (!sm) return null;
      return sm[2] ? Math.round((parseFloat(sm[1])+parseFloat(sm[2]))/2*10)/10 : parseFloat(sm[1]);
    }

    // Build one entry per calendar day — daytime periods only
    const dayMap = {};
    for (const period of periods) {
      if (!period.startTime) continue;
      // Get date in Pacific time
      const d = new Date(period.startTime);
      const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // YYYY-MM-DD
      if (dayMap[dateStr] && !period.isDaytime) continue; // prefer daytime
      const txt = period.detailedForecast || period.shortForecast || '';
      const wind = parseWind(period);
      const swell = parseSwell(txt);
      dayMap[dateStr] = {
        date: dateStr,
        dow: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' }),
        name: period.name || dateStr,
        wind_kts: wind.kts,
        wind_dir: wind.dir,
        swell_ft: swell,
        summary: txt.slice(0, 200),
        isDaytime: period.isDaytime
      };
    }

    // Attach tide and current data
    const forecastDays = Object.values(dayMap)
      .sort(function(a,b){return a.date.localeCompare(b.date);})
      .slice(0,7);

    for (const day of forecastDays) {
      const dayTides = tidesByDate[day.date] || [];
      const dayCurrents = currentsByDate[day.date] || [];
      const highTides = dayTides.filter(function(t){return t.type==='H';});
      const lowTides = dayTides.filter(function(t){return t.type==='L';});
      day.high_tides = highTides.map(function(t){return{time:formatTime12(t.t),ft:parseFloat(parseFloat(t.v).toFixed(1))};});
      day.low_tides = lowTides.map(function(t){return{time:formatTime12(t.t),ft:parseFloat(parseFloat(t.v).toFixed(1))};});
      day.best_window = highTides.length ? formatTime12(highTides[0].t) : null;
      let maxFlood = { speed: 0, time: null };
      let maxEbb = { speed: 0, time: null };
      const slacks = [];
      for (const c of dayCurrents) {
        const spd = Math.abs(parseFloat(c.Velocity_Major || c.Speed || 0));
        const type = (c.Type || '').toLowerCase();
        const t = formatTime12(c.Time);
        if (type === 'flood' && spd > maxFlood.speed) maxFlood = { speed: parseFloat(spd.toFixed(1)), time: t };
        if (type === 'ebb' && spd > maxEbb.speed) maxEbb = { speed: parseFloat(spd.toFixed(1)), time: t };
        if (type === 'slack' || spd < 0.2) slacks.push({ time: t, speed: parseFloat(spd.toFixed(1)) });
      }
      day.max_flood = maxFlood.speed > 0 ? maxFlood : null;
      day.max_ebb = maxEbb.speed > 0 ? maxEbb : null;
      day.slacks = slacks;
    }

    res.json({ days: forecastDays, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('Forecast error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});


app.get('/health', function(req, res) {
  res.json({ status: 'ok', time: new Date().toISOString(), port: PORT });
});

app.get('/conditions', async function(req, res) {
  try {
    const results = await Promise.all([fetchTides(), fetchWeather(), fetchCurrents()]);
    res.json(Object.assign({}, results[0], results[1], results[2], { fetched_at: new Date().toISOString() }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/reports', async function(req, res) {
  const species = req.query.species || 'salmon';
  try {
    const reports = await fetchReports(species);
    // Generate a summary if we have reports and an API key
    let summary = null;
    if (reports.length && process.env.ANTHROPIC_API_KEY) {
      try {
        const reportText = reports.map(function(r) { return r.source + ': ' + r.snippet; }).join(' | ');
        const prompt = 'Here are recent SF Bay Area fishing reports: ' + reportText + ' Summarize the key fishing intel in 3-4 sentences. Focus on: what species are biting, where, and any notable catch numbers or techniques mentioned. Be specific and direct. No fluff.';
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
        });
        const d = await resp.json();
        summary = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : null;
      } catch(e) { console.error('Summary error:', e.message); }
    }
    res.json({ reports: reports, summary: summary, fetched_at: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/analyze-cfc', async function(req, res) {
  const species = req.body.species || 'salmon';
  const location = req.body.location || 'ocean';
  const report = req.body.report || '';
  if (!report) return res.status(400).json({ error: 'No report provided' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API key not configured' });
  const spotCtx = species === 'Salmon' ? ' Key local spots: channel buoys, west buoy, middle grounds, Rocky Point, Muir Beach, Duxbury Reef, Pacifica, Gulf of the Farallones, Pt. Reyes.' : '';
  const locCtx = location === 'bay' ? ' Focus on inside-the-Bay catches if mentioned.' : '';
  const prompt = 'I fish ' + species.toLowerCase() + ' out of the Golden Gate on a 26ft Glacier Bay catamaran. Go/no-go: max 5ft swell, 20kt wind ocean (25kt Bay), never south wind outside.' + spotCtx + locCtx + '\n\nCFC report:\n' + report + '\n\nSummarize in 3-4 sentences: (1) where they have been catching, (2) depth/conditions, (3) bait/technique, (4) recommendation for my next trip.';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    const text = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : 'Could not analyze.';
    res.json({ result: text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/cfc-debug', async function(req, res) {
  if (!process.env.CFC_USERNAME) return res.json({ error: 'No credentials' });
  try {
    const result = await cfc.debugFetch('https://forums.coastsidefishingclub.com/forums/saltwater-fishing-reports.5/');
    res.json(result);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/cfc-reports', async function(req, res) {
  if (!process.env.CFC_USERNAME || !process.env.CFC_PASSWORD) {
    return res.json({ reports: [], error: 'CFC credentials not configured' });
  }
  try {
    const reports = await cfc.getRecentReports();
    res.json({ reports: reports, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('CFC reports error:', e.message);
    res.json({ reports: [], error: e.message });
  }
});

app.get('/cfc-historical', async function(req, res) {
  if (!process.env.CFC_USERNAME || !process.env.CFC_PASSWORD || !process.env.ANTHROPIC_API_KEY) {
    return res.json({ summary: null, error: 'Credentials not configured' });
  }
  try {
    const summary = await cfc.getHistoricalSummary(process.env.ANTHROPIC_API_KEY);
    res.json({ summary: summary, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('CFC historical error:', e.message);
    res.json({ summary: null, error: e.message });
  }
});

app.post('/briefing', async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Add ANTHROPIC_API_KEY to Railway variables to enable briefings.' });
  const species = req.body.species || 'salmon';
  const location = req.body.location || 'ocean';
  let conditions, reports;
  try {
    const results = await Promise.all([
      Promise.all([fetchTides(), fetchWeather(), fetchCurrents()]).then(function(r) { return Object.assign({}, r[0], r[1], r[2]); }),
      fetchReports(species)
    ]);
    conditions = results[0];
    reports = results[1];
  } catch(e) {
    return res.status(500).json({ error: 'Could not fetch live data: ' + e.message });
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true });
  const month = now.toLocaleString('en-US', { month:'long' });
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(),0,0)) / 86400000);

  const tideStr = (conditions.events || []).map(function(e) { return e.type + ' ' + e.time + ' (' + e.ft + ' ft)'; }).join(', ') || 'unavailable';
  const currentStr = (conditions.current_events || []).map(function(e) { return e.type + ' ' + e.time + ' (' + e.speed + ' kts)'; }).join(', ') || 'unavailable';
  const reportStr = reports.length ? reports.map(function(r) { return r.source + ': ' + r.snippet; }).join('\n\n') : 'No recent reports available.';

  let migrationNote;
  if (dayOfYear < 120) migrationNote = 'fish staging offshore, beginning to move toward coast as water warms';
  else if (dayOfYear < 180) migrationNote = 'fish moving toward the coast, following anchovy schools. Season opens June 27 south of Pt. Arena for SF/San Mateo coast.';
  else if (dayOfYear < 240) migrationNote = 'peak season - fish actively feeding near structure and bait schools along the coast';
  else if (dayOfYear < 300) migrationNote = 'late season - fish beginning to move toward river mouths, staging near nearshore structure';
  else migrationNote = 'fish moving toward rivers, season winding down';

  const prompt = 'You are an expert SF Bay Area sport fishing advisor with deep knowledge of Chinook salmon, halibut, rockfish, lingcod, Dungeness crab, and white seabass fishing in the waters outside the Golden Gate and inside SF Bay. You know every local spot intimately.\n\nToday is ' + dateStr + ', current time ' + timeStr + ' Pacific.\nThe angler has a 26-foot Glacier Bay catamaran. Go/No-Go thresholds: max 5 ft swell, max 20 kt wind, never in south wind. Bay fishing threshold: max 25 kt wind, swell irrelevant.\n\nLIVE CONDITIONS:\n- Tide now: ' + (conditions.tide_now_ft !== null ? conditions.tide_now_ft + ' ft (' + (conditions.tide_now_label||'') + ')' : 'unavailable') + '\n- Tides today: ' + tideStr + '\n- GG Bridge current: ' + (conditions.current_now_kts !== null ? conditions.current_now_kts + ' kts ' + (conditions.current_now_dir||'') : 'unavailable') + '\n- Current events today: ' + currentStr + '\n- Wind: ' + (conditions.wind_kts !== null ? conditions.wind_kts + ' kts from ' + (conditions.wind_dir||'?') : 'unavailable') + '\n- Ocean swell: ' + (conditions.swell_ft !== null ? conditions.swell_ft + ' ft (note: if this seems high, use the NWS forecast text to determine actual combined seas)' : 'unavailable') + '\n- NWS Forecast: ' + (conditions.forecast_summary || 'unavailable') + '\n\nRECENT FISHING REPORTS:\n' + reportStr + '\n\nKNOWLEDGE BASE:\n\nSEASONS & REGULATIONS:\n- SF Chinook salmon 2026: opens June 27 south of Pt. Arena (SF/San Mateo coastline). CURRENTLY CLOSED for SF ocean waters.\n- Halibut: open year-round, 22 inch minimum, 5 fish limit.\n- Rockfish/lingcod: complex depth and seasonal restrictions, CCAs in effect. Always verify at wildlife.ca.gov.\n- Dungeness crab: check CDFW for season status and domoic acid closures before every trip.\n- White seabass: 28 inch minimum, 3 fish limit. Best Aug-Nov.\n\nMIGRATION & PATTERNS:\n- Chinook migration status for ' + month + ': ' + migrationNote + '\n- Chinook prefer 52-58F water, best bite 1-2 hrs before/after high tide, troll 90-180 ft.\n- Halibut: sandy bottom 20-60 ft, slack water around high tide is prime, drift slowly.\n- Rockfish/lingcod: hard bottom 60-300 ft, incoming tide most active.\n- Dungeness crab: 60-120 ft, strong tidal flow ideal.\n- White seabass: kelp bed edges at dawn/dusk, live squid, incoming tide.\n\nBAR CROSSING:\n- Stay in ship channel unless swells under 6 ft. Never cross on large ebb + swell.\n- Bonita Channel (Marin side, 50-60 ft) good up to 10 ft swell.\n- South Bar has NO channel - avoid entirely, dangerous first-generation breakers.\n- Ebb current steepens bar waves significantly. Flood flattens bar but roughens Pt. Lobos and Pt. Bonita.\n- Pt. Lobos on flood: pass outside Mile Rock. Pt. Bonita: washing machine effect on both tides.\n- Lose power on bar: anchor immediately - current takes you across South Bar fast.\n\nSPOTS:\n- Channel buoys/middle grounds/west buoy: salmon, best on incoming tide, 3-12 mi out.\n- Rocky Point/Muir Beach: near-shore salmon structure, 3-5 mi.\n- Duxbury Reef/Bolinas: salmon and rockfish, fishes well in most conditions, ~10 mi.\n- Pacifica/Pedro Point: accessible salmon year-round, ~10 mi south.\n- Gulf of the Farallones: big salmon and rockfish, needs under 4 ft swell, ~27 mi.\n- Pt. Reyes/Drakes Bay: salmon and seabass, ~20 mi north, check conditions.\n- Potato Patch: halibut prime spot, sandy bottom outside Gate, ~5 mi.\n- Raccoon Strait/Angel Island: Bay halibut, tidal current flats, protected.\n- Treasure Island flats: Bay halibut, sandy bottom mid-Bay.\n- Farallon Islands rocky bottom: best rockfish/lingcod structure, ~27 mi.\n- Pt. Bonita/Marin Headlands reefs: closer rockfish option, ~5 mi.\n\nProvide a comprehensive daily fishing briefing covering ALL species. Structure it exactly as follows:\n\n**OVERALL GO / NO-GO: [GO FISH / CAUTION / NO-GO]**\nOne sentence on overall conditions for getting out today.\n\n**CONDITIONS SUMMARY**\n2-3 sentences on wind, swell (use NWS forecast text for actual sea height), tides, and current. What do they mean practically for getting out and crossing the bar today?\n\n**BEST TIME WINDOWS TODAY**\nList 1-3 specific time windows (e.g. 7:00-9:30am) with tide/current reasoning. Be specific.\n\n**SPECIES BREAKDOWN**\nFor each species, one line verdict and recommendation:\n- SALMON: [open/closed + go/no-go + best spot if applicable]\n- HALIBUT: [go/no-go + best spot today - ocean or Bay]\n- ROCKFISH/LINGCOD: [go/no-go + best spot today]\n- DUNGENESS CRAB: [season status + go/no-go]\n- WHITE SEABASS: [seasonal note + go/no-go]\n\n**WHERE TO FISH**\nRank the top 3 spots for today across all species. Number each one. Format: "1. [Spot name]: [why it makes sense today - conditions + recent reports + species]. 2. ..." Include any spots mentioned in recent reports even if not on the usual list. If a spot should be avoided today say so and why.\n\n**TOP RECOMMENDATION TODAY**\nOne clear answer: specific species, spot, time window, technique. Be direct.\n\n**WHAT TO USE**\nSpecific bait and technique for the top recommendation.\n\n**INTEL FROM RECENT REPORTS**\n2-3 sentences on what reports are saying. Be specific, note if data is limited.\n\n**OUTLOOK**\n1-2 sentences. Is today worth it, or wait for better conditions/season opener?\n\nBe direct, specific, and practical. Use local spot names. This is a knowledgeable local guide, not a liability disclaimer.';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    if (d.error) return res.status(500).json({ error: d.error.message });
    const text = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : 'Could not generate briefing.';
    res.json({ briefing: text, generated_at: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/forecast', async function(req, res) {
  try {
    const pad = function(n) { return String(n).padStart(2,'0'); };
    const today = new Date();
    const startDate = today.getFullYear() + pad(today.getMonth()+1) + pad(today.getDate());
    const endDay = new Date(today); endDay.setDate(today.getDate() + 6);
    const endDate = endDay.getFullYear() + pad(endDay.getMonth()+1) + pad(endDay.getDate());
    const headers = { 'User-Agent': 'SFBayFishingApp/1.0 (fishing@example.com)' };

    // Use NWS JSON API for 7-day forecast — more reliable than text parsing
    const nwsRes = await fetch('https://api.weather.gov/zones/forecast/PZZ540/forecast', { headers: headers });
    const nwsData = await nwsRes.json();
    const periods = (nwsData.properties && nwsData.properties.periods) ? nwsData.properties.periods : [];

    // Fetch 7-day tide predictions (hilo)
    const tideRes = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=sf_fishing&begin_date=' + startDate + '&end_date=' + endDate + '&datum=MLLW&station=9414290&time_zone=lst_ldt&interval=hilo&units=english&format=json');
    const tideData = await tideRes.json();
    const tidePreds = tideData.predictions || [];

    // Fetch 7-day current predictions
    const currentRes = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=sf_fishing&begin_date=' + startDate + '&end_date=' + endDate + '&station=PUG1515&time_zone=lst_ldt&interval=MAX_SLACK&units=english&format=json');
    const currentData = await currentRes.json();
    const currentPreds = (currentData.current_predictions && currentData.current_predictions.cp) ? currentData.current_predictions.cp : [];

    function formatTime12(t) {
      if (!t) return '';
      const timePart = t.includes(' ') ? t.split(' ')[1] : t;
      const hm = timePart.split(':');
      const h = parseInt(hm[0]), mn = parseInt(hm[1]||0);
      const ampm = h >= 12 ? 'pm' : 'am';
      const h12 = h > 12 ? h-12 : (h===0?12:h);
      return h12 + ':' + String(mn).padStart(2,'0') + ampm;
    }

    // Group tides by date
    const tidesByDate = {};
    for (const t of tidePreds) {
      const d = t.t.split(' ')[0];
      if (!tidesByDate[d]) tidesByDate[d] = [];
      tidesByDate[d].push(t);
    }

    // Group currents by date
    const currentsByDate = {};
    for (const c of currentPreds) {
      const d = (c.Time || '').split(' ')[0];
      if (!currentsByDate[d]) currentsByDate[d] = [];
      currentsByDate[d].push(c);
    }

    // Parse wind/swell from NWS period text
    function parseWind(txt) {
      const wm = (txt||'').match(/(N|NE|NNE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\s+wind[s]?\s+(\d+)\s*(?:to\s*(\d+))?\s*(?:kt|knots?)/i);
      if (!wm) return { kts: null, dir: null };
      return { kts: wm[3] ? Math.round((parseInt(wm[2])+parseInt(wm[3]))/2) : parseInt(wm[2]), dir: wm[1].toUpperCase() };
    }
    function parseSwell(txt) {
      const sm = (txt||'').match(/(?:combined\s+)?[Ss]eas\s+(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/);
      if (!sm) return null;
      return sm[2] ? Math.round((parseFloat(sm[1])+parseFloat(sm[2]))/2*10)/10 : parseFloat(sm[1]);
    }

    // Build one entry per calendar day using daytime periods only
    const dayMap = {};
    for (const period of periods) {
      if (!period.startTime) continue;
      const dateStr = period.startTime.slice(0,10);
      // Use daytime period (isDaytime=true) as primary; skip night-only if day already set
      if (dayMap[dateStr] && !period.isDaytime) continue;
      const txt = period.detailedForecast || period.shortForecast || '';
      const wind = parseWind(txt);
      const swell = parseSwell(txt);
      const d = new Date(period.startTime);
      dayMap[dateStr] = {
        date: dateStr,
        dow: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' }),
        name: period.name || dateStr,
        wind_kts: wind.kts,
        wind_dir: wind.dir,
        swell_ft: swell,
        summary: txt.replace(/Wave\s+Detail[^.]*\./gi,'').trim().slice(0,200),
        isDaytime: period.isDaytime
      };
    }

    // Attach tide and current data
    const forecastDays = Object.values(dayMap).sort(function(a,b){return a.date.localeCompare(b.date);}).slice(0,7);
    for (const day of forecastDays) {
      const dayTides = tidesByDate[day.date] || [];
      const dayCurrents = currentsByDate[day.date] || [];
      const highTides = dayTides.filter(function(t){return t.type==='H';});
      const lowTides = dayTides.filter(function(t){return t.type==='L';});
      day.high_tides = highTides.map(function(t){return{time:formatTime12(t.t),ft:parseFloat(parseFloat(t.v).toFixed(1))};});
      day.low_tides = lowTides.map(function(t){return{time:formatTime12(t.t),ft:parseFloat(parseFloat(t.v).toFixed(1))};});
      day.best_window = highTides.length ? formatTime12(highTides[0].t) : null;
      // Max flood and ebb per day
      let maxFlood = { speed: 0, time: null };
      let maxEbb = { speed: 0, time: null };
      const slacks = [];
      for (const c of dayCurrents) {
        const spd = Math.abs(parseFloat(c.Velocity_Major || c.Speed || 0));
        const type = (c.Type || '').toLowerCase();
        const t = formatTime12(c.Time);
        if (type === 'flood' && spd > maxFlood.speed) maxFlood = { speed: parseFloat(spd.toFixed(1)), time: t };
        if (type === 'ebb' && spd > maxEbb.speed) maxEbb = { speed: parseFloat(spd.toFixed(1)), time: t };
        if (type === 'slack' || spd < 0.2) slacks.push({ time: t, speed: parseFloat(spd.toFixed(1)) });
      }
      day.max_flood = maxFlood.speed > 0 ? maxFlood : null;
      day.max_ebb = maxEbb.speed > 0 ? maxEbb : null;
      day.slacks = slacks;
    }

    res.json({ days: forecastDays, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('Forecast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/health', function(req, res) {
  res.json({ status: 'ok', time: new Date().toISOString(), port: PORT });
});

app.get('/conditions', async function(req, res) {
  try {
    const results = await Promise.all([fetchTides(), fetchWeather(), fetchCurrents()]);
    res.json(Object.assign({}, results[0], results[1], results[2], { fetched_at: new Date().toISOString() }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/reports', async function(req, res) {
  const species = req.query.species || 'salmon';
  try {
    const reports = await fetchReports(species);
    // Generate a summary if we have reports and an API key
    let summary = null;
    if (reports.length && process.env.ANTHROPIC_API_KEY) {
      try {
        const reportText = reports.map(function(r) { return r.source + ': ' + r.snippet; }).join(' | ');
        const prompt = 'Here are recent SF Bay Area fishing reports: ' + reportText + ' Summarize the key fishing intel in 3-4 sentences. Focus on: what species are biting, where, and any notable catch numbers or techniques mentioned. Be specific and direct. No fluff.';
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
        });
        const d = await resp.json();
        summary = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : null;
      } catch(e) { console.error('Summary error:', e.message); }
    }
    res.json({ reports: reports, summary: summary, fetched_at: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/analyze-cfc', async function(req, res) {
  const species = req.body.species || 'salmon';
  const location = req.body.location || 'ocean';
  const report = req.body.report || '';
  if (!report) return res.status(400).json({ error: 'No report provided' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API key not configured' });
  const spotCtx = species === 'Salmon' ? ' Key local spots: channel buoys, west buoy, middle grounds, Rocky Point, Muir Beach, Duxbury Reef, Pacifica, Gulf of the Farallones, Pt. Reyes.' : '';
  const locCtx = location === 'bay' ? ' Focus on inside-the-Bay catches if mentioned.' : '';
  const prompt = 'I fish ' + species.toLowerCase() + ' out of the Golden Gate on a 26ft Glacier Bay catamaran. Go/no-go: max 5ft swell, 20kt wind ocean (25kt Bay), never south wind outside.' + spotCtx + locCtx + '\n\nCFC report:\n' + report + '\n\nSummarize in 3-4 sentences: (1) where they have been catching, (2) depth/conditions, (3) bait/technique, (4) recommendation for my next trip.';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    const text = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : 'Could not analyze.';
    res.json({ result: text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/cfc-debug', async function(req, res) {
  if (!process.env.CFC_USERNAME) return res.json({ error: 'No credentials' });
  try {
    const result = await cfc.debugFetch('https://forums.coastsidefishingclub.com/forums/saltwater-fishing-reports.5/');
    res.json(result);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/cfc-reports', async function(req, res) {
  if (!process.env.CFC_USERNAME || !process.env.CFC_PASSWORD) {
    return res.json({ reports: [], error: 'CFC credentials not configured' });
  }
  try {
    const reports = await cfc.getRecentReports();
    res.json({ reports: reports, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('CFC reports error:', e.message);
    res.json({ reports: [], error: e.message });
  }
});

app.get('/cfc-historical', async function(req, res) {
  if (!process.env.CFC_USERNAME || !process.env.CFC_PASSWORD || !process.env.ANTHROPIC_API_KEY) {
    return res.json({ summary: null, error: 'Credentials not configured' });
  }
  try {
    const summary = await cfc.getHistoricalSummary(process.env.ANTHROPIC_API_KEY);
    res.json({ summary: summary, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('CFC historical error:', e.message);
    res.json({ summary: null, error: e.message });
  }
});

app.post('/briefing', async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Add ANTHROPIC_API_KEY to Railway variables to enable briefings.' });
  const species = req.body.species || 'salmon';
  const location = req.body.location || 'ocean';
  let conditions, reports;
  try {
    const results = await Promise.all([
      Promise.all([fetchTides(), fetchWeather(), fetchCurrents()]).then(function(r) { return Object.assign({}, r[0], r[1], r[2]); }),
      fetchReports(species)
    ]);
    conditions = results[0];
    reports = results[1];
  } catch(e) {
    return res.status(500).json({ error: 'Could not fetch live data: ' + e.message });
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true });
  const month = now.toLocaleString('en-US', { month:'long' });
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(),0,0)) / 86400000);

  const tideStr = (conditions.events || []).map(function(e) { return e.type + ' ' + e.time + ' (' + e.ft + ' ft)'; }).join(', ') || 'unavailable';
  const currentStr = (conditions.current_events || []).map(function(e) { return e.type + ' ' + e.time + ' (' + e.speed + ' kts)'; }).join(', ') || 'unavailable';
  const reportStr = reports.length ? reports.map(function(r) { return r.source + ': ' + r.snippet; }).join('\n\n') : 'No recent reports available.';

  let migrationNote;
  if (dayOfYear < 120) migrationNote = 'fish staging offshore, beginning to move toward coast as water warms';
  else if (dayOfYear < 180) migrationNote = 'fish moving toward the coast, following anchovy schools. Season opens June 27 south of Pt. Arena for SF/San Mateo coast.';
  else if (dayOfYear < 240) migrationNote = 'peak season - fish actively feeding near structure and bait schools along the coast';
  else if (dayOfYear < 300) migrationNote = 'late season - fish beginning to move toward river mouths, staging near nearshore structure';
  else migrationNote = 'fish moving toward rivers, season winding down';

  const prompt = 'You are an expert SF Bay Area sport fishing advisor with deep knowledge of Chinook salmon, halibut, rockfish, lingcod, Dungeness crab, and white seabass fishing in the waters outside the Golden Gate and inside SF Bay. You know every local spot intimately.\n\nToday is ' + dateStr + ', current time ' + timeStr + ' Pacific.\nThe angler has a 26-foot Glacier Bay catamaran. Go/No-Go thresholds: max 5 ft swell, max 20 kt wind, never in south wind. Bay fishing threshold: max 25 kt wind, swell irrelevant.\n\nLIVE CONDITIONS:\n- Tide now: ' + (conditions.tide_now_ft !== null ? conditions.tide_now_ft + ' ft (' + (conditions.tide_now_label||'') + ')' : 'unavailable') + '\n- Tides today: ' + tideStr + '\n- GG Bridge current: ' + (conditions.current_now_kts !== null ? conditions.current_now_kts + ' kts ' + (conditions.current_now_dir||'') : 'unavailable') + '\n- Current events today: ' + currentStr + '\n- Wind: ' + (conditions.wind_kts !== null ? conditions.wind_kts + ' kts from ' + (conditions.wind_dir||'?') : 'unavailable') + '\n- Ocean swell: ' + (conditions.swell_ft !== null ? conditions.swell_ft + ' ft (note: if this seems high, use the NWS forecast text to determine actual combined seas)' : 'unavailable') + '\n- NWS Forecast: ' + (conditions.forecast_summary || 'unavailable') + '\n\nRECENT FISHING REPORTS:\n' + reportStr + '\n\nKNOWLEDGE BASE:\n\nSEASONS & REGULATIONS:\n- SF Chinook salmon 2026: opens June 27 south of Pt. Arena (SF/San Mateo coastline). CURRENTLY CLOSED for SF ocean waters.\n- Halibut: open year-round, 22 inch minimum, 5 fish limit.\n- Rockfish/lingcod: complex depth and seasonal restrictions, CCAs in effect. Always verify at wildlife.ca.gov.\n- Dungeness crab: check CDFW for season status and domoic acid closures before every trip.\n- White seabass: 28 inch minimum, 3 fish limit. Best Aug-Nov.\n\nMIGRATION & PATTERNS:\n- Chinook migration status for ' + month + ': ' + migrationNote + '\n- Chinook prefer 52-58F water, best bite 1-2 hrs before/after high tide, troll 90-180 ft.\n- Halibut: sandy bottom 20-60 ft, slack water around high tide is prime, drift slowly.\n- Rockfish/lingcod: hard bottom 60-300 ft, incoming tide most active.\n- Dungeness crab: 60-120 ft, strong tidal flow ideal.\n- White seabass: kelp bed edges at dawn/dusk, live squid, incoming tide.\n\nBAR CROSSING:\n- Stay in ship channel unless swells under 6 ft. Never cross on large ebb + swell.\n- Bonita Channel (Marin side, 50-60 ft) good up to 10 ft swell.\n- South Bar has NO channel - avoid entirely, dangerous first-generation breakers.\n- Ebb current steepens bar waves significantly. Flood flattens bar but roughens Pt. Lobos and Pt. Bonita.\n- Pt. Lobos on flood: pass outside Mile Rock. Pt. Bonita: washing machine effect on both tides.\n- Lose power on bar: anchor immediately - current takes you across South Bar fast.\n\nSPOTS:\n- Channel buoys/middle grounds/west buoy: salmon, best on incoming tide, 3-12 mi out.\n- Rocky Point/Muir Beach: near-shore salmon structure, 3-5 mi.\n- Duxbury Reef/Bolinas: salmon and rockfish, fishes well in most conditions, ~10 mi.\n- Pacifica/Pedro Point: accessible salmon year-round, ~10 mi south.\n- Gulf of the Farallones: big salmon and rockfish, needs under 4 ft swell, ~27 mi.\n- Pt. Reyes/Drakes Bay: salmon and seabass, ~20 mi north, check conditions.\n- Potato Patch: halibut prime spot, sandy bottom outside Gate, ~5 mi.\n- Raccoon Strait/Angel Island: Bay halibut, tidal current flats, protected.\n- Treasure Island flats: Bay halibut, sandy bottom mid-Bay.\n- Farallon Islands rocky bottom: best rockfish/lingcod structure, ~27 mi.\n- Pt. Bonita/Marin Headlands reefs: closer rockfish option, ~5 mi.\n\nProvide a comprehensive daily fishing briefing covering ALL species. Structure it exactly as follows:\n\n**OVERALL GO / NO-GO: [GO FISH / CAUTION / NO-GO]**\nOne sentence on overall conditions for getting out today.\n\n**CONDITIONS SUMMARY**\n2-3 sentences on wind, swell (use NWS forecast text for actual sea height), tides, and current. What do they mean practically for getting out and crossing the bar today?\n\n**BEST TIME WINDOWS TODAY**\nList 1-3 specific time windows (e.g. 7:00-9:30am) with tide/current reasoning. Be specific.\n\n**SPECIES BREAKDOWN**\nFor each species, one line verdict and recommendation:\n- SALMON: [open/closed + go/no-go + best spot if applicable]\n- HALIBUT: [go/no-go + best spot today - ocean or Bay]\n- ROCKFISH/LINGCOD: [go/no-go + best spot today]\n- DUNGENESS CRAB: [season status + go/no-go]\n- WHITE SEABASS: [seasonal note + go/no-go]\n\n**WHERE TO FISH**\nRank the top 3 spots for today across all species. Number each one. Format: "1. [Spot name]: [why it makes sense today - conditions + recent reports + species]. 2. ..." Include any spots mentioned in recent reports even if not on the usual list. If a spot should be avoided today say so and why.\n\n**TOP RECOMMENDATION TODAY**\nOne clear answer: specific species, spot, time window, technique. Be direct.\n\n**WHAT TO USE**\nSpecific bait and technique for the top recommendation.\n\n**INTEL FROM RECENT REPORTS**\n2-3 sentences on what reports are saying. Be specific, note if data is limited.\n\n**OUTLOOK**\n1-2 sentences. Is today worth it, or wait for better conditions/season opener?\n\nBe direct, specific, and practical. Use local spot names. This is a knowledgeable local guide, not a liability disclaimer.';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    if (d.error) return res.status(500).json({ error: d.error.message });
    const text = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : 'Could not generate briefing.';
    res.json({ briefing: text, generated_at: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/forecast', async function(req, res) {
  try {
    const headers = { 'User-Agent': 'SFBayFishingApp/1.0 (fishing@example.com)' };

    // Fetch 7-day NWS marine forecast text
    const nwsRes = await fetch('https://forecast.weather.gov/shmrn.php?mz=PZZ540', { headers: headers });
    const nwsHtml = await nwsRes.text();
    const nwsText = nwsHtml.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ');

    // Parse day blocks from NWS forecast
    const dayPattern = /((?:TODAY|TONIGHT|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)(?:\s+NIGHT)?)\s+(.+?)(?=(?:TODAY|TONIGHT|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)(?:\s+NIGHT)?|$)/gi;
    const dayBlocks = [];
    let m;
    while ((m = dayPattern.exec(nwsText)) !== null) {
      dayBlocks.push({ label: m[1].trim(), text: m[2].trim() });
    }

    function parseWindFromText(txt) {
      const wm = txt.match(/(N|NE|NNE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\s+wind\s+(\d+)\s*(?:to\s*(\d+))?\s*(?:kt|knots?)/i);
      if (!wm) return { kts: null, dir: null };
      return {
        kts: wm[3] ? Math.round((parseInt(wm[2])+parseInt(wm[3]))/2) : parseInt(wm[2]),
        dir: wm[1].toUpperCase()
      };
    }

    function parseSwellFromText(txt) {
      const sm = txt.match(/(?:combined\s+)?[Ss]eas\s+(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/);
      if (!sm) return null;
      return sm[2] ? Math.round((parseFloat(sm[1])+parseFloat(sm[2]))/2*10)/10 : parseFloat(sm[1]);
    }

    // Build forecast days — merge day/night pairs
    const forecastDays = [];
    const today = new Date();

    // Map label to actual date
    function labelToDate(label) {
      const upper = label.toUpperCase();
      const days = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
      const todayDow = today.getDay();
      if (upper.startsWith('TODAY')) return new Date(today);
      if (upper.startsWith('TONIGHT')) return new Date(today);
      for (let i = 0; i < days.length; i++) {
        if (upper.startsWith(days[i])) {
          let diff = i - todayDow;
          if (diff <= 0) diff += 7;
          const d = new Date(today);
          d.setDate(today.getDate() + diff);
          return d;
        }
      }
      return null;
    }

    // Collect daytime blocks (skip NIGHT/TONIGHT for primary forecast)
    const daytimeBlocks = dayBlocks.filter(function(b) {
      return !b.label.includes('NIGHT') && !b.label.includes('TONIGHT');
    });

    for (let i = 0; i < Math.min(daytimeBlocks.length, 7); i++) {
      const block = daytimeBlocks[i];
      const date = labelToDate(block.label);
      if (!date) continue;
      const wind = parseWindFromText(block.text);
      const swell = parseSwellFromText(block.text);
      // Get summary — first sentence
      const summary = block.text.replace(/Wave\s+Detail[^.]*\./gi,'').trim().slice(0, 180);
      forecastDays.push({
        date: date.toISOString().split('T')[0],
        dow: date.toLocaleDateString('en-US', { weekday: 'short' }),
        label: block.label,
        wind_kts: wind.kts,
        wind_dir: wind.dir,
        swell_ft: swell,
        summary: summary
      });
    }

    // Fetch 7-day tide predictions
    const pad = function(n) { return String(n).padStart(2,'0'); };
    const startDate = today.getFullYear() + pad(today.getMonth()+1) + pad(today.getDate());
    const endDay = new Date(today); endDay.setDate(today.getDate() + 6);
    const endDate = endDay.getFullYear() + pad(endDay.getMonth()+1) + pad(endDay.getDate());

    const tideRes = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=sf_fishing&begin_date=' + startDate + '&end_date=' + endDate + '&datum=MLLW&station=9414290&time_zone=lst_ldt&interval=hilo&units=english&format=json');
    const tideData = await tideRes.json();
    const tidePreds = tideData.predictions || [];

    // Fetch 7-day current predictions
    const currentRes = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=sf_fishing&begin_date=' + startDate + '&end_date=' + endDate + '&station=PUG1515&time_zone=lst_ldt&interval=MAX_SLACK&units=english&format=json');
    const currentData = await currentRes.json();
    const currentPreds = (currentData.current_predictions && currentData.current_predictions.cp) ? currentData.current_predictions.cp : [];

    // Group tides and currents by date
    function groupByDate(items, dateField, valField) {
      const map = {};
      for (const item of items) {
        const d = (item[dateField] || item.t || item.Time || '').split(' ')[0];
        if (!map[d]) map[d] = [];
        map[d].push(item);
      }
      return map;
    }

    const tidesByDate = groupByDate(tidePreds, 't');
    const currentsByDate = groupByDate(currentPreds, 'Time');

    function formatTime12(t) {
      if (!t) return '';
      const parts = t.split(' ');
      const timePart = parts.length > 1 ? parts[1] : parts[0];
      const hm = timePart.split(':');
      const h = parseInt(hm[0]), mn = parseInt(hm[1]);
      const ampm = h >= 12 ? 'pm' : 'am';
      const h12 = h > 12 ? h-12 : (h===0?12:h);
      return h12 + ':' + String(mn).padStart(2,'0') + ampm;
    }

    // Attach tide and current data to each forecast day
    for (const day of forecastDays) {
      const dateStr = day.date;
      const dayTides = tidesByDate[dateStr] || [];
      const dayCurrents = currentsByDate[dateStr] || [];

      // Best fishing window = first high tide time
      const highTides = dayTides.filter(function(t) { return t.type === 'H'; });
      const lowTides = dayTides.filter(function(t) { return t.type === 'L'; });
      day.high_tides = highTides.map(function(t) { return { time: formatTime12(t.t), ft: parseFloat(parseFloat(t.v).toFixed(1)) }; });
      day.low_tides = lowTides.map(function(t) { return { time: formatTime12(t.t), ft: parseFloat(parseFloat(t.v).toFixed(1)) }; });
      day.best_window = highTides.length ? formatTime12(highTides[0].t) : null;

      // Max flood and ebb with times
      let maxFlood = { speed: 0, time: null };
      let maxEbb = { speed: 0, time: null };
      const slacks = [];
      for (const c of dayCurrents) {
        const spd = Math.abs(parseFloat(c.Velocity_Major || c.Speed || 0));
        const type = (c.Type || '').toLowerCase();
        const t = formatTime12(c.Time);
        if (type === 'flood' && spd > maxFlood.speed) maxFlood = { speed: parseFloat(spd.toFixed(1)), time: t };
        if (type === 'ebb' && spd > maxEbb.speed) maxEbb = { speed: parseFloat(spd.toFixed(1)), time: t };
        if (type === 'slack' || spd < 0.2) slacks.push({ time: t, speed: parseFloat(spd.toFixed(1)) });
      }
      day.max_flood = maxFlood.speed > 0 ? maxFlood : null;
      day.max_ebb = maxEbb.speed > 0 ? maxEbb : null;
      day.slacks = slacks;
    }

    res.json({ days: forecastDays, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('Forecast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/tides-multi', async function(req, res) {
  try {
    const pad = function(n) { return String(n).padStart(2,'0'); };
    const today = new Date();
    const dateStr = today.getFullYear() + pad(today.getMonth()+1) + pad(today.getDate());
    const base = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?application=sf_fishing&begin_date=' + dateStr + '&end_date=' + dateStr + '&time_zone=lst_ldt&units=english&format=json';

    function formatTime12(t) {
      if (!t) return '';
      const timePart = t.includes(' ') ? t.split(' ')[1] : t;
      const hm = timePart.split(':');
      const h = parseInt(hm[0]), mn = parseInt(hm[1]||0);
      return (h>12?h-12:(h===0?12:h)) + ':' + String(mn).padStart(2,'0') + (h>=12?'pm':'am');
    }

    const locations = [
      { id: 'golden_gate', name: 'Golden Gate', tideStation: '9414290', currentStation: 'SFB1203', datum: 'MLLW' },
      { id: 'alcatraz', name: 'Alcatraz', tideStation: '9414792', currentStation: 'SFB1211', datum: 'MLLW' },

    ];

    const results = [];
    for (const loc of locations) {
      try {
        const [tideRes, currentRes, currentHourlyRes] = await Promise.all([
          fetch(base + '&product=predictions&interval=hilo&datum=' + loc.datum + '&station=' + loc.tideStation),
          fetch(base + '&product=currents_predictions&interval=MAX_SLACK&station=' + loc.currentStation),
          fetch(base + '&product=currents_predictions&interval=6&station=' + loc.currentStation)
        ]);
        const tideData = await tideRes.json();
        const currentData = await currentRes.json();
        const currentHourlyData = await currentHourlyRes.json();

        const tides = (tideData.predictions || []).map(function(p) {
          return { type: p.type==='H'?'High':'Low', time: formatTime12(p.t.split(' ')[1]), ft: parseFloat(parseFloat(p.v).toFixed(1)) };
        });

        const cp = (currentData.current_predictions && currentData.current_predictions.cp) ? currentData.current_predictions.cp : [];
        const events = cp.map(function(p) {
          const spd = Math.abs(parseFloat(p.Velocity_Major || p.Speed || 0));
          const type = p.Type==='ebb'?'Ebb':p.Type==='flood'?'Flood':(spd<0.2?'Slack':(p.Type||'Slack'));
          return { type: type, time: formatTime12(p.Time.split(' ')[1]), speed: parseFloat(spd.toFixed(1)) };
        });

        const cpH = (currentHourlyData.current_predictions && currentHourlyData.current_predictions.cp) ? currentHourlyData.current_predictions.cp : [];
        const hourly = cpH.map(function(p) {
          const vel = parseFloat(p.Velocity_Major || 0);
          const t = (p.Time||'').split(' ');
          const hm = (t.length>1?t[1]:t[0]).split(':');
          return { hour: parseInt(hm[0]||0), min: parseInt(hm[1]||0), vel: parseFloat(vel.toFixed(2)) };
        });

        let maxFlood = { speed:0, time:null }, maxEbb = { speed:0, time:null };
        for (const e of events) {
          if (e.type==='Flood' && e.speed>maxFlood.speed) maxFlood = { speed:e.speed, time:e.time };
          if (e.type==='Ebb' && e.speed>maxEbb.speed) maxEbb = { speed:e.speed, time:e.time };
        }

        results.push({
          id: loc.id, name: loc.name, note: loc.note||null,
          tides, current_events: events, current_hourly: hourly,
          max_flood: maxFlood.speed>0?maxFlood:null,
          max_ebb: maxEbb.speed>0?maxEbb:null
        });
      } catch(e) {
        console.error('Location ' + loc.id + ' error:', e.message);
        results.push({ id: loc.id, name: loc.name, note: loc.note||null, tides:[], current_events:[], current_hourly:[], max_flood:null, max_ebb:null });
      }
    }

    res.json({ locations: results, fetched_at: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('SF Fishing API running on port ' + PORT);
});
