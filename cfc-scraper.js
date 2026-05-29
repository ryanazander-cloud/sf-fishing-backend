const fetch = require('node-fetch');

const CFC_BASE = 'https://forums.coastsidefishingclub.com';
const CFC_LOGIN_URL = CFC_BASE + '/login/login';
const CFC_REPORTS_URL = CFC_BASE + '/forums/saltwater-fishing-reports.7/';
const CFC_BAY_URL = CFC_BASE + '/forums/san-francisco-bay-and-delta.22/';

// Cache
var cfcCache = {
  cookie: null,
  cookieExpires: null,
  recentReports: null,
  recentReportsFetched: null,
  historicalSummary: null,
  historicalSummaryFetched: null
};

async function cfcLogin() {
  if (!process.env.CFC_USERNAME || !process.env.CFC_PASSWORD) {
    throw new Error('CFC credentials not configured');
  }

  // Return cached cookie if still valid (4 hour session)
  if (cfcCache.cookie && cfcCache.cookieExpires && new Date() < cfcCache.cookieExpires) {
    return cfcCache.cookie;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': CFC_BASE + '/login'
  };

  // First get the login page to grab CSRF token
  const loginPageRes = await fetch(CFC_BASE + '/login/', { headers: { 'User-Agent': headers['User-Agent'] } });
  const loginHtml = await loginPageRes.text();

  // Extract _xfToken
  const tokenMatch = loginHtml.match(/name="_xfToken"\s+value="([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : '';
  const initCookies = loginPageRes.headers.get('set-cookie') || '';

  // Submit login form
  const body = new URLSearchParams({
    login: process.env.CFC_USERNAME,
    password: process.env.CFC_PASSWORD,
    remember: '1',
    _xfToken: token,
    _xfRedirect: CFC_BASE + '/'
  });

  const loginRes = await fetch(CFC_LOGIN_URL, {
    method: 'POST',
    headers: Object.assign({}, headers, { 'Cookie': initCookies }),
    body: body.toString(),
    redirect: 'manual'
  });

  const setCookie = loginRes.headers.get('set-cookie') || '';
  if (!setCookie || setCookie.length < 10) {
    throw new Error('CFC login failed — check credentials');
  }

  // Extract session cookies
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
    // Normalize: strip /latest, /unread, /page-N suffixes
    url = url.replace(/\/(latest|unread|page-\d+)\/?$/, '/');
    if (!url.endsWith('/')) url += '/';
    // Skip non-thread links
    if (!url.includes('/threads/')) continue;
    if (!seen.has(url)) { seen.add(url); links.push(url); }
  }
  return links;
}

function extractPostContent(html) {
  const posts = [];

  // XenForo 2: messages are in article.message elements
  const articleRe = /<article[^>]*data-author="([^"]*)"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = articleRe.exec(html)) !== null) {
    const author = m[1].trim();
    const inner = m[2];

    // Date from time element
    const dateMatch = inner.match(/datetime="([^"]+)"/);
    const date = dateMatch ? dateMatch[1].slice(0, 10) : '';

    // Post text from bbWrapper div
    const bbMatch = inner.match(/<div[^>]*class="[^"]*bbWrapper[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (bbMatch) {
      const text = bbMatch[1]
        .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '') // strip quotes
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim();
      if (text.length > 30) posts.push({ user: author || 'Member', date, text: text.slice(0, 800) });
    }
  }

  // Fallback: look for any bbWrapper if no articles found
  if (!posts.length) {
    const bbRe = /<div[^>]*class="[^"]*bbWrapper[^"]*"[^>]*>([\s\S]{50,2000}?)<\/div>/gi;
    while ((m = bbRe.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      if (text.length > 50) posts.push({ user: 'Member', date: '', text: text.slice(0,800) });
      if (posts.length >= 5) break;
    }
  }

  return posts;
}

async function scrapeForumPage(url, cookie) {
  const html = await fetchCFCPage(url, cookie);
  const links = extractThreadLinks(html).slice(0, 8);
  const reports = [];
  for (const link of links) {
    try {
      const threadHtml = await fetchCFCPage(link, cookie);
      const posts = extractPostContent(threadHtml);
      const titleMatch = threadHtml.match(/<h1[^>]*class="[^"]*p-title-value[^"]*"[^>]*>([^<]{3,100})</i);
      const title = titleMatch ? titleMatch[1].trim() : link.split('/').slice(-1)[0].replace(/-/g,' ');
      if (posts.length) {
        reports.push({
          title: title,
          url: link,
          date: posts[0].date,
          author: posts[0].user,
          content: posts[0].text,
          section: url.includes('bay') ? 'Bay' : 'Saltwater',
          replies: posts.slice(1, 3).map(function(p) { return { user: p.user, date: p.date, text: p.text }; })
        });
      }
    } catch(e) { console.error('CFC thread error:', e.message); }
    if (reports.length >= 6) break;
  }
  return reports;
}

async function getRecentReports() {
  // Return cached if less than 2 hours old
  if (cfcCache.recentReports && cfcCache.recentReportsFetched &&
      (Date.now() - cfcCache.recentReportsFetched) < 2 * 60 * 60 * 1000) {
    return cfcCache.recentReports;
  }

  const cookie = await cfcLogin();

  // Scrape both saltwater and bay forums in parallel
  const [saltwaterReports, bayReports] = await Promise.all([
    scrapeForumPage(CFC_REPORTS_URL, cookie),
    scrapeForumPage(CFC_BAY_URL, cookie)
  ]);

  const reports = saltwaterReports.concat(bayReports).slice(0, 12);
  cfcCache.recentReports = reports;
  cfcCache.recentReportsFetched = Date.now();
  return reports;
}

async function getHistoricalSummary(anthropicKey) {
  // Return cached if less than 7 days old
  if (cfcCache.historicalSummary && cfcCache.historicalSummaryFetched &&
      (Date.now() - cfcCache.historicalSummaryFetched) < 7 * 24 * 60 * 60 * 1000) {
    return cfcCache.historicalSummary;
  }

  const cookie = await cfcLogin();
  const allReports = [];

  // Scrape pages 1-8 to get ~2 seasons of history
  for (let page = 1; page <= 8; page++) {
    const url = CFC_REPORTS_URL + '?page=' + page;
    const html = await fetchCFCPage(url, cookie);
    const links = extractThreadLinks(html).slice(0, 10);
    for (const link of links) {
      try {
        const threadHtml = await fetchCFCPage(link, cookie);
        const posts = extractPostContent(threadHtml);
        const titleMatch = threadHtml.match(/<h1[^>]*class="[^"]*p-title-value[^"]*"[^>]*>([^<]+)</i);
        const title = titleMatch ? titleMatch[1].trim() : '';
        if (posts.length) {
          allReports.push({ title, date: posts[0].date, content: posts[0].text });
        }
      } catch(e) { /* skip */ }
    }
    // Small delay to be polite
    await new Promise(function(r) { setTimeout(r, 500); });
  }

  if (!allReports.length) throw new Error('No historical reports found');

  // Ask Claude to synthesize patterns
  const reportText = allReports.map(function(r) {
    return '[' + r.date + '] ' + r.title + ': ' + r.content.slice(0, 300);
  }).join('\n\n');

  const prompt = 'You are analyzing historical SF Bay Area fishing reports from the Coastside Fishing Club to identify seasonal and tactical patterns. Here are reports spanning the last 2 seasons:\n\n' + reportText.slice(0, 15000) + '\n\nPlease synthesize the key patterns into a structured summary covering:\n1. SEASONAL TIMING: When do salmon, halibut, rockfish typically show up at which spots by month?\n2. PRODUCTIVE SPOTS: Which spots are mentioned most often and under what conditions?\n3. TIDE PATTERNS: What tide phases consistently produce at which locations?\n4. DEPTH AND TECHNIQUE: What depths and methods are most commonly reported as productive?\n5. WATER CONDITIONS: What temperature, clarity, or bait conditions correlate with good fishing?\n6. BEST MONTHS: What are historically the best months for each species?\n\nBe specific, cite patterns you see in multiple reports, and note any trends. This will be used to improve daily fishing recommendations.';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
  });
  const d = await resp.json();
  const summary = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : '';

  cfcCache.historicalSummary = summary;
  cfcCache.historicalSummaryFetched = Date.now();
  return summary;
}

async function debugFetch(url) {
  const cookie = await cfcLogin();
  const html = await fetchCFCPage(url, cookie);
  // Extract all href links
  const links = (html.match(/href="([^"]+)"/gi) || []).slice(0, 50).map(function(m) { return m.match(/href="([^"]+)"/i)[1]; });
  // Check if logged in
  const loggedIn = html.includes('data-logged-in="true"');
  return { loggedIn, htmlLength: html.length, links, htmlSnippet: html.slice(0, 500) };
}

module.exports = { getRecentReports, getHistoricalSummary, cfcLogin, debugFetch };
