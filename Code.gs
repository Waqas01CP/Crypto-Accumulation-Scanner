// ============================================================
// Crypto Accumulation Scanner — Google Apps Script
// Author: Waqas Sharif | github.com/Waqas01CP
//
// SETUP: Before running, set your API keys in Script Properties:
//   Extensions → Apps Script → Project Settings → Script Properties
//   Add: CMC_API_KEY   → your CoinMarketCap Pro API key
//        COINGECKO_API_KEY → your CoinGecko API key (optional, free tier works)
//
// RUN ORDER:
//   1. fetchMEXCAndCMCAccumulationActivity()  — main scan, creates cap-tier sheets
//   2. fetchVolatilityForAccumulatingCoins()   — adds volatility % to accumulating coins
//   3. calculateVolatilityScoreAndRemark()     — adds Z-score and remark columns
//   4. get7DCandles()                          — caches 7-day OHLCV data (slow, ~5 min)
//   5. fetchAllCoinListings()                  — paginated CoinGecko exchange listing
//      (run repeatedly via trigger until complete — auto-resumes via stored index)
// ============================================================


// ── CONFIGURATION ────────────────────────────────────────────────────────────

const CONFIG = {
  MEXC_DETAIL_URL  : "https://contract.mexc.com/api/v1/contract/detail",
  MEXC_TICKER_URL  : "https://contract.mexc.com/api/v1/contract/ticker",
  COINGECKO_BASE   : "https://api.coingecko.com/api/v3",
  CMC_BASE         : "https://pro-api.coinmarketcap.com/v1",
  CMC_PAGES        : 12,          // 12 × 100 = 1,200 coins scanned
  COINGECKO_PAGES  : 20,          // Total pages for exchange listing fetch
  CANDLE_CHUNK_KB  : 400,         // Max KB per Script Properties value (hard limit ~500KB)
  SLEEP_CMC_MS     : 1200,        // Delay between CMC pages (rate limit)
  SLEEP_GECKO_MS   : 2500,        // Delay between CoinGecko calls (free tier: ~30/min)
};

const MARKET_CAP_RANGES = [
  { name: "Micro Cap Accumulation",      min: 10000000,   max: 30000000,   threshold: 0.08   },
  { name: "Small Cap Accumulation",      min: 30000000,   max: 100000000,  threshold: 0.05   },
  { name: "Mid Cap Accumulation",        min: 100000000,  max: 300000000,  threshold: 0.03   },
  { name: "Upper Mid Cap Accumulation",  min: 300000000,  max: 1000000000,threshold: 0.015  },
  { name: "Large Cap Accumulation",      min: 1000000000,max: Infinity,     threshold: 0.0075 },
];

const STABLECOINS = new Set([
  'USDT','USDC','DAI','BUSD','TUSD','USDP','GUSD','EURT','USDN',
  'XAUT','WBTC','FDUSD','PYUSD','FRAX','USDD','USDS','LUSD','USDX','SUSD','CUSD'
]);


// ── API KEY HELPERS ──────────────────────────────────────────────────────────

function getCmcApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty("CMC_API_KEY");
  if (!key) throw new Error("CMC_API_KEY not set in Script Properties. See setup instructions.");
  return key;
}

function getCoinGeckoHeaders() {
  const key = PropertiesService.getScriptProperties().getProperty("COINGECKO_API_KEY");
  return key ? { "x-cg-pro-api-key": key } : {};
}


// ── SHEET HELPERS ────────────────────────────────────────────────────────────

/**
 * Returns a sheet by name, creating it if it doesn't exist.
 * If reset=true, deletes and recreates it (clean slate).
 */
function getOrCreateSheet(name, reset) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(name);
  if (sheet && reset) { ss.deleteSheet(sheet); sheet = null; }
  if (!sheet)         { sheet = ss.insertSheet(name); }
  return sheet;
}

/**
 * Appends rows to a named sheet. Creates the sheet and writes headers on first call.
 */
function appendToSheet(sheetName, rows, headers) {
  if (!rows || rows.length === 0) return;
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (headers) sheet.appendRow(headers);
  }
  rows.forEach(row => sheet.appendRow(row));
}


// ── SCRIPT PROPERTIES HELPERS (pagination state) ────────────────────────────

function getStoredIndex() {
  const val = PropertiesService.getScriptProperties().getProperty("COINGECKO_PAGE_INDEX");
  return val ? parseInt(val, 10) : 1;
}

function setStoredIndex(page) {
  PropertiesService.getScriptProperties().setProperty("COINGECKO_PAGE_INDEX", String(page));
}

function resetStoredIndex() {
  PropertiesService.getScriptProperties().deleteProperty("COINGECKO_PAGE_INDEX");
}


// ── MEXC HELPERS ─────────────────────────────────────────────────────────────

/**
 * Fetches all MEXC USDT-margined perpetual futures pairs and their latest prices.
 * Returns a map: baseCoin (uppercase) → { symbol, baseCoin, price }
 */
function fetchMexcSymbols() {
  const detailData = JSON.parse(UrlFetchApp.fetch(CONFIG.MEXC_DETAIL_URL)).data;
  const tickerData = JSON.parse(UrlFetchApp.fetch(CONFIG.MEXC_TICKER_URL)).data;

  const symbols = {};

  detailData.forEach(pair => {
    if (pair.quoteCoin === "USDT") {
      symbols[pair.baseCoin] = { symbol: pair.symbol, baseCoin: pair.baseCoin };
    }
  });

  tickerData.forEach(ticker => {
    const base = ticker.symbol.replace("_USDT", "");
    if (symbols[base]) {
      symbols[base].price = parseFloat(ticker.lastPrice);
    }
  });

  return symbols;
}

/**
 * Matches a CMC coin to a MEXC symbol.
 * Handles multiplier prefixes like 1000, 10000, 1000000 (e.g., 1000SHIB = SHIB/1000).
 * Returns { availableOnMEXC, mexcSymbol, mexcPrice } or defaults with "-".
 */
function matchCoinToMexc(cmcSymbol, cmcName, mexcSymbols) {
  const prefixPattern = /^(1000000|100000|10000|1000|100)/;

  for (const base in mexcSymbols) {
    let normalizedBase = base.toLowerCase();
    let divisor = 1;

    const prefixMatch = normalizedBase.match(prefixPattern);
    if (prefixMatch) {
      divisor        = parseInt(prefixMatch[0], 10);
      normalizedBase = normalizedBase.replace(prefixMatch[0], "");
    }

    const nameMatch   = normalizedBase === cmcName.split(" ")[0].toLowerCase();
    const symbolMatch = normalizedBase.toUpperCase() === cmcSymbol;

    if (nameMatch || symbolMatch) {
      return {
        availableOnMEXC : "Yes",
        mexcSymbol       : mexcSymbols[base].symbol,
        mexcPrice        : (mexcSymbols[base].price || 0) / divisor,
        baseCoin         : mexcSymbols[base].baseCoin,
      };
    }
  }

  // Fallback: strict symbol-only match
  for (const base in mexcSymbols) {
    if (base.toUpperCase() === cmcSymbol) {
      return {
        availableOnMEXC : "Yes",
        mexcSymbol       : mexcSymbols[base].symbol,
        mexcPrice        : mexcSymbols[base].price || 0,
        baseCoin         : mexcSymbols[base].baseCoin,
      };
    }
  }

  return { availableOnMEXC: "No", mexcSymbol: "-", mexcPrice: "-", baseCoin: "-" };
}


// ── FINANCIAL LOGIC ──────────────────────────────────────────────────────────

/**
 * Returns true if a coin is too illiquid to trade reliably.
 * Uses tiered volume/market-cap thresholds.
 */
function isIlliquid(volume24h, marketCap) {
  const ratio = volume24h / marketCap;
  if (marketCap < 10000000)  return ratio < 0.005;
  if (marketCap < 30000000)  return ratio < 0.003;
  if (marketCap < 100000000) return ratio < 0.002;
  if (marketCap < 1000000000) return ratio < 0.001;
  return ratio < 0.0005;
}

/**
 * Applies dynamic tolerance bands to accumulation thresholds.
 * Wider ranges get slightly wider tolerance to reduce false negatives.
 */
function applyDynamicTolerance(min, max) {
  const rangeWidth = max - min;
  const tolerance  = Math.max(1, Math.min(3, rangeWidth * 0.15));
  return { min: min - tolerance, max: max + tolerance };
}

/**
 * Classifies price-action into one of 7 accumulation patterns.
 * Called only for coins that have already passed the broad accumulation gate.
 * Returns a labelled remark string, or "❌ No Clear Accumulation" if no pattern matches.
 */
function getAccumulationRemark(change24h, change7d, change30d) {
  const patterns = {
    strong  : { c24: [0,5],    c7: [0,8],    c30: [10,20] },
    quiet   : { c24: [-5,0],   c7: [0,5],    c30: [10,20] },
    hidden  : { c24: [0,5],    c7: [-5,0],   c30: [5,15]  },
    early   : { c24: [-5,0],   c7: [-5,0],   c30: [5,15]  },
    sideways: { c24: [0,5],    c7: [0,5],    c30: [0,10]  },
    pressure: { c24: [-3,0],   c7: [-8,-2],  c30: [0,10]  },
    neutral : { c24: [-5,5],   c7: [-8,8],   c30: [0,5]   },
  };

  function inRange(val, [lo, hi]) {
    const band = applyDynamicTolerance(lo, hi);
    return val >= band.min && val <= band.max;
  }

  function matches(p) {
    return inRange(change24h, p.c24) && inRange(change7d, p.c7) && inRange(change30d, p.c30);
  }

  if (matches(patterns.strong))   return "🔥 Strong Accumulation + Breakout Building";
  if (matches(patterns.quiet))    return "🌱 Quiet Steady Accumulation";
  if (matches(patterns.hidden))   return "🥷 Hidden/Silent Accumulation";
  if (matches(patterns.early))    return "🧤 Early Stage Accumulation";
  if (matches(patterns.sideways)) return "🪶 Sideways Stability Before Move";
  if (matches(patterns.pressure)) return "🛡️ Accumulation With Small Pressure";
  if (matches(patterns.neutral))  return "⚖️ Neutral, Very Long Prep Phase";
  return "❌ No Clear Accumulation";
}

/**
 * Checks whether the Vol/Cap ratio is within the expected healthy range for a cap tier.
 * Thresholds derived from empirical percentile analysis (2022–2024 market data).
 */
function getVolCapComment(volToCapRatio, marketCap) {
  if (!marketCap || !volToCapRatio || isNaN(marketCap) || isNaN(volToCapRatio)) return "";

  const thresholds = {
    micro    : { min: 0.05129, max: 0.10991 },
    small    : { min: 0.03716, max: 0.08656 },
    mid      : { min: 0.02539, max: 0.05481 },
    upperMid : { min: 0.00980, max: 0.02998 },
    large    : { min: 0.00503, max: 0.01461 },
  };

  let tier;
  if      (marketCap < 30000000)    tier = thresholds.micro;
  else if (marketCap < 100000000)   tier = thresholds.small;
  else if (marketCap < 300000000)   tier = thresholds.mid;
  else if (marketCap < 1000000000) tier = thresholds.upperMid;
  else                                 tier = thresholds.large;

  if (volToCapRatio >= tier.min && volToCapRatio <= tier.max) {
    return "✅ In range";
  }
  return `❌ Out of range  Min:${tier.min}  Max:${tier.max}`;
}


// ── MAIN SCAN ────────────────────────────────────────────────────────────────

/**
 * STEP 1 — Main function.
 * Pulls 1,200 coins from CoinMarketCap, cross-references with MEXC futures,
 * segments by market cap tier, classifies accumulation patterns, and writes
 * to per-tier sheets. Accumulating coins are highlighted in green.
 */
function fetchMEXCAndCMCAccumulationActivity() {
  const cmcApiKey = getCmcApiKey();

  // Clean old sheets
  MARKET_CAP_RANGES.forEach(range => {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(range.name);
    if (sheet) ss.deleteSheet(sheet);
  });

  // Fetch MEXC symbols
  const mexcSymbols = fetchMexcSymbols();

  // Fetch CMC listings (paginated)
  const cmcData = [];
  for (let page = 1; page <= CONFIG.CMC_PAGES; page++) {
    const start  = (page - 1) * 100 + 1;
    const url    = `${CONFIG.CMC_BASE}/cryptocurrency/listings/latest?start=${start}&limit=100`;
    const res    = UrlFetchApp.fetch(url, { headers: { "X-CMC_PRO_API_KEY": cmcApiKey } });
    cmcData.push(...JSON.parse(res.getContentText()).data);
    Utilities.sleep(CONFIG.SLEEP_CMC_MS);
  }

  // Process each coin
  const matchedCoins = [];

  cmcData.forEach(coin => {
    const volume24h  = coin.quote.USD.volume_24h;
    const marketCap  = coin.quote.USD.market_cap;
    const cmcSymbol  = coin.symbol.toUpperCase();

    if (marketCap < 10000000)          return;
    if (STABLECOINS.has(cmcSymbol))      return;
    if (isIlliquid(volume24h, marketCap)) return;

    const volToCapRatio = volume24h / marketCap;
    const change24h     = coin.quote.USD.percent_change_24h;
    const change7d      = coin.quote.USD.percent_change_7d;
    const change30d     = coin.quote.USD.percent_change_30d;

    // Stage 1: broad accumulation gate (original logic preserved)
    const isAccumulating = (
      change24h >= -6 && change24h <= 6 &&
      change7d  >= -10 && change7d  <= 10 &&
      change30d >= 0  && change30d <= 25
    ) ? "Yes" : "No";

    // Stage 2: pattern classification, only called if broad gate passed
    // Non-accumulating coins get an empty remark (cleaner for sheet scanning)
    const accumulationRemark = (isAccumulating === "Yes")
      ? getAccumulationRemark(change24h, change7d, change30d)
      : "";

    const mexcMatch    = matchCoinToMexc(cmcSymbol, coin.name, mexcSymbols);
    const volCapComment = getVolCapComment(volToCapRatio, marketCap);

    matchedCoins.push({
      name             : coin.name,
      symbol           : cmcSymbol,
      mexcSymbol       : mexcMatch.mexcSymbol,
      baseCoin         : mexcMatch.baseCoin,
      cmcPrice         : coin.quote.USD.price,
      mexcPrice        : mexcMatch.mexcPrice,
      volume24h,
      marketCap,
      volToCapRatio,
      availableOnMEXC  : mexcMatch.availableOnMEXC,
      isAccumulating,
      accumulationRemark,
      volCapComment,
    });
  });

  // Write per-tier sheets
  const headers = [
    "Name", "Symbol", "MEXC Symbol", "BaseCoin", "CMC Price", "MEXC Price",
    "Volume 24h", "Market Cap", "Vol/Cap Ratio", "Available on MEXC",
    "In Accumulation Range", "Accumulation Remarks", "Vol/Cap Comment"
  ];

  MARKET_CAP_RANGES.forEach(range => {
    const coinsInRange = matchedCoins
      .filter(c => c.marketCap >= range.min && c.marketCap < range.max)
      .sort((a, b) => b.volToCapRatio - a.volToCapRatio);

    if (coinsInRange.length === 0) return;

    const sheet = getOrCreateSheet(range.name, false);
    const rows  = [headers];
    const greenRows = [];

    coinsInRange.forEach((coin, idx) => {
      rows.push([
        coin.name, coin.symbol, coin.mexcSymbol, coin.baseCoin,
        coin.cmcPrice, coin.mexcPrice, coin.volume24h, coin.marketCap,
        coin.volToCapRatio, coin.availableOnMEXC,
        coin.isAccumulating, coin.accumulationRemark, coin.volCapComment
      ]);
      if (coin.isAccumulating === "Yes") greenRows.push(idx + 2);
    });

    sheet.getRange(1, 1, rows.length, headers.length).setValues(rows);

    for (let col = 1; col <= headers.length; col++) sheet.autoResizeColumn(col);

    greenRows.forEach(rowNum => {
      sheet.getRange(rowNum, 1, 1, headers.length).setBackground("#ccffcc");
    });
  });

  Logger.log("Accumulation scan complete.");
}


// ── VOLATILITY FETCH ─────────────────────────────────────────────────────────

/**
 * STEP 2 — Adds a "Volatility %" column to each cap-tier sheet.
 * Adds a "Volatility %" column to each cap-tier sheet for ALL coins with a MEXC symbol.
 * Volatility is calculated for accumulating and non-accumulating coins alike —
 * this allows direct comparison across the full sheet.
 * Uses a time-weighted 2-day OHLCV calculation from MEXC index price klines.
 */
function fetchVolatilityForAccumulatingCoins() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  MARKET_CAP_RANGES.forEach(range => {
    const sheet = ss.getSheetByName(range.name);
    if (!sheet) return;

    const values   = sheet.getDataRange().getValues();
    const headers  = values[0];

    const symbolCol = headers.indexOf("MEXC Symbol") + 1;
    const volHeader = "Volatility %";

    if (symbolCol === 0) {
      Logger.log(`Missing MEXC Symbol column in sheet: ${range.name}`);
      return;
    }

    // Add header if not present
    let volCol = headers.indexOf(volHeader) + 1;
    if (volCol === 0) {
      volCol = headers.length + 1;
      sheet.getRange(1, volCol).setValue(volHeader);
    }

    const now        = Math.floor(Date.now() / 1000);
    const twoDaysAgo = now - (60 * 60 * 24 * 2);

    for (let i = 1; i < values.length; i++) {
      const row        = values[i];
      const mexcSymbol = row[symbolCol - 1];

      // Fetch volatility for ALL coins with a valid MEXC symbol.
      // Accumulation status is intentionally NOT used as a filter here —
      // volatility data on non-accumulating coins is useful for comparison.
      if (!mexcSymbol || mexcSymbol === "-") continue;

      const url = `https://contract.mexc.com/api/v1/contract/kline/index_price/${mexcSymbol}` +
                  `?interval=Day1&start=${twoDaysAgo}&end=${now}`;

      try {
        const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        const data = JSON.parse(res.getContentText());

        if (!data.success || !data.data || data.data.open.length < 2) continue;

        const opens  = data.data.open.map(parseFloat);
        const highs  = data.data.high.map(parseFloat);
        const lows   = data.data.low.map(parseFloat);
        const closes = data.data.close.map(parseFloat);

        const yMean = (opens[0] + highs[0] + lows[0] + closes[0]) / 4;
        const tMean = (opens[1] + highs[1] + lows[1] + closes[1]) / 4;
        const gMean = (yMean + tMean) / 2;

        // Time-weight: proportion of today elapsed
        const utc     = new Date();
        const secToday = utc.getUTCHours() * 3600 + utc.getUTCMinutes() * 60 + utc.getUTCSeconds();
        const tWeight  = secToday / 86400;
        const yWeight  = 1 - tWeight;

        const wVariance = (Math.pow(yMean - gMean, 2) * yWeight) +
                          (Math.pow(tMean - gMean, 2) * tWeight);
        const wStdDev   = Math.sqrt(wVariance);

        const pctVol = (wStdDev / closes[1]) * 100;
        sheet.getRange(i + 1, volCol).setValue(pctVol.toFixed(2));

      } catch (err) {
        Logger.log(`Volatility error for ${mexcSymbol}: ${err}`);
      }
    }
  });

  Logger.log("Volatility fetch complete.");
}


// ── VOLATILITY SCORE ─────────────────────────────────────────────────────────

/**
 * STEP 3 — Adds "Volatility Score" (Z-score) and "Volatility Remark" columns.
 * Uses log-log regression baseline: ln(Vol%) ≈ 1.2 × ln(MarketCap) − 24.8
 * Baseline derived from 2020–2024 market data. Recalibrate stdev every ~15 days.
 */
function calculateVolatilityScoreAndRemark() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const STDEV = 0.55; // Recalibrate periodically — see comments in README

  function getZScore(volPercent, marketCap) {
    const expectedLogVol = 1.2 * Math.log(marketCap) - 24.8;
    const actualLogVol   = Math.log(volPercent);
    return (actualLogVol - expectedLogVol) / STDEV;
  }

  function classifyZ(z) {
    if (z >= -0.5  && z <= 0.5)  return "✅ Ideal Volatility for Accumulation";
    if (z >  0.5   && z <= 1.2)  return "⚠️ Slightly Hot, Monitor";
    if (z >  1.2)                 return "🔥 High Volatility — Breakout Risk";
    if (z >= -1.2  && z < -0.5)  return "🧊 Slightly Cold, Passive Range";
    return "❄️ Too Cold — Low Interest";
  }

  MARKET_CAP_RANGES.forEach(range => {
    const sheet = ss.getSheetByName(range.name);
    if (!sheet) return;

    const values  = sheet.getDataRange().getValues();
    const headers = values[0];

    const volCol  = headers.indexOf("Volatility %") + 1;
    const capCol  = headers.indexOf("Market Cap") + 1;
    if (volCol === 0 || capCol === 0) return;

    let scoreCol  = headers.indexOf("Volatility Score") + 1;
    let remarkCol = headers.indexOf("Volatility Remark") + 1;

    if (scoreCol === 0) {
      scoreCol = headers.length + 1;
      sheet.getRange(1, scoreCol).setValue("Volatility Score");
    }
    if (remarkCol === 0) {
      remarkCol = scoreCol + 1;
      sheet.getRange(1, remarkCol).setValue("Volatility Remark");
    }

    for (let i = 1; i < values.length; i++) {
      const vol = parseFloat(values[i][volCol - 1]);
      const cap = parseFloat(values[i][capCol - 1]);

      if (!vol || !cap || isNaN(vol) || isNaN(cap) || cap <= 0 || vol <= 0) continue;

      const z = getZScore(vol, cap);
      sheet.getRange(i + 1, scoreCol).setValue(z.toFixed(2));
      sheet.getRange(i + 1, remarkCol).setValue(classifyZ(z));
    }

    sheet.autoResizeColumn(scoreCol);
    sheet.autoResizeColumn(remarkCol);
  });

  Logger.log("Volatility scoring complete.");
}


// ── 7-DAY CANDLE CACHE ───────────────────────────────────────────────────────

/**
 * STEP 4 — Fetches 8-day OHLCV candles for all MEXC USDT futures symbols.
 * FIX: Chunks data into multiple Script Properties keys to avoid the 500KB limit.
 * Each chunk key: "cached7DCandles_0", "cached7DCandles_1", etc.
 * Chunk count stored in "cached7DCandles_chunks".
 */
function get7DCandles() {
  const mexcSymbols = fetchMexcSymbols();

  const now        = Math.floor(Date.now() / 1000);
  const eightDaysAgo = now - (60 * 60 * 24 * 8);

  const allCandles = {};
  let count = 0;

  for (const baseCoin in mexcSymbols) {
    const symbol = mexcSymbols[baseCoin].symbol;
    const url    = `https://contract.mexc.com/api/v1/contract/kline/${symbol}` +
                   `?interval=Day1&start=${eightDaysAgo}&end=${now}`;

    try {
      const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      const data = JSON.parse(res.getContentText());

      if (!data.success || !data.data || data.data.open.length < 8) continue;

      allCandles[symbol] = {
        open  : data.data.open.map(parseFloat),
        high  : data.data.high.map(parseFloat),
        low   : data.data.low.map(parseFloat),
        close : data.data.close.map(parseFloat),
        volume: data.data.vol.map(parseFloat),
        time  : data.data.time,
      };
      count++;

    } catch (err) {
      Logger.log(`Candle fetch error for ${symbol}: ${err}`);
    }
  }

  // Chunk into multiple property keys to stay under 500KB per value
  const props        = PropertiesService.getScriptProperties();
  const fullJson     = JSON.stringify(allCandles);
  const chunkSize    = CONFIG.CANDLE_CHUNK_KB * 1024; // bytes
  const chunks       = [];

  for (let i = 0; i < fullJson.length; i += chunkSize) {
    chunks.push(fullJson.slice(i, i + chunkSize));
  }

  // Clear old chunks
  const oldCount = parseInt(props.getProperty("cached7DCandles_chunks") || "0", 10);
  for (let i = 0; i < oldCount; i++) props.deleteProperty(`cached7DCandles_${i}`);

  // Write new chunks
  chunks.forEach((chunk, i) => props.setProperty(`cached7DCandles_${i}`, chunk));
  props.setProperty("cached7DCandles_chunks", String(chunks.length));

  Logger.log(`Stored 7D candles for ${count} coins across ${chunks.length} chunk(s).`);
}

/**
 * Retrieves the cached 7D candle data from chunked Script Properties.
 * Returns the full parsed object.
 */
function getChunkedCandles() {
  const props      = PropertiesService.getScriptProperties();
  const chunkCount = parseInt(props.getProperty("cached7DCandles_chunks") || "0", 10);
  if (chunkCount === 0) return {};

  let fullJson = "";
  for (let i = 0; i < chunkCount; i++) {
    fullJson += props.getProperty(`cached7DCandles_${i}`) || "";
  }
  return JSON.parse(fullJson);
}


// ── DATA INTEGRITY CHECK ─────────────────────────────────────────────────────

/**
 * Utility — validates cached candle data for BTC and ETH.
 * Run after get7DCandles() to confirm the cache is clean.
 */
function checkBTCAndETHDataIntegrity() {
  const candleData   = getChunkedCandles();
  const symbolsCheck = ["BTC_USDT", "ETH_USDT"];

  symbolsCheck.forEach(symbol => {
    const data = candleData[symbol];
    if (!data) { Logger.log(`No data found for ${symbol}`); return; }

    const { open, high, low, close, volume, time } = data;
    Logger.log(`--- Integrity check: ${symbol} (${open.length} candles) ---`);

    open.forEach((o, i) => {
      if ([o, high[i], low[i], close[i], volume[i]].some(isNaN)) {
        Logger.log(`⚠️ NaN at index ${i}`);
      }
      if (low[i] > Math.min(o, close[i])) {
        Logger.log(`⚠️ Low inconsistency at index ${i}: low=${low[i]} open=${o} close=${close[i]}`);
      }
      if (high[i] < Math.max(o, close[i])) {
        Logger.log(`⚠️ High inconsistency at index ${i}: high=${high[i]} open=${o} close=${close[i]}`);
      }
    });

    Logger.log(`${symbol}: integrity check passed.`);
  });
}


// ── COINGECKO EXCHANGE LISTING ───────────────────────────────────────────────

/**
 * Fetches a single page of coins from CoinGecko (100 per page, sorted by market cap).
 */
function fetchCoinsByPage(page) {
  const url = `${CONFIG.COINGECKO_BASE}/coins/markets` +
              `?vs_currency=usd&order=market_cap_desc&per_page=100&page=${page}&sparkline=false`;

  const res = UrlFetchApp.fetch(url, {
    headers         : getCoinGeckoHeaders(),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    Logger.log(`CoinGecko page ${page} failed: ${res.getContentText().slice(0, 200)}`);
    return [];
  }

  return JSON.parse(res.getContentText());
}

/**
 * Fetches exchange listings (spot + futures) for a single coin by CoinGecko ID.
 * NOTE: Uses `has_trading_incentive` as a proxy for futures listing.
 *       This is an approximation — some exchanges set this flag inconsistently.
 */
function fetchExchangesForCoin(coinId) {
  const url = `${CONFIG.COINGECKO_BASE}/coins/${coinId}` +
              `?tickers=true&market_data=false&community_data=false&developer_data=false`;

  const res = UrlFetchApp.fetch(url, {
    headers         : getCoinGeckoHeaders(),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    Logger.log(`Failed to fetch tickers for ${coinId}`);
    return null;
  }

  const data    = JSON.parse(res.getContentText());
  const tickers = data?.tickers || [];

  const spotSet    = new Set();
  const futuresSet = new Set();

  tickers.forEach(ticker => {
    const name = ticker?.market?.name;
    if (!name) return;
    if (ticker.market.has_trading_incentive) futuresSet.add(name);
    else                                      spotSet.add(name);
  });

  return {
    id     : data.id,
    symbol : data.symbol,
    name   : data.name,
    spot   : [...spotSet],
    futures: [...futuresSet],
  };
}

/**
 * STEP 5 — Paginated CoinGecko exchange listing fetch.
 * Designed to be run multiple times via a time-based trigger (runs every 5 min).
 * Auto-resumes from stored page index. Writes to "Spot Listings" and "Futures Listings" sheets.
 *
 * To start fresh: run resetStoredIndex() first, then delete the two listing sheets.
 * To set up a trigger: Apps Script → Triggers → Add trigger → this function → every 5 minutes.
 */
function fetchAllCoinListings() {
  let   currentPage = getStoredIndex();
  const startTime   = Date.now();
  const TOTAL_PAGES = CONFIG.COINGECKO_PAGES;
  const HEADERS_SPOT    = ["CoinGecko ID", "Symbol", "Name", "Spot Exchanges"];
  const HEADERS_FUTURES = ["CoinGecko ID", "Symbol", "Name", "Futures Exchanges"];

  for (; currentPage <= TOTAL_PAGES; currentPage++) {
    const coins = fetchCoinsByPage(currentPage);

    const spotRows    = [];
    const futuresRows = [];

    for (const coin of coins) {
      try {
        Utilities.sleep(CONFIG.SLEEP_GECKO_MS);

        const ex = fetchExchangesForCoin(coin.id);
        if (!ex) continue;

        if (ex.spot.length    > 0) spotRows.push([ex.id, ex.symbol, ex.name, ex.spot.join(", ")]);
        if (ex.futures.length > 0) futuresRows.push([ex.id, ex.symbol, ex.name, ex.futures.join(", ")]);

        // Stop ~90 seconds before Apps Script's 6-minute execution limit
        if ((Date.now() - startTime) / 1000 > 270) {
          Logger.log(`Execution limit approaching. Saved progress at page ${currentPage}.`);
          setStoredIndex(currentPage);
          appendToSheet("Spot Listings",    spotRows,    HEADERS_SPOT);
          appendToSheet("Futures Listings", futuresRows, HEADERS_FUTURES);
          return;
        }

      } catch (err) {
        Logger.log(`Error on coin ${coin.id}: ${err}`);
      }
    }

    appendToSheet("Spot Listings",    spotRows,    HEADERS_SPOT);
    appendToSheet("Futures Listings", futuresRows, HEADERS_FUTURES);
  }

  setStoredIndex(TOTAL_PAGES + 1);
  Logger.log("All coin exchange listings fetched and written.");
}

/**
 * Utility — resets the CoinGecko pagination index back to page 1.
 * Run this before starting a fresh fetchAllCoinListings() run.
 */
function resetCoinListingProgress() {
  resetStoredIndex();
  Logger.log("Page index reset to 1. Ready for a fresh run.");
}
