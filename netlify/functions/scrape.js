const https = require("https");
const zlib  = require("zlib");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function randUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function buildURLs(keyword, location, page) {
  const slug = k => k.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return [
    `https://www.yellowpages.com.au/search/listings?clue=${encodeURIComponent(keyword)}&locationClue=${encodeURIComponent(location)}&pageNumber=${page}`,
    `https://www.yellowpages.com.au/find/${slug(keyword)}/${slug(location)}?pageNumber=${page}`,
    `https://www.yellowpages.com.au/search/listings?clue=${encodeURIComponent(keyword)}&locationClue=${encodeURIComponent(location)}&page=${page}`,
  ];
}

function fetchURL(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": randUA(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.yellowpages.com.au/",
        "Cache-Control": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
      },
      timeout: 25000,
    };

    const req = https.get(url, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith("http")
          ? res.headers.location
          : "https://www.yellowpages.com.au" + res.headers.location;
        return resolve(fetchURL(loc, attempt));
      }
      if ([403, 429, 503].includes(res.statusCode) && attempt < 3) {
        return setTimeout(() => resolve(fetchURL(url, attempt + 1)), (attempt + 1) * 4000);
      }

      const chunks = [];
      let stream = res;
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      if (enc === "gzip")    stream = res.pipe(zlib.createGunzip());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());

      stream.on("data", c => chunks.push(c));
      stream.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });
    req.on("error", err => {
      if (attempt < 2) setTimeout(() => resolve(fetchURL(url, attempt + 1)), 2000);
      else reject(err);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function parseListings(html, fields) {
  const leads = [];
  const strip = s => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const decode = s => s.replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">");

  let sections = html.split(/(?=<(?:div|li|article)[^>]+(?:data-listing-id|class="[^"]*(?:listing-result|organic|natural)[^"]*")[^>]*>)/i);
  if (sections.length < 3) {
    sections = html.split(/(?=<div[^>]+class="[^"]*listing[^"]*"[^>]*>)/i);
  }

  for (const sec of sections) {
    if (sec.length < 80) continue;
    if (!sec.match(/listing-name|business-name|tel:|listing-contact/i)) continue;

    const lead = {};

    if (fields.includes("name")) {
      const m = sec.match(/class="[^"]*listing-name[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,100})/i)
             || sec.match(/<h[123][^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,100})/i);
      lead["Business Name"] = m ? decode(m[1].trim()) : "";
    }
    if (fields.includes("phone")) {
      const m = sec.match(/href="tel:([^"]+)"/i);
      lead["Phone"] = m ? m[1].replace("tel:","").trim() : "";
    }
    if (fields.includes("website")) {
      const m = sec.match(/href="(https?:\/\/(?!(?:www\.)?yellowpages\.com\.au)[^"]{5,})"[^>]*(?:class="[^"]*(?:website|visit|external)[^"]*"|data-[a-z]+=["'][^"']*website[^"']*["'])/i);
      lead["Website"] = m ? m[1].trim() : "";
    }
    if (fields.includes("address")) {
      const m = sec.match(/class="[^"]*(?:listing-address|address)[^"]*"[^>]*>([\s\S]{3,300}?)<\/(?:p|div|span)/i);
      lead["Address"] = m ? decode(strip(m[1])) : "";
    }
    if (fields.includes("suburb")) {
      const m = sec.match(/\b([A-Z][a-zA-Z '\-]{1,30}),?\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b(?:\s+(\d{4}))?/);
      lead["Suburb/State"] = m ? `${m[1].trim()}, ${m[2]}${m[3] ? " " + m[3] : ""}` : "";
    }
    if (fields.includes("category")) {
      const m = sec.match(/class="[^"]*categor[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,80})/i);
      lead["Category"] = m ? decode(m[1].trim()) : "";
    }
    if (fields.includes("email")) {
      const m = sec.match(/href="mailto:([^"?&]+)"/i);
      lead["Email"] = m ? m[1].trim() : "";
    }
    if (fields.includes("yp_url")) {
      const m = sec.match(/href="(\/[a-z][^"?#]{10,}\/[^"?#]{3,}(?:\.htm)?)"[^>]*class="[^"]*listing-name/i)
             || sec.match(/class="[^"]*listing-name[^"]*"[^>]*href="(\/[^"?#]{10,})"/i);
      lead["YP Listing URL"] = m ? "https://www.yellowpages.com.au" + m[1] : "";
    }

    if (lead["Business Name"] && lead["Business Name"].length > 1) leads.push(lead);
  }

  const seen = new Set();
  return leads.filter(l => {
    const k = (l["Business Name"] || "").toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const keyword  = (body.keyword  || "").trim();
  const location = (body.location || "").trim();
  const pages    = Math.min(parseInt(body.pages) || 1, 10);
  const fields   = body.fields || ["name","phone","website","address","suburb"];

  if (!keyword || !location) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "keyword and location required" }) };
  }

  const allLeads = [], errors = [], debugInfo = [];

  for (let page = 1; page <= pages; page++) {
    const urls = buildURLs(keyword, location, page);
    let success = false;

    for (const url of urls) {
      try {
        const { status, body: html } = await fetchURL(url);
        debugInfo.push(`Page ${page}: ${url} → HTTP ${status} (${html.length} bytes)`);

        if (status === 200 && html.length > 1000) {
          const leads = parseListings(html, fields);
          allLeads.push(...leads);
          debugInfo.push(`Page ${page}: parsed ${leads.length} leads`);
          success = true;
          break;
        } else {
          debugInfo.push(`Page ${page}: got status ${status}, trying next URL`);
        }
      } catch(e) {
        debugInfo.push(`Page ${page}: ${url} → Error: ${e.message}`);
      }
    }

    if (!success) errors.push(`Page ${page}: could not fetch results (YP AU may be blocking)`);
    if (page < pages) await sleep(3000 + Math.random() * 2000);
  }

  const seen = new Set();
  const uniqueLeads = allLeads.filter(l => {
    const k = (l["Business Name"] || "").toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ leads: uniqueLeads, total: uniqueLeads.length, pages, errors, debug: debugInfo }),
  };
};