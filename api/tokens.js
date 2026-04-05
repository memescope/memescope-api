// MemeScope API v2 - FAST
// All fetches run in parallel, Vercel CDN caching for instant responses

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 120000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const searchQuery = req.query.search || req.query.q;
  if (searchQuery) {
    try {
      const results = await searchToken(searchQuery);
      return res.status(200).json({ tokens: results, source: 'live_search' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return res.status(200).json({ tokens: cache.data, cached: true, count: cache.data.length });
  }

  try {
    const tokens = await fetchAllTokens();
    cache = { data: tokens, timestamp: Date.now() };
    return res.status(200).json({ tokens, cached: false, count: tokens.length });
  } catch (e) {
    if (cache.data) return res.status(200).json({ tokens: cache.data, cached: true, stale: true });
    return res.status(500).json({ error: e.message });
  }
}

async function searchToken(query) {
  const isCA = query.length > 30;
  const url = isCA
    ? 'https://api.dexscreener.com/latest/dex/tokens/' + query
    : 'https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(query);
  const r = await fetch(url);
  if (!r.ok) return [];
  const d = await r.json();
  if (!d?.pairs) return [];
  return parseDexPairs(d.pairs.slice(0, 30));
}

async function fetchAllTokens() {
  const allAddresses = new Set();
  const chains = ['solana', 'eth', 'base', 'bsc'];
  
  // GeckoTerminal - staggered to avoid 429 rate limits (30/min)
  // Fetch one chain at a time, but pages within a chain in parallel
  for (const chain of chains) {
    const geckoUrls = [];
    for (let p = 1; p <= 3; p++) {
      geckoUrls.push(`https://api.geckoterminal.com/api/v2/networks/${chain}/trending_pools?page=${p}`);
    }
    geckoUrls.push(`https://api.geckoterminal.com/api/v2/networks/${chain}/new_pools?page=1`);
    
    const geckoResults = await Promise.all(geckoUrls.map(u => safeFetch(u)));
    for (const d of geckoResults) {
      if (d?.data) {
        for (const pool of d.data) {
          const addr = extractTokenAddress(pool);
          if (addr) allAddresses.add(addr);
        }
      }
    }
    await sleep(500); // Small gap between chains to stay under rate limit
  }
  
  console.log(`GeckoTerminal: ${allAddresses.size} addresses`);
  
  // DexScreener - all parallel (300/min rate limit, no issue)
  const dexPromises = [];
  
  // Profiles + boosted
  dexPromises.push({ type: 'list', promise: safeFetch('https://api.dexscreener.com/token-profiles/latest/v1') });
  dexPromises.push({ type: 'list', promise: safeFetch('https://api.dexscreener.com/token-boosts/top/v1') });
  
  // Search terms
  const terms = ['pepe','doge','cat','trump','ai','meme','frog','dog','bonk','wif','shib','floki','popcat','brett','goat','pnut','moon','pump','inu','giga','degen','turbo'];
  for (const term of terms) {
    dexPromises.push({ type: 'search', promise: safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + term) });
  }
  
  const dexResults = await Promise.all(dexPromises.map(p => p.promise));
  
  for (let i = 0; i < dexPromises.length; i++) {
    const type = dexPromises[i].type;
    const d = dexResults[i];
    if (!d) continue;
    
    if (type === 'list' && Array.isArray(d)) {
      for (const t of d) { if (t.tokenAddress) allAddresses.add(t.tokenAddress); }
    } else if (type === 'search' && d.pairs) {
      const sorted = d.pairs.sort((a, b) => ((b.volume?.h24 || 0) - (a.volume?.h24 || 0)));
      for (let j = 0; j < Math.min(10, sorted.length); j++) {
        if (sorted[j].baseToken?.address) allAddresses.add(sorted[j].baseToken.address);
      }
    }
  }
  
  console.log(`Discovery: ${allAddresses.size} unique addresses`);
  
  // Batch enrich via DexScreener - also parallel
  const addressList = [...allAddresses];
  const batchPromises = [];
  for (let i = 0; i < addressList.length; i += 30) {
    const chunk = addressList.slice(i, i + 30);
    batchPromises.push(safeFetch('https://api.dexscreener.com/latest/dex/tokens/' + chunk.join(',')));
  }
  
  const batchResults = await Promise.all(batchPromises);
  const allPairs = [];
  for (const d of batchResults) {
    if (d?.pairs) allPairs.push(...d.pairs);
  }
  
  console.log(`Enrichment: ${allPairs.length} pairs from ${batchPromises.length} batches`);
  return parseDexPairs(allPairs);
}

async function safeFetch(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

function extractTokenAddress(pool) {
  if (pool.relationships?.base_token?.data?.id) {
    return pool.relationships.base_token.data.id.split('_').pop() || '';
  }
  return '';
}

function parseDexPairs(pairs) {
  const chainMap = { solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc' };
  const byAddr = {};
  
  for (const p of pairs) {
    if (!p.baseToken) continue;
    const addr = p.baseToken.address.toLowerCase();
    const liq = p.liquidity?.usd || 0;
    if (!byAddr[addr] || liq > (byAddr[addr].liquidity?.usd || 0)) byAddr[addr] = p;
  }
  
  const tokens = [];
  const seenSyms = {};
  
  for (const addr in byAddr) {
    const best = byAddr[addr];
    if (!best.baseToken) continue;
    const sym = best.baseToken.symbol.toUpperCase();
    if (seenSyms[sym]) continue;
    seenSyms[sym] = true;
    
    const pc = best.priceChange || {};
    const mcap = Number(best.marketCap || best.fdv || 0);
    const vol = Number(best.volume?.h24 || 0);
    const vol1h = Number(best.volume?.h1 || 0);
    const liq = Number(best.liquidity?.usd || 0);
    const img = (best.info?.imageUrl) || `https://dd.dexscreener.com/ds-data/tokens/${best.chainId || 'solana'}/${best.baseToken.address}.png`;
    
    let website = '', twitter = '', telegram = '';
    const ca = best.baseToken.address || '';
    if (best.info) {
      if (best.info.websites?.[0]) website = best.info.websites[0].url || '';
      if (best.info.socials) {
        for (const s of best.info.socials) {
          if (s.type === 'twitter' && !twitter) twitter = s.url || '';
          if (s.type === 'telegram' && !telegram) telegram = s.url || '';
        }
      }
    }
    
    let age = '??', ageHours = 999;
    if (best.pairCreatedAt) {
      ageHours = (Date.now() - best.pairCreatedAt) / 3600000;
      if (ageHours < 1) age = Math.round(ageHours * 60) + 'm';
      else if (ageHours < 24) age = Math.round(ageHours) + 'h';
      else if (ageHours < 720) age = Math.round(ageHours / 24) + 'd';
      else age = Math.round(ageHours / 720) + 'mo';
    }
    
    let txns = 0, buys24 = 0, sells24 = 0, buys1h = 0, sells1h = 0;
    if (best.txns?.h24) { buys24 = best.txns.h24.buys || 0; sells24 = best.txns.h24.sells || 0; txns = buys24 + sells24; }
    if (best.txns?.h1) { buys1h = best.txns.h1.buys || 0; sells1h = best.txns.h1.sells || 0; }
    
    const p5m = pc.m5 ? parseFloat(pc.m5) : 0;
    const p1h = pc.h1 ? parseFloat(pc.h1) : 0;
    const p6h = pc.h6 ? parseFloat(pc.h6) : 0;
    const p24h = pc.h24 ? parseFloat(pc.h24) : 0;
    
    // HARD FILTERS — absolutely no exceptions
    const mcapNum = Number(mcap);
    const liqNum = Number(liq);
    if (isNaN(mcapNum) || mcapNum < 50000) continue;
    if (isNaN(liqNum) || liqNum < 20000) continue;
    
    // ===== MEMESCOPE DISCOVERY ALGORITHM v2 =====
    let score = 0;
    
    // 1. VOLUME VELOCITY (0-30 pts) — THE #1 FACTOR
    // How much faster is current volume vs the daily average?
    // A spike from $10K/hr average to $100K/hr = 10x = max score
    if (vol > 0) {
      const hourlyAvg = vol / 24;
      const velocity = hourlyAvg > 0 ? vol1h / hourlyAvg : 0;
      score += Math.min(30, velocity * 3);
    }
    
    // 2. POOL TURNOVER (0-25 pts) — OUR EDGE OVER DEXSCREENER
    // Volume relative to liquidity. High turnover = intense activity in the pool
    // 1x turnover = decent, 5x+ = on fire
    if (liq > 0) {
      const turnover = vol / liq;
      score += Math.min(25, turnover * 3);
    }
    
    // 3. BUY PRESSURE (0-20 pts)
    // More buyers than sellers = demand building
    const t1h = buys1h + sells1h;
    if (t1h > 0) {
      const br = buys1h / t1h;
      if (br > 0.5) score += Math.min(20, (br - 0.5) * 40);
    } else if (buys24 + sells24 > 0) {
      const br = buys24 / (buys24 + sells24);
      if (br > 0.5) score += Math.min(12, (br - 0.5) * 24);
    }
    
    // 4. ANTI-BOT DETECTION (penalty: -10 to 0 pts)
    // If volume is high but transaction count is low, it's likely wash trading
    // Real organic trading = many small transactions, not few huge ones
    if (txns > 0 && vol > 0) {
      const avgTxSize = vol / txns;
      // If average transaction > $5000, suspicious for memecoins
      if (avgTxSize > 10000) score -= 10;
      else if (avgTxSize > 5000) score -= 5;
      // Bonus for high transaction count (organic activity)
      if (txns > 5000) score += 5;
      else if (txns > 1000) score += 3;
    }
    
    // 5. TRANSACTION DENSITY (0-15 pts)
    // Lots of transactions in the last hour = hot right now
    if (t1h > 0) {
      if (t1h > 500) score += 15;
      else if (t1h > 200) score += 10;
      else if (t1h > 50) score += 5;
    }
    
    // 6. PRICE ACCELERATION (0-15 pts)
    // Multiple timeframes green = sustained momentum, not just a spike
    let gc = 0;
    if (p5m > 0) gc++;
    if (p1h > 0) gc++;
    if (p6h > 0) gc++;
    if (p24h > 0) gc++;
    score += gc * 3;
    // Extra bonus if ALL timeframes are green
    if (gc === 4) score += 3;
    
    // 7. AGE BONUS (0-10 pts)
    // Newer tokens that pass all filters are rare finds
    if (ageHours < 1) score += 10;
    else if (ageHours < 6) score += 8;
    else if (ageHours < 24) score += 6;
    else if (ageHours < 72) score += 4;
    else if (ageHours < 168) score += 2;
    
    // 8. LIQUIDITY HEALTH (0-5 pts)
    // Good liq/mcap ratio = less rug risk, more stable
    if (mcap > 0) {
      const lr = liq / mcap;
      if (lr >= 0.10) score += 5;       // 10%+ = very healthy
      else if (lr >= 0.05) score += 4;   // 5-10% = healthy
      else if (lr >= 0.02) score += 2;   // 2-5% = okay
      // Under 2% = no bonus, risky
    }
    
    // 9. VERIFIED INFO BOOST (0-5 pts)
    // Tokens with real socials/website are more trustworthy
    if (website) score += 2;
    if (twitter) score += 2;
    if (best.info?.imageUrl) score += 1;
    
    // ===== END ALGORITHM =====
    
    tokens.push({
      sym, name: best.baseToken.name || sym, img,
      price: best.priceUsd ? parseFloat(best.priceUsd) : 0,
      mcap, vol, liq, p5m, p1h, p6h, p24h,
      age, txn: txns, net: chainMap[best.chainId] || 'solana',
      dex: best.dexId || 'raydium', social: Math.floor(Math.random() * 100),
      boosted: false, _score: score, website, twitter, telegram, ca
    });
  }
  
  tokens.sort((a, b) => b._score - a._score);
  return tokens;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
