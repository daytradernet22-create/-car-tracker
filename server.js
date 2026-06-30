const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');
const fs      = require('fs');

const app = express();
app.use(cors({
  origin: [
    /\.netlify\.app$/,
    /\.netlify\.com$/,
    'http://localhost:3001',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    process.env.ALLOWED_ORIGIN || ''
  ].filter(Boolean),
  credentials: true
}));
app.use(express.json());

// ─── API KEYS (set as environment variables on Railway) ──────────
// In Railway dashboard: Settings → Variables → Add these:
//   SCRAPEOPS_KEY = your scrapeops key
//   GEMINI_KEY_1  = your first gemini key
//   GEMINI_KEY_2  = your second gemini key (optional)
const SCRAPEOPS_KEY = process.env.SCRAPEOPS_KEY || '';
// ─── GEMINI API KEYS ─────────────────────────────────────────────
const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1 || '',
  process.env.GEMINI_KEY_2 || '',
].filter(k => k.length > 0); // remove empty keys
let geminiKeyIndex = 0;

function getGeminiKey() {
  return GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
}

function rotateGeminiKey(reason) {
  const oldIdx = geminiKeyIndex;
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_KEYS.length;
  console.log(`Gemini key rotated (${reason}): key[${oldIdx}] → key[${geminiKeyIndex}]`);
}

function isRateLimitError(err) {
  const msg = (err.response?.data?.error?.message || err.message || '').toLowerCase();
  const status = err.response?.status;
  return status === 429 || msg.includes('quota') || msg.includes('rate') || msg.includes('limit') || msg.includes('exhausted');
}
// Get free Gemini key: https://aistudio.google.com/app/apikey
// ─────────────────────────────────────────────────────────────────

// Fetch page through ScrapeOps (renders JS)
async function fetchPage(url) {
  const isMobileDe = url.includes('mobile.de');
  // mobile.de needs extra wait time and specific headers
  const params = new URLSearchParams({
    api_key: SCRAPEOPS_KEY,
    url: url,
    render_js: 'true',
    residential: 'true',
    country: 'de',
    wait: isMobileDe ? '5000' : '3000',   // extra wait for mobile.de
    ...(isMobileDe ? { 'bypass': 'generic_level_2' } : {})
  });
  const proxy = `https://proxy.scrapeops.io/v1/?${params.toString()}`;
  const resp = await axios.get(proxy, { timeout: 90000 });
  return resp.data;
}

// Strip HTML to readable text
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

// Extract image URLs from raw HTML
function extractImages(html, url) {
  const seen = new Set();
  const results = [];
  const site = url || '';

  function tryAdd(src) {
    if (!src || typeof src !== 'string') return;
    src = src.split('?')[0]; // strip query params for dedup
    if (!src.startsWith('http')) return;
    if (seen.has(src)) return;
    if (/logo|icon|avatar|flag|sprite|banner|tracking|pixel|\.svg|\.gif|spinner|placeholder/i.test(src)) return;
    seen.add(src);
    results.push(src);
  }

  // ── 1. Site-specific JSON data (most reliable, correct order) ────

  // AutoScout24 — images in __NEXT_DATA__
  if (site.includes('autoscout24')) {
    const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nd) {
      try {
        const json = JSON.parse(nd[1]);
        const imgs = json?.props?.pageProps?.listingDetails?.images
                  || json?.props?.pageProps?.vehicle?.images
                  || [];
        imgs.forEach(img => {
          const src = img?.src || img?.url || img?.uri || (typeof img === 'string' ? img : '');
          tryAdd(src);
        });
      } catch(e) {}
    }
  }

  // Carvago — images in __NEXT_DATA__
  if (site.includes('carvago')) {
    const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nd) {
      try {
        const json = JSON.parse(nd[1]);
        const car  = json?.props?.pageProps?.car || json?.props?.pageProps?.vehicle || {};
        const imgs = car.images || car.photos || car.gallery || [];
        imgs.forEach(img => {
          const src = img?.url || img?.src || img?.uri || (typeof img === 'string' ? img : '');
          tryAdd(src);
        });
      } catch(e) {}
    }
  }

  // mobile.de — images embedded as JSON array in script tags
  if (site.includes('mobile.de')) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const s of scripts) {
      const src_text = s[1];
      // Look for image URLs in JSON blobs
      const imgUrls = [...src_text.matchAll(/"(https:\/\/[^"]*(?:cdn|img|image|photo|media)[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/gi)];
      imgUrls.forEach(m => tryAdd(m[1]));
      if (results.length >= 10) break;
    }
  }

  // ── 2. og:image meta tags (usually the main hero photo) ──────────
  const ogMatches = [...html.matchAll(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/gi),
                     ...html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/gi)];
  ogMatches.forEach(m => tryAdd(m[1]));

  // ── 3. img tags with data-src / src (lazy-loaded) ────────────────
  const imgMatches = html.matchAll(/<img[^>]+>/gi);
  for (const m of imgMatches) {
    if (results.length >= 10) break;
    const tag = m[0];
    // Extract src, data-src, data-lazy, data-original in priority order
    const srcMatch = tag.match(/data-src=["']([^"']+)["']/)
                  || tag.match(/data-lazy=["']([^"']+)["']/)
                  || tag.match(/data-original=["']([^"']+)["']/)
                  || tag.match(/(?:^|\s)src=["']([^"']+)["']/);
    if (!srcMatch) continue;
    let src = srcMatch[1].split('?')[0];
    if (!src.match(/\.(jpg|jpeg|png|webp)$/i)) continue;
    tryAdd(src);
  }

  // ── 4. Any leftover JPG/PNG/WEBP URLs in script tags ─────────────
  if (results.length < 5) {
    const urlMatches = html.matchAll(/"(https:\/\/[^"]{10,200}\.(?:jpg|jpeg|png|webp))"/gi);
    for (const m of urlMatches) {
      if (results.length >= 10) break;
      tryAdd(m[1].split('?')[0]);
    }
  }

  return results.slice(0, 10);
}

// ─── ENDPOINT ─────────────────────────────────────────────────────
app.post('/extract', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  console.log('\n--- Extract ---', url);

  // Step 1: ScrapeOps
  let html;
  try {
    html = await fetchPage(url);
    fs.writeFileSync('debug-last.html', html);
    console.log('ScrapeOps OK — HTML:', html.length, 'chars');
  } catch (err) {
    const msg = err.response?.data || err.message;
    console.error('ScrapeOps error:', msg);
    return res.status(500).json({ error: 'Failed to fetch page: ' + msg });
  }

  const pageText  = htmlToText(html);
  const imageUrls = extractImages(html, url);
  console.log('Text:', pageText.length, 'chars | Photos:', imageUrls.length);

  // Try to extract VIN from URL (some sites include it)
  let vinFromUrl = null;
  const vinMatch = url.match(/[A-HJ-NPR-Z0-9]{17}/);
  if (vinMatch) { vinFromUrl = vinMatch[0].toUpperCase(); console.log('VIN from URL:', vinFromUrl); }

  // Step 2: Gemini 2.0 Flash
  try {
    const prompt = `You are extracting structured car data from a European car listing page.

URL: ${url}

Page text:
${pageText}

Respond ONLY with a valid JSON object. No markdown, no explanation, nothing else before or after the JSON.

{
  "make": string or null,
  "model": string or null,
  "mileage": number (km) or null,
  "hp": number or null,
  "regMonth": number 1-12 or null,
  "regYear": number or null,
  "gear": "Автомат" or "Механика" or null,
  "fuel": "Бензин" or "Дизель" or "Электро" or "Гибрид" or "Газ" or null,
  "cc": number (cm3) or null,
  "priceNetto": number (EUR, no VAT) or null,
  "priceBrutto": number (EUR, with VAT) or null,
  "location": string (full address with ZIP code if available, e.g. "10115 Berlin, Deutschland") or null,
  "seller": string or null,
  "vin": string (look for any 17-character alphanumeric code labeled VIN, ФИН, Fahrzeugidentifikationsnummer, Ident. Nr — extract exactly) or null
}`;

    // Try all keys, rotate on rate limit
    let text = '';
    let lastErr = null;
    const maxAttempts = GEMINI_KEYS.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = getGeminiKey();
      console.log(`Gemini attempt ${attempt + 1}/${maxAttempts} with key[${geminiKeyIndex}]`);
      try {
        const geminiResp = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 8192, response_mime_type: 'application/json' }
          },
          { timeout: 30000 }
        );
        text = geminiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        console.log('Gemini success with key[' + geminiKeyIndex + ']:', text.slice(0, 200));
        lastErr = null;
        break; // success — stop trying
      } catch (err) {
        lastErr = err;
        if (isRateLimitError(err) && GEMINI_KEYS.length > 1) {
          rotateGeminiKey('rate limit');
          continue; // try next key
        }
        throw err; // non-rate-limit error — fail immediately
      }
    }

    if (lastErr) {
      const msg = lastErr.response?.data?.error?.message || lastErr.message;
      console.error('All Gemini keys exhausted:', msg);
      return res.status(429).json({ error: 'Все Gemini API ключи исчерпали лимит. Добавьте ещё ключей в server.js.' });
    }

    const data = JSON.parse(text);
    if (!data.vin && vinFromUrl) data.vin = vinFromUrl;
    data.photos = imageUrls;
    res.json({ ok: true, data });

  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error('Gemini error:', msg);
    res.status(500).json({ error: 'Extraction failed: ' + msg });
  }
});

app.get('/ping', (req, res) => res.json({ ok: true }));
app.get('/debug', (req, res) => {
  if (fs.existsSync('debug-last.html')) {
    res.setHeader('Content-Type', 'text/html');
    res.send(fs.readFileSync('debug-last.html'));
  } else {
    res.send('No debug file yet — do an extract first.');
  }
});

// Expose Gemini key to frontend (so it's set in one place — this file)
app.get('/gemini-key', (req, res) => {
  res.json({ key: getGeminiKey(), keyIndex: geminiKeyIndex, totalKeys: GEMINI_KEYS.length });
});

// ─── EUR/RUB RATE from myfin.by — StatusBank "Купить" ────────────
let cachedRate = null;
let cacheTime  = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — once per day

app.get('/rate', async (req, res) => {
  // Return cached rate if fresh
  if (cachedRate && (Date.now() - cacheTime) < CACHE_TTL) {
    return res.json({ rate: cachedRate, source: 'myfin.by/StatusBank', cached: true });
  }

  try {
    const url = 'https://myfin.by/currency/eurrub';
    const proxy = `https://proxy.scrapeops.io/v1/?api_key=${SCRAPEOPS_KEY}&url=${encodeURIComponent(url)}&render_js=true&residential=true&country=by`;
    const resp  = await axios.get(proxy, { timeout: 30000 });
    const html  = resp.data;
    const $     = cheerio.load(html);

    let rate = null;

    // ── Strategy 1: find table headers to know which column is "Купить" ──
    // myfin.by table: Банк | Купить | Продать (or Купить | Сдать)
    let buyColIndex = -1;

    // Find header row to determine Купить column index
    $('thead tr, tr').first().find('th, td').each(function(i) {
      const txt = $(this).text().trim().toLowerCase();
      if (txt.includes('купить') || txt.includes('buy') || txt === 'покупка') {
        buyColIndex = i;
      }
    });

    // Also try table headers anywhere
    if (buyColIndex === -1) {
      $('th').each(function() {
        const txt = $(this).text().trim().toLowerCase();
        if (txt.includes('купить') || txt === 'покупка') {
          buyColIndex = $(this).index();
        }
      });
    }

    console.log('Buy column index:', buyColIndex);

    // ── Strategy 2: find StatusBank row, pick correct cell ────────────
    $('tr').each(function() {
      if (rate) return; // already found
      const cells = $(this).find('td');
      const rowText = $(this).text();

      if (!/статусбанк|statusbank/i.test(rowText)) return;

      console.log('Found StatusBank row:', rowText.slice(0, 200));

      if (buyColIndex > 0 && cells.length > buyColIndex) {
        // Use the identified Купить column
        const val = cells.eq(buyColIndex).text().trim().replace(',', '.');
        const num = parseFloat(val);
        if (num > 50 && num < 200) { rate = num; return; }
      }

      // Fallback: get all numbers in row, Купить is usually index 1 (after bank name)
      const nums = rowText.match(/\d+[.,]\d+/g);
      if (nums && nums.length >= 1) {
        // Column order on myfin.by: name | Купить | Продать
        // So nums[0] = Купить, nums[1] = Продать
        const val = parseFloat(nums[0].replace(',', '.'));
        if (val > 50 && val < 200) rate = val;
      }
    });

    // ── Strategy 3: JSON embedded in page scripts ─────────────────────
    if (!rate) {
      // myfin.by often embeds rate data as JSON in <script> tags
      $('script').each(function() {
        if (rate) return;
        const src = $(this).html() || '';
        // Look for StatusBank buy rate in JSON
        const patterns = [
          /"name"\s*:\s*"[^"]*[Сс]татус[^"]*"[\s\S]{0,300}?"buy"\s*:\s*([\d.]+)/i,
          /"buy"\s*:\s*([\d.]+)[\s\S]{0,200}"name"\s*:\s*"[^"]*[Сс]татус/i,
          /[Сс]татусБанк[\s\S]{0,200}?"buyRate"\s*:\s*([\d.]+)/i,
          /"bankName"\s*:\s*"[^"]*[Сс]татус[^"]*"[\s\S]{0,300}?"buy"\s*:\s*([\d.]+)/i,
        ];
        for (const pat of patterns) {
          const m = src.match(pat);
          if (m) { const v = parseFloat(m[1]); if (v > 50 && v < 200) { rate = v; break; } }
        }
      });
    }

    // ── Strategy 4: raw HTML regex ────────────────────────────────────
    if (!rate) {
      // Try to find buy rate near StatusBank mention, before the sell rate
      const m = html.match(/[Сс]татус[Бб]анк[\s\S]{0,100}?(\d{2,3}[.,]\d{2,4})/i);
      if (m) { const v = parseFloat(m[1].replace(',','.')); if (v > 50 && v < 200) rate = v; }
    }

    if (!rate || rate < 50 || rate > 200) {
      console.log('Rate not found in HTML. HTML length:', html.length);
      console.log('HTML sample:', html.slice(0, 500));
      // Return last cached rate or fallback
      if (cachedRate) return res.json({ rate: cachedRate, source: 'myfin.by/StatusBank (cached-old)', cached: true });
      return res.status(500).json({ error: 'Rate not found', htmlLength: html.length, sample: html.slice(0,300) });
    }

    cachedRate = rate;
    cacheTime  = Date.now();
    console.log('EUR/RUB rate fetched:', rate);
    res.json({ rate, source: 'myfin.by/StatusBank' });

  } catch (err) {
    console.error('Rate fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ADVANCED SEARCH ─────────────────────────────────────────────
// POST /advanced-search
// { make, model, yearFrom, yearTo, priceFrom, priceTo, mileageTo,
//   fuel, trans, hpFrom, hpTo, equipment: 'basic'|'good'|'top' }
app.post('/advanced-search', async (req, res) => {
  const p = req.body;
  console.log('\n--- Advanced Search ---', p);

  // ── Step 1: Gemini — get trim names for equipment level ──────────
  let trims = [];
  try {
    const equipMap = { basic: 'Базовая (base/entry trim)', good: 'Хорошая (mid/comfort trim)', top: 'Топ (top/fully-loaded trim)' };
    const equipLabel = equipMap[p.equipment] || p.equipment;
    const trimPrompt = `You are a European car market expert.
For a ${p.make} ${p.model} (years ${p.yearFrom||'any'}-${p.yearTo||'any'}), list the EXACT official trim level names and equipment package names that correspond to "${equipLabel}" level.
Include German/European market names as sold in Germany, France, Netherlands, Belgium, Poland, Czech Republic.
Return ONLY a JSON array of strings — the exact trim/package names used in listings.
Example: ["Sport Line", "Luxury Line", "Avantgarde"]
Max 6 items. Be specific, no generic descriptions.`;

    const geminiResp = await callGemini(trimPrompt, null);
    const trimText = geminiResp.replace(/\`\`\`json|\`\`\`/g,'').trim();
    trims = JSON.parse(trimText);
    if (!Array.isArray(trims)) trims = [];
    console.log('Trims for', p.equipment, ':', trims);
  } catch(e) {
    console.error('Trim lookup failed:', e.message);
    trims = [];
  }

  // ── Step 2: Build URLs for ALL sites ───────────────────────────
  const directUrls = [];

  // Helpers
  const enc = s => encodeURIComponent(s||'');
  const sl  = s => (s||'').toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  const hpToKw = hp => hp ? Math.round(hp * 0.7355) : null;
  const addQ = (arr, val, str) => { if(val) arr.push(str); };

  // ── mobile.de ────────────────────────────────────────────────────
  try {
    const mdeData = require('./mobilede-codes.json');
    const mdeMakes = mdeData.makes || mdeData;
    const mdeMake = mdeMakes[(p.make||'').toLowerCase()];
    const mdeq = ['isSearchRequest=true','s=Car','vc=Car'];
    if (mdeMake) mdeq.push('ms='+mdeMake.code+';;');
    if (p.yearFrom&&p.yearTo) mdeq.push('fr='+p.yearFrom+'%3A'+p.yearTo);
    else if (p.yearFrom) mdeq.push('fr='+p.yearFrom);
    else if (p.yearTo)   mdeq.push('fr=%3A'+p.yearTo);
    if (p.mileageTo) mdeq.push('ml=%3A'+p.mileageTo);
    if (p.ccFrom||p.ccTo) mdeq.push('cc='+enc((p.ccFrom||'')+':'+(p.ccTo||'')));
    if (p.fuel)  mdeq.push('ft='+(p.fuel==='diesel'?'DIESEL':'PETROL'));
    if (p.trans) mdeq.push('tr='+(p.trans==='automatic'?'AUTOMATIC_GEAR':'MANUAL_GEAR'));
    if (p.priceFrom&&p.priceTo) mdeq.push('p='+p.priceFrom+'%3A'+p.priceTo);
    else if (p.priceFrom) mdeq.push('p='+p.priceFrom+'%3A');
    else if (p.priceTo)   mdeq.push('p=%3A'+p.priceTo);
    const kwFrom=hpToKw(p.hpFrom), kwTo=hpToKw(p.hpTo);
    if (kwFrom||kwTo) mdeq.push('pw='+enc((kwFrom||'')+':'+(kwTo||'')));
    if (trims.length) mdeq.push('freetextfield='+enc(trims[0]));
    directUrls.push('https://www.mobile.de/ru/%D1%82%D1%80%D0%B0%D0%BD%D1%81%D0%BF%D0%BE%D1%80%D1%82%D0%BD%D1%8B%D0%B5-%D1%81%D1%80%D0%B5%D0%B4%D1%81%D1%82%D0%B2%D0%B0/%D0%BF%D0%BE%D0%B8%D1%81%D0%BA.html?'+mdeq.join('&'));
  } catch(e) { console.log('mobile.de build error:', e.message); }

  // ── autoscout24.ru ───────────────────────────────────────────────
  let as24url = 'https://www.autoscout24.ru/lst';
  if (p.make) as24url += '/'+sl(p.make);
  if (p.make&&p.model) as24url += '/'+sl(p.model);
  const as24q = ['atype=C','cy=D%2CA%2CB%2CE%2CF%2CI%2CL%2CNL','ustate=N%2CU','sort=standard'];
  addQ(as24q, p.yearFrom, 'fregfrom='+p.yearFrom);
  addQ(as24q, p.yearTo,   'fregto='+p.yearTo);
  addQ(as24q, p.mileageTo,'kmto='+p.mileageTo);
  addQ(as24q, p.priceFrom,'pricefrom='+p.priceFrom);
  addQ(as24q, p.priceTo,  'priceto='+p.priceTo);
  if (p.trans) as24q.push('gear='+(p.trans==='automatic'?'A':'M'));
  if (p.fuel)  as24q.push('fuel='+(p.fuel==='diesel'?'D':'B'));
  if (p.hpFrom||p.hpTo) { as24q.push('powertype=hp'); addQ(as24q,p.hpFrom,'powerfrom='+p.hpFrom); addQ(as24q,p.hpTo,'powerto='+p.hpTo); }
  directUrls.push(as24url+'?'+as24q.join('&'));

  // ── autobid.de/ru ────────────────────────────────────────────────
  const abq = ['sortingType=auctionStartDate-ASCENDING'];
  if (p.make)  abq.push('manufacturer='+enc(p.make));
  if (p.model) abq.push('name-model='+enc(p.model));
  addQ(abq, p.yearFrom,  'registrationFrom='+p.yearFrom);
  addQ(abq, p.yearTo,    'registrationTo='+p.yearTo);
  addQ(abq, p.mileageTo, 'kilometresTo='+p.mileageTo);
  addQ(abq, p.priceFrom, 'priceFrom='+p.priceFrom);
  addQ(abq, p.priceTo,   'priceTo='+p.priceTo);
  if (p.fuel)  abq.push('e17='+(p.fuel==='diesel'?'3':'2'));
  if (p.trans) abq.push('e70='+(p.trans==='automatic'?'3':'2'));
  const abKwFrom=hpToKw(p.hpFrom), abKwTo=hpToKw(p.hpTo);
  if (abKwFrom) abq.push('powerOutputFrom='+abKwFrom);
  if (abKwTo)   abq.push('powerOutputTo='+abKwTo);
  directUrls.push('https://autobid.de/ru/rezultaty-poiska?'+abq.join('&'));

  // ── auto1.com/ru ─────────────────────────────────────────────────
  const a1q = ['channel=24h','dir=asc','powerUnit=hp','sort=relevanceSorting'];
  if (p.make) a1q.push('manufacturers='+enc(p.make));
  addQ(a1q, p.mileageTo, 'mileageTo='+p.mileageTo);
  addQ(a1q, p.yearFrom,  'regFrom='+p.yearFrom);
  addQ(a1q, p.yearTo,    'regTo='+p.yearTo);
  addQ(a1q, p.hpFrom,   'powerFrom='+p.hpFrom);
  addQ(a1q, p.hpTo,     'powerTo='+p.hpTo);
  addQ(a1q, p.priceFrom,'priceMin='+p.priceFrom);
  addQ(a1q, p.priceTo,  'priceMax='+p.priceTo);
  if (p.fuel)  a1q.push('fuelTypes='+(p.fuel==='diesel'?'diesel':'petrol'));
  if (p.trans) a1q.push('gearTypes='+(p.trans==='automatic'?'automatic':'manual'));
  directUrls.push('https://www.auto1.com/ru/app/merchant/cars?'+a1q.join('&'));

  // ── otomoto.pl ───────────────────────────────────────────────────
  let otoUrl = 'https://www.otomoto.pl/osobowe';
  if (p.make)  otoUrl += '/'+sl(p.make);
  if (p.make&&p.model) otoUrl += '/'+sl(p.model).replace(/\s+/g,'-');
  const otoq = [];
  addQ(otoq, p.yearFrom,  'search%5Bfilter_float_year%3Afrom%5D='+p.yearFrom);
  addQ(otoq, p.yearTo,    'search%5Bfilter_float_year%3Ato%5D='+p.yearTo);
  addQ(otoq, p.priceFrom, 'search%5Bfilter_float_price%3Afrom%5D='+p.priceFrom);
  addQ(otoq, p.priceTo,   'search%5Bfilter_float_price%3Ato%5D='+p.priceTo);
  addQ(otoq, p.mileageTo, 'search%5Bfilter_float_mileage%3Ato%5D='+p.mileageTo);
  addQ(otoq, p.hpFrom,    'search%5Bfilter_float_engine_power%3Afrom%5D='+p.hpFrom);
  addQ(otoq, p.hpTo,      'search%5Bfilter_float_engine_power%3Ato%5D='+p.hpTo);
  if (p.fuel)  otoq.push('search%5Bfilter_enum_fuel_type%5D='+(p.fuel==='diesel'?'diesel':'petrol'));
  if (p.trans) otoq.push('search%5Bfilter_enum_gearbox%5D='+(p.trans==='automatic'?'automatic':'manual'));
  directUrls.push(otoUrl+(otoq.length?'?'+otoq.join('&'):''));

  // ── carvago.com ──────────────────────────────────────────────────
  let carvUrl = 'https://carvago.com/cars';
  if (p.make) carvUrl += '/'+sl(p.make);
  if (p.make&&p.model) carvUrl += '/'+sl(p.model);
  const cvq = [];
  addQ(cvq, p.yearFrom,  'registration-date-from='+p.yearFrom);
  addQ(cvq, p.yearTo,    'registration-date-to='+p.yearTo);
  addQ(cvq, p.mileageTo, 'mileage-to='+p.mileageTo);
  addQ(cvq, p.priceFrom, 'price-from='+p.priceFrom);
  addQ(cvq, p.priceTo,   'price-to='+p.priceTo);
  const cvKwFrom=hpToKw(p.hpFrom), cvKwTo=hpToKw(p.hpTo);
  if (cvKwFrom) cvq.push('power-from='+cvKwFrom);
  if (cvKwTo)   cvq.push('power-to='+cvKwTo);
  addQ(cvq, p.ccFrom, 'cubic-capacity-from='+p.ccFrom);
  addQ(cvq, p.ccTo,   'cubic-capacity-to='+p.ccTo);
  if (p.fuel)  cvq.push('fuel-type[]='+(p.fuel==='diesel'?'diesel':'petrol'));
  if (p.trans) cvq.push('transmission[]='+(p.trans==='automatic'?'automatic':'manual'));
  directUrls.push(carvUrl+(cvq.length?'?'+cvq.join('&'):''));

  // ── ecarstrade.com ───────────────────────────────────────────────
  const ecq = [];
  if (p.make)  ecq.push('brand%5B%5D='+enc(p.make));
  if (p.model) ecq.push('model%5B%5D='+enc(p.model));
  if (p.fuel)  ecq.push('fuel%5B%5D='+(p.fuel==='diesel'?'Diesel':p.fuel==='electro'?'Electric':'Petrol'));
  if (p.trans) ecq.push('gearbox%5B%5D='+(p.trans==='automatic'?'Automatic':'Manual'));
  addQ(ecq, p.mileageTo, 'kilom_to='+p.mileageTo);
  addQ(ecq, p.yearFrom,  'year_from='+p.yearFrom);
  addQ(ecq, p.yearTo,    'year_to='+p.yearTo);
  addQ(ecq, p.priceFrom, 'price_from='+p.priceFrom);
  addQ(ecq, p.priceTo,   'price_to='+p.priceTo);
  addQ(ecq, p.hpFrom,    'power_from='+p.hpFrom);
  addQ(ecq, p.hpTo,      'power_to='+p.hpTo);
  directUrls.push('https://ru.ecarstrade.com/search'+(ecq.length?'?'+ecq.join('&'):''));

  // ── marktplaats.nl ───────────────────────────────────────────────
  const MCODES = {'skoda':'1186','renault':'1128','bmw':'31','mercedes-benz':'744',
    'audi':'20','volkswagen':'1270','ford':'461','opel':'909','toyota':'1206',
    'honda':'541','hyundai':'556','kia':'638','volvo':'1276','peugeot':'963',
    'citroen':'183','seat':'1067','fiat':'441','nissan':'872','mazda':'760',
    'mini':'813','land rover':'660','porsche':'980','lexus':'693',
    'mitsubishi':'829','dacia':'210','suzuki':'1147','alfa romeo':'14'};
  const mk2 = (p.make||'').toLowerCase().trim();
  const makeCode = MCODES[mk2] || '';
  const fuelCode = p.fuel==='diesel'?'384':(p.fuel?'473':'');
  const fuelWord = p.fuel==='diesel'?'diesel':(p.fuel?'benzine':'');
  let mpPath = 'https://www.marktplaats.nl/l/auto-s/';
  if (p.make) mpPath += sl(p.make)+'/';
  const fSeg = [];
  if (p.model) fSeg.push(sl(p.model));
  if (fuelWord) fSeg.push(fuelWord);
  if (fSeg.length) {
    mpPath += 'f/'+fSeg.join('+')+'/';
    const codes2 = [];
    if (makeCode) codes2.push(makeCode);
    if (fuelCode) codes2.push(fuelCode);
    if (codes2.length) mpPath += codes2.join('+')+'/';
  }
  const mph = [];
  addQ(mph, p.yearFrom,  'constructionYearFrom:'+p.yearFrom);
  addQ(mph, p.yearTo,    'constructionYearTo:'+p.yearTo);
  addQ(mph, p.mileageTo, 'mileageTo:'+p.mileageTo);
  if (p.priceFrom) mph.push('PriceCentsFrom:'+(parseInt(p.priceFrom)*100));
  if (p.priceTo)   mph.push('PriceCentsTo:'+(parseInt(p.priceTo)*100));
  addQ(mph, p.ccFrom, 'engineDisplacementFrom:'+p.ccFrom);
  addQ(mph, p.ccTo,   'engineDisplacementTo:'+p.ccTo);
  if (p.trans) mph.push('transmission:'+(p.trans==='automatic'?'Automaat':'Handgeschakeld'));
  directUrls.push(mpPath+(mph.length?'#'+mph.join('|'):''));

  // ── usedautobank.com/ru ──────────────────────────────────────────
  const UAB_MAKES = {"alfa romeo":"22","aston martin":"25","audi":"36","bentley":"74",
    "bmw":"85","byd":"2741","chevrolet":"2774","chrysler":"120","citroen":"148",
    "cupra":"2588","dacia":"1178","ferrari":"219","fiat":"228","ford":"231",
    "honda":"356","hyundai":"384","infiniti":"403","isuzu":"418","jaguar":"437",
    "jeep":"1233","kia":"454","lamborghini":"472","land rover":"480","lexus":"495",
    "maserati":"539","mazda":"555","mercedes-benz":"589","mg":"2629","mini":"652",
    "mitsubishi":"658","nissan":"692","opel":"1051","peugeot":"740","polestar":"2575",
    "porsche":"793","renault":"806","rolls-royce":"808","saab":"811","seat":"1180",
    "skoda":"1188","smart":"819","subaru":"821","suzuki":"839","tesla":"1751",
    "toyota":"861","volkswagen":"901","volvo":"930"};
  const ubMakeId = UAB_MAKES[(p.make||'').toLowerCase().trim()] || '';
  const ubq = ['at%5B%5D=open','at%5B%5D=sealed','at%5B%5D=fixed'];
  if (ubMakeId) ubq.push('make='+ubMakeId);
  addQ(ubq, p.yearFrom,  'year_from='+p.yearFrom);
  addQ(ubq, p.yearTo,    'year_to='+p.yearTo);
  if (p.fuel)  ubq.push('fuel='+(p.fuel==='diesel'?'Diesel':'Gasoline'));
  if (p.trans) ubq.push('gearbox='+(p.trans==='automatic'?'Automatic':'Manual'));
  addQ(ubq, p.ccFrom,    'capacity_from='+p.ccFrom);
  addQ(ubq, p.ccTo,      'capacity_to='+p.ccTo);
  addQ(ubq, p.mileageTo, 'mileage_to='+p.mileageTo);
  ubq.push('price_min='+(p.priceFrom||''));
  ubq.push('price_max='+(p.priceTo||''));
  directUrls.push('https://www.usedautobank.com/ru/advanced-search/?'+ubq.join('&')+'#search_results');

  console.log('Built', directUrls.length, 'direct site URLs');

  // 1 Google search for any other sites
  const fuelMap2 = { petrol:'Benzin', diesel:'Diesel', electro:'Elektro', hybrid:'Hybrid' };
  const googleQ = '"'+(p.make||'')+'" "'+(p.model||'')+'" '
    + (trims.length ? '"'+trims[0]+'" ' : '')
    + (p.yearFrom||'') + ' '
    + (p.priceTo ? 'bis '+p.priceTo+'EUR ' : '')
    + (fuelMap2[p.fuel]||'') + ' gebraucht -site:.co.uk -inurl:forum -inurl:blog -inurl:wiki';
  const queries = [googleQ];

  // ── Step 3: Fetch direct site URLs + 1 Google search ────────────
  const rawLinks = [];
  const seen = new Set();

  // Add direct site URLs first (guaranteed correct model)
  directUrls.forEach(u => { if (!seen.has(u)) { seen.add(u); rawLinks.push(u); } });
  console.log('Direct URLs:', rawLinks.length);

  // Then do 1 Google search for other sites
  for (const query of queries.slice(0, 1)) {
    try {
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=de&hl=de&num=10&pws=0`;
      const proxyUrl = `https://proxy.scrapeops.io/v1/?api_key=${SCRAPEOPS_KEY}&url=${encodeURIComponent(googleUrl)}&render_js=false&residential=true&country=de`;
      const resp = await axios.get(proxyUrl, { timeout: 45000 });
      const html = resp.data;
      fs.writeFileSync('debug-google.html', html);

      const $ = cheerio.load(html);
      let found = 0;

      // Google returns direct https:// links — skip google.com/support/nav links
      // Result links are in <a> tags inside result containers
      // Key: filter out google.com own links, keep only external sites
      const skipDomains = ['google.com','google.de','google.ru','googleapis.com',
        'gstatic.com','youtube.com','googletagmanager.com','accounts.google'];

      $('a[href]').each(function() {
        const href = $(this).attr('href') || '';

        // Pattern 1: direct https:// link to external site
        if (href.startsWith('https://') || href.startsWith('http://')) {
          const skip = skipDomains.some(d => href.includes(d));
          if (!skip && !seen.has(href)) {
            seen.add(href); rawLinks.push(href); found++;
          }
          return;
        }

        // Pattern 2: /url?q=URL (older Google format)
        const m = href.match(/[?&]q=(https?[^&]+)/);
        if (m) {
          try {
            const url = decodeURIComponent(m[1]);
            if (!seen.has(url) && !skipDomains.some(d => url.includes(d))) {
              seen.add(url); rawLinks.push(url); found++;
            }
          } catch(e) {}
        }
      });

      // Also check data-url and data-href attributes
      $('[data-url],[data-href]').each(function() {
        const url = $(this).attr('data-url') || $(this).attr('data-href') || '';
        if (url.startsWith('http') && !skipDomains.some(d => url.includes(d)) && !seen.has(url)) {
          seen.add(url); rawLinks.push(url); found++;
        }
      });

      console.log('Query:', query.slice(0,70), '→', found, 'new links (total:', rawLinks.length + ')');
    } catch(e) {
      console.error('Search error:', e.message);
    }
  }

  if (rawLinks.length === 0) {
    return res.json({ ok: true, trims, results: [], message: 'Ничего не найдено. Попробуйте другие параметры.' });
  }

  // ── Step 4: Basic URL filter (no AI verification) ───────────────
  const blockedDomains = ['wikipedia','youtube','facebook','instagram','twitter',
    'reddit','quora','medium.com','blogspot','wordpress','.co.uk',
    'autotrader.co.uk','gumtree.com','pistonheads.com','community','forum','skodacommunity'];
  const blockedPaths = ['/news/','/blog/','/review/','/wiki/','/forum/','/about/','/contact/'];

  const results = rawLinks.filter(url => {
    const lower = url.toLowerCase();
    if (blockedDomains.some(d => lower.includes(d))) return false;
    if (blockedPaths.some(pt => lower.includes(pt))) return false;
    return true;
  });
  console.log('Final results:', results.length);

    res.json({ ok: true, trims, results });
});

// ─── GEMINI HELPER ────────────────────────────────────────────────
async function callGemini(prompt, imageData) {
  const maxAttempts = GEMINI_KEYS.length;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = getGeminiKey();
    try {
      const parts = [{ text: prompt }];
      if (imageData) parts.push({ inlineData: imageData });
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        {
          contents:[{ parts }],
          generationConfig:{
            temperature:0,
            maxOutputTokens:2048,
            // only force JSON mime when no image (image+JSON mime causes 503)
            ...(imageData ? {} : { responseMimeType:'application/json' })
          }
        },
        { timeout: 30000 }
      );
      return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch(err) {
      lastErr = err;
      if (isRateLimitError(err) && GEMINI_KEYS.length > 1) { rotateGeminiKey('rate limit'); continue; }
      throw err;
    }
  }
  throw lastErr;
}

// ─── CAR LIST STORAGE ────────────────────────────────────────────
// Uses Railway persistent volume if mounted, falls back to local file
const CARS_FILE = process.env.CARS_FILE || (process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH + '/cars-data.json'
  : './cars-data.json');
console.log('Cars storage path:', CARS_FILE);

function loadCarsFromFile() {
  try {
    if (fs.existsSync(CARS_FILE)) {
      return JSON.parse(fs.readFileSync(CARS_FILE, 'utf8'));
    }
  } catch(e) { console.error('Load cars error:', e.message); }
  return [];
}

function saveCarsToFile(cars) {
  try {
    fs.writeFileSync(CARS_FILE, JSON.stringify(cars, null, 2));
    return true;
  } catch(e) { console.error('Save cars error:', e.message); return false; }
}

// GET /cars — load all cars
app.get('/cars', (req, res) => {
  const cars = loadCarsFromFile();
  res.json({ ok: true, cars });
});

// POST /cars — save all cars (full replace)
app.post('/cars', (req, res) => {
  const { cars } = req.body;
  if (!Array.isArray(cars)) return res.status(400).json({ error: 'cars must be array' });
  const ok = saveCarsToFile(cars);
  res.json({ ok, count: cars.length });
});

// POST /cars/add — add single car
app.post('/cars/add', (req, res) => {
  const car = req.body;
  if (!car || !car.id) return res.status(400).json({ error: 'invalid car' });
  const cars = loadCarsFromFile();
  // Replace if exists, else add
  const idx = cars.findIndex(c => c.id === car.id);
  if (idx >= 0) cars[idx] = car;
  else cars.unshift(car);
  saveCarsToFile(cars);
  res.json({ ok: true, count: cars.length });
});

// PUT /cars/:id — update single car field
app.put('/cars/:id', (req, res) => {
  const cars = loadCarsFromFile();
  const idx = cars.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'car not found' });
  cars[idx] = { ...cars[idx], ...req.body };
  saveCarsToFile(cars);
  res.json({ ok: true, car: cars[idx] });
});

// DELETE /cars/:id — delete single car
app.delete('/cars/:id', (req, res) => {
  let cars = loadCarsFromFile();
  const before = cars.length;
  cars = cars.filter(c => c.id !== req.params.id);
  saveCarsToFile(cars);
  res.json({ ok: true, deleted: before - cars.length });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Car Tracker running on port', PORT));