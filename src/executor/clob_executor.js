const https = require('https');
const { getDb, initDb, closeDb } = require('../utils/db');

// ─── Constants ───────────────────────────────────────────────────────────────

const CLOB_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const MAX_DRAWDOWN_PCT = 0.20; // 20% stop-loss threshold

// Telegram alert callback (injected at runtime)
let alertFn = null;

/**
 * Register the Telegram alert function.
 * @param {function} fn - Function to call with alert messages.
 */
function setAlertCallback(fn) {
  alertFn = fn;
}

/**
 * Send a Telegram alert if callback is registered.
 * @param {string} message
 */
function sendAlert(message) {
  if (typeof alertFn === 'function') {
    alertFn(message);
  }
}

// ─── CLOB Helpers ────────────────────────────────────────────────────────────

/**
 * Fetch the midpoint price for a CLOB token.
 * @param {string} tokenId
 * @returns {Promise<number|null>}
 */
function fetchClobMidpoint(tokenId) {
  return new Promise((resolve) => {
    const url = `${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
    https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.mid) {
            resolve(parseFloat(parsed.mid));
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Fetch market details from Gamma API by token ID.
 * @param {string} tokenId
 * @returns {Promise<object|null>}
 */
function fetchMarketByTokenId(tokenId) {
  return new Promise((resolve) => {
    const url = `${GAMMA_BASE}/markets?closed=false&limit=1000`;
    https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const markets = JSON.parse(data);
          if (!Array.isArray(markets)) {
            resolve(null);
            return;
          }
          const match = markets.find((m) => {
            try {
              const ids = JSON.parse(m.clobTokenIds || '[]');
              return ids.includes(tokenId);
            } catch {
              return false;
            }
          });
          resolve(match || null);
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Fetch the current expert position size for a market (simulated).
 * In production, this queries the expert's actual positions.
 * @param {string} decisionId - The expert's decision ID
 * @param {string} clobTokenId
 * @returns {Promise<number>} Current expert position size
 */
async function fetchExpertPositionSize(decisionId, clobTokenId) {
  // This function queries the expert's current position on the CLOB.
  // In a production setup, this calls the polymarket-clob-client API.
  // For now, return a placeholder that can be overridden.
  // A real implementation would query the L2 orderbook or the expert's wallet.
  return 0; // placeholder — override with real expert API
}

// ─── Deduplication & Conflict Alert (Preserved Existing Logic) ──────────────

/**
 * Check for duplicate pending orders with the same decisionId and tokenId.
 * @param {object} database
 * @param {string} decisionId
 * @param {string} clobTokenId
 * @returns {boolean}
 */
function isDuplicate(database, decisionId, clobTokenId) {
  const row = database.prepare(`
    SELECT id FROM follow_orders
    WHERE decisionId = ? AND clobTokenId = ? AND status = 'PENDING'
    LIMIT 1
  `).get(decisionId, clobTokenId);
  return !!row;
}

/**
 * Check for conflicting orders (opposite side active on same token).
 * @param {object} database
 * @param {string} clobTokenId
 * @param {string} side
 * @returns {boolean}
 */
function hasConflict(database, clobTokenId, side) {
  const opposite = side === 'BUY' ? 'SELL' : 'BUY';
  const row = database.prepare(`
    SELECT id FROM follow_orders
    WHERE clobTokenId = ? AND side = ? AND status IN ('PENDING', 'FILLED')
    LIMIT 1
  `).get(clobTokenId, opposite);
  return !!row;
}

// ─── Re-entry Prevention ────────────────────────────────────────────────────

/**
 * Check if the expert is re-entering a previously settled/closed position.
 * @param {object} database
 * @param {string} clobTokenId
 * @returns {object|null} Previous closed order info
 */
function findPreviousClosedPosition(database, clobTokenId) {
  return database.prepare(`
    SELECT id, price, side, status, filledSize, closed_price, realized_pnl
    FROM follow_orders
    WHERE clobTokenId = ? AND status IN ('SETTLED', 'EXPERT_CLOSED')
    ORDER BY updatedAt DESC
    LIMIT 1
  `).get(clobTokenId);
}

// ─── Core Executor Functions ─────────────────────────────────────────────────

/**
 * Process pending decisions: follow expert signals.
 * @param {Array<object>} decisions - Array of {decisionId, clobTokenId, side, price, size, title}
 */
async function processPendingDecisions(decisions) {
  const database = getDb();

  const insertOrder = database.prepare(`
    INSERT INTO follow_orders (decisionId, clobTokenId, side, price, size, orderId, status, filledSize)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const dec of decisions) {
    const { decisionId, clobTokenId, side, price, size, title } = dec;

    // Existing: Deduplication check
    if (isDuplicate(database, decisionId, clobTokenId)) {
      console.log(`[SKIP] Duplicate: ${decisionId} / ${clobTokenId}`);
      continue;
    }

    // Existing: Conflict Alert
    if (hasConflict(database, clobTokenId, side)) {
      console.log(`[CONFLICT] Opposite active order on ${clobTokenId}`);
      sendAlert(`⚠️ 冲突告警: ${title}\n检测到与当前持仓方向相反的活跃订单，请人工确认。`);
      continue;
    }

    // NEW: Re-entry Prevention
    const prevClosed = findPreviousClosedPosition(database, clobTokenId);
    if (prevClosed) {
      // Expert is re-entering a previously closed position — skip automatically
      insertOrder.run(
        decisionId, clobTokenId, side, price, size,
        null, // orderId
        'SKIPPED_REENTRY',
        0
      );

      const prevPrice = prevClosed.price || 'N/A';
      sendAlert(
        `⚠️ 专家重新入场已平仓标的: ${title}\n` +
        `历史跟单价: ${prevPrice} | 当前专家价: ${price}\n` +
        `请确认是否需要手动干预。`
      );

      console.log(`[SKIP RE-ENTRY] ${clobTokenId} was previously closed at ${prevClosed.status}`);
      continue;
    }

    // Follow the signal (simulated fill)
    try {
      insertOrder.run(decisionId, clobTokenId, side, price, size, null, 'PENDING', 0);
      console.log(`[FOLLOW] ${side} ${size} @ ${price} on ${clobTokenId}`);
    } catch (err) {
      console.error(`[ERROR] Failed to follow decision ${decisionId}:`, err.message);
    }
  }
}

/**
 * Check active orders for expert close-through and stop-loss.
 */
async function checkActiveOrders() {
  const database = getDb();

  const activeOrders = database.prepare(`
    SELECT * FROM follow_orders
    WHERE status IN ('PENDING', 'FILLED')
  `).all();

  const updateOrder = database.prepare(`
    UPDATE follow_orders
    SET status = ?, closed_price = ?, realized_pnl = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  for (const order of activeOrders) {
    // ── Expert Close Follow-Through ──
    // Check if the expert's position size has dropped to 0
    const expertSize = await fetchExpertPositionSize(order.decisionId, order.clobTokenId);
    if (expertSize === 0 && (order.status === 'FILLED' || order.filledSize > 0)) {
      const currentPrice = await fetchClobMidpoint(order.clobTokenId);
      if (currentPrice) {
        const realizedPnl = (currentPrice - order.price) * order.size;
        updateOrder.run('EXPERT_CLOSED', currentPrice, realizedPnl, order.id);

        const pnlSign = realizedPnl >= 0 ? '+' : '';
        sendAlert(
          `🔔 专家已平仓: ${order.clobTokenId}\n` +
          `跟单价: ${order.price} → 当前价: ${currentPrice}\n` +
          `已实现 PnL: ${pnlSign}${realizedPnl.toFixed(2)} USDC\n` +
          `状态: EXPERT_CLOSED`
        );
        console.log(`[EXPERT CLOSED] ${order.clobTokenId} PnL: ${realizedPnl.toFixed(2)}`);
      }
      continue;
    }

    // ── Max Drawdown Stop-Loss ──
    // Only check FILLED orders with a known entry
    if (order.status === 'FILLED' && order.filledSize > 0) {
      const currentPrice = await fetchClobMidpoint(order.clobTokenId);
      if (currentPrice) {
        const entryValue = order.price * order.size;
        const unrealizedPnl = (currentPrice - order.price) * order.size;
        const drawdownPct = entryValue > 0 ? unrealizedPnl / entryValue : 0;

        if (drawdownPct <= -MAX_DRAWDOWN_PCT) {
          updateOrder.run('STOP_LOSS', currentPrice, unrealizedPnl, order.id);

          const pnlSign = unrealizedPnl >= 0 ? '+' : '';
          sendAlert(
            `🛑 止损触发: ${order.clobTokenId}\n` +
            `跟单价: ${order.price} → 止损价: ${currentPrice}\n` +
            `回撤: ${(drawdownPct * 100).toFixed(1)}%\n` +
            `已实现 PnL: ${pnlSign}${unrealizedPnl.toFixed(2)} USDC\n` +
            `状态: STOP_LOSS`
          );
          console.log(`[STOP LOSS] ${order.clobTokenId} drawdown: ${(drawdownPct * 100).toFixed(1)}%`);
        }
      }
    }
  }
}

// ─── Backfill Migration ──────────────────────────────────────────────────────

/**
 * One-time migration: calculate realized_pnl for existing SETTLED orders
 * where it is NULL. Uses Win/Loss logic based on entry price vs settlement.
 */
async function backfillRealizedPnl() {
  const database = getDb();

  // Find SETTLED orders with NULL realized_pnl
  const orders = database.prepare(`
    SELECT id, price, size, status, closed_price, realized_pnl
    FROM follow_orders
    WHERE status = 'SETTLED' AND realized_pnl IS NULL
  `).all();

  if (orders.length === 0) {
    console.log('[MIGRATION] No SETTLED orders need backfill.');
    return;
  }

  const updateOrder = database.prepare(`
    UPDATE follow_orders SET realized_pnl = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?
  `);

  let backfilled = 0;
  for (const order of orders) {
    let pnl = null;

    if (order.closed_price !== null && order.closed_price !== undefined) {
      // If closed_price is set, use it
      pnl = (order.closed_price - order.price) * order.size;
    } else {
      // Win/Loss logic for SETTLED binary markets:
      // If the position was BUY (yes), and the market resolved to 1.00 (yes wins):
      //   Win: profit = (1.00 - entry_price) * size
      //   Loss: loss = -entry_price * size
      // For simplicity, we estimate based on typical binary resolution.
      // In production, this would query the actual market resolution.
      // Default conservative approach: assume loss for unresolved closed_price
      pnl = -order.price * order.size; // conservative loss estimate
    }

    updateOrder.run(pnl, order.id);
    backfilled++;
  }

  console.log(`[MIGRATION] Backfilled realized_pnl for ${backfilled} SETTLED orders.`);
}

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the executor: set up DB and run migration.
 */
async function initExecutor() {
  initDb();
  await backfillRealizedPnl();
  console.log('[EXECUTOR] Initialized.');
}

module.exports = {
  initExecutor,
  processPendingDecisions,
  checkActiveOrders,
  backfillRealizedPnl,
  fetchClobMidpoint,
  setAlertCallback,
  getDb,
  closeDb,
};
