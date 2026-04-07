// api/tokens.js — MemeScope Token API
// Pulls from GeckoTerminal trending + new pools (7 chains)
// + DexScreener profiles/boosted/meme search terms
// Batch enriches via DexScreener, scores, filters, caches

const CACHE_TTL = 120000; // 2 minutes
let cache = { data: null, ts: 0 };

// === 7 CHAINS ===
const GECKO_CHAINS = ['solana', 'eth', 'base', 'bsc', 'tron', 'polygon_pos', 'arbitrum', 'abstract'];

const MEME_SEARCH_TERMS = [
  'pepe','doge','shib','bonk','floki','wojak','chad','meme','inu','cat',
  'frog','moon','elon','trump','ai','grok','brett','toshi','degen','based',
  'pnut','goat'
];

const HARD_FILTERS = {
  minMcap: 50000,
  minLiq: 20000,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeFetch(url, opts) {
  try {
    const r = await fetch(url, opts || {});
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Score a token
function scoreToken(t) {
  let score = 0;
  // Volume velocity
  if (t.mcap > 0) score += Math.min(40, (t.vol / t.mcap) * 40);
  // Price action
  score += Math.min(15, Math.abs(t.p24h || 0) * 0.15);
  score += Math.min(10, Math.abs(t.p1h || 0) * 0.2);
  score += Math.min(8, Math.abs(t.p5m || 0) * 0.3);
  // Transaction density
  score += Math.min(15, (t.txn || 0) / 500);
  // Liquidity health
  if (t.liq > 100000) score += 8;
  else if (t.liq > 50000) score += 5;
  else if (t.liq > 20000) score += 2;
  // Low mcap bonus
  if (t.mcap < 500000) score += 10;
  else if (t.mcap < 2000000) score += 5;
  // Age bonus (newer = more interesting)
  if (t.age && t.age.includes('m')) score += 8;
  else if (t.age && t.age.includes('h')) score += 5;
  else if (t.age && t.age.includes('d')) {
    const days = parseInt(t.age);
    if (days < 7) score += 3;
  }
  // Social/verified bonus
  if (t.social > 50) score += 5;
  if (t.website) score += 2;
  if (t.twitter) score += 2;
  return score;
}

function parseDexPair(p) {
  const chainMap = {
    'solana': 'solana',
    'ethereum': 'eth',
    'base': 'base',
    'bsc': 'bsc',
    'tron': 'tron',
    'polygon_pos': 'polygon',
    'arbitrum': 'arbitrum',
    'abstract': 'abstract',
  };
  const net = chainMap[p.chainId] || p.chainId || 'solana';
  const price = p.priceUsd ? parseFloat(p.priceUsd) : 0;
  const mcap = p.marketCap || p.fdv || 0;
  const vol = p.volume ? (p.volume.h24 || 0) : 0;
  const liq = p.liquidity ? (p.liquidity.usd || 0) : 0;
  const pc = p.priceChange || {};

  let age = '??';
  if (p.pairCreatedAt) {
    const ageHrs = (Date.now() - p.pairCreatedAt) / 3600000;
    if (ageHrs < 1) age = Math.round(ageHrs * 60) + 'm';
    else if (ageHrs < 24) age = Math.round(ageHrs) + 'h';
    else if (ageHrs < 720) age = Math.round(ageHrs / 24) + 'd';
    else if (ageHrs < 8760) age = Math.round(ageHrs / 720) + 'mo';
    else age = Math.round(ageHrs / 8760) + 'y';
  }

  let txns = 0;
  if (p.txns && p.txns.h24) txns = (p.txns.h24.buys || 0) + (p.txns.h24.sells || 0);

  let tokenImg = '';
  if (p.info && p.info.imageUrl) tokenImg = p.info.imageUrl;

  return {
    sym: p.baseToken ? p.baseToken.symbol.toUpperCase() : '???',
    name: p.baseToken ? p.baseToken.name : 'Unknown',
    img: tokenImg,
    price, mcap, vol, liq,
    p5m: pc.m5 ? parseFloat(pc.m5) : 0,
    p1h: pc.h1 ? parseFloat(pc.h1) : 0,
    p6h: pc.h6 ? parseFloat(pc.h6) : 0,
    p24h: pc.h24 ? parseFloat(pc.h24) : 0,
    age, txn: txns, net, 
    dex: p.dexId || '',
    social: 0, boosted: false,
    website: p.info?.websites?.[0]?.url || '',
    twitter: p.info?.socials?.find(s => s.type === 'twitter')?.url || '',
    telegram: p.info?.socials?.find(s => s.type === 'telegram')?.url || '',
    ca: p.baseToken?.address || '',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Search mode
  const search = req.query?.search;
  if (search) {
    const data = await safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(search));
    if (data && data.pairs) {
      const results = data.pairs.slice(0, 20).map(parseDexPair).filter(t => t.mcap >= 1000);
      return res.status(200).json({ tokens: results, search: true });
    }
    return res.status(200).json({ tokens: [], search: true });
  }

  // Check cache
  if (cache.data && (Date.now() - cache.ts < CACHE_TTL)) {
    return res.status(200).json({ tokens: cache.data, cached: true });
  }

  try {
    const seenCAs = new Set();
    const allTokens = [];

    function addToken(t) {
      if (!t.ca || seenCAs.has(t.ca)) return;
      if (t.mcap < HARD_FILTERS.minMcap || t.liq < HARD_FILTERS.minLiq) return;
      seenCAs.add(t.ca);
      allTokens.push(t);
    }

    // 1. GeckoTerminal trending pools (7 chains)
    for (const chain of GECKO_CHAINS) {
      const data = await safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/trending_pools?page=1', { headers: { 'Accept': 'application/json' } });
      if (data?.data) {
        for (const pool of data.data) {
          const addr = pool.attributes?.address;
          if (!addr) continue;
          // Enrich via DexScreener
          const ds = await safeFetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);
          if (ds?.pairs?.[0]) addToken(parseDexPair(ds.pairs[0]));
        }
      }
      await sleep(200);
    }

    // 2. GeckoTerminal new pools (7 chains)
    for (const chain of GECKO_CHAINS) {
      const data = await safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/new_pools?page=1', { headers: { 'Accept': 'application/json' } });
      if (data?.data) {
        for (const pool of data.data.slice(0, 10)) {
          const addr = pool.attributes?.address;
          if (!addr) continue;
          const ds = await safeFetch('https://api.dexscreener.com/latest/dex/pairs/' + chain + '/' + addr);
          if (ds?.pairs?.[0]) addToken(parseDexPair(ds.pairs[0]));
        }
      }
      await sleep(200);
    }

    // 3. DexScreener token profiles
    const profiles = await safeFetch('https://api.dexscreener.com/token-profiles/latest/v1');
    if (profiles) {
      const addrs = profiles.slice(0, 30).map(p => p.tokenAddress).filter(Boolean);
      for (let i = 0; i < addrs.length; i += 5) {
        const batch = addrs.slice(i, i + 5);
        for (const addr of batch) {
          const ds = await safeFetch('https://api.dexscreener.com/latest/dex/tokens/' + addr);
          if (ds?.pairs?.[0]) addToken(parseDexPair(ds.pairs[0]));
        }
        await sleep(200);
      }
    }

    // 4. DexScreener boosted tokens
    const boosted = await safeFetch('https://api.dexscreener.com/token-boosts/latest/v1');
    if (boosted) {
      const addrs = boosted.slice(0, 20).map(p => p.tokenAddress).filter(Boolean);
      for (const addr of addrs) {
        const ds = await safeFetch('https://api.dexscreener.com/latest/dex/tokens/' + addr);
        if (ds?.pairs?.[0]) {
          const t = parseDexPair(ds.pairs[0]);
          t.boosted = true;
          addToken(t);
        }
      }
      await sleep(200);
    }

    // 5. DexScreener meme search terms
    for (const term of MEME_SEARCH_TERMS) {
      const data = await safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + term);
      if (data?.pairs) {
        for (const p of data.pairs.slice(0, 5)) {
          addToken(parseDexPair(p));
        }
      }
      await sleep(150);
    }

    // Score and sort
    for (const t of allTokens) {
      t._score = scoreToken(t);
      t.social = Math.min(100, Math.round(t._score));
    }
    allTokens.sort((a, b) => b._score - a._score);

    cache = { data: allTokens, ts: Date.now() };
    return res.status(200).json({ tokens: allTokens, cached: false });

  } catch (err) {
    if (cache.data) return res.status(200).json({ tokens: cache.data, cached: true, error: err.message });
    return res.status(500).json({ error: err.message });
  }
}
