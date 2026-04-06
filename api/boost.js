// api/boost.js — Deploy to memescope-api repo on Vercel
// Handles POST /api/boost (submit boost) and GET /api/boost?ca=xxx (check boost)

const https = require('https');

const PAYMENT_WALLET = '82p2EEAB5jobWxVYjGN4aZm84ZGcK3TSzpHqTXv5kvMg';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const BOOST_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Tier config: boostCount → required USD price
const TIERS = {
  20:  { usd: 99,  label: '⚡20' },
  50:  { usd: 199, label: '⚡50' },
  100: { usd: 399, label: '⚡100' },
  500: { usd: 999, label: '⚡500' },
};

// In-memory store (resets on cold start — use KV/Redis for production)
const boostStore = {};

// Clean expired boosts
function cleanExpired() {
  const now = Date.now();
  for (const ca of Object.keys(boostStore)) {
    if (boostStore[ca].expiration < now) {
      delete boostStore[ca];
    }
  }
}

// Helper: make HTTPS POST request (no fetch dependency)
function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let result = '';
      res.on('data', (chunk) => { result += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(result));
        } catch (e) {
          reject(new Error('Failed to parse response'));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Verify SOL transaction on-chain
async function verifyTransaction(txSignature, expectedSolAmount) {
  try {
    const data = await httpsPost(SOLANA_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [txSignature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
    });

    if (!data.result) return { valid: false, reason: 'Transaction not found' };

    const tx = data.result;

    // Check confirmation
    if (tx.meta && tx.meta.err) {
      return { valid: false, reason: 'Transaction failed on-chain' };
    }

    // Find SOL transfer to payment wallet
    const instructions = (tx.transaction && tx.transaction.message && tx.transaction.message.instructions) || [];
    let transferFound = false;
    let transferAmount = 0;

    for (const ix of instructions) {
      if (ix.parsed && ix.parsed.type === 'transfer' && ix.program === 'system') {
        const info = ix.parsed.info;
        if (info.destination === PAYMENT_WALLET) {
          transferFound = true;
          transferAmount = info.lamports / 1e9;
          break;
        }
      }
    }

    if (!transferFound) {
      return { valid: false, reason: 'No transfer to payment wallet found' };
    }

    // Allow 2% slippage on SOL amount
    const minRequired = expectedSolAmount * 0.98;
    if (transferAmount < minRequired) {
      return { valid: false, reason: 'Insufficient amount. Sent ' + transferAmount.toFixed(4) + ' SOL, required ' + expectedSolAmount.toFixed(4) + ' SOL' };
    }

    return { valid: true, amount: transferAmount };
  } catch (err) {
    return { valid: false, reason: 'RPC error: ' + err.message };
  }
}

// Check if tx signature was already used
function isTxUsed(txSignature) {
  for (const ca of Object.keys(boostStore)) {
    if (boostStore[ca].txSignature === txSignature) return true;
  }
  return false;
}

module.exports = async (req, res) => {
  try {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    cleanExpired();

    // ─── GET: Check boost status ───
    if (req.method === 'GET') {
      const ca = req.query ? req.query.ca : null;

      // If no CA specified, return all active boosts
      if (!ca) {
        const activeBoosts = {};
        for (const tokenCA of Object.keys(boostStore)) {
          const data = boostStore[tokenCA];
          activeBoosts[tokenCA] = {
            boostCount: data.boostCount,
            expiration: data.expiration,
            remainingMs: data.expiration - Date.now(),
            tier: data.tier,
          };
        }
        return res.status(200).json({ boosts: activeBoosts });
      }

      // Check specific token
      const boost = boostStore[ca];
      if (!boost || boost.expiration < Date.now()) {
        return res.status(200).json({ boosted: false, ca: ca });
      }

      return res.status(200).json({
        boosted: true,
        ca: ca,
        boostCount: boost.boostCount,
        expiration: boost.expiration,
        remainingMs: boost.expiration - Date.now(),
        tier: boost.tier,
      });
    }

    // ─── POST: Submit boost ───
    if (req.method === 'POST') {
      var body = req.body || {};
      var txSignature = body.txSignature;
      var ca = body.ca;
      var tier = body.tier;
      var solAmount = body.solAmount;

      // Validate inputs
      if (!txSignature || !ca || !tier) {
        return res.status(400).json({ error: 'Missing required fields: txSignature, ca, tier' });
      }

      var tierNum = parseInt(tier);
      if (!TIERS[tierNum]) {
        return res.status(400).json({ error: 'Invalid tier. Must be 20, 50, 100, or 500' });
      }

      // Check if tx already used
      if (isTxUsed(txSignature)) {
        return res.status(400).json({ error: 'Transaction signature already used' });
      }

      // Verify on-chain
      var verification = await verifyTransaction(txSignature, solAmount || 0);
      if (!verification.valid) {
        return res.status(400).json({ error: 'Transaction verification failed', reason: verification.reason });
      }

      // Store boost
      var now = Date.now();
      var existing = boostStore[ca];

      // If already boosted, add to existing boost count and extend expiration
      var newBoostCount = (existing ? existing.boostCount : 0) + tierNum;
      var newExpiration = Math.max(existing ? existing.expiration : 0, now + BOOST_DURATION_MS);

      boostStore[ca] = {
        boostCount: newBoostCount,
        expiration: newExpiration,
        timestamp: now,
        tier: tierNum,
        txSignature: txSignature,
      };

      return res.status(200).json({
        success: true,
        ca: ca,
        boostCount: newBoostCount,
        expiration: newExpiration,
        tier: tierNum,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    return res.status(500).json({ error: 'Server error', message: err.message });
  }
};
