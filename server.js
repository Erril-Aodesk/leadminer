const https = require("https");
const zlib  = require("zlib");
const http  = require("http");

const ZENROWS_API_KEY = "780567355fbfcda661e405bd0a3a0b249c59c1a2";
const PORT = process.env.PORT || 3000;

function fetchViaZenRows(targetUrl, attempt = 0) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      apikey: ZENROWS_API_KEY,
      url: targetUrl,
      antibot: "true",
      premium_proxy: "true",
      proxy_country: "au",
    });
    const apiUrl = `https://api.zenrows.com/v1/?${params.toString()}`;
    const req = https.get(apiUrl, { timeout: 55000 }, res => {
      const chunks = [];
      let stream = res;
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      if (enc === "gzip")         stream = res.pipe(zlib.createGunzip());
      else if (enc === "br")      stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });
    req.on("error", err => {
      if (attempt < 2) setTimeout(() => resolve(fetchViaZenRows(targetUrl, attempt + 1)), 2000);
      else reject(err);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function parseListings(html, fields, keyword) {
  const leads = [];
  const strip  = s => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const decode = s => s.replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">");

  let sections = html.split(/(?=<div[^>]+class="[^"]*(?:listing-result|organic|natural|search-result)[^"]*")/i);
  if (sections.length < 3) sections = html.split(/(?=<div[^>]+class="[^"]*result[^"]*"[^>]*>)/i);

  for (const sec of sections) {
    if (sec.length < 100) continue;
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
      const m = sec.match(/href="(https?:\/\/(?!(?:www\.)?yellowpages\.com\.au)[^"]{5,})"[^>]*(?:class="[^"]*(?:website|visit|external|track-visit)[^"]*"|data-[a-z]+=[\"'][^"']*website[^"']*[\"'])/i)
             || sec.match(/(?:class="[^"]*(?:website|visit-website)[^"]*")[^>]*href="(https?:\/\/[^"]+)"/i);
      lead["Website"] = m ? m[1].trim() : "";
    }
    if (fields.includes("address")) {
      const m = sec.match(/class="[^"]*(?:listing-address|address|street-address)[^"]*"[^>]*>([\s\S]{3,300}?)<\/(?:p|div|span|address)>/i);
      lead["Address"] = m ? decode(strip(m[1])) : "";
    }
    if (fields.includes("suburb")) {
      const m = sec.match(/\b([A-Z][a-zA-Z '\-]{1,30}),?\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b(?:\s+(\d{4}))?/);
      lead["Suburb/State"] = m ? `${m[1].trim()}, ${m[2]}${m[3]?" "+m[3]:""}` : "";
    }
    if (fields.includes("category")) {
      const m = sec.match(/class="[^"]*(?:categor|business-type|listing-category)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,80})/i);
      lead["Category"] = m ? decode(m[1].trim()) : "";
    }
    if (fields.includes("email")) {
      const m = sec.match(/href="mailto:([^"?&]+)"/i);
      lead["Email"] = m ? m[1].trim() : "";
    }
    if (fields.includes("yp_url")) {
      const m = sec.match(/href="(\/[a-zA-Z0-9][^"?#]{10,})"\s*[^>]*class="[^"]*listing-name/i)
             || sec.match(/class="[^"]*listing-name[^"]*"[^>]*href="(\/[^"?#]{10,})"/i);
      lead["YP Listing URL"] = m ? "https://www.yellowpages.com.au"+m[1] : "";
    }

    if (lead["Business Name"] && lead["Business Name"].length > 1) leads.push(lead);
  }

  const stopWords = new Set(["and","the","for","with","firm","company","service","services","group","pty","ltd"]);
  const kwWords = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  let filtered = leads;
  if (kwWords.length > 0) {
    const f = leads.filter(l => {
      const hay = [l["Business Name"]||"", l["Category"]||""].join(" ").toLowerCase();
      return kwWords.some(w => hay.includes(w));
    });
    if (f.length > 0) filtered = f;
  }

  const seen = new Set();
  return filtered.filter(l => {
    const k = (l["Business Name"]||"").toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (req.method === "GET" && req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "3.0" }));
    return;
  }

  if (req.method === "POST" && req.url === "/html-dump") {
    let rawBody = "";
    req.on("data", c => rawBody += c);
    req.on("end", async () => {
      try {
        const body = JSON.parse(rawBody);
        const url = `https://www.yellowpages.com.au/search/listings?clue=${encodeURIComponent(body.keyword)}&locationClue=${encodeURIComponent(body.location)}&pageNumber=1`;
        const { status, body: html } = await fetchViaZenRows(url);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`STATUS: ${status}\nLENGTH: ${html.length}\n\n${html.substring(0, 15000)}`);
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method !== "POST" || req.url !== "/scrape") {
    res.writeHead(404); res.end(JSON.stringify({ error: "Not found" })); return;
  }

  let rawBody = "";
  req.on("data", c => rawBody += c);
  req.on("end", async () => {
    let body;
    try { body = JSON.parse(rawBody); }
    catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }

    const keyword  = (body.keyword  || "").trim();
    const location = (body.location || "").trim();
    const pages    = Math.min(parseInt(body.pages) || 1, 10);
    const fields   = body.fields || ["name","phone","website","address","suburb"];

    if (!keyword || !location) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "keyword and location required" }));
      return;
    }

    const allLeads = [], errors = [], debugInfo = [];

    for (let page = 1; page <= pages; page++) {
      const url = `https://www.yellowpages.com.au/search/listings?clue=${encodeURIComponent(keyword)}&locationClue=${encodeURIComponent(location)}&pageNumber=${page}`;
      debugInfo.push(`Page ${page}: fetching → ${url}`);
      try {
        const { status, body: html } = await fetchViaZenRows(url);
        debugInfo.push(`Page ${page}: HTTP ${status}, ${html.length} bytes`);
        if (status === 200 && html.length > 1000) {
          const leads = parseListings(html, fields, keyword);
          allLeads.push(...leads);
          debugInfo.push(`Page ${page}: parsed ${leads.length} leads`);
        } else {
          errors.push(`Page ${page}: status ${status}`);
        }
      } catch(e) {
        errors.push(`Page ${page}: ${e.message}`);
      }
      if (page < pages) await sleep(1500 + Math.random() * 1000);
    }

    const seen = new Set();
    const uniqueLeads = allLeads.filter(l => {
      const k = (l["Business Name"]||"").toLowerCase().trim();
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ leads: uniqueLeads, total: uniqueLeads.length, pages, errors, debug: debugInfo }));
  });
});

server.listen(PORT, () => console.log(`LeadMiner server running on port ${PORT}`));