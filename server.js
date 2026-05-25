const express = require('express');
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
    const predRes = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=sf_fishing&begin_date=' + dateStr + '&end_date=' + dateStr + '&station=PUG1515&time_zone=lst_ldt&interval=MAX_SLACK&units=english&format=json');
    const obsRes = await fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents&application=sf_fishing&begin_date=' + dateStr + '&end_date=' + dateStr + '&station=PUG1515&time_zone=lst_ldt&units=english&format=json');
    const predData = await predRes.json();
    const obsData = await obsRes.json();
    const cp = (predData.current_predictions && predData.current_predictions.cp) ? predData.current_predictions.cp : [];
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
    return { current_events: events, current_now_kts: currentNow, current_now_dir: currentDir };
  } catch(e) {
    console.error('Currents error:', e.message);
    return { current_events: [], current_now_kts: null, current_now_dir: null };
  }
}

async function fetchWeather() {
  try {
    const res = await fetch('https://forecast.weather.gov/shmrn.php?mz=PZZ540', {
      headers: { 'User-Agent': 'SFBayFishingApp/1.0 (fishing@example.com)' }
    });
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    let windKts = null;
    let windDir = null;
    let swellFt = null;
    let summary = '';
    const wm = text.match(/(N|NE|NNE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\s+wind\s+(\d+)\s*(?:to\s*(\d+))?\s*(?:kt|knots?)/i);
    if (wm) {
      windDir = wm[1].toUpperCase();
      windKts = wm[3] ? Math.round((parseInt(wm[2])+parseInt(wm[3]))/2) : parseInt(wm[2]);
    }
    const sm = text.match(/Seas?\s+(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/i);
    if (sm) {
      swellFt = sm[2] ? Math.round((parseFloat(sm[1])+parseFloat(sm[2]))/2*10)/10 : parseFloat(sm[1]);
    }
    const forecastMatch = text.match(/TODAY.{0,300}/i);
    summary = forecastMatch ? forecastMatch[0].trim() : text.slice(0,250).trim();
    return { wind_kts: windKts, wind_dir: windDir, swell_ft: swellFt, forecast_summary: summary };
  } catch(e) {
    console.error('Weather error:', e.message);
    return { wind_kts: null, wind_dir: null, swell_ft: null, forecast_summary: '' };
  }
}

async function fetchReports(species) {
  const results = [];
  const headers = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
  try {
    const res = await fetch('https://www.norcalfishreports.com/fish_reports/saltwater_reports.php', { headers: headers });
    const html = await res.text();
    const matches = Array.from(html.matchAll(/<div[^>]*class="[^"]*report[^"]*"[^>]*>([\s\S]{50,600}?)<\/div>/gi));
    if (matches.length) {
      const snip = excerpt(matches[0][1], 400);
      if (snip && snip.length > 30) results.push({ source: 'NorCal Fish Reports', snippet: snip, url: 'https://www.norcalfishreports.com/fish_reports/saltwater_reports.php' });
    } else {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const snip = bodyMatch ? excerpt(bodyMatch[1], 500) : '';
      if (snip && snip.length > 50) results.push({ source: 'NorCal Fish Reports', snippet: snip, url: 'https://www.norcalfishreports.com/fish_reports/saltwater_reports.php' });
    }
  } catch(e) { console.error('NorCal:', e.message); }

  if (species === 'salmon' || species === 'halibut' || species === 'rockfish') {
    try {
      const res = await fetch('https://www.norcalfishreports.com/spots/1233/san-francisco-bay.php', { headers: headers });
      const html = await res.text();
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const snip = bodyMatch ? excerpt(bodyMatch[1], 400) : '';
      if (snip && snip.length > 50) results.push({ source: 'NorCal Fish Reports - SF Bay', snippet: snip, url: 'https://www.norcalfishreports.com/spots/1233/san-francisco-bay.php' });
    } catch(e) { console.error('NorCal SF Bay:', e.message); }
  }

  if (species === 'crab') {
    try {
      const res = await fetch('https://wildlife.ca.gov/Fishing/Ocean/Crab/Dungeness', { headers: headers });
      const html = await res.text();
      const bodyMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      if (bodyMatch) results.push({ source: 'CDFW Dungeness Crab', snippet: excerpt(bodyMatch[1], 400), url: 'https://wildlife.ca.gov/Fishing/Ocean/Crab/Dungeness' });
    } catch(e) { console.error('CDFW crab:', e.message); }
  }

  if (species === 'salmon' || species === 'halibut') {
    try {
      const res = await fetch('https://www.wackyjackysportfishing.com/', { headers: headers });
      const html = await res.text();
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const snip = bodyMatch ? excerpt(bodyMatch[1], 350) : '';
      if (snip && snip.length > 30) results.push({ source: 'Wacky Jacky Sport Fishing', snippet: snip, url: 'https://www.wackyjackysportfishing.com/' });
    } catch(e) { console.error('Wacky Jacky:', e.message); }
  }

  return results.filter(function(r) { return r.snippet && r.snippet.length > 20; }).slice(0, 4);
}

app.get('/health', function(req, res) {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(), 
    port: PORT,
    has_api_key: !!process.env.ANTHROPIC_API_KEY,
    key_prefix: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.slice(0,10) + '...' : 'missing'
  });
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
    res.json({ reports: reports, fetched_at: new Date().toISOString() });
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

  const prompt = 'You are an expert SF Bay Area sport fishing advisor with deep knowledge of Chinook salmon, halibut, rockfish, Dungeness crab, and white seabass fishing in the waters outside the Golden Gate. You know every local spot intimately.\n\nToday is ' + dateStr + ', current time ' + timeStr + ' Pacific.\nThe angler has a 26-foot Glacier Bay catamaran. Go/No-Go: max 5 ft swell, max 20 kt wind, never in south wind.\nTarget species: ' + species + (location === 'bay' ? ' (inside SF Bay)' : ' (ocean, outside Golden Gate)') + '.\n\nLIVE CONDITIONS:\n- Tide now: ' + (conditions.tide_now_ft !== null ? conditions.tide_now_ft + ' ft (' + (conditions.tide_now_label||'') + ')' : 'unavailable') + '\n- Tides today: ' + tideStr + '\n- GG Bridge current: ' + (conditions.current_now_kts !== null ? conditions.current_now_kts + ' kts ' + (conditions.current_now_dir||'') : 'unavailable') + '\n- Current events: ' + currentStr + '\n- Wind: ' + (conditions.wind_kts !== null ? conditions.wind_kts + ' kts from ' + (conditions.wind_dir||'?') : 'unavailable') + '\n- Swell: ' + (conditions.swell_ft !== null ? conditions.swell_ft + ' ft' : 'unavailable') + '\n- Forecast: ' + (conditions.forecast_summary || 'unavailable') + '\n\nRECENT REPORTS:\n' + reportStr + '\n\nKNOWLEDGE BASE:\n- SF Chinook 2026 season: opens June 27 south of Pt. Arena (SF/San Mateo coastline). Currently closed for SF waters.\n- Migration status for ' + month + ': ' + migrationNote + '\n- Chinook prefer 52-58F water. Best bite 1-2 hrs before/after high tide.\n- Stay in ship channel unless swells under 6 ft. Never cross on large ebb + swell - wait for slack.\n- Bonita Channel (Marin side) good alternative up to 10 ft swell.\n- South Bar has NO channel - avoid entirely. Dangerous first-generation breakers.\n- Ebb current steepens bar waves. Flood flattens bar but makes Pt. Lobos and Pt. Bonita rougher.\n- Pt. Lobos on flood: pass outside Mile Rock. Pt. Bonita: washing machine effect on both tides.\n- If you lose power on the bar: anchor immediately - north-to-south current takes you across South Bar fast.\n- Channel buoys/middle grounds best on incoming tide. Duxbury fishes well any conditions. Farallones needs under 4 ft swell.\n- Halibut: Potato Patch and Raccoon Strait on slack around high. Sandy bottom 20-60 ft.\n- Rockfish: Farallon Islands and Pt. Bonita reefs, 60-300 ft hard bottom.\n\nProvide a fishing briefing in this exact structure:\n\n**GO / NO-GO: [verdict]**\nOne sentence with primary reason.\n\n**CONDITIONS SUMMARY**\n2-3 sentences on wind, swell, tides, current and what they mean practically.\n\n**BEST WINDOWS TODAY**\nSpecific time windows (e.g. 6:30-9:00am) with reasoning. Be specific.\n\n**WHERE TO FISH**\nTop 2-3 spots with reasoning. Use local spot names. Explain why each makes sense today.\n\n**WHAT TO USE**\nSpecific bait and technique based on conditions and reports.\n\n**INTEL FROM RECENT REPORTS**\n2-3 sentences on what charter boats and reports say this week. Be specific.\n\n**OUTLOOK**\n1-2 sentences on whether to go today or wait.\n\nBe direct, specific, and practical. Use local spot names. This is advice from an experienced local guide.';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    if (d.error) return res.status(500).json({ error: d.error.message });
    const text = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : 'Could not generate briefing.';
    res.json({ briefing: text, generated_at: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('SF Fishing API running on port ' + PORT);
});
