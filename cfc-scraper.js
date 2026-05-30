const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const CFC_BASE = 'https://forums.coastsidefishingclub.com';
const CFC_SALTWATER_URL = CFC_BASE + '/forums/saltwater-fishing-reports.7/';
const CFC_BAY_URL = CFC_BASE + '/forums/san-francisco-bay-and-delta.22/';

// Cache file path - persists on Railway volume between deploys
const CACHE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp';
const HISTORICAL_CACHE_FILE = path.join(CACHE_DIR, 'cfc_historical.json');
const RECENT_CACHE_FILE = path.join(CACHE_DIR, 'cfc_recent.json');

// In-memory cache
var cfcCache = {
  cookie: null,
  cookieExpires: null,
  recentReports: null,
  recentReportsFetched: null,
  historicalSummary: null,
  historicalSummaryFetched: null
};

// Load persistent cache on startup
function loadPersistentCache() {
  try {
    if (fs.existsSync(HISTORICAL_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORICAL_CACHE_FILE, 'utf8'));
      cfcCache.historicalSummary = data.summary;
      cfcCache.historicalSummaryFetched = data.fetched;
      console.log('Loaded historical CFC cache from', HISTORICAL_CACHE_FILE);
    }
    if (fs.existsSync(RECENT_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(RECENT_CACHE_FILE, 'utf8'));
      // Only use if less than 3 hours old
      if (data.fetched && (Date.now() - data.fetched) < 3 * 60 * 60 * 1000) {
        cfcCache.recentReports = data.reports;
        cfcCache.recentReportsFetched = data.fetched;
        console.log('Loaded recent CFC cache from', RECENT_CACHE_FILE);
      }
    }
  } catch(e) { console.log('Cache load note:', e.message); }
}

function savePersistentCache(type, data) {
  try {
    if (type === 'historical') {
      fs.writeFileSync(HISTORICAL_CACHE_FILE, JSON.stringify({ summary: data, fetched: Date.now() }));
    } else if (type === 'recent') {
      fs.writeFileSync(RECENT_CACHE_FILE, JSON.stringify({ reports: data, fetched: Date.now() }));
    }
  } catch(e) { console.log('Cache save note:', e.message); }
}

loadPersistentCache();

async function cfcLogin() {
  if (!process.env.CFC_USERNAME || !process.env.CFC_PASSWORD) {
    throw new Error('CFC credentials not configured');
  }
  if (cfcCache.cookie && cfcCache.cookieExpires && new Date() < cfcCache.cookieExpires) {
    return cfcCache.cookie;
  }
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const loginPageRes = await fetch(CFC_BASE + '/login/', { headers: { 'User-Agent': ua } });
  const loginHtml = await loginPageRes.text();
  const tokenMatch = loginHtml.match(/name="_xfToken"\s+value="([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : '';
  const initCookies = loginPageRes.headers.get('set-cookie') || '';
  const body = new URLSearchParams({
    login: process.env.CFC_USERNAME,
    password: process.env.CFC_PASSWORD,
    remember: '1',
    _xfToken: token,
    _xfRedirect: CFC_BASE + '/'
  });
  const loginRes = await fetch(CFC_BASE + '/login/login', {
    method: 'POST',
    headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': initCookies, 'Referer': CFC_BASE + '/login' },
    body: body.toString(),
    redirect: 'manual'
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  if (!setCookie || setCookie.length < 10) throw new Error('CFC login failed — check credentials');
  const cookies = setCookie.split(',').map(function(c) { return c.split(';')[0].trim(); }).join('; ');
  cfcCache.cookie = cookies;
  cfcCache.cookieExpires = new Date(Date.now() + 4 * 60 * 60 * 1000);
  return cookies;
}

async function fetchCFCPage(url, cookie) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': cookie,
      'Referer': CFC_BASE
    }
  });
  return res.text();
}

function extractThreadLinks(html) {
  const matches = html.matchAll(/href="((?:https:\/\/forums\.coastsidefishingclub\.com)?\/threads\/[^"?#]+)"/gi);
  const links = [];
  const seen = new Set();
  for (const m of matches) {
    let url = m[1];
    if (!url.startsWith('http')) url = CFC_BASE + url;
    url = url.replace(/\/(latest|unread|page-\d+)\/?$/, '/');
    if (!url.endsWith('/')) url += '/';
    if (!url.includes('/threads/')) continue;
    if (!seen.has(url)) { seen.add(url); links.push(url); }
  }
  return links;
}

function extractPostContent(html) {
  const posts = [];
  const articleRe = /<article[^>]*data-author="([^"]*)"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = articleRe.exec(html)) !== null) {
    const author = m[1].trim();
    const inner = m[2];
    const dateMatch = inner.match(/datetime="([^"]+)"/);
    const date = dateMatch ? dateMatch[1].slice(0, 10) : '';
    const bbMatch = inner.match(/<div[^>]*class="[^"]*bbWrapper[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (bbMatch) {
      const text = bbMatch[1]
        .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim();
      if (text.length > 30) posts.push({ user: author || 'Member', date, text: text.slice(0, 800) });
    }
  }
  if (!posts.length) {
    const bbRe = /<div[^>]*class="[^"]*bbWrapper[^"]*"[^>]*>([\s\S]{50,2000}?)<\/div>/gi;
    while ((m = bbRe.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      if (text.length > 50) { posts.push({ user: 'Member', date: '', text: text.slice(0,800) }); }
      if (posts.length >= 5) break;
    }
  }
  return posts;
}

async function scrapeForumPage(url, cookie, section) {
  const html = await fetchCFCPage(url, cookie);
  const links = extractThreadLinks(html).slice(0, 8);
  const reports = [];
  for (const link of links) {
    try {
      const threadHtml = await fetchCFCPage(link, cookie);
      const posts = extractPostContent(threadHtml);
      const titleMatch = threadHtml.match(/<h1[^>]*class="[^"]*p-title-value[^"]*"[^>]*>([^<]{3,100})</i);
      const title = titleMatch ? titleMatch[1].trim() : link.split('/').slice(-2, -1)[0].replace(/-/g,' ');
      if (posts.length) {
        reports.push({
          title, url: link, date: posts[0].date, author: posts[0].user,
          content: posts[0].text, section: section,
          replies: posts.slice(1, 3).map(function(p) { return { user: p.user, date: p.date, text: p.text }; })
        });
      }
    } catch(e) { console.error('CFC thread error:', e.message); }
    if (reports.length >= 6) break;
  }
  return reports;
}

async function getRecentReports() {
  if (cfcCache.recentReports && cfcCache.recentReportsFetched &&
      (Date.now() - cfcCache.recentReportsFetched) < 2 * 60 * 60 * 1000) {
    return cfcCache.recentReports;
  }
  const cookie = await cfcLogin();
  const [saltwaterReports, bayReports] = await Promise.all([
    scrapeForumPage(CFC_SALTWATER_URL, cookie, 'Saltwater'),
    scrapeForumPage(CFC_BAY_URL, cookie, 'Bay')
  ]);
  const reports = saltwaterReports.concat(bayReports).slice(0, 12);
  cfcCache.recentReports = reports;
  cfcCache.recentReportsFetched = Date.now();
  savePersistentCache('recent', reports);
  return reports;
}

async function getHistoricalSummary(anthropicKey, forceRefresh) {
  // Return cached if less than 7 days old and not forcing refresh
  if (!forceRefresh && cfcCache.historicalSummary && cfcCache.historicalSummaryFetched &&
      (Date.now() - cfcCache.historicalSummaryFetched) < 7 * 24 * 60 * 60 * 1000) {
    return cfcCache.historicalSummary;
  }

  const cookie = await cfcLogin();
  const allReports = [];
  console.log('Starting CFC historical scrape...');

  // Scrape both forums, 50 pages each
  // Strategy: extract thread titles + dates from forum index pages (fast, no per-thread fetch)
  // Then fetch full content for a sample of the most recent/relevant threads
  for (const forumConfig of [
    { url: CFC_SALTWATER_URL, section: 'Saltwater' },
    { url: CFC_BAY_URL, section: 'Bay' }
  ]) {
    const threadMeta = []; // titles + dates from index pages

    for (let page = 1; page <= 50; page++) {
      try {
        const url = forumConfig.url + (page > 1 ? '?page=' + page : '');
        const html = await fetchCFCPage(url, cookie);

        // Parse each structItem block — title, date, AND preview text if available
        const itemMatches = html.matchAll(/<div[^>]*class="[^"]*structItem[^"]*"[^>]*>([\s\S]*?)<\/article>/gi);
        for (const im of itemMatches) {
          const block = im[1];
          // Title and URL
          const titleM = block.match(/<div[^>]*class="[^"]*structItem-title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(\/threads\/[^"]+)"[^>]*>([^<]{3,120})<\/a>/i);
          if (!titleM) continue;
          const threadUrl = CFC_BASE + titleM[1].replace(/\/(latest|unread)\/?$/, '/');
          const title = titleM[2].trim();
          // Date
          const dateM = block.match(/datetime="([^"]+)"/);
          const date = dateM ? dateM[1].slice(0,10) : '';
          // Preview text (XenForo sometimes shows snippet)
          const previewM = block.match(/<div[^>]*class="[^"]*structItem-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
          let preview = '';
          if (previewM) {
            preview = previewM[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 200);
          }
          // Skip non-fishing threads
          if (/test posting|introduce yourself/i.test(title)) continue;
          threadMeta.push({ url: threadUrl, title, date, section: forumConfig.section, preview });
        }
        // Fallback: simpler title extraction if structItem parsing found nothing
        if (!threadMeta.length || threadMeta[threadMeta.length-1].section !== forumConfig.section) {
          const simpleTitles = html.matchAll(/<a[^>]*href="(\/threads\/[^"?#]+)"[^>]*class="[^"]*">([^<]{5,120})<\/a>/gi);
          const simpleDates = Array.from(html.matchAll(/datetime="([^"]+)"/gi)).map(function(m){return m[1].slice(0,10);});
          let si = 0;
          for (const m of simpleTitles) {
            const u = CFC_BASE + m[1].replace(/\/(latest|unread)\/?$/,'/');
            if (!threadMeta.find(function(t){return t.url===u;})) {
              threadMeta.push({url:u, title:m[2].trim(), date:simpleDates[si]||'', section:forumConfig.section, preview:''});
              si++;
            }
          }
        }

        if (!html.includes('structItem-title')) break; // no items found, past last page
        console.log('CFC index: page', page, forumConfig.section, '— threads so far:', threadMeta.length);
        await new Promise(function(r) { setTimeout(r, 150); });
      } catch(e) {
        console.error('CFC index page error:', e.message);
        break;
      }
    }

    // Now fetch full content for up to 80 threads spread across time
    // Sample evenly from the full date range for good seasonal coverage
    const sampled = [];
    if (threadMeta.length <= 80) {
      sampled.push(...threadMeta);
    } else {
      const step = Math.floor(threadMeta.length / 80);
      for (let i = 0; i < threadMeta.length; i += step) sampled.push(threadMeta[i]);
    }

    console.log('CFC fetching', sampled.length, 'threads for', forumConfig.section);
    if (global.historicalBuildStatus) global.historicalBuildStatus.progress = 'Fetching content for ' + sampled.length + ' ' + forumConfig.section + ' threads...';
    for (const meta of sampled) {
      // Use index page preview if substantial enough — avoids per-thread fetch
      if (meta.preview && meta.preview.length > 80) {
        allReports.push({ title: meta.title, date: meta.date, section: meta.section, content: meta.preview });
        continue;
      }
      try {
        const threadHtml = await fetchCFCPage(meta.url, cookie);
        const posts = extractPostContent(threadHtml);
        if (posts.length) {
          allReports.push({
            title: meta.title,
            date: posts[0].date || meta.date,
            section: meta.section,
            content: posts[0].text.slice(0, 350)
          });
        }
        await new Promise(function(r) { setTimeout(r, 150); });
      } catch(e) { /* skip */ }
    }
    console.log('CFC historical', forumConfig.section, 'complete:', allReports.length, 'total');
  }

  console.log('CFC historical scrape complete:', allReports.length, 'reports');
  if (!allReports.length) throw new Error('No historical reports found');

  // Sort by date
  allReports.sort(function(a,b) { return a.date.localeCompare(b.date); });

  // Build structured text for Claude
  const reportText = allReports.map(function(r) {
    return '[' + r.date + '] [' + r.section + '] ' + r.title + ': ' + r.content;
  }).join('\n\n');

  const prompt = 'You are analyzing ' + allReports.length + ' historical fishing reports from the Coastside Fishing Club (SF Bay Area) to identify seasonal and tactical patterns. These reports span multiple seasons.\n\nREPORTS:\n' + reportText.slice(0, 18000) + '\n\nSynthesize the key patterns into a structured summary. Be specific — cite actual spots, months, depths, and techniques that appear repeatedly.\n\n1. SEASONAL TIMING BY SPECIES\n- Salmon: which months produce at which spots? When do fish typically arrive/depart?\n- Halibut: peak months in Bay vs ocean? Best tide phases?\n- Rockfish/Lingcod: any seasonal patterns at Farallones vs nearshore reefs?\n- Dungeness Crab: season timing and productive areas?\n- Tuna: when do albacore/bluefin typically show up offshore?\n\n2. TOP PRODUCING SPOTS (ranked by frequency of mentions)\nList the most mentioned spots and what conditions make them produce.\n\n3. TIDE & CURRENT PATTERNS\nWhat tide phases produce at which locations? Any slack water patterns?\n\n4. SUCCESSFUL TECHNIQUES BY SEASON\nWhat baits, depths, and methods appear most in successful reports by month?\n\n5. WATER CONDITION INDICATORS\nWhat bait fish presence, water temp, or other conditions correlate with good fishing?\n\n6. NOTABLE TRENDS\nAnything that stands out across multiple seasons — improving/declining fisheries, shifting patterns?\n\nThis summary will be injected into daily AI fishing briefings to improve spot and timing recommendations.';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await resp.json();
  if (d.error) throw new Error('Claude API error: ' + d.error.message);
  const summary = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : '';

  cfcCache.historicalSummary = summary;
  cfcCache.historicalSummaryFetched = Date.now();
  savePersistentCache('historical', summary);
  console.log('CFC historical summary generated:', summary.length, 'chars');

  // Also build weekly summaries from the raw reports
  console.log('Starting weekly summary build...');
  buildWeeklySummaries(anthropicKey, allReports).catch(function(e) {
    console.error('Weekly build error:', e.message);
  });

  return summary;
}

// Get week number (1-52) from a date string YYYY-MM-DD
function getWeekOfYear(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
}

// Get week label like "Jun 22 - Jun 28"
function getWeekLabel(week) {
  const d = new Date(2024, 0, 1); // use 2024 as reference (leap year)
  d.setDate(d.getDate() + (week - 1) * 7);
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  const fmt = function(dt) { return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  return fmt(d) + ' - ' + fmt(end);
}

// Build weekly index from raw reports
function buildWeeklyIndex(reports) {
  const weeks = {};
  for (const r of reports) {
    const week = getWeekOfYear(r.date);
    if (!week) continue;
    if (!weeks[week]) weeks[week] = [];
    weeks[week].push(r);
  }
  return weeks;
}

const WEEKLY_CACHE_FILE = path.join(CACHE_DIR, 'cfc_weekly.json');
var weeklyCache = null;

function loadWeeklyCache() {
  try {
    if (fs.existsSync(WEEKLY_CACHE_FILE)) {
      weeklyCache = JSON.parse(fs.readFileSync(WEEKLY_CACHE_FILE, 'utf8'));
      console.log('Loaded weekly CFC cache:', Object.keys(weeklyCache.summaries || {}).length, 'weeks');
    }
  } catch(e) { console.log('Weekly cache load note:', e.message); }
}
loadWeeklyCache();

async function buildWeeklySummaries(anthropicKey, rawReports) {
  const weeklyIndex = buildWeeklyIndex(rawReports);
  const summaries = {};
  const weeks = Object.keys(weeklyIndex).sort(function(a,b){return parseInt(a)-parseInt(b);});

  console.log('Building weekly summaries for', weeks.length, 'weeks...');

  for (const week of weeks) {
    const reports = weeklyIndex[week];
    if (reports.length < 2) {
      // Not enough data for this week — skip or use minimal summary
      summaries[week] = { label: getWeekLabel(parseInt(week)), count: reports.length, summary: null };
      continue;
    }

    const label = getWeekLabel(parseInt(week));
    const reportText = reports.map(function(r) {
      return '[' + r.date + '] [' + r.section + '] ' + r.title + ': ' + r.content;
    }).join('\n');

    try {
      const prompt = 'These are historical SF Bay Area fishing reports from the Coastside Fishing Club for the week of ' + label + ' across multiple years:\n\n' + reportText.slice(0, 6000) + '\n\nSynthesize what fishing was like during this week historically. Be specific and brief (150-200 words):\n- What species were being caught and where?\n- What depths, baits, techniques worked?\n- Any tide/current patterns mentioned?\n- How many fish (limits, counts) if mentioned?\n- Any notable conditions (water temp, bait presence, weather)?\n\nFormat as a concise paragraph a fisherman would find useful for planning a trip during this week.';

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
      });
      const d = await resp.json();
      const summary = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : null;
      summaries[week] = { label: label, count: reports.length, summary: summary, years: [...new Set(reports.map(function(r){return r.date.slice(0,4);}))].sort() };
      console.log('Weekly summary generated: week', week, '(' + label + ') —', reports.length, 'reports');
      // Small delay to avoid rate limiting
      await new Promise(function(r) { setTimeout(r, 200); });
    } catch(e) {
      console.error('Weekly summary error for week', week, ':', e.message);
      summaries[week] = { label: label, count: reports.length, summary: null };
    }
  }

  // Save to cache
  const cacheData = { summaries: summaries, built: Date.now(), report_count: rawReports.length };
  try { fs.writeFileSync(WEEKLY_CACHE_FILE, JSON.stringify(cacheData)); } catch(e) {}
  weeklyCache = cacheData;
  console.log('Weekly summaries complete:', Object.keys(summaries).length, 'weeks');
  return summaries;
}

function getWeeklySummary(targetDate) {
  if (!weeklyCache || !weeklyCache.summaries) return null;
  const week = getWeekOfYear(targetDate);
  if (!week) return null;
  // Check target week and adjacent weeks
  const results = [];
  for (let w = week - 1; w <= week + 1; w++) {
    if (w < 1 || w > 52) continue;
    const s = weeklyCache.summaries[w];
    if (s && s.summary) results.push(Object.assign({ week: w }, s));
  }
  return results;
}

async function debugFetch(url) {
  const cookie = await cfcLogin();
  const html = await fetchCFCPage(url, cookie);
  const links = (html.match(/href="([^"]+)"/gi) || []).slice(0, 50).map(function(m) { return m.match(/href="([^"]+)"/i)[1]; });
  const loggedIn = html.includes('data-logged-in="true"');
  return { loggedIn, htmlLength: html.length, links, htmlSnippet: html.slice(0, 500) };
}

module.exports = { getRecentReports, getHistoricalSummary, buildWeeklySummaries, getWeeklySummary, getWeekLabel, getWeekOfYear, cfcLogin, debugFetch };
