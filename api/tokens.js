// api/tokens.js — MemeScope Token API (Reads from Supabase)
// Cloudflare Worker fills the database every 2 minutes
// This API just reads from it — super fast

const SUPABASE_URL = 'https://rkemboxtxdlkincfkxil.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8YVBJrxaLmYTcwy_d6_8mw_aPhaH_YE';

const CACHE_TTL = 30000; // 30 second in-memory cache
let cache = { data: null, ts: 0 };

async function safeFetch(url, opts) {
  try {
    const r = await fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Convert database row to the format MemeScope frontend expects
function formatToken(row) {
  // Calculate age string from timestamp
  let age = '??';
  if (row.age) {
    const ageHrs = (Date.now() - new Date(row.age).getTime()) / 3600000;
    if (ageHrs < 1) age = Math.round(ageHrs * 60) + 'm';
    else if (ageHrs < 24) age = Math.round(ageHrs) + 'h';
    else if (ageHrs < 720) age = Math.round(ageHrs / 24) + 'd';
    else if (ageHrs < 8760) age = Math.round(ageHrs / 720) + 'mo';
    else age = Math.round(ageHrs / 8760) + 'y';
  }

  return {
    sym: row.symbol || '???',
    name: row.name || 'Unknown',
    img: row.image || '',
    price: row.price || 0,
    mcap: row.mcap || 0,
    vol: row.volume || 0,
    liq: row.liquidity || 0,
    p5m: row.p5m || 0,
    p1h: row.p1h || 0,
    p6h: row.p6h || 0,
    p24h: row.p24h || 0,
    age: age,
    txn: row.txns || 0,
    net: row.chain || 'solana',
    dex: row.dex || '',
    social: 0,
    boosted: row.boosted || false,
    website: row.website || '',
    twitter: row.twitter || '',
    telegram: row.telegram || '',
    ca: row.address || '',
  };
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

// DexScreener pair parser for live search fallback
function parseDexPair(p) {
  const chainMap = {
    'solana': 'solana', 'ethereum': 'eth', 'base': 'base', 'bsc': 'bsc', 'sui': 'sui', 'tron': 'tron',
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

  return {
    sym: p.baseToken ? p.baseToken.symbol.toUpperCase() : '???',
    name: p.baseToken ? p.baseToken.name : 'Unknown',
    img: p.info?.imageUrl || '',
    price, mcap, vol, liq,
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // === LIVE SEARCH — goes direct to DexScreener ===
  const search = req.query?.search;
  if (search) {
    const data = await safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(search));
    if (data?.pairs) {
      const results = data.pairs.slice(0, 20).map(parseDexPair).filter(t => t.mcap >= 1000);
      return res.status(200).json({ tokens: results, search: true });
    }
    return res.status(200).json({ tokens: [], search: true });
  }

  // === MAIN FEED — read from Supabase ===
  if (cache.data && (Date.now() - cache.ts < CACHE_TTL)) {
    return res.status(200).json({ tokens: cache.data, cached: true });
  }

  try {
    // Fetch tokens updated in the last 4 hours, ordered by volume
    const supabaseResp = await fetch(
      SUPABASE_URL + '/rest/v1/tokens?select=*&updated_at=gte.' + new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString() + '&order=volume.desc&limit=1000',
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
        },
      }
    );

    if (!supabaseResp.ok) {
      throw new Error('Supabase fetch failed: ' + supabaseResp.status);
    }

    const rows = await supabaseResp.json();

    // Convert to frontend format and score
    const tokens = rows.map(formatToken);
    for (const t of tokens) {
      t._score = scoreToken(t);
      t.social = Math.min(100, Math.round(t._score));
    }
    tokens.sort((a, b) => b._score - a._score);

    cache = { data: tokens, ts: Date.now() };
    return res.status(200).json({ tokens: tokens, cached: false, count: tokens.length });

  } catch (err) {
    if (cache.data) return res.status(200).json({ tokens: cache.data, cached: true, error: err.message });
    return res.status(500).json({ error: err.message });
  }
}
