const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── NOAA Tides ────────────────────────────────────────────────────────────────
async function fetchTides() {
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=sf_fishing&begin_date=${dateStr}&end_date=${dateStr}&datum=MLLW&station=9414290&time_zone=lst_ldt&interval=hilo&units=english&format=json`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const predictions = data.predictions || [];
    const events = predictions.map(p => ({
      type: p.type === 'H' ? 'High' : 'Low',
      time: formatTime(p.t.split(' ')[1]),
      ft: parseFloat(parseFloat(p.v).toFixed(1))
    }));

    // Find current tide height (hourly)
    const hourlyUrl = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=sf_fishing&begin_date=${dateStr}&end_date=${dateStr}&datum=MLLW&station=9414290&time_zone=lst_ldt&interval=h&units=english&format=json`;
    const hRes = await fetch(hourlyUrl);
    const hData = await hRes.json();
    const hourly = hData.predictions || [];
    const now = new Date();
    let closest = null, minDiff = Infinity;
    for (const p of hourly) {
      const t = new Date(p.t.replace(' ', 'T'));
      const diff = Math.abs(t - now);
      if (diff < minDiff) { minDiff = diff; closest = p; }
    }
    const tideNow = closest ? parseFloat(parseFloat(closest.v).toFixed(1)) : null;

    // Determine tide direction
    let tideLabel = '';
    if (closest && hourly.length > 1) {
      const idx = hourly.indexOf(closest);
      if (idx > 0) {
        const prev = parseFloat(hourly[idx-1].v);
        const curr = parseFloat(closest.v);
        tideLabel = curr > prev ? 'incoming' : 'outgoing';
      }
    }

    return { events, tide_now_ft: tideNow, tide_now_label: tideLabel };
  } catch (e) {
    console.error('Tide fetch error:', e.message);
    return { events: [], tide_now_ft: null, tide_now_label: '' };
  }
}

function formatTime(t) {
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr), m = parseInt(mStr);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}

// ── NWS Marine Forecast ───────────────────────────────────────────────────────
async function fetchWeather() {
  try {
    const res = await fetch('https://api.weather.gov/zones/forecast/PZZ530/forecast', {
      headers: { 'User-Agent': 'SFBayFishingApp/1.0 (contact@example.com)' }
    });
    const data = await res.json();
    const periods = data.properties?.periods || [];

    let windKts = null, windDir = null, swellFt = null, summary = '';

    for (const period of periods) {
      const txt = period.detailedForecast || period.shortForecast || '';

      if (windKts === null) {
        const wm = txt.match(/(\d+)\s*(?:to\s*(\d+))?\s*knots?/i);
        const dm = txt.match(/\b(N|NE|NNE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b/);
        if (wm) windKts = wm[2] ? Math.round((parseInt(wm[1]) + parseInt(wm[2])) / 2) : parseInt(wm[1]);
        if (dm) windDir = dm[1];
      }

      if (swellFt === null) {
        const sm = txt.match(/(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?))?\s*(?:ft|feet)/i);
        if (sm) swellFt = sm[2] ? Math.round((parseFloat(sm[1]) + parseFloat(sm[2])) / 2 * 10) / 10 : parseFloat(sm[1]);
      }

      if (!summary && period.name) {
        summary = `${period.name}: ${txt.slice(0, 200)}`;
      }

      if (windKts !== null && swellFt !== null) break;
    }

    return { wind_kts: windKts, wind_dir: windDir, swell_ft: swellFt, forecast_summary: summary };
  } catch (e) {
    console.error('Weather fetch error:', e.message);
    return { wind_kts: null, wind_dir: null, swell_ft: null, forecast_summary: '' };
  }
}

// ── Fishing Reports ───────────────────────────────────────────────────────────
async function fetchFishingReports(species, location) {
  const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
  if (!BRAVE_API_KEY) return { reports: [], error: 'No search API key configured' };

  const today = new Date();
  const month = today.toLocaleString('en-US', { month: 'long' });
  const year = today.getFullYear();

  const queries = {
    salmon: `SF Bay Area salmon fishing report ${month} ${year} "channel buoys" OR "middle grounds" OR "west buoy" OR "Rocky Point" OR Duxbury OR Pacifica OR Farallones`,
    halibut: location === 'bay'
      ? `San Francisco Bay halibut fishing report ${month} ${year} Raccoon Strait Angel Island Treasure Island`
      : `San Francisco ocean halibut fishing report ${month} ${year} Potato Patch Pacifica`,
    rockfish: `San Francisco Bay Area rockfish lingcod fishing report ${month} ${year} Farallon Islands Pt Bonita`,
    seabass: `white seabass fishing report San Francisco Bay Area ${month} ${year} kelp Pt Reyes Marin`,
    crab: `Dungeness crab season San Francisco ${month} ${year} open closed domoic acid`
  };

  const q = queries[species] || queries.salmon;

  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5&freshness=pm`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY
      }
    });
    const data = await res.json();
    const results = (data.web?.results || []).map(r => ({
      source: r.meta_url?.hostname?.replace('www.','') || r.title,
      title: r.title,
      snippet: r.description,
      url: r.url
    }));
    return { reports: results };
  } catch (e) {
    console.error('Search error:', e.message);
    return { reports: [], error: e.message };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
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
  const location = req.query.location || 'ocean';
  try {
    const data = await fetchFishingReports(species, location);
    res.json({ ...data, fetched_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/all', async (req, res) => {
  const species = req.query.species || 'salmon';
  const location = req.query.location || 'ocean';
  try {
    const [tides, weather, reportsData] = await Promise.all([
      fetchTides(),
      fetchWeather(),
      fetchFishingReports(species, location)
    ]);
    res.json({
      ...tides,
      ...weather,
      reports: reportsData.reports,
      fetched_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`SF Fishing API running on port ${PORT}`));
