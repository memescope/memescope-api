// api/boost.js — Boost system for MemeScope
// GET /api/boost — list all active boosts
// GET /api/boost?ca=xxx — check specific token
// POST /api/boost — submit a boost (txSignature, ca, tier, solAmount)

const PAYMENT_WALLET = '82p2EEAB5jobWxVYjGN4aZm84ZGcK3TSzpHqTXv5kvMg';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const BOOST_DURATION_MS = 24 * 60 * 60 * 1000;

const TIERS = {
  20:  { usd: 99 },
  50:  { usd: 199 },
  100: { usd: 399 },
  500: { usd: 999 },
};

const boostStore = {};

function cleanExpired() {
  const now = Date.now();
  for (const ca of Object.keys(boostStore)) {
    if (boostStore[ca].expiration < now) {
      delete boostStore[ca];
    }
  }
}

async function verifyTransaction(txSignature, expectedSolAmount) {
  try {
    const resp = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [txSignature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
      })
    });
    const data = await resp.json();
    if (!data.result) return { valid: false, reason: 'Transaction not found' };
    if (data.result.meta && data.result.meta.err) return { valid: false, reason: 'Transaction failed' };
    const instructions = data.result.transaction?.message?.instructions || [];
    for (const ix of instructions) {
      if (ix.parsed && ix.parsed.type === 'transfer' && ix.program === 'system') {
        if (ix.parsed.info.destination === PAYMENT_WALLET) {
          const amount = ix.parsed.info.lamports / 1e9;
          if (amount >= expectedSolAmount * 0.98) return { valid: true, amount };
          return { valid: false, reason: 'Insufficient amount' };
        }
      }
    }
    return { valid: false, reason: 'No transfer to payment wallet' };
  } catch (err) {
    return { valid: false, reason: 'RPC error: ' + err.message };
  }
}

function isTxUsed(txSignature) {
  for (const ca of Object.keys(boostStore)) {
    if (boostStore[ca].txSignature === txSignature) return true;
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    cleanExpired();

    if (req.method === 'GET') {
      const ca = req.query ? req.query.ca : undefined;
      if (!ca) {
        const activeBoosts = {};
        for (const tokenCA of Object.keys(boostStore)) {
          activeBoosts[tokenCA] = {
            boostCount: boostStore[tokenCA].boostCount,
            expiration: boostStore[tokenCA].expiration,
            remainingMs: boostStore[tokenCA].expiration - Date.now(),
            tier: boostStore[tokenCA].tier,
          };
        }
        return res.status(200).json({ boosts: activeBoosts });
      }
      const boost = boostStore[ca];
      if (!boost || boost.expiration < Date.now()) {
        return res.status(200).json({ boosted: false, ca });
      }
      return res.status(200).json({
        boosted: true, ca,
        boostCount: boost.boostCount,
        expiration: boost.expiration,
        remainingMs: boost.expiration - Date.now(),
        tier: boost.tier,
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (!body.txSignature || !body.ca || !body.tier) {
        return res.status(400).json({ error: 'Missing fields: txSignature, ca, tier' });
      }
      const tierNum = parseInt(body.tier);
      if (!TIERS[tierNum]) {
        return res.status(400).json({ error: 'Invalid tier' });
      }
      if (isTxUsed(body.txSignature)) {
        return res.status(400).json({ error: 'Transaction already used' });
      }
      const verification = await verifyTransaction(body.txSignature, body.solAmount || 0);
      if (!verification.valid) {
        return res.status(400).json({ error: 'Verification failed', reason: verification.reason });
      }
      const now = Date.now();
      const existing = boostStore[body.ca];
      const newBoostCount = (existing ? existing.boostCount : 0) + tierNum;
      const newExpiration = Math.max(existing ? existing.expiration : 0, now + BOOST_DURATION_MS);
      boostStore[body.ca] = {
        boostCount: newBoostCount,
        expiration: newExpiration,
        timestamp: now,
        tier: tierNum,
        txSignature: body.txSignature,
      };
      return res.status(200).json({
        success: true, ca: body.ca,
        boostCount: newBoostCount,
        expiration: newExpiration,
        tier: tierNum,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error', message: err.message });
  }
}
