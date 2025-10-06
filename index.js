const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
// Decide runtime: Render/serverless vs local
const isServerEnv = Boolean(process.env.RENDER || process.env.AWS_REGION || process.env.AWS_EXECUTION_ENV);
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
    },
  });

  const $ = cheerio.load(data);
  const title = $("#productTitle").text().trim();
  const price = $("span.a-offscreen").first().text().trim();

  if (!title) throw new Error("Axios scrape failed (no title found)");
  return { title, price };
}

async function launchBrowser() {
  if (isServerEnv) {
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }
  return puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
}

async function scrapeWithPuppeteer(url) {
  const browser = await launchBrowser();

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Wait for either title or an error block
  await Promise.race([
    page.waitForSelector("#productTitle", { timeout: 15000 }).catch(() => null),
    page.waitForSelector("#dp", { timeout: 15000 }).catch(() => null),
  ]);

  const data = await page.evaluate(() => {
    const title = document.querySelector("#productTitle")?.innerText.trim();
    const price = document.querySelector("span.a-offscreen")?.innerText.trim();
    return { title, price };
  });

  await browser.close();
  if (!data.title) throw new Error("Puppeteer scrape failed (no title)");
  return data;
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

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
