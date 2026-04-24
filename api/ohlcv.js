// api/ohlcv.js — OHLCV Proxy for MemeScope Charts
// Fast proxy: single GeckoTerminal call with server-side caching
// No retries, no delays — speed is priority so TradingView doesn't timeout

const ohlcvCache = {};
const poolCache = {};
const OHLCV_TTL = 90000;
const POOL_TTL = 300000;

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
  if (cached && Date.now() - cached.ts < POOL_TTL) return cached.pool;

  // Try GeckoTerminal first
  try {
    const r = await fetch('https://api.geckoterminal.com/api/v2/networks/' + geckoChain + '/tokens/' + tokenAddr + '/pools?page=1', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
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
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + tokenAddr, {
      signal: AbortSignal.timeout(5000),
    });
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

  poolCache[cacheKey] = { pool: null, ts: Date.now() };
  return null;
}

async function fetchOHLCV(geckoChain, pool, agg, mult) {
  const cacheKey = geckoChain + ':' + pool + ':' + agg + ':' + mult;
  const cached = ohlcvCache[cacheKey];
  if (cached && Date.now() - cached.ts < OHLCV_TTL) return cached.data;

  let bars = [];

  try {
    const url = 'https://api.geckoterminal.com/api/v2/networks/' + geckoChain + '/pools/' + pool + '/ohlcv/' + agg + '?aggregate=' + mult + '&limit=1000&currency=usd';
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const d = await r.json();
      bars = parseBars(d);
    }
  } catch (e) {}

  // Cache and return
  if (bars.length) {
    ohlcvCache[cacheKey] = { data: bars, ts: Date.now() };
  }
  return bars;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { chain, address, resolution } = req.query;
  if (!chain || !address) {
    return res.status(400).json({ error: 'Missing chain or address' });
  }

  const geckoChain = GECKO_CHAIN_MAP[chain] || chain;
  const resConfig = RES_MAP[resolution || '1'] || RES_MAP['1'];

  try {
    const pool = await findPool(geckoChain, address);
    if (!pool) {
      res.setHeader('Cache-Control', 'no-cache');
      return res.status(200).json({ bars: [], noData: true, reason: 'pool_not_found' });
    }

    const bars = await fetchOHLCV(geckoChain, pool, resConfig.agg, resConfig.mult);

    if (bars.length > 0) {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }

    return res.status(200).json({ bars, noData: bars.length === 0, pool });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(500).json({ error: e.message, bars: [], noData: true });
  }
}
