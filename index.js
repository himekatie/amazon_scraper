// const express = require("express");
// const puppeteer = require("puppeteer-core");
// const chromium = require("@sparticuz/chromium");

// const app = express();
// const PORT = process.env.PORT || 3000;
// app.get("/", (req, res) => {
//   res.json({ status: "ok" });
// });
// app.get("/scrape", async (req, res) => {
//   const url = req.query.url;
//   if (!url) return res.status(400).json({ error: "Missing ?url=" });

//   try {
//     const browser = await puppeteer.launch({
//       args: chromium.args,
//       defaultViewport: chromium.defaultViewport,
//       executablePath: await chromium.executablePath(), // Render finds Chromium here
//       headless: chromium.headless,
//     });

//     const page = await browser.newPage();
//     await page.goto(url, { waitUntil: "domcontentloaded" });

//     const data = await page.evaluate(() => {
//       const title = document.querySelector("#productTitle")?.innerText.trim();
//       const price = document.querySelector("span.a-offscreen")?.innerText.trim();
//       return { title, price };
//     });

//     await browser.close();
//     res.json(data);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Scraping failed", details: err.message });
//   }
// });

// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(data);
    const title = $("#productTitle").text().trim();
    const price = $("span.a-offscreen").first().text().trim();

    res.json({ title, price });
  } catch (err) {
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
