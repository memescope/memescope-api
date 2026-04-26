// MemeScope Cloudflare Worker Scraper v6
// v5 scraper + OHLCV proxy (no cold starts = instant chart data)

const GECKO_CHAINS = ['solana', 'eth', 'base', 'bsc', 'sui-network', 'tron', 'arbitrum', 'avax', 'polygon_pos', 'optimism', 'blast', 'ton'];

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
const OHLCV_TTL = 600000;       // 10 minutes — historical bars don't change
const POOL_TTL = 600000;        // 10 minutes (successful lookups)
const POOL_FAIL_TTL = 30000;    // 30 seconds (failed lookups — retry soon)

const GECKO_CHAIN_MAP = {
  solana: 'solana', eth: 'eth', base: 'base',
  bsc: 'bsc', sui: 'sui-network', tron: 'tron',
  ethereum: 'eth', 'sui-network': 'sui-network',
  arbitrum: 'arbitrum', avalanche: 'avax', avax: 'avax',
  polygon: 'polygon_pos', optimism: 'optimism',
  blast: 'blast', ton: 'ton',
};

// DexScreener uses different chain slugs
const DEX_CHAIN_MAP = {
  solana: 'solana', eth: 'ethereum', base: 'base',
  bsc: 'bsc', sui: 'sui', tron: 'tron',
  ethereum: 'ethereum', 'sui-network': 'sui',
  arbitrum: 'arbitrum', avalanche: 'avalanche', avax: 'avalanche',
  polygon: 'polygon', optimism: 'optimism',
  blast: 'blast', ton: 'ton',
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

// Fetch with retry — handles 429 rate limits with backoff
async function fetchWithRetry(url, opts, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(url, { ...(opts || {}), signal: controller.signal });
      clearTimeout(timeout);

      if (r.status === 429) {
        // Rate limited — wait and retry
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
          continue;
        }
        return null;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch {
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function findPool(geckoChain, tokenAddr, inputChain) {
  const cacheKey = geckoChain + ':' + tokenAddr;
  const cached = poolCache[cacheKey];
  const ttl = cached && cached.pool ? POOL_TTL : POOL_FAIL_TTL;
  if (cached && Date.now() - cached.ts < ttl) return cached.pool;

  const dexChain = DEX_CHAIN_MAP[inputChain] || DEX_CHAIN_MAP[geckoChain] || inputChain;

  // Run DexScreener and GeckoTerminal in parallel — use whichever responds first with a result
  const dexP = fetchWithRetry('https://api.dexscreener.com/latest/dex/tokens/' + tokenAddr, {}, 1).then(d => {
    if (d && d.pairs && d.pairs.length) {
      const chainPairs = d.pairs.filter(p => p.chainId === dexChain);
      const pool = (chainPairs.length ? chainPairs : d.pairs).reduce(
        (b, p) => ((p.liquidity && p.liquidity.usd) || 0) > ((b.liquidity && b.liquidity.usd) || 0) ? p : b,
        (chainPairs.length ? chainPairs : d.pairs)[0]
      );
      if (pool.pairAddress) return pool.pairAddress;
    }
    return null;
  }).catch(() => null);

  const geckoP = fetchWithRetry(
    'https://api.geckoterminal.com/api/v2/networks/' + geckoChain + '/tokens/' + tokenAddr + '/pools?page=1',
    { headers: { 'Accept': 'application/json' } }, 1
  ).then(d => {
    if (d && d.data && d.data.length > 0) {
      let poolId = d.data[0].attributes && d.data[0].attributes.address;
      if (!poolId) {
        const parts = d.data[0].id.split('_');
        poolId = parts.length > 1 ? parts.slice(1).join('_') : d.data[0].id;
      }
      return poolId;
    }
    return null;
  }).catch(() => null);

  // Race: take whichever resolves with a non-null value first
  const pool = await Promise.any([
    dexP.then(r => { if (r) return r; throw new Error('no pool'); }),
    geckoP.then(r => { if (r) return r; throw new Error('no pool'); }),
  ]).catch(() => null);

  poolCache[cacheKey] = { pool, ts: Date.now() };
  return pool;
}

async function fetchOHLCV(geckoChain, pool, agg, mult) {
  const cacheKey = geckoChain + ':' + pool + ':' + agg + ':' + mult;
  const cached = ohlcvCache[cacheKey];
  if (cached && Date.now() - cached.ts < OHLCV_TTL) return cached.data;

  const url = 'https://api.geckoterminal.com/api/v2/networks/' + geckoChain + '/pools/' + pool + '/ohlcv/' + agg + '?aggregate=' + mult + '&limit=300&currency=usd';
  const d = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, 3);

  let bars = [];
  if (d) bars = parseBars(d);

  if (bars.length) {
    ohlcvCache[cacheKey] = { data: bars, ts: Date.now() };
  } else if (cached && cached.data && cached.data.length) {
    // Rate limited or failed — return stale cache instead of empty
    return cached.data;
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
  const debug = url.searchParams.get('debug') === '1';
  const debugLog = [];

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
    // Use provided pool, or discover it
    let pool = providedPool || await findPool(geckoChain, address, chain);
    if (debug) debugLog.push('pool=' + pool + ' geckoChain=' + geckoChain);

    if (!pool) {
      return new Response(JSON.stringify({ bars: [], noData: true, reason: 'pool_not_found', debug: debugLog }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...corsHeaders() },
      });
    }

    // Fetch OHLCV — inline for debug visibility
    const ohlcvUrl = 'https://api.geckoterminal.com/api/v2/networks/' + geckoChain + '/pools/' + pool + '/ohlcv/' + resConfig.agg + '?aggregate=' + resConfig.mult + '&limit=300&currency=usd';
    if (debug) debugLog.push('ohlcvUrl=' + ohlcvUrl);

    let bars = await fetchOHLCV(geckoChain, pool, resConfig.agg, resConfig.mult);
    if (debug) debugLog.push('bars_count=' + bars.length);

    // If no bars, try raw fetch to see what GeckoTerminal returns
    if (bars.length === 0 && debug) {
      try {
        const rawR = await fetch(ohlcvUrl, { headers: { 'Accept': 'application/json' } });
        debugLog.push('raw_status=' + rawR.status);
        const rawText = await rawR.text();
        debugLog.push('raw_len=' + rawText.length);
        debugLog.push('raw_snippet=' + rawText.substring(0, 200));
      } catch (e2) {
        debugLog.push('raw_error=' + e2.message);
      }
    }

    // If pool from DexScreener didn't work on GeckoTerminal, try discovering via GeckoTerminal directly
    if (bars.length === 0 && providedPool) {
      const gtPool = await findPool(geckoChain, address, chain);
      if (debug) debugLog.push('gt_fallback_pool=' + gtPool);
      if (gtPool && gtPool !== pool) {
        bars = await fetchOHLCV(geckoChain, gtPool, resConfig.agg, resConfig.mult);
        pool = gtPool;
        if (debug) debugLog.push('gt_bars_count=' + bars.length);
      }
    }

    const resp = { bars, noData: bars.length === 0, pool };
    if (debug) resp.debug = debugLog;

    return new Response(JSON.stringify(resp), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': bars.length > 0 ? 's-maxage=120, stale-while-revalidate=60' : 'no-cache',
        ...corsHeaders(),
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, bars: [], noData: true, debug: debugLog }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...corsHeaders() },
    });
  }
}

// ============ TRADES PROXY ============

const tradesCache = {};
const TRADES_TTL = 10000; // 10 seconds — trades update frequently

async function handleTrades(url) {
  const chain = url.searchParams.get('chain');
  const address = url.searchParams.get('address');
  const debug = url.searchParams.get('debug') === '1';
  const debugLog = [];

  if (!chain || !address) {
    return new Response(JSON.stringify({ error: 'Missing chain or address', trades: [] }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  try {
    const geckoChain = GECKO_CHAIN_MAP[chain] || chain;
    const providedPool = url.searchParams.get('pool');
    const pool = providedPool || await findPool(geckoChain, address, chain);
    if (debug) debugLog.push('geckoChain=' + geckoChain + ' pool=' + pool + ' provided=' + !!providedPool);

    if (!pool) {
      return new Response(JSON.stringify({ trades: [], noData: true, reason: 'no pool found', debug: debugLog }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...corsHeaders() },
      });
    }

    // Check cache
    const cacheKey = geckoChain + ':' + pool + ':trades';
    const cached = tradesCache[cacheKey];
    if (cached && Date.now() - cached.ts < TRADES_TTL) {
      if (debug) debugLog.push('cache_hit count=' + cached.data.length);
      return new Response(JSON.stringify({ trades: cached.data, pool, cached: true, debug: debugLog }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=8, stale-while-revalidate=5', ...corsHeaders() },
      });
    }

    // Fetch trades from GeckoTerminal
    const tradesUrl = 'https://api.geckoterminal.com/api/v2/networks/' + geckoChain + '/pools/' + pool + '/trades?trade_volume_in_usd_greater_than=0';
    if (debug) debugLog.push('tradesUrl=' + tradesUrl);

    let d = null;
    let rawStatus = 0;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const rawResp = await fetch(tradesUrl, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
      clearTimeout(timeout);
      rawStatus = rawResp.status;
      if (debug) debugLog.push('status=' + rawStatus);
      if (rawResp.ok) {
        d = await rawResp.json();
        if (debug) debugLog.push('data_items=' + (d && d.data ? d.data.length : 'no_data'));
      } else {
        if (debug) {
          const errText = await rawResp.text();
          debugLog.push('error_body=' + errText.substring(0, 200));
        }
      }
    } catch (e) {
      if (debug) debugLog.push('fetch_error=' + e.message);
      d = null;
    }

    let trades = [];
    if (d && d.data && d.data.length) {
      trades = d.data.map(t => {
        const a = t.attributes || {};
        return {
          time: a.block_timestamp,
          type: a.kind || 'unknown',
          priceUsd: parseFloat(a.price_to_in_currency_token || a.price_from_in_usd || 0),
          priceToken: parseFloat(a.price_from_in_currency_token || 0),
          amountBase: parseFloat(a.from_token_amount || 0),
          amountQuote: parseFloat(a.to_token_amount || 0),
          volumeUsd: parseFloat(a.volume_in_usd || 0),
          txHash: a.tx_hash || '',
          maker: a.tx_from_address || '',
        };
      });
    }

    // Cache results
    if (trades.length) {
      tradesCache[cacheKey] = { data: trades, ts: Date.now() };
    }

    const resp = { trades, pool };
    if (debug) resp.debug = debugLog;
    return new Response(JSON.stringify(resp), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=8, stale-while-revalidate=5', ...corsHeaders() },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, trades: [], debug: debugLog }), {
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
    'arbitrum': 'arbitrum', 'avalanche': 'avalanche',
    'polygon': 'polygon', 'optimism': 'optimism',
    'blast': 'blast', 'ton': 'ton',
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
  const chainSearches = ['pump fun solana', 'sunpump tron', 'cetus sui', 'viral meme', 'camelot arbitrum', 'trader joe avalanche', 'quickswap polygon', 'velodrome optimism', 'thruster blast', 'ston fi ton'].map(q =>
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

// ============ TOKENS FEED (replaces Vercel) ============

const tokensCache = { data: null, ts: 0 };
const TOKENS_TTL = 30000; // 30 seconds

function formatAge(isoDate) {
  if (!isoDate) return '—';
  const ageHrs = (Date.now() - new Date(isoDate).getTime()) / 3600000;
  if (ageHrs < 0 || ageHrs > 43800) return '—';
  if (ageHrs < 1) return Math.round(ageHrs * 60) + 'm';
  if (ageHrs < 24) return Math.round(ageHrs) + 'h';
  if (ageHrs < 720) return Math.round(ageHrs / 24) + 'd';
  if (ageHrs < 8760) return Math.round(ageHrs / 720) + 'mo';
  return Math.round(ageHrs / 8760) + 'y';
}

function rowToToken(row) {
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
    age: formatAge(row.age),
    txn: row.txns || 0,
    net: row.chain || 'solana',
    dex: row.dex || '',
    social: 0,
    boosted: false,
    website: row.website || '',
    twitter: row.twitter || '',
    telegram: row.telegram || '',
    ca: row.address || '',
    pairAddress: row.pair_address || '',
  };
}

async function handleBugReport(request) {
  try {
    const body = await request.json();
    const message = (body.message || '').trim();
    if (!message) {
      return new Response(JSON.stringify({ error: 'Message required' }), {
        status: 400, headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }
    console.log('BUG_REPORT:', JSON.stringify({
      message,
      email: (body.email || '').trim() || null,
      url: body.url || null,
      time: new Date().toISOString()
    }));
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }
}

async function handleTokens(url, env) {
  const search = url.searchParams.get('search');
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_KEY;
  const headers = { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + supabaseKey };

  // === SEARCH ===
  if (search) {
    const [dexData, sbResp] = await Promise.all([
      safeFetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(search)),
      safeFetch(
        supabaseUrl + '/rest/v1/tokens?select=*&or=(symbol.ilike.*' + encodeURIComponent(search) + '*,name.ilike.*' + encodeURIComponent(search) + '*)&order=mcap.desc&limit=10',
        { headers }
      ),
    ]);

    const results = [];
    const seenCA = new Set();

    // Supabase results first
    if (sbResp) {
      for (const row of sbResp) {
        if (!row.address || seenCA.has(row.address)) continue;
        seenCA.add(row.address);
        results.push(rowToToken(row));
      }
    }

    // DexScreener results
    if (dexData?.pairs) {
      const dexChainMap = { 'solana':'solana','ethereum':'eth','base':'base','bsc':'bsc','sui':'sui','tron':'tron','arbitrum':'arbitrum','avalanche':'avalanche','polygon':'polygon','optimism':'optimism','blast':'blast','ton':'ton' };
      for (const p of dexData.pairs.slice(0, 20)) {
        const ca = p.baseToken?.address;
        if (!ca || seenCA.has(ca)) continue;
        const mcap = p.marketCap || p.fdv || 0;
        if (mcap < 1000) continue;
        seenCA.add(ca);
        const pc = p.priceChange || {};
        let txns = 0;
        if (p.txns?.h24) txns = (p.txns.h24.buys || 0) + (p.txns.h24.sells || 0);
        let age = '—';
        if (p.pairCreatedAt) {
          const ageHrs = (Date.now() - p.pairCreatedAt) / 3600000;
          if (ageHrs >= 0 && ageHrs < 43800) {
            if (ageHrs < 1) age = Math.round(ageHrs * 60) + 'm';
            else if (ageHrs < 24) age = Math.round(ageHrs) + 'h';
            else if (ageHrs < 720) age = Math.round(ageHrs / 24) + 'd';
            else if (ageHrs < 8760) age = Math.round(ageHrs / 720) + 'mo';
            else age = Math.round(ageHrs / 8760) + 'y';
          }
        }
        results.push({
          sym: p.baseToken.symbol.toUpperCase(), name: p.baseToken.name || 'Unknown',
          img: p.info?.imageUrl || '', price: p.priceUsd ? parseFloat(p.priceUsd) : 0,
          mcap, vol: p.volume ? (p.volume.h24 || 0) : 0, liq: p.liquidity ? (p.liquidity.usd || 0) : 0,
          p5m: pc.m5 ? parseFloat(pc.m5) : 0, p1h: pc.h1 ? parseFloat(pc.h1) : 0,
          p6h: pc.h6 ? parseFloat(pc.h6) : 0, p24h: pc.h24 ? parseFloat(pc.h24) : 0,
          age, txn: txns, net: dexChainMap[p.chainId] || p.chainId || 'solana', dex: p.dexId || '',
          social: 0, boosted: false, ca,
          website: p.info?.websites?.[0]?.url || '',
          twitter: p.info?.socials?.find(s => s.type === 'twitter')?.url || '',
          pairAddress: p.pairAddress || '',
        });
      }
    }

    results.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
    return new Response(JSON.stringify({ tokens: results.slice(0, 20), search: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  // === MAIN FEED ===
  if (tokensCache.data && Date.now() - tokensCache.ts < TOKENS_TTL) {
    return new Response(JSON.stringify({ tokens: tokensCache.data, cached: true }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=25, stale-while-revalidate=10', ...corsHeaders() },
    });
  }

  try {
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const resp = await fetch(
      supabaseUrl + '/rest/v1/tokens?select=*&updated_at=gte.' + cutoff + '&order=volume.desc&limit=1000',
      { headers }
    );
    if (!resp.ok) {
      // Return stale cache if available
      if (tokensCache.data) {
        return new Response(JSON.stringify({ tokens: tokensCache.data, cached: true, stale: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
      return new Response(JSON.stringify({ tokens: [], error: 'Supabase error ' + resp.status }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const rows = await resp.json();
    const tokens = rows.map(rowToToken).filter(t => {
      if (!t.img) return false;           // no image
      if (t.liq < 3000) return false;      // rugged — liquidity too low
      if (t.mcap < 5000) return false;     // dead — mcap too low
      if (t.vol < 100) return false;       // no activity
      return true;
    });
    tokensCache.data = tokens;
    tokensCache.ts = Date.now();

    return new Response(JSON.stringify({ tokens, cached: false }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=25, stale-while-revalidate=10', ...corsHeaders() },
    });
  } catch (e) {
    if (tokensCache.data) {
      return new Response(JSON.stringify({ tokens: tokensCache.data, cached: true, stale: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
    return new Response(JSON.stringify({ tokens: [], error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
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

    // === TRADES PROXY ROUTE ===
    if (url.pathname === '/trades') {
      return handleTrades(url);
    }

    // === BUG REPORT ===
    if (url.pathname === '/bug-report' && request.method === 'POST') {
      return handleBugReport(request);
    }

    // === TOKENS FEED (replaces Vercel API) ===
    if (url.pathname === '/tokens') {
      return handleTokens(url, env);
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
        '/tokens': 'Token feed + search — params: ?search=query',
        '/ohlcv': 'OHLCV chart proxy — params: chain, address, resolution',
        '/trades': 'Recent trades proxy — params: chain, address',
      },
      strategy: 'Rotates 36 search terms across 3 runs (6 min full cycle)',
      blueChips: BLUE_CHIPS.length + ' always tracked',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
