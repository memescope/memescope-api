// MemeScope API - Vercel Serverless Function
// Aggregates GeckoTerminal trending/new pools + DexScreener enrichment
// Caches results for 2 minutes so users get instant responses

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 120000; // 2 minutes

export default async function handler(req, res) {
  // CORS headers so MemeScope can call this from any domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Live search: if ?search=<address> is passed, do a direct DexScreener lookup
  const searchQuery = req.query.search || req.query.q;
  if (searchQuery) {
    try {
      const searchResults = await searchToken(searchQuery);
      return res.status(200).json({ tokens: searchResults, source: 'live_search', cached: false });
    } catch (e) {
      return res.status(500).json({ error: 'Search failed', message: e.message });
    }
  }

  // Return cached data if still fresh
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return res.status(200).json({ tokens: cache.data, cached: true, age: Math.round((now - cache.timestamp) / 1000) });
  }

  // Fetch fresh data
  try {
    const tokens = await fetchAllTokens();
    cache = { data: tokens, timestamp: Date.now() };
    return res.status(200).json({ tokens, cached: false, count: tokens.length });
  } catch (e) {
    // If fetch fails but we have stale cache, return it
    if (cache.data) {
      return res.status(200).json({ tokens: cache.data, cached: true, stale: true });
    }
    return res.status(500).json({ error: 'Fetch failed', message: e.message });
  }
}

// ===== LIVE SEARCH =====
async function searchToken(query) {
  const tokens = [];
  
  // Try DexScreener token lookup (for contract addresses)
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + query);
    if (r.ok) {
      const d = await r.json();
      if (d && d.pairs && d.pairs.length > 0) {
        const parsed = parseDexPairs(d.pairs);
        tokens.push(...parsed);
      }
    }
  } catch (e) {}
  
  // Also try DexScreener search (for names/symbols)
  if (tokens.length === 0) {
    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(query));
      if (r.ok) {
        const d = await r.json();
        if (d && d.pairs && d.pairs.length > 0) {
          const parsed = parseDexPairs(d.pairs.slice(0, 20));
          tokens.push(...parsed);
        }
      }
    } catch (e) {}
  }
  
  return tokens;
}

// ===== MAIN FETCH =====
async function fetchAllTokens() {
  const allAddresses = new Set();
  
  // STEP 1: GeckoTerminal - trending pools from all chains (organic trending)
  const chains = ['solana', 'eth', 'base', 'bsc'];
  
  for (const chain of chains) {
    // Trending pools - pages 1-5 (more pages = more tokens)
    for (let page = 1; page <= 5; page++) {
      try {
        const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${chain}/trending_pools?page=${page}`);
        if (r.status === 429) {
          await sleep(2000);
          continue;
        }
        if (r.ok) {
          const d = await r.json();
          if (d && d.data) {
            for (const pool of d.data) {
              const addr = extractTokenAddress(pool);
              if (addr) allAddresses.add(addr);
            }
          }
        }
      } catch (e) {}
      await sleep(150);
    }
    
    // New pools - pages 1-3 (catch early movers)
    for (let page = 1; page <= 3; page++) {
      try {
        const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${chain}/new_pools?page=${page}`);
        if (r.status === 429) { await sleep(2000); continue; }
        if (r.ok) {
          const d = await r.json();
          if (d && d.data) {
            for (const pool of d.data) {
              const addr = extractTokenAddress(pool);
              if (addr) allAddresses.add(addr);
            }
          }
        }
      } catch (e) {}
      await sleep(150);
    }
  }
  
  console.log(`GeckoTerminal: ${allAddresses.size} unique token addresses`);
  
  // STEP 2: DexScreener profiles (registered tokens)
  try {
    const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d)) {
        for (const t of d) {
          if (t.tokenAddress) allAddresses.add(t.tokenAddress);
        }
      }
    }
  } catch (e) {}
  
  // STEP 3: DexScreener boosted tokens (paid but often active)
  try {
    const r = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d)) {
        for (const t of d) {
          if (t.tokenAddress) allAddresses.add(t.tokenAddress);
        }
      }
    }
  } catch (e) {}
  
  // STEP 4: DexScreener search for meme/trending terms (top 10 per term)
  const memeTerms = [
    'pepe', 'doge', 'cat', 'trump', 'ai', 'meme', 'frog', 'dog', 'bonk', 'wif',
    'shib', 'floki', 'neiro', 'popcat', 'brett', 'goat', 'pnut', 'elon', 'wojak', 'chad',
    'sol', 'moon', 'pump', 'baby', 'inu', 'king', 'giga', 'based', 'degen', 'turbo'
  ];
  
  for (const term of memeTerms) {
    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + term);
      if (r.ok) {
        const d = await r.json();
        if (d && d.pairs) {
          const sorted = d.pairs.sort((a, b) => ((b.volume?.h24 || 0) - (a.volume?.h24 || 0)));
          for (let i = 0; i < Math.min(10, sorted.length); i++) {
            if (sorted[i].baseToken?.address) {
              allAddresses.add(sorted[i].baseToken.address);
            }
          }
        }
      }
    } catch (e) {}
  }
  
  console.log(`Total unique addresses: ${allAddresses.size}`);
  
  // STEP 4: Batch fetch from DexScreener for full pair data (images, socials, price changes)
  const addressList = [...allAddresses];
  const allPairs = [];
  
  for (let i = 0; i < addressList.length; i += 30) {
    const chunk = addressList.slice(i, i + 30);
    try {
      const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + chunk.join(','));
      if (r.ok) {
        const d = await r.json();
        if (d && d.pairs) allPairs.push(...d.pairs);
      }
    } catch (e) {}
    await sleep(100);
  }
  
  console.log(`DexScreener: ${allPairs.length} pairs from ${Math.ceil(addressList.length / 30)} batch calls`);
  
  // STEP 5: Parse and deduplicate
  return parseDexPairs(allPairs);
}

// ===== HELPERS =====
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
    if (!byAddr[addr] || liq > (byAddr[addr].liquidity?.usd || 0)) {
      byAddr[addr] = p;
    }
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
    const mcap = best.marketCap || best.fdv || 0;
    const vol = best.volume?.h24 || 0;
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
    
    let age = '??';
    if (best.pairCreatedAt) {
      const h = (Date.now() - best.pairCreatedAt) / 3600000;
      if (h < 1) age = Math.round(h * 60) + 'm';
      else if (h < 24) age = Math.round(h) + 'h';
      else if (h < 720) age = Math.round(h / 24) + 'd';
      else age = Math.round(h / 720) + 'mo';
    }
    
    let txns = 0;
    let buys24 = 0, sells24 = 0;
    let buys1h = 0, sells1h = 0;
    if (best.txns?.h24) {
      buys24 = best.txns.h24.buys || 0;
      sells24 = best.txns.h24.sells || 0;
      txns = buys24 + sells24;
    }
    if (best.txns?.h1) {
      buys1h = best.txns.h1.buys || 0;
      sells1h = best.txns.h1.sells || 0;
    }
    
    const liq = best.liquidity?.usd || 0;
    const p5m = pc.m5 ? parseFloat(pc.m5) : 0;
    const p1h = pc.h1 ? parseFloat(pc.h1) : 0;
    const p6h = pc.h6 ? parseFloat(pc.h6) : 0;
    const p24h = pc.h24 ? parseFloat(pc.h24) : 0;
    const vol1h = best.volume?.h1 || 0;
    
    // ===== MEMESCOPE DISCOVERY ALGORITHM =====
    // HARD FILTERS: must pass or get excluded
    if (mcap < 50000 || liq < 20000) continue; // Skip tokens under 50K mcap or 20K liquidity
    
    let score = 0;
    
    // 1. VOLUME MOMENTUM (0-30 pts)
    // How much of 24h volume happened in the last hour? Higher = hotter right now
    if (vol > 0) {
      const volMomentum = vol1h / (vol / 24); // ratio vs hourly average
      score += Math.min(30, volMomentum * 5);
    }
    
    // 2. BUY PRESSURE (0-25 pts)
    // More buyers than sellers = demand building
    const totalTxns1h = buys1h + sells1h;
    if (totalTxns1h > 0) {
      const buyRatio = buys1h / totalTxns1h;
      if (buyRatio > 0.5) score += Math.min(25, (buyRatio - 0.5) * 50); // 0-25 pts for 50-100% buy ratio
    } else if (buys24 + sells24 > 0) {
      const buyRatio24 = buys24 / (buys24 + sells24);
      if (buyRatio24 > 0.5) score += Math.min(15, (buyRatio24 - 0.5) * 30);
    }
    
    // 3. AGE BONUS (0-20 pts)
    // Younger tokens that already passed the filters are rare finds
    let ageHours = 999;
    if (best.pairCreatedAt) {
      ageHours = (Date.now() - best.pairCreatedAt) / 3600000;
    }
    if (ageHours < 1) score += 20;        // Under 1 hour
    else if (ageHours < 6) score += 16;    // Under 6 hours
    else if (ageHours < 24) score += 12;   // Under 1 day
    else if (ageHours < 72) score += 8;    // Under 3 days
    else if (ageHours < 168) score += 4;   // Under 1 week
    
    // 4. PRICE ACCELERATION (0-20 pts)
    // Multiple timeframes green = sustained momentum
    let greenCount = 0;
    if (p5m > 0) greenCount++;
    if (p1h > 0) greenCount++;
    if (p6h > 0) greenCount++;
    if (p24h > 0) greenCount++;
    score += greenCount * 5; // 5 pts per green timeframe
    
    // 5. LIQUIDITY HEALTH (0-5 pts)
    // Healthy liq/mcap ratio means less rug risk
    if (mcap > 0) {
      const liqRatio = liq / mcap;
      if (liqRatio >= 0.05) score += 5;      // 5%+ liq/mcap = healthy
      else if (liqRatio >= 0.02) score += 3;  // 2-5% = okay
      else score += 1;                         // Under 2% = risky
    }
    
    // ===== END ALGORITHM =====
    
    tokens.push({
      sym, name: best.baseToken.name || sym, img,
      price: best.priceUsd ? parseFloat(best.priceUsd) : 0,
      mcap, vol, liq,
      p5m, p1h, p6h, p24h,
      age, txn: txns,
      net: chainMap[best.chainId] || 'solana',
      dex: best.dexId || 'raydium',
      social: Math.floor(Math.random() * 100),
      boosted: false, _score: score,
      website, twitter, telegram, ca
    });
  }
  
  tokens.sort((a, b) => b._score - a._score);
  return tokens;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
