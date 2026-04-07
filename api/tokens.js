// api/tokens.js — MemeScope Token API (Optimized for Vercel 10s timeout)
// Parallel fetching + batch DexScreener enrichment

const CACHE_TTL = 120000;
let cache = { data: null, ts: 0 };

const GECKO_CHAINS = ['solana', 'eth', 'base', 'bsc'];

const MEME_SEARCH_TERMS = [
  'pepe','doge','shib','bonk','floki','wojak','chad','meme','inu','cat',
  'frog','moon','elon','trump','ai','grok','brett','toshi','degen','based',
  'pnut','goat'
];

async function safeFetch(url, opts) {
  try {
    const r = await fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function scoreToken(t) {
  let score = 0;
  if (t.mcap > 0) score += Math.min(40, (t.vol / t.mcap) * 40);
  score += Math.min(15, Math.abs(t.p24h || 0) * 0.15);
  score += Math.min(10, Math.abs(t.p1h || 0) * 0.2);
  score += Math.min(8, Math.abs(t.p5m || 0) * 0.3);
  score += Math.min(15, (t.txn || 0) / 500);
  if (t.liq > 100000) score += 8;
  else if (t.liq > 50000) score += 5;
  else if (t.liq > 20000) score += 2;
  if (t.mcap < 500000) score += 10;
  else if (t.mcap < 2000000) score += 5;
  if (t.age && t.age.includes('m')) score += 8;
  else if (t.age && t.age.includes('h')) score += 5;
  else if (t.age && t.age.includes('d')) { if (parseInt(t.age) < 7) score += 3; }
  if (t.website) score += 2;
  if (t.twitter) score += 2;
  return score;
}

function parseDexPair(p) {
  const chainMap = {
    'solana': 'solana', 'ethereum': 'eth', 'base': 'base', 'bsc': 'bsc',
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
    img: tokenImg, price, mcap, vol, liq,
    p5m: pc.m5 ? parseFloat(pc.m5) : 0,
    p1h: pc.h1 ? parseFloat(pc.h1) : 0,
    p6h: pc.h6 ? parseFloat(pc.h6) : 0,
    p24h: pc.h24 ? parseFloat(pc.h24) : 0,
    age, txn: txns, net, dex: p.dexId || '',
    social: 0, boosted: false,
    website: p.info?.websites?.[0]?.url || '',
    twitter: p.info?.socials?.find(s => s.type === 'twitter')?.url || '',
    telegram: p.info?.socials?.find(s => s.type === 'telegram')?.url || '',
    ca: p.baseToken?.address || '',
  };
}

// Batch enrich via DexScreener (comma-separated, up to 30 addresses)
async function batchEnrich(addresses) {
  if (!addresses.length) return [];
  const results = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const url = 'https://api.dexscreener.com/latest/dex/tokens/' + chunk.join(',');
    const data = await safeFetch(url);
    if (data?.pairs) {
      const best = {};
      for (const p of data.pairs) {
        const addr = p.baseToken?.address;
        if (!addr) continue;
        const liq = p.liquidity?.usd || 0;
        if (!best[addr] || liq > (best[addr].liquidity?.usd || 0)) best[addr] = p;
      }
      results.push(...Object.values(best));
    }
  }
  return results;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const search = req.query?.search;
  if (search) {
    const data = await safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(search));
    if (data?.pairs) {
      const results = data.pairs.slice(0, 20).map(parseDexPair).filter(t => t.mcap >= 1000);
      return res.status(200).json({ tokens: results, search: true });
    }
    return res.status(200).json({ tokens: [], search: true });
  }

  if (cache.data && (Date.now() - cache.ts < CACHE_TTL)) {
    return res.status(200).json({ tokens: cache.data, cached: true });
  }

  try {
    const seenCAs = new Set();
    const allTokens = [];

    function addToken(t) {
      if (!t.ca || seenCAs.has(t.ca)) return;
      if (t.mcap < 50000 || t.liq < 20000) return;
      seenCAs.add(t.ca);
      allTokens.push(t);
    }

    // ========= ALL PHASES IN PARALLEL =========

    // Phase 1: GeckoTerminal trending + new (all 8 chains, 16 requests parallel)
    const geckoPromises = GECKO_CHAINS.flatMap(chain => [
      safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/trending_pools?page=1', { headers: { 'Accept': 'application/json' } }),
      safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/new_pools?page=1', { headers: { 'Accept': 'application/json' } }),
    ]);

    // Phase 2: DexScreener profiles + boosted
    const dsProfilePromise = safeFetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const dsBoostedPromise = safeFetch('https://api.dexscreener.com/token-boosts/latest/v1');

    // Phase 3: Meme search terms (all 22 in parallel)
    const searchPromises = MEME_SEARCH_TERMS.map(term =>
      safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + term)
    );

    // FIRE EVERYTHING AT ONCE
    const [geckoResults, profiles, boosted, ...searchResults] = await Promise.all([
      Promise.all(geckoPromises),
      dsProfilePromise,
      dsBoostedPromise,
      ...searchPromises,
    ]);

    // --- Process GeckoTerminal results ---
    const geckoAddresses = new Set();
    for (const data of geckoResults) {
      if (!data?.data) continue;
      for (const pool of data.data.slice(0, 15)) {
        // Try to get token address from relationship
        const tokenId = pool.relationships?.base_token?.data?.id || '';
        const underscoreIdx = tokenId.indexOf('_');
        if (underscoreIdx > -1) {
          geckoAddresses.add(tokenId.substring(underscoreIdx + 1));
        }
      }
    }

    // --- Process DexScreener profiles/boosted ---
    const dsAddresses = new Set();
    if (profiles) {
      for (const p of profiles.slice(0, 40)) {
        if (p.tokenAddress) dsAddresses.add(p.tokenAddress);
      }
    }
    if (boosted) {
      for (const p of boosted.slice(0, 30)) {
        if (p.tokenAddress) {
          dsAddresses.add(p.tokenAddress);
          // NOT marking as boosted — only MemeScope's own boost system does that
        }
      }
    }

    // --- Process search results directly (they already have pair data) ---
    for (const data of searchResults) {
      if (data?.pairs) {
        for (const p of data.pairs.slice(0, 5)) {
          addToken(parseDexPair(p));
        }
      }
    }

    // --- Batch enrich GeckoTerminal + DexScreener addresses ---
    const allAddresses = [...new Set([...geckoAddresses, ...dsAddresses])];
    const enriched = await batchEnrich(allAddresses.slice(0, 120));
    for (const p of enriched) {
      addToken(parseDexPair(p));
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
