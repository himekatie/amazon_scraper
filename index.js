const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { google } = require("googleapis");
// Decide runtime: Render/serverless vs local
const isServerEnv = Boolean(
  process.env.RENDER_EXTERNAL_URL ||
  process.env.AWS_REGION ||
  process.env.AWS_EXECUTION_ENV ||
  process.env.VERCEL ||
  process.env.GOOGLE_FUNCTION_TARGET ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH
);
let puppeteer;
let chromium;
if (isServerEnv) {
  puppeteer = require("puppeteer-core");
  chromium = require("@sparticuz/chromium");
} else {
  puppeteer = require("puppeteer");
}

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Amazon scraper is running" });
});

async function scrapeWithAxios(url) {
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Referer": "https://www.google.com/",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  const $ = cheerio.load(data);
  const title = $("#productTitle").text().trim();
  const price = $("span.a-offscreen").first().text().trim();

  if (!title) throw new Error("Axios scrape failed (no title found)");
  return { title, price };
}

async function retry(fn, { retries = 3, delayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message || err);
      // Only retry for transient filesystem/launch issues
      if (!/ETXTBSY|EBUSY|ECONNRESET|ENOTFOUND|EAGAIN/i.test(msg)) break;
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

async function launchBrowser() {
  if (isServerEnv) {
    const execPath = await chromium.executablePath();
    return retry(() => puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: execPath,
      headless: chromium.headless,
    }), { retries: 4, delayMs: 700 });
  }
  return retry(() => puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  }), { retries: 2, delayMs: 500 });
}

async function prepareAmazonPage(page) {
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9", referer: "https://www.google.com/" });
  await page.setViewport({ width: 1366, height: 768 });
}

function ensureLanguageParam(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("language")) {
      u.searchParams.set("language", "en_US");
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function maybeAcceptConsent(page) {
  // Common Amazon cookie consent selectors
  const consentSelectors = [
    "#sp-cc-accept",
    "input[name=accept]",
    "#aee-cookie-banner-accept",
    "button[name=accept]",
  ];
  for (const sel of consentSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(1000);
      break;
    }
  }
}

async function isCaptcha(page) {
  return Boolean(
    await page.$("#captchacharacters, form[action*=validateCaptcha], .captcha-page")
  );
}

async function waitForTitle(page, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hasTitle = await page.$("#productTitle");
    if (hasTitle) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function scrapeWithPuppeteer(url) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await prepareAmazonPage(page);

  let targetUrl = ensureLanguageParam(url);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  await maybeAcceptConsent(page);
  if (await isCaptcha(page)) {
    await browser.close();
    throw new Error("Encountered Amazon captcha page");
  }

  const found = await waitForTitle(page, 30000);

  // Fallback: try scrolling and extra wait
  if (!found) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 3));
    await page.waitForTimeout(1500);
  }

  const data = await page.evaluate(() => {
    const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();
    const title = normalize(document.querySelector("#productTitle")?.textContent);
    // Prefer price inside core price block when available
    const priceSel = document.querySelector("#corePriceDisplay_desktop_feature_div span.a-offscreen") || document.querySelector("span.a-offscreen");
    const price = normalize(priceSel?.textContent);
    return { title, price };
  });

  await browser.close();
  if (!data.title) throw new Error("Puppeteer scrape failed (no title)");
  return data;
}

async function getSheetsClient() {
  let credsJson = process.env.GOOGLE_CREDENTIALS;
  const credsB64 = process.env.GOOGLE_CREDENTIALS_BASE64;
  if (!credsJson && credsB64) {
    try {
      credsJson = Buffer.from(credsB64, "base64").toString("utf8");
    } catch (e) {
      throw new Error("GOOGLE_CREDENTIALS_BASE64 is not valid base64");
    }
  }
  if (!credsJson) throw new Error("Missing GOOGLE_CREDENTIALS (or GOOGLE_CREDENTIALS_BASE64) env var");

  let creds;
  try {
    creds = JSON.parse(credsJson);
  } catch (e) {
    throw new Error("Credentials env is not valid JSON");
  }

  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

function shortenTitleForSheet(raw) {
  if (!raw) return "";
  let t = String(raw);
  t = t.replace(/^Amazon\.com:\s*/i, "");
  t = t.replace(/\bby\s+[A-Z0-9][\w\s&-]+$/i, "");
  t = t.replace(/\s*\|\s*.*$/i, "");
  t = t.replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  const maxLen = Number(process.env.TITLE_MAX_LEN || 60);
  if (t.length > maxLen) t = t.slice(0, maxLen - 1).trim() + "…";
  return t;
}

app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    let data;
    try {
      data = await scrapeWithAxios(url);
      console.log("✅ Scraped with axios+cheerio");
    } catch (err) {
      console.warn("⚠️ Axios failed, falling back to Puppeteer:", err.message);
      data = await scrapeWithPuppeteer(url);
      console.log("✅ Scraped with puppeteer");
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

app.post("/sync", async (req, res) => {
  try {
    const spreadsheetId = process.env.SHEET_ID;
    const sheetName = process.env.SHEET_NAME || "Sheet1";
    const startRow = Number(process.env.START_ROW || 4);
    if (!spreadsheetId) throw new Error("Missing SHEET_ID env var");

    const sheets = await getSheetsClient();

    // 1) Read URLs from I
    const readRange = `${sheetName}!I${startRow}:I`;
    const readResp = await sheets.spreadsheets.values.get({ spreadsheetId, range: readRange });
    const urlRows = readResp.data.values || [];

    // 2) Fetch scrape results in parallel
    const base = process.env.SCRAPER_BASE || (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`);
    const fetches = urlRows.map(async (row) => {
      const url = (row && row[0]) || "";
      if (!url) return ["", ""];
      try {
        const resp = await axios.get(`${base}/scrape`, { params: { url } });
        const data = resp.data || {};
        if (data.error) return [
          `ERR: ${data.details || data.error}`,
          ""
        ];
        return [shortenTitleForSheet(data.title || ""), data.price || ""];
      } catch (e) {
        return [`ERR: ${e.message}`, ""];
      }
    });
    const results = await Promise.all(fetches);

    // 3) Write Title (E) and Price (G)
    const titles = results.map(r => [r[0]]);
    const prices = results.map(r => [r[1]]);

    const writeTitleRange = `${sheetName}!E${startRow}:E`;
    const writePriceRange = `${sheetName}!G${startRow}:G`;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: writeTitleRange,
      valueInputOption: "RAW",
      requestBody: { values: titles }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: writePriceRange,
      valueInputOption: "RAW",
      requestBody: { values: prices }
    });

    res.json({ ok: true, rows: results.length });
  } catch (err) {
    console.error("/sync error", err);
    res.status(500).json({ error: "sync_failed", details: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
