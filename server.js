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

async function fetchCurrents() {
  // NOAA current station PUG1515 = Golden Gate Bridge
  const today = new Date();
  const pad = function(n) { return String(n).padStart(2,'0'); };
  const dateStr = today.getFullYear() + pad(today.getMonth()+1) + pad(today.getDate());
  try {
    const [predRes, obsRes] = await Promise.all([
      fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=sf_fishing&begin_date='+dateStr+'&end_date='+dateStr+'&station=PUG1515&time_zone=lst_ldt&interval=MAX_SLACK&units=english&format=json'),
      fetch('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents&application=sf_fishing&begin_date='+dateStr+'&end_date='+dateStr+'&station=PUG1515&time_zone=lst_ldt&units=english&format=json')
    ]);
    const predData = await predRes.json();
    const obsData = await obsRes.json();

    // Max/slack predictions
    const events = (predData.current_predictions && predData.current_predictions.cp ? predData.current_predictions.cp : []).map(function(p) {
      const spd = parseFloat(parseFloat(p.Velocity_Major || p.Speed || 0).toFixed(1));
      const type = p.Type === 'ebb' ? 'Ebb' : p.Type === 'flood' ? 'Flood' : (p.Type || '');
      const isSlack = Math.abs(spd) < 0.2 || p.Type === 'slack';
      return {
        type: isSlack ? 'Slack' : type,
        time: formatTime(p.Time.split(' ')[1]),
        speed: Math.abs(spd)
      };
    });

    // Current speed right now from observations
    let currentNow = null, currentDir = null;
    const obs = obsData.current_observations || obsData.data || [];
    if (obs.length) {
      const now = new Date();
      let closest = null, minDiff = Infinity;
      for (const o of obs) {
        const t = new Date((o.t || o.time || '').replace(' ','T'));
        const diff = Math.abs(t - now);
        if (diff < minDiff) { minDiff = diff; closest = o; }
      }
      if (closest) {
        const spd = parseFloat(closest.s || closest.Speed || 0);
        currentNow = Math.abs(parseFloat(spd.toFixed(1)));
        // Positive = flood (incoming), negative = ebb (outgoing)
        const vel = parseFloat(closest.v || closest.Velocity_Major || spd);
        currentDir = vel > 0 ? 'flood' : vel < 0 ? 'ebb' : 'slack';
      }
    }

    return { current_events: events, current_now_kts: currentNow, current_now_dir: currentDir };
  } catch (e) {
    console.error('Currents error:', e.message);
    return { current_events: [], current_now_kts: null, current_now_dir: null };
  }
}

async function fetchWeather() {
  try {
    // PZZ540 = Point Arena to Pt Reyes 10NM — covers ocean waters outside Golden Gate with full swell data
    // Use raw text forecast which is much easier to parse than JSON API
    const res = await fetch('https://forecast.weather.gov/shmrn.php?mz=PZZ540', {
      headers: { 'User-Agent': 'SFBayFishingApp/1.0 (fishing@example.com)' }
    });
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

    let windKts = null, windDir = null, swellFt = null, summary = '';

    // Extract TODAY section
    const todayMatch = text.match(/TODAY[^.]*?(?:\.|$)/i);
    const tonightMatch = text.match(/TONIGHT[^.]*?(?:\.|$)/i);
    const firstPeriod = todayMatch ? todayMatch[0] : (tonightMatch ? tonightMatch[0] : text.slice(0,300));

    // Wind speed: "NW wind 10 to 15 kt" or "wind 15 knots"
    const wm = firstPeriod.match(/(N|NE|NNE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\s+wind\s+(\d+)\s*(?:to\s*(\d+))?\s*(?:kt|knots?)/i);
    if (wm) {
      windDir = wm[1].toUpperCase();
      windKts = wm[3] ? Math.round((parseInt(wm[2])+parseInt(wm[3]))/2) : parseInt(wm[2]);
    } else {
      const wm2 = text.match(/(N|NE|NNE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\s+wind\s+(\d+)\s*(?:to\s*(\d+))?\s*(?:kt|knots?)/i);
      if (wm2) { windDir = wm2[1].toUpperCase(); windKts = wm2[3] ? Math.round((parseInt(wm2[2])+parseInt(wm2[3]))/2) : parseInt(wm2[2]); }
    }

    // Seas/swell: "Seas 4 to 6 ft" or "Seas 5 ft"
    const sm = text.match(/Seas?\s+(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/i);
    if (sm) swellFt = sm[2] ? Math.round((parseFloat(sm[1])+parseFloat(sm[2]))/2*10)/10 : parseFloat(sm[1]);

    // Summary: first 250 chars of the forecast text
    const forecastMatch = text.match(/TODAY.{0,250}/i);
    summary = forecastMatch ? forecastMatch[0].trim() : text.slice(0,250).trim();

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
    const [tides, weather, currents] = await Promise.all([fetchTides(), fetchWeather(), fetchCurrents()]);
    res.json(Object.assign({}, tides, weather, currents, { fetched_at: new Date().toISOString() }));
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

app.post('/briefing', async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'API key not configured. Add ANTHROPIC_API_KEY to Railway variables.' });

  const species = req.body.species || 'salmon';
  const location = req.body.location || 'ocean';

  // Gather all live data in parallel
  let conditions, reports;
  try {
    [conditions, reports] = await Promise.all([
      (async () => {
        const [tides, weather, currents] = await Promise.all([fetchTides(), fetchWeather(), fetchCurrents()]);
        return Object.assign({}, tides, weather, currents);
      })(),
      fetchReports(species)
    ]);
  } catch(e) {
    return res.status(500).json({ error: 'Could not fetch live data: ' + e.message });
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true, timeZone:'America/Los_Angeles' });
  const month = now.toLocaleString('en-US', { month:'long' });
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(),0,0)) / 86400000);

  // Format tide events
  const tideStr = (conditions.events || []).map(function(e) {
    return e.type + ' ' + e.time + ' (' + e.ft + ' ft)';
  }).join(', ') || 'unavailable';

  // Format current events
  const currentStr = (conditions.current_events || []).map(function(e) {
    return e.type + ' ' + e.time + ' (' + e.speed + ' kts)';
  }).join(', ') || 'unavailable';

  // Format reports
  const reportStr = reports.length
    ? reports.map(function(r) { return r.source + ': ' + r.snippet; }).join('

')
    : 'No recent reports available.';

  const prompt = `You are an expert SF Bay Area sport fishing advisor with deep knowledge of Chinook salmon, halibut, rockfish, Dungeness crab, and white seabass fishing in the waters outside the Golden Gate. You know every local spot intimately — the channel buoys, middle grounds, west buoy, Rocky Point, Muir Beach, Duxbury Reef, Potato Patch, Gulf of the Farallones, Pt. Reyes, and the nuances of each.

Today is ${dateStr}, current time ${timeStr} Pacific.
The angler has a 26-foot Glacier Bay catamaran — a capable, stable boat.
Go/No-Go thresholds: max 5 ft swell, max 20 kt wind, never in south wind.
Target species today: ${species}${location === 'bay' ? ' (inside SF Bay)' : ' (ocean, outside Golden Gate)'}.

LIVE CONDITIONS RIGHT NOW:
- Tide now: ${conditions.tide_now_ft !== null ? conditions.tide_now_ft + ' ft (' + (conditions.tide_now_label||'') + ')' : 'unavailable'}
- Today's tides: ${tideStr}
- Current at Golden Gate (NOAA PUG1515): ${conditions.current_now_kts !== null ? conditions.current_now_kts + ' kts ' + (conditions.current_now_dir||'') : 'unavailable'}
- Today's current events: ${currentStr}
- Wind: ${conditions.wind_kts !== null ? conditions.wind_kts + ' kts from ' + (conditions.wind_dir||'?') : 'unavailable'}
- Swell: ${conditions.swell_ft !== null ? conditions.swell_ft + ' ft' : 'unavailable'}
- NWS forecast: ${conditions.forecast_summary || 'unavailable'}

RECENT FISHING REPORTS:
${reportStr}

YOUR KNOWLEDGE BASE — apply this to your advice:
- SF Chinook salmon season 2026 opens June 27 south of Pt. Arena (San Mateo/SF coastline). Currently closed for SF waters. Open south of Pigeon Point.
- Chinook prefer 52–58°F water. In ${month}, fish are typically ${dayOfYear < 150 ? 'staging offshore, beginning to move toward the coast as water warms' : dayOfYear < 200 ? 'actively feeding near the coast, following bait schools of anchovies' : dayOfYear < 270 ? 'peak season — fish concentrated near structure and bait' : 'late season, fish moving toward river mouths'}.
- Best bite windows are typically 1–2 hours before and after high tide when bait schools are most active.
- Strong ebb current at the Gate steepens bar waves — advise timing transit near slack.
- Channel buoys and middle grounds fish best on incoming tide. Duxbury fishes well in any conditions. Farallones requires calm seas (under 4 ft) but holds bigger fish.
- For halibut: Potato Patch and Raccoon Strait produce on slack tide around high. Sandy bottom at 20–60 ft. Drift with live bait.
- For rockfish/lingcod: Farallon Islands rocky bottom, Pt. Bonita reefs. Fish 60–300 ft on hard bottom.
- For Dungeness crab: always check CDFW for season/domoic acid status before setting pots.

Please provide a fishing briefing in the following structure:

**GO / NO-GO: [GO FISH / CAUTION / NO-GO]**
One sentence verdict with primary reason.

**CONDITIONS SUMMARY**
2–3 sentences on today's wind, swell, tides, and current — what they mean practically for getting out and fishing.

**BEST WINDOWS TODAY**
Specific time windows (e.g. "6:30–9:00am") with reasoning based on tide, current, and light conditions. Be specific.

**WHERE TO FISH**
Top 2–3 spot recommendations with reasoning. Reference specific local spot names. Explain why each spot makes sense today given conditions and recent reports.

**WHAT TO USE**
Specific technique and bait recommendations based on current reports and conditions.

**INTEL FROM RECENT REPORTS**
2–3 sentences synthesizing what the charter boats and fishing reports are saying this week. Be specific about locations and fish counts if available.

**OUTLOOK**
1–2 sentences on whether conditions improve or worsen in the next 2–3 days, and whether it's worth waiting.

Be direct, specific, and practical. Use local spot names. Don't hedge excessively. This is advice from an experienced local guide, not a liability disclaimer.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
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
