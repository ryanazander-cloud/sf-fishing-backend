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
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr), m = parseInt(mStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return h12 + ':' + String(m).padStart(2,'0') + ' ' + ampm;
}

function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,'')
             .replace(/<style[\s\S]*?<\/style>/gi,'')
             .replace(/<[^>]+>/g,' ')
             .replace(/\s+/g,' ')
             .replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#\d+;/g,'')
             .trim();
}

function excerpt(text, maxLen) {
  if (!text) return '';
  const clean = stripHtml(text);
  return clean.length > (maxLen||200) ? clean.slice(0, maxLen||200) + '...' : clean;
}

async function fetchTides() {
  const today = new Date();
  const pad = function(n) { return String(n).padStart(2,'0'); };
  const dateStr = today.getFullYear() + pad(today.getMonth()+1) + pad(today.getDate());
  try {
    const base = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?application=sf_fishing&begin_date='+dateStr+'&end_date='+dateStr+'&datum=MLLW&station=9414290&time_zone=lst_ldt&units=english&format=json';
    const [hiloRes, hourlyRes] = await Promise.all([
      fetch(base + '&product=predictions&interval=hilo'),
      fetch(base + '&product=predictions&interval=h')
    ]);
    const hiloData = await hiloRes.json();
    const hourlyData = await hourlyRes.json();
    const events = (hiloData.predictions || []).map(function(p) {
      return { type: p.type === 'H' ? 'High' : 'Low', time: formatTime(p.t.split(' ')[1]), ft: parseFloat(parseFloat(p.v).toFixed(1)) };
    });
    const hourly = hourlyData.predictions || [];
    const now = new Date();
    let closest = null, minDiff = Infinity;
    for (const p of hourly) {
      const diff = Math.abs(new Date(p.t.replace(' ','T')) - now);
      if (diff < minDiff) { minDiff = diff; closest = p; }
    }
    const tideNow = closest ? parseFloat(parseFloat(closest.v).toFixed(1)) : null;
    let tideLabel = '';
    if (closest) {
      const idx = hourly.indexOf(closest);
      if (idx > 0) tideLabel = parseFloat(closest.v) > parseFloat(hourly[idx-1].v) ? 'incoming' : 'outgoing';
    }
    return { events: events, tide_now_ft: tideNow, tide_now_label: tideLabel };
  } catch (e) {
    console.error('Tide error:', e.message);
    return { events: [], tide_now_ft: null, tide_now_label: '' };
  }
}

async function fetchWeather() {
  try {
    // Try point forecast first for better wind/swell data (outside Golden Gate)
    const pointRes = await fetch('https://api.weather.gov/points/37.8,-122.6', {
      headers: { 'User-Agent': 'SFBayFishingApp/1.0 (fishing@example.com)' }
    });
    const pointData = await pointRes.json();
    const forecastUrl = pointData.properties && pointData.properties.forecast;

    // Also fetch zone forecast
    const zoneRes = await fetch('https://api.weather.gov/zones/forecast/PZZ530/forecast', {
      headers: { 'User-Agent': 'SFBayFishingApp/1.0 (fishing@example.com)' }
    });
    const zoneData = await zoneRes.json();
    const periods = (zoneData.properties && zoneData.properties.periods) ? zoneData.properties.periods : [];

    let windKts = null, windDir = null, swellFt = null, summary = '';

    for (const period of periods) {
      const txt = (period.detailedForecast || period.shortForecast || '').toLowerCase();
      const txtOrig = period.detailedForecast || period.shortForecast || '';

      if (windKts === null) {
        // Match "10 to 20 knots", "15 knots", "10-20 kt"
        const wm = txtOrig.match(/(\d+)\s*(?:to\s*(\d+))?\s*(?:knots?|kts?)\b/i);
        if (wm) windKts = wm[2] ? Math.round((parseInt(wm[1])+parseInt(wm[2]))/2) : parseInt(wm[1]);
        // Wind direction
        const dm = txtOrig.match(/\b(north|south|east|west|NE|NW|SE|SW|NNE|NNW|SSE|SSW|ENE|ESE|WNW|WSW|N|S|E|W)\b/i);
        if (dm) {
          const dirMap = {north:'N',south:'S',east:'E',west:'W'};
          windDir = dirMap[dm[1].toLowerCase()] || dm[1].toUpperCase();
        }
      }

      if (swellFt === null) {
        // Match wave heights: "combined seas 4 to 6 feet", "waves 3 feet", "4 to 6 ft"
        const sm = txtOrig.match(/(?:seas?|waves?|swell)\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/i);
        if (sm) {
          swellFt = sm[2] ? Math.round((parseFloat(sm[1])+parseFloat(sm[2]))/2*10)/10 : parseFloat(sm[1]);
        } else {
          // Fallback: any feet measurement
          const sm2 = txtOrig.match(/(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/i);
          if (sm2) swellFt = sm2[2] ? Math.round((parseFloat(sm2[1])+parseFloat(sm2[2]))/2*10)/10 : parseFloat(sm2[1]);
        }
      }

      if (!summary && period.name) summary = period.name + ': ' + txtOrig.slice(0,240);
      if (windKts !== null && windDir !== null && swellFt !== null) break;
    }

    return { wind_kts: windKts, wind_dir: windDir, swell_ft: swellFt, forecast_summary: summary };
  } catch (e) {
    console.error('Weather error:', e.message);
    return { wind_kts: null, wind_dir: null, swell_ft: null, forecast_summary: '' };
  }
}

async function fetchReports(species) {
  const results = [];
  const headers = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

  // 1. NorCalFishReports saltwater reports — best source for SF Bay charter boats
  try {
    const res = await fetch('https://www.norcalfishreports.com/fish_reports/saltwater_reports.php', { headers });
    const html = await res.text();
    // Extract recent report snippets
    const matches = [...html.matchAll(/<div[^>]*class="[^"]*report[^"]*"[^>]*>([\s\S]{50,600}?)<\/div>/gi)];
    if (matches.length) {
      const snip = excerpt(matches[0][1], 400);
      if (snip && snip.length > 30) results.push({ source: 'NorCal Fish Reports', snippet: snip, url: 'https://www.norcalfishreports.com/fish_reports/saltwater_reports.php' });
    } else {
      // Fallback: grab body text
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const snip = bodyMatch ? excerpt(bodyMatch[1], 500) : '';
      if (snip && snip.length > 50) results.push({ source: 'NorCal Fish Reports', snippet: snip, url: 'https://www.norcalfishreports.com/fish_reports/saltwater_reports.php' });
    }
  } catch(e) { console.error('NorCal:', e.message); }

  // 2. NorCalFishReports SF Bay specific
  if (['salmon','halibut','rockfish'].includes(species)) {
    try {
      const res = await fetch('https://www.norcalfishreports.com/spots/1233/san-francisco-bay.php', { headers });
      const html = await res.text();
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const snip = bodyMatch ? excerpt(bodyMatch[1], 400) : '';
      if (snip && snip.length > 50) results.push({ source: 'NorCal Fish Reports — SF Bay', snippet: snip, url: 'https://www.norcalfishreports.com/spots/1233/san-francisco-bay.php' });
    } catch(e) { console.error('NorCal SF Bay:', e.message); }
  }

  // 3. CDFW crab status
  if (species === 'crab') {
    try {
      const res = await fetch('https://wildlife.ca.gov/Fishing/Ocean/Crab/Dungeness', { headers });
      const html = await res.text();
      const bodyMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      if (bodyMatch) results.push({ source: 'CDFW Dungeness Crab', snippet: excerpt(bodyMatch[1], 400), url: 'https://wildlife.ca.gov/Fishing/Ocean/Crab/Dungeness' });
    } catch(e) { console.error('CDFW crab:', e.message); }
  }

  // 4. Wacky Jacky (correct URL)
  if (['salmon','halibut'].includes(species)) {
    try {
      const res = await fetch('https://www.wackyjackysportfishing.com/', { headers });
      const html = await res.text();
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const snip = bodyMatch ? excerpt(bodyMatch[1], 350) : '';
      if (snip && snip.length > 30) results.push({ source: 'Wacky Jacky Sport Fishing', snippet: snip, url: 'https://www.wackyjackysportfishing.com/' });
    } catch(e) { console.error('Wacky Jacky:', e.message); }
  }

  return results.filter(r => r.snippet && r.snippet.length > 20).slice(0, 4);
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', time: new Date().toISOString(), port: PORT });
});

app.get('/conditions', async function(req, res) {
  try {
    const [tides, weather] = await Promise.all([fetchTides(), fetchWeather()]);
    res.json(Object.assign({}, tides, weather, { fetched_at: new Date().toISOString() }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/reports', async function(req, res) {
  const species = req.query.species || 'salmon';
  try {
    const reports = await fetchReports(species);
    res.json({ reports: reports, fetched_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/analyze-cfc', async function(req, res) {
  const { species, location, report } = req.body;
  if (!report) return res.status(400).json({ error: 'No report provided' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API key not configured' });
  const spotCtx = species === 'Salmon' ? ' Key local spots: channel buoys, west buoy, middle grounds, Rocky Point, Muir Beach, Duxbury Reef, Pacifica, Gulf of the Farallones, Pt. Reyes.' : '';
  const locCtx = location === 'bay' ? ' Focus on inside-the-Bay catches if mentioned.' : '';
  const prompt = 'I fish ' + (species||'salmon').toLowerCase() + ' out of the Golden Gate on a 26ft Glacier Bay catamaran. Go/no-go: max 5ft swell, 20kt wind ocean (25kt Bay), never south wind outside.' + spotCtx + locCtx + '\n\nCFC report:\n' + report + '\n\nSummarize in 3-4 sentences: (1) where they\'ve been catching, (2) depth/conditions, (3) bait/technique, (4) recommendation for my next trip.';
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    const text = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : 'Could not analyze report.';
    res.json({ result: text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', function() {
  console.log('SF Fishing API running on port ' + PORT);
});
