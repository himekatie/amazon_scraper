const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

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
    },
  });

  const $ = cheerio.load(data);
  const title = $("#productTitle").text().trim();
  const price = $("span.a-offscreen").first().text().trim();

  if (!title) throw new Error("Axios scrape failed (no title found)");
  return { title, price };
}

async function scrapeWithPuppeteer(url) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

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
