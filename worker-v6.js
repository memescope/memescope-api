// MemeScope Cloudflare Worker Scraper v6
// v5 scraper + OHLCV proxy (no cold starts = instant chart data)

const GECKO_CHAINS = ['solana', 'eth', 'base', 'bsc', 'sui-network', 'tron'];

const SEARCH_GROUPS = [
  ['pepe','doge','shib','bonk','floki','wojak','chad','meme','inu','cat','frog','moon'],
  ['elon','trump','ai','grok','brett','toshi','degen','based','pnut','goat','virtual','anime'],
  ['neiro','popcat','wif','render','pengu','bome','turbo','ponke','mog','dog','rocket','pork'],
];

const BLUE_CHIPS = [
  '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
  '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
  '0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E',
  '0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a',
  '0x68749665FF8D2d112Fa859AA293F07A622782F38',
  '0x4d224452801ACEd8B2F0aebE155379bb5D594381',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
  'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
  '0x532f27101965dd16442E59d40670FaF5eBB142E4',
  '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
  '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  '0xbA2aE424d960c26247Dd6c32edC70B295c744C43',
  '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E',
];

let _runCount = 0;

// ============ SHARED HELPERS ============

async function safeFetch(url, opts) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, { ...(opts || {}), signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ============ OHLCV PROXY ============

const ohlcvCache = {};
const poolCache = {};
const OHLCV_TTL = 90000;       // 90 seconds
const POOL_TTL = 300000;       // 5 minutes (successful lookups)
const POOL_FAIL_TTL = 15000;   // 15 seconds (failed lookups)

const GECKO_CHAIN_MAP = {
  solana: 'solana', eth: 'eth', base: 'base',
  bsc: 'bsc', sui: 'sui-network', tron: 'tron',
  ethereum: 'eth', 'sui-network': 'sui-network',
};

const RES_MAP = {
  '1':   { agg: 'minute', mult: 1 },
  '5':   { agg: 'minute', mult: 5 },
  '15':  { agg: 'minute', mult: 15 },
  '30':  { agg: 'minute', mult: 30 },
  '60':  { agg: 'hour',   mult: 1 },
  '240': { agg: 'hour',   mult: 4 },
  '1D':  { agg: 'day',    mult: 1 },
};

function parseBars(data) {
  const list = data && data.data && data.data.attributes && data.data.attributes.ohlcv_list;
  if (!list || !list.length) return [];
  return list.map(c => ({
    time: c[0] * 1000, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5],
  })).sort((a, b) => a.time - b.time);
}

async function findPool(geckoChain, tokenAddr) {
  const cacheKey = geckoChain + ':' + tokenAddr;
  const cached = poolCache[cacheKey];
  const ttl = cached && cached.pool ? POOL_TTL : POOL_FAIL_TTL;
  if (cached && Date.now() - cached.ts < ttl) return cached.pool;

  // Try GeckoTerminal first
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch('https://api.geckoterminal.com/api/v2/networks/' + geckoChain + '/tokens/' + tokenAddr + '/pools?page=1', {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (r.ok) {
      const d = await r.json();
      if (d.data && d.data.length > 0) {
        let poolId = d.data[0].attributes && d.data[0].attributes.address;
        if (!poolId) {
          const parts = d.data[0].id.split('_');
          poolId = parts.length > 1 ? parts.slice(1).join('_') : d.data[0].id;
        }
        poolCache[cacheKey] = { pool: poolId, ts: Date.now() };
        return poolId;
      }
    }
  } catch (e) {}

  // Fallback: DexScreener
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + tokenAddr, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (r.ok) {
      const d = await r.json();
      if (d.pairs && d.pairs.length) {
        const best = d.pairs.reduce((b, p) => (p.liquidity && p.liquidity.usd || 0) > (b.liquidity && b.liquidity.usd || 0) ? p : b, d.pairs[0]);
        if (best.pairAddress) {
          poolCache[cacheKey] = { pool: best.pairAddress, ts: Date.now() };
          return best.pairAddress;
        }
      }
    }
  } catch (e) {}

  // Don't cache failures — let every request try fresh
  return null;
}

async function fetchOHLCV(geckoChain, pool, agg, mult) {
  const cacheKey = geckoChain + ':' + pool + ':' + agg + ':' + mult;
  const cached = ohlcvCache[cacheKey];
  if (cached && Date.now() - cached.ts < OHLCV_TTL) return cached.data;

  let bars = [];
  try {
    const url = 'https://api.geckoterminal.com/api/v2/networks/' + geckoChain + '/pools/' + pool + '/ohlcv/' + agg + '?aggregate=' + mult + '&limit=1000&currency=usd';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (r.ok) {
      const d = await r.json();
      bars = parseBars(d);
    }
  } catch (e) {}

  if (bars.length) {
    ohlcvCache[cacheKey] = { data: bars, ts: Date.now() };
  }
  return bars;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function handleOHLCV(url) {
  const chain = url.searchParams.get('chain');
  const address = url.searchParams.get('address');
  const resolution = url.searchParams.get('resolution') || '1';

  if (!chain || !address) {
    return new Response(JSON.stringify({ error: 'Missing chain or address' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  const geckoChain = GECKO_CHAIN_MAP[chain] || chain;
  const resConfig = RES_MAP[resolution] || RES_MAP['1'];
  const providedPool = url.searchParams.get('pool');

  try {
    const pool = providedPool || await findPool(geckoChain, address);
    if (!pool) {
      return new Response(JSON.stringify({ bars: [], noData: true, reason: 'pool_not_found' }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...corsHeaders() },
      });
    }

    const bars = await fetchOHLCV(geckoChain, pool, resConfig.agg, resConfig.mult);

    return new Response(JSON.stringify({ bars, noData: bars.length === 0, pool }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': bars.length > 0 ? 's-maxage=60, stale-while-revalidate=30' : 'no-cache',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, bars: [], noData: true }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...corsHeaders() },
    });
  }
}

// ============ SCRAPER (unchanged from v5) ============

function parseDexPair(p) {
  const chainMap = {
    'solana': 'solana', 'ethereum': 'eth', 'base': 'base',
    'bsc': 'bsc', 'sui': 'sui', 'tron': 'tron',
    'pulsechain': 'pulsechain', 'arbitrum': 'arbitrum',
    'polygon': 'polygon', 'avalanche': 'avalanche',
    'optimism': 'optimism', 'monad': 'monad',
  };
  const chain = chainMap[p.chainId] || p.chainId || 'solana';
  const price = p.priceUsd ? parseFloat(p.priceUsd) : 0;
  const mcap = p.marketCap || p.fdv || 0;
  const vol = p.volume ? (p.volume.h24 || 0) : 0;
  const liq = p.liquidity ? (p.liquidity.usd || 0) : 0;
  const pc = p.priceChange || {};

  let age = null;
  if (p.pairCreatedAt) {
    age = new Date(p.pairCreatedAt).toISOString();
  }

  let txns = 0, buys = 0, sells = 0;
  if (p.txns && p.txns.h24) {
    buys = p.txns.h24.buys || 0;
    sells = p.txns.h24.sells || 0;
    txns = buys + sells;
  }

  return {
    address: p.baseToken?.address || '',
    chain,
    symbol: p.baseToken ? p.baseToken.symbol.toUpperCase() : '???',
    name: p.baseToken ? p.baseToken.name : 'Unknown',
    image: p.info?.imageUrl || '',
    price,
    mcap,
    volume: vol,
    liquidity: liq,
    fdv: p.fdv || 0,
    p5m: pc.m5 ? parseFloat(pc.m5) : 0,
    p1h: pc.h1 ? parseFloat(pc.h1) : 0,
    p6h: pc.h6 ? parseFloat(pc.h6) : 0,
    p24h: pc.h24 ? parseFloat(pc.h24) : 0,
    txns,
    buys,
    sells,
    age,
    pair_address: p.pairAddress || '',
    pair_url: p.url || '',
    dex: p.dexId || '',
    website: p.info?.websites?.[0]?.url || '',
    twitter: p.info?.socials?.find(s => s.type === 'twitter')?.url || '',
    telegram: p.info?.socials?.find(s => s.type === 'telegram')?.url || '',
  };
}

async function batchEnrich(addresses) {
  if (!addresses.length) return [];
  const results = [];
  for (let i = 0; i < Math.min(addresses.length, 90); i += 30) {
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

async function upsertToSupabase(tokens, supabaseUrl, supabaseKey) {
  if (!tokens.length) return { success: 0, error: 'no tokens' };
  const now = new Date().toISOString();
  const rows = tokens.map(t => ({ ...t, updated_at: now }));
  try {
    const resp = await fetch(supabaseUrl + '/rest/v1/tokens?on_conflict=address,chain', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    });
    if (resp.ok) {
      return { success: rows.length, total: rows.length };
    } else {
      const errText = await resp.text();
      return { success: 0, total: rows.length, status: resp.status, error: errText.substring(0, 500) };
    }
  } catch (err) {
    return { success: 0, total: rows.length, fetchError: err.message };
  }
}

async function scrapeTokens() {
  const seenCAs = new Set();
  const allTokens = [];

  function addToken(t) {
    if (!t.address || seenCAs.has(t.address + t.chain)) return;
    if (!BLUE_CHIPS.includes(t.address)) {
      if (t.mcap < 10000 || t.liquidity < 5000) return;
      if (t.liquidity > 0 && t.mcap / t.liquidity > 50) return;
    }
    seenCAs.add(t.address + t.chain);
    allTokens.push(t);
  }

  const groupIdx = _runCount % 3;
  _runCount++;
  const searchTerms = SEARCH_GROUPS[groupIdx];

  const geckoPromises = GECKO_CHAINS.map(chain =>
    safeFetch('https://api.geckoterminal.com/api/v2/networks/' + chain + '/trending_pools?page=1&include=base_token', { headers: { 'Accept': 'application/json' } })
  );
  const dsProfilePromise = safeFetch('https://api.dexscreener.com/token-profiles/latest/v1');
  const dsBoostedPromise = safeFetch('https://api.dexscreener.com/token-boosts/latest/v1');
  const searchPromises = searchTerms.map(term =>
    safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + term)
  );
  const chainSearches = ['pump fun solana', 'sunpump tron', 'cetus sui', 'viral meme'].map(q =>
    safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q))
  );
  const blueChipPromise = safeFetch('https://api.dexscreener.com/latest/dex/tokens/' + BLUE_CHIPS.slice(0, 30).join(','));

  const [geckoResults, profiles, boosted, searchResults, chainResults, blueChipData] = await Promise.all([
    Promise.all(geckoPromises),
    dsProfilePromise,
    dsBoostedPromise,
    Promise.all(searchPromises),
    Promise.all(chainSearches),
    blueChipPromise,
  ]);

  if (blueChipData?.pairs) {
    const best = {};
    for (const p of blueChipData.pairs) {
      const addr = p.baseToken?.address;
      if (!addr) continue;
      const liq = p.liquidity?.usd || 0;
      if (!best[addr] || liq > (best[addr].liquidity?.usd || 0)) best[addr] = p;
    }
    for (const p of Object.values(best)) {
      const token = parseDexPair(p);
      token.source = 'blue_chip';
      addToken(token);
    }
  }

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

  const dsAddresses = new Set();
  if (profiles) {
    for (const p of profiles.slice(0, 60)) {
      if (p.tokenAddress) dsAddresses.add(p.tokenAddress);
    }
  }
  if (boosted) {
    for (const p of boosted.slice(0, 40)) {
      if (p.tokenAddress) dsAddresses.add(p.tokenAddress);
    }
  }

  for (const data of searchResults) {
    if (data?.pairs) {
      for (const p of data.pairs.slice(0, 10)) {
        const token = parseDexPair(p);
        token.source = 'dexscreener_search';
        addToken(token);
      }
    }
  }

  for (const data of chainResults) {
    if (data?.pairs) {
      for (const p of data.pairs.slice(0, 10)) {
        const token = parseDexPair(p);
        token.source = 'dexscreener_chain';
        addToken(token);
      }
    }
  }

  const allAddresses = [...new Set([...geckoAddresses, ...dsAddresses])];
  const enriched = await batchEnrich(allAddresses.slice(0, 90));
  for (const p of enriched) {
    const token = parseDexPair(p);
    if (geckoAddresses.has(token.address)) token.source = 'geckoterminal';
    else if (dsAddresses.has(token.address)) token.source = 'dexscreener';
    else token.source = 'enriched';
    if (!token.image && geckoImages[token.address]) {
      token.image = geckoImages[token.address];
    }
    addToken(token);
  }

  return { tokens: allTokens, group: groupIdx, terms: searchTerms.length };
}

// ============ CLOUDFLARE WORKER ENTRY POINTS ============

export default {
  async scheduled(event, env, ctx) {
    console.log('Scraper v6 started at', new Date().toISOString());
    try {
      const { tokens, group } = await scrapeTokens();
      console.log('Scraped', tokens.length, 'tokens (group', group, ')');
      const result = await upsertToSupabase(tokens, env.SUPABASE_URL, env.SUPABASE_KEY);
      console.log('Upserted', result.success, '/', result.total);
    } catch (err) {
      console.log('Scraper error:', err.message);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight for all routes
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders() });
    }

    // === OHLCV PROXY ROUTE ===
    if (url.pathname === '/ohlcv') {
      return handleOHLCV(url);
    }

    // === MANUAL SCRAPER TRIGGER ===
    if (url.pathname === '/run') {
      try {
        const { tokens, group, terms } = await scrapeTokens();
        const result = await upsertToSupabase(tokens, env.SUPABASE_URL, env.SUPABASE_KEY);
        return new Response(JSON.stringify({
          scraped: tokens.length,
          searchGroup: group,
          searchTerms: terms,
          result: result,
          timestamp: new Date().toISOString(),
        }, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // === STATUS PAGE ===
    return new Response(JSON.stringify({
      status: 'MemeScope Scraper v6',
      cron: 'Every 2 minutes',
      routes: {
        '/': 'This status page',
        '/run': 'Manual scraper trigger',
        '/ohlcv': 'OHLCV chart proxy — params: chain, address, resolution',
      },
      strategy: 'Rotates 36 search terms across 3 runs (6 min full cycle)',
      blueChips: BLUE_CHIPS.length + ' always tracked',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
