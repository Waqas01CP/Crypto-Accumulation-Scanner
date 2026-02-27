# Crypto Accumulation Scanner

A Google Apps Script that scans 1,200+ cryptocurrencies across CoinMarketCap and MEXC Futures, classifies them by accumulation pattern, and scores their volatility against a market-cap-normalised baseline — all written directly into a Google Sheet.

---

## What It Does

**Step 1 — Market Scan (`fetchMEXCAndCMCAccumulationActivity`)**

Pulls the top 1,200 coins from CoinMarketCap and cross-references them against all MEXC USDT-margined perpetual futures pairs. For each coin it:

- Filters out stablecoins and illiquid assets (tiered vol/cap thresholds)
- Segments into 5 market-cap tiers (Micro → Large Cap)
- Classifies price action into one of 7 accumulation signatures (see below)
- Checks whether the Vol/Cap ratio is within the historically healthy range for that tier
- Highlights accumulating coins in green and sorts by Vol/Cap ratio

**Step 2 — Volatility Fetch (`fetchVolatilityForAccumulatingCoins`)**

For every coin flagged as accumulating, fetches 2-day OHLCV data from MEXC index price klines and computes a **time-weighted volatility percentage**. Today's data is weighted by how far through the day we currently are, preventing incomplete candles from distorting the reading.

**Step 3 — Volatility Scoring (`calculateVolatilityScoreAndRemark`)**

Applies a **log-log regression Z-score** to normalise each coin's volatility against what is statistically expected for its market cap. The baseline regression (`ln(Vol%) ≈ 1.2 × ln(MarketCap) − 24.8`) was derived from 2020–2024 market data.

| Z-Score Range | Remark |
|---|---|
| −0.5 to +0.5 | ✅ Ideal Volatility for Accumulation |
| +0.5 to +1.2 | ⚠️ Slightly Hot, Monitor |
| > +1.2 | 🔥 High Volatility — Breakout Risk |
| −1.2 to −0.5 | 🧊 Slightly Cold, Passive Range |
| < −1.2 | ❄️ Too Cold — Low Interest |

> **Recalibration note:** The standard deviation (`STDEV = 0.55`) should be recalculated approximately every 15 days during high-volatility market regimes. Replace the value in `calculateVolatilityScoreAndRemark()` as needed.

**Step 4 — 7-Day Candle Cache (`get7DCandles`)**

Fetches 8-day OHLCV candles for all MEXC USDT futures pairs and stores them in Script Properties for downstream use. Data is chunked across multiple property keys to avoid Google's 500KB-per-key limit.

**Step 5 — Exchange Listing (`fetchAllCoinListings`)**

Paginated CoinGecko fetch that records which exchanges list each coin (spot and futures). Designed to resume across multiple executions via a time-based trigger.

---

## Accumulation Pattern Classification

Seven distinct price-action signatures, classified by 24h / 7d / 30d price change combinations with dynamic tolerance bands:

| Pattern | Signal |
|---|---|
| 🔥 Strong Accumulation + Breakout Building | Short-term momentum + medium-term base |
| 🌱 Quiet Steady Accumulation | Mild pullback short-term, solid medium-term |
| 🥷 Hidden/Silent Accumulation | Slight strength short-term, weak 7d, positive month |
| 🧤 Early Stage Accumulation | Weak short and medium term, positive month |
| 🪶 Sideways Stability Before Move | Flat across all timeframes |
| 🛡️ Accumulation With Small Pressure | Minor short-term decline, recovering monthly |
| ⚖️ Neutral, Very Long Prep Phase | Near-flat across all timeframes |

---

## Setup

### 1. Open Apps Script

In your Google Sheet: **Extensions → Apps Script**

### 2. Paste the Code

Copy the contents of `Code.gs` into the script editor. Delete any existing `myFunction` placeholder.

### 3. Set API Keys via Script Properties

**Extensions → Apps Script → Project Settings → Script Properties**

Add the following:

| Property | Value |
|---|---|
| `CMC_API_KEY` | Your CoinMarketCap Pro API key |
| `COINGECKO_API_KEY` | Your CoinGecko API key *(optional — free tier works without it)* |

> ⚠️ **Never paste your API key directly into the code.** Always use Script Properties.

### 4. Run in Order

Run each function from the Apps Script editor in this sequence:

```
1. fetchMEXCAndCMCAccumulationActivity   (~3-4 minutes)
2. fetchVolatilityForAccumulatingCoins   (~2-5 minutes depending on coin count)
3. calculateVolatilityScoreAndRemark     (~30 seconds)
4. get7DCandles                          (~5-8 minutes, run once per day)
```

For Step 5 (`fetchAllCoinListings`), set up a **time-based trigger** (every 5 minutes) — the function auto-resumes from where it left off. Run `resetCoinListingProgress()` first to start fresh.

### 5. Verify the Cache

After `get7DCandles`, run `checkBTCAndETHDataIntegrity()` to confirm the candle data stored correctly.

---

## Output Sheets

| Sheet Name | Contents |
|---|---|
| Micro Cap Accumulation | Coins $10M–$30M market cap |
| Small Cap Accumulation | Coins $30M–$100M market cap |
| Mid Cap Accumulation | Coins $100M–$300M market cap |
| Upper Mid Cap Accumulation | Coins $300M–$1B market cap |
| Large Cap Accumulation | Coins $1B+ market cap |
| Spot Listings | CoinGecko spot exchange data |
| Futures Listings | CoinGecko futures exchange data |

Green-highlighted rows = coins currently in an accumulation pattern.

---

## Technical Notes

- **Multiplier prefix handling:** MEXC lists some tokens as `1000SHIB`, `10000LADYS` etc. The matcher normalises these and adjusts the price by the divisor automatically.
- **Illiquidity filter:** Coins with Vol/Cap ratios below tier-specific thresholds are excluded — these are targets for price manipulation, not genuine accumulation.
- **Script Properties chunking:** The 7D candle cache splits data across multiple keys (400KB per chunk) to work within Google's 500KB-per-property hard limit.
- **Execution timeout safety:** `fetchAllCoinListings` saves progress and exits ~90 seconds before Apps Script's 6-minute limit, allowing a trigger to resume it cleanly.

---

## APIs Used

- [CoinMarketCap Pro API](https://pro.coinmarketcap.com/) — market cap, volume, price change data
- [MEXC Futures API](https://mxcdevelop.github.io/apidocs/contract_v1_en/) — futures pair listings, ticker prices, kline data
- [CoinGecko API](https://www.coingecko.com/en/api) — exchange listing data

---

## Author

Waqas Sharif — [github.com/Waqas01CP](https://github.com/Waqas01CP) | [LinkedIn](https://www.linkedin.com/in/ma-waqas-sharif/)
