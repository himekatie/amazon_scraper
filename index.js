const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Grab title and price
    const data = await page.evaluate(() => {
      const title = document.querySelector("#productTitle")?.innerText.trim();
      const price =
        document.querySelector("span.a-offscreen")?.innerText.trim();
      return { title, price };
    });

    await browser.close();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scraping failed", details: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
