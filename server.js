# SF Bay Fishing Backend

A lightweight API that provides real-time tide, marine weather, and fishing report data for the SF Bay Area fishing dashboard.

## Endpoints

- `GET /health` — health check
- `GET /conditions` — NOAA tides + NWS marine forecast
- `GET /reports?species=salmon&location=ocean` — fishing report search results
- `GET /all?species=salmon&location=ocean` — all data in one call

## Environment Variables

Set these in Railway dashboard under Variables:

| Variable | Description |
|---|---|
| `BRAVE_API_KEY` | Brave Search API key (free tier at brave.com/search/api) |

## Species options
`salmon`, `halibut`, `rockfish`, `seabass`, `crab`

## Location options
`ocean`, `bay`

{
  "name": "sf-fishing-backend",
  "version": "1.0.0",
  "description": "SF Bay Area fishing conditions API",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "node-fetch": "^2.7.0",
    "cors": "^2.8.5"
  }
}

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function formatTime(t) {
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr), m = parseInt(mStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function excerpt(text, maxLen = 200) {
  if (!text) return '';
  const clean = stripHtml(text).replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#\d+;/g,'');
  return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
}

async function fetchTides() {
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;
  try {
    const [hiloRes, hourlyRes] = await Promise.all([
      fetch(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=sf_fishing&begin_date=${dateStr}&end_date=${dateStr}&datum=MLLW&station=9414290&time_zone=lst_ldt&interval=hilo&units=english&format=json`),
      fetch(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=sf_fishing&begin_date=${dateStr}&end_date=${dateStr}&datum=MLLW&station=9414290&time_zone=lst_ldt&interval=h&units=english&format=json`)
    ]);
    const hiloData = await hiloRes.json();
    const hourlyData = await hourlyRes.json();
    const events = (hiloData.predictions || []).map(p => ({
      type: p.type === 'H' ? 'High' : 'Low',
      time: formatTime(p.t.split(' ')[1]),
      ft: parseFloat(parseFloat(p.v).toFixed(1))
    }));
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
    return { events, tide_now_ft: tideNow, tide_now_label: tideLabel };
  } catch (e) {
    console.error('Tide error:', e.message);
    return { events: [], tide_now_ft: null, tide_now_label: '' };
  }
}

async function fetchWeather() {
  try {
    const res = await fetch('https://api.weather.gov/zones/forecast/PZZ530/forecast', {
      headers: { 'User-Agent': 'SFBayFishingApp/1.0 (fishing-app@example.com)' }
    });
    const data = await res.json();
    const periods = data.properties?.periods || [];
    let windKts = null, windDir = null, swellFt = null, summary = '';
    for (const period of periods) {
      const txt = period.detailedForecast || period.shortForecast || '';
      if (windKts === null) {
        const wm = txt.match(/(\d+)\s*(?:to\s*(\d+))?\s*knots?/i);
        const dm = txt.match(/\b(N|NE|NNE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b/);
        if (wm) windKts = wm[2] ? Math.round((parseInt(wm[1])+parseInt(wm[2]))/2) : parseInt(wm[1]);
        if (dm) windDir = dm[1];
      }
      if (swellFt === null) {
        const sm = txt.match(/(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/i);
        if (sm) swellFt = sm[2] ? Math.round((parseFloat(sm[1])+parseFloat(sm[2]))/2*10)/10 : parseFloat(sm[1]);
      }
      if (!summary && period.name) summary = `${period.name}: ${txt.slice(0,220)}`;
      if (windKts !== null && swellFt !== null) break;
    }
    return { wind_kts: windKts, wind_dir: windDir, swell_ft: swellFt, forecast_summary: summary };
  } catch (e) {
    console.error('Weather error:', e.message);
    return { wind_kts: null, wind_dir: null, swell_ft: null, forecast_summary: '' };
  }
}

async function fetchReports(species) {
  const results = [];
  if (['salmon','halibut'].includes(species)) {
    try {
      const res = await fetch('http://www.wackyjacky.com/reports.html', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FishingApp/1.0)' }
      });
      const html = await res.text();
      const snip = excerpt(html, 400);
      if (snip && snip.length > 30) results.push({ source: 'Wacky Jacky', snippet: snip, url: 'http://www.wackyjacky.com/reports.html' });
    } catch(e) { console.error('Wacky Jacky:', e.message); }
  }
  if (['salmon','halibut','rockfish'].includes(species)) {
    try {
      const res = await fetch('https://www.hulicat.com/fishing-reports/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FishingApp/1.0)' }
      });
      const html = await res.text();
      const bodyMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
      const snip = excerpt(bodyMatch ? bodyMatch[1] : html, 350);
      if (snip && snip.length > 30) results.push({ source: 'Huli Cat', snippet: snip, url: 'https://www.hulicat.com/fishing-reports/' });
    } catch(e) { console.error('Huli Cat:', e.message); }
  }
  if (species === 'crab') {
    try {
      const res = await fetch('https://wildlife.ca.gov/Fishing/Ocean/Crab/Dungeness', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FishingApp/1.0)' }
      });
      const html = await res.text();
      const bodyMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      if (bodyMatch) results.push({ source: 'CDFW Dungeness Crab', snippet: excerpt(bodyMatch[1], 400), url: 'https://wildlife.ca.gov/Fishing/Ocean/Crab/Dungeness' });
    } catch(e) { console.error('CDFW crab:', e.message); }
  }
  return results.slice(0, 4);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), port: PORT });
});

app.get('/conditions', async (req, res) => {
  try {
    const [tides, weather] = await Promise.all([fetchTides(), fetchWeather()]);
    res.json({ ...tides, ...weather, fetched_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/reports', async (req, res) => {
  const species = req.query.species || 'salmon';
  try {
    const reports = await fetchReports(species);
    res.json({ reports, fetched_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/all', async (req, res) => {
  const species = req.query.species || 'salmon';
  try {
    const [tides, weather, reports] = await Promise.all([fetchTides(), fetchWeather(), fetchReports(species)]);
    res.json({ ...tides, ...weather, reports, fetched_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SF Fishing API running on 0.0.0.0:${PORT}`);
});
