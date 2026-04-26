// api/tokens.js — MemeScope Token API (Hybrid: Live + Supabase)
// Main feed: Live from DexScreener/GeckoTerminal (always fresh)
// Search: Checks Supabase first (for blue chips like PEPE), then DexScreener
// Fallback: If live fetch fails, serve from Supabase

const SUPABASE_URL = 'https://rkemboxtxdlkincfkxil.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8YVBJrxaLmYTcwy_d6_8mw_aPhaH_YE';

const CACHE_TTL = 120000;
let cache = { data: null, ts: 0 };

const GECKO_CHAINS = ['solana', 'eth', 'base', 'bsc', 'sui-network', 'tron', 'arbitrum', 'avax', 'polygon_pos', 'optimism', 'blast', 'ton'];

const MEME_SEARCH_TERMS = [
  'pepe','doge','shib','bonk','floki','wojak','chad','meme','inu','cat',
  'frog','moon','elon','trump','ai','grok','brett','toshi','degen','based',
  'pnut','goat','virtual','anime','neiro','popcat','wif','render','pengu',
  'bome','turbo','ponke','mog','dog','rocket','pork','sol','sui'
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
    'solana': 'solana', 'ethereum': 'eth', 'base': 'base', 'bsc': 'bsc', 'sui': 'sui', 'tron': 'tron',
    'arbitrum': 'arbitrum', 'avalanche': 'avalanche', 'polygon': 'polygon', 'optimism': 'optimism', 'blast': 'blast', 'ton': 'ton',
  };
  const net = chainMap[p.chainId] || p.chainId || 'solana';
  const price = p.priceUsd ? parseFloat(p.priceUsd) : 0;
  const mcap = p.marketCap || p.fdv || 0;
  const vol = p.volume ? (p.volume.h24 || 0) : 0;
  const liq = p.liquidity ? (p.liquidity.usd || 0) : 0;
  const pc = p.priceChange || {};

  let age = '\u2014';
  if (p.pairCreatedAt) {
    const ageHrs = (Date.now() - p.pairCreatedAt) / 3600000;
    if (ageHrs < 0 || ageHrs > 43800) age = '\u2014';
    else if (ageHrs < 1) age = Math.round(ageHrs * 60) + 'm';
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
    pair: p.quoteToken ? p.quoteToken.symbol.toUpperCase() : '',
    pairAddress: p.pairAddress || '',
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

// Supabase fallback — read from database
async function fetchFromSupabase() {
  try {
    const resp = await fetch(
      SUPABASE_URL + '/rest/v1/tokens?select=*&updated_at=gte.' + new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() + '&order=volume.desc&limit=1000',
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
        },
      }
    );
    if (!resp.ok) return [];
    const rows = await resp.json();
    return rows.map(row => {
      let age = '2014';
      if (row.age) {
        const ageHrs = (Date.now() - new Date(row.age).getTime()) / 3600000;
        if (ageHrs < 1) age = Math.round(ageHrs * 60) + 'm';
        else if (ageHrs < 24) age = Math.round(ageHrs) + 'h';
        else if (ageHrs < 720) age = Math.round(ageHrs / 24) + 'd';
        else if (ageHrs < 8760) age = Math.round(ageHrs / 720) + 'mo';
        else age = Math.round(ageHrs / 8760) + 'y';
      }
      return {
        sym: row.symbol || '???', name: row.name || 'Unknown',
        img: row.image || '', price: row.price || 0,
        mcap: row.mcap || 0, vol: row.volume || 0, liq: row.liquidity || 0,
        p5m: row.p5m || 0, p1h: row.p1h || 0, p6h: row.p6h || 0, p24h: row.p24h || 0,
        age, txn: row.txns || 0, net: row.chain || 'solana', dex: row.dex || '',
        social: 0, boosted: row.boosted || false,
        website: row.website || '', twitter: row.twitter || '', telegram: row.telegram || '',
        ca: row.address || '', pairAddress: row.pair_address || '',
      };
    });
  } catch { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // === SEARCH — check Supabase + DexScreener ===
  const search = req.query?.search;
  if (search) {
    // Search both Supabase and DexScreener in parallel
    const [dexData, supabaseResp] = await Promise.all([
      safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(search)),
      fetch(
        SUPABASE_URL + '/rest/v1/tokens?select=*&or=(symbol.ilike.*' + encodeURIComponent(search) + '*,name.ilike.*' + encodeURIComponent(search) + '*)&order=mcap.desc&limit=10',
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
      ).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);

    const results = [];
    const seenCA = new Set();

    // Add Supabase results first (has blue chips like PEPE)
    for (const row of supabaseResp) {
      if (!row.address || seenCA.has(row.address)) continue;
      seenCA.add(row.address);
      let age = '2014';
      if (row.age) {
        const ageHrs = (Date.now() - new Date(row.age).getTime()) / 3600000;
        if (ageHrs < 1) age = Math.round(ageHrs * 60) + 'm';
        else if (ageHrs < 24) age = Math.round(ageHrs) + 'h';
        else if (ageHrs < 720) age = Math.round(ageHrs / 24) + 'd';
        else if (ageHrs < 8760) age = Math.round(ageHrs / 720) + 'mo';
        else age = Math.round(ageHrs / 8760) + 'y';
      }
      results.push({
        sym: row.symbol, name: row.name, img: row.image || '', price: row.price || 0,
        mcap: row.mcap || 0, vol: row.volume || 0, liq: row.liquidity || 0,
        p5m: row.p5m || 0, p1h: row.p1h || 0, p6h: row.p6h || 0, p24h: row.p24h || 0,
        age, txn: row.txns || 0, net: row.chain || 'solana', dex: row.dex || '',
        social: 0, boosted: false, ca: row.address,
        pairAddress: row.pair_address || '',
        website: row.website || '', twitter: row.twitter || '', telegram: row.telegram || '',
      });
    }

    // Add DexScreener results
    if (dexData?.pairs) {
      for (const p of dexData.pairs.slice(0, 20)) {
        const t = parseDexPair(p);
        if (t.ca && !seenCA.has(t.ca) && t.mcap >= 1000) {
          seenCA.add(t.ca);
          results.push(t);
        }
      }
    }

    results.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
    return res.status(200).json({ tokens: results.slice(0, 20), search: true });
  }

  // === MAIN FEED — live fetch, Supabase fallback ===
  if (cache.data && (Date.now() - cache.ts < CACHE_TTL)) {
    return res.status(200).json({ tokens: cache.data, cached: true });
  }

  try {
    const seenCAs = new Set();
    const allTokens = [];

    function addToken(t) {
      if (!t.ca || seenCAs.has(t.ca)) return;
      if (!t.img) return;
      if (t.mcap < 10000 || t.liq < 5000) return;
      if (t.liq > 0 && t.mcap / t.liq > 50) return;
      if (t.age && (t.age.endsWith('m') && parseInt(t.age) < 30)) return;
      // Scam filters: volume way too high vs mcap, or liquidity too thin vs volume
      if (t.vol > 0 && t.mcap > 0 && t.vol / t.mcap > 15) return;
      if (t.vol > 0 && t.liq > 0 && t.vol / t.liq > 100) return;
      seenCAs.add(t.ca);
      allTokens.push(t);
    }

    // ========= ALL PHASES IN PARALLEL =========

    const geckoPromises = GECKO_CHAINS.flatMap(chain => [
      safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/trending_pools?page=1&include=base_token', { headers: { 'Accept': 'application/json' } }),
      safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/trending_pools?page=2&include=base_token', { headers: { 'Accept': 'application/json' } }),
      safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/trending_pools?page=3&include=base_token', { headers: { 'Accept': 'application/json' } }),
      safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/new_pools?page=1&include=base_token', { headers: { 'Accept': 'application/json' } }),
      safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/new_pools?page=2&include=base_token', { headers: { 'Accept': 'application/json' } }),
    ]);

    const dsProfilePromise = safeFetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const dsBoostedPromise = safeFetch('https://api.dexscreener.com/token-boosts/latest/v1');

    const searchPromises = MEME_SEARCH_TERMS.map(term =>
      safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + term)
    );

    const cgTrendingPromise = safeFetch('https://api.coingecko.com/api/v3/search/trending');

    const dsChainSearches = [
      'cetus sui', 'turbos sui', 'bluefin sui', 'sundog tron',
      'pump fun', 'sunpump', 'viral', 'nft', 'gaming',
      'camelot arbitrum', 'trader joe avalanche', 'quickswap polygon',
      'velodrome optimism', 'thruster blast', 'ston fi ton'
    ].map(q => safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q)));

    const [geckoResults, profiles, boosted, cgTrending, dsChainResults, ...searchResults] = await Promise.all([
      Promise.all(geckoPromises),
      dsProfilePromise,
      dsBoostedPromise,
      cgTrendingPromise,
      Promise.all(dsChainSearches),
      ...searchPromises,
    ]);

    // --- Process GeckoTerminal ---
    const geckoAddresses = new Set();
    const geckoImages = {};
    for (const data of geckoResults) {
      if (!data?.data) continue;
      if (data.included) {
        for (const inc of data.included) {
          if (inc.type === 'token' && inc.attributes?.image_url) {
            const tid = inc.id || '';
            const uidx = tid.indexOf('_');
            if (uidx > -1) {
              geckoImages[tid.substring(uidx + 1)] = inc.attributes.image_url;
            }
          }
        }
      }
      for (const pool of data.data.slice(0, 20)) {
        const tokenId = pool.relationships?.base_token?.data?.id || '';
        const underscoreIdx = tokenId.indexOf('_');
        if (underscoreIdx > -1) {
          geckoAddresses.add(tokenId.substring(underscoreIdx + 1));
        }
      }
    }

    // --- Process DexScreener profiles/boosted ---
    const dsAddresses = new Set();
    const profileAddresses = new Set();
    if (profiles) {
      for (const p of profiles.slice(0, 80)) {
        if (p.tokenAddress) {
          dsAddresses.add(p.tokenAddress);
          if (p.header) profileAddresses.add(p.tokenAddress);
        }
      }
    }
    if (boosted) {
      for (const p of boosted.slice(0, 60)) {
        if (p.tokenAddress) dsAddresses.add(p.tokenAddress);
      }
    }

    // --- Process search results ---
    for (const data of searchResults) {
      if (data?.pairs) {
        for (const p of data.pairs.slice(0, 10)) {
          addToken(parseDexPair(p));
        }
      }
    }

    // --- Process CoinGecko trending ---
    const cgAddresses = new Set();
    if (cgTrending?.coins) {
      for (const c of cgTrending.coins) {
        const item = c.item;
        if (item?.platforms) {
          for (const [platform, addr] of Object.entries(item.platforms)) {
            if (addr) cgAddresses.add(addr);
          }
        }
      }
    }

    // --- Process chain searches ---
    for (const data of dsChainResults) {
      if (data?.pairs) {
        for (const p of data.pairs.slice(0, 15)) {
          addToken(parseDexPair(p));
        }
      }
    }

    // --- Batch enrich ---
    const allAddresses = [...new Set([...geckoAddresses, ...dsAddresses, ...cgAddresses])];
    const enriched = await batchEnrich(allAddresses.slice(0, 250));
    for (const p of enriched) {
      addToken(parseDexPair(p));
    }

    // Score and sort live tokens
    for (const t of allTokens) {
      if (!t.img && t.ca && geckoImages[t.ca]) {
        t.img = geckoImages[t.ca];
      }
      t._score = scoreToken(t);
      t.social = Math.min(100, Math.round(t._score));
      t.hasProfile = profileAddresses.has(t.ca);
    }

    allTokens.sort((a, b) => b._score - a._score);

    cache = { data: allTokens, ts: Date.now() };
    return res.status(200).json({ tokens: allTokens, cached: false, source: 'live' });

  } catch (err) {
    // Live fetch failed — fall back to Supabase
    if (cache.data) {
      return res.status(200).json({ tokens: cache.data, cached: true, error: err.message });
    }

    // No cache either — try Supabase
    try {
      const sbTokens = await fetchFromSupabase();
      if (sbTokens.length > 0) {
        for (const t of sbTokens) {
          t._score = scoreToken(t);
          t.social = Math.min(100, Math.round(t._score));
        }
        sbTokens.sort((a, b) => b._score - a._score);
        return res.status(200).json({ tokens: sbTokens, cached: false, source: 'supabase' });
      }
    } catch {}

    return res.status(500).json({ error: err.message });
  }
}
