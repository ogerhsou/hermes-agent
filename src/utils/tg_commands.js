const { getDb, initDb } = require('./db');
const { fetchClobMidpoint } = require('../executor/clob_executor');

// ─── /positions Command ─────────────────────────────────────────────────────

/**
 * Build the /positions message text.
 * @returns {Promise<string>}
 */
async function buildPositionsMessage() {
  initDb();
  const database = getDb();

  // ── Section 1: Open (PENDING) ──
  const openOrders = database.prepare(`
    SELECT id, decisionId, clobTokenId, side, price, size, status, filledSize, createdAt
    FROM follow_orders
    WHERE status = 'PENDING'
    ORDER BY createdAt DESC
  `).all();

  let openSection = '📊 *未平仓 (Open)*\n';

  if (openOrders.length === 0) {
    openSection += '暂无未平仓订单。\n';
  } else {
    let totalUnrealized = 0;

    for (const order of openOrders) {
      const currentPrice = await fetchClobMidpoint(order.clobTokenId);
      let unrealizedPnl = 0;
      let priceInfo = '';

      if (currentPrice) {
        const size = order.filledSize || order.size;
        unrealizedPnl = (currentPrice - order.price) * size;
        totalUnrealized += unrealizedPnl;
        const sign = unrealizedPnl >= 0 ? '+' : '';
        priceInfo = `\n  当前价: ${currentPrice} | 未实现 PnL: ${sign}${unrealizedPnl.toFixed(2)} USDC`;
      } else {
        priceInfo = '\n  (无法获取实时价格)';
      }

      openSection += `• ${order.clobTokenId}\n` +
        `  方向: ${order.side} | 跟单价: ${order.price} | 数量: ${order.size}${priceInfo}\n`;
    }

    const sign = totalUnrealized >= 0 ? '+' : '';
    openSection += `\n💰 总未实现 PnL: ${sign}${totalUnrealized.toFixed(2)} USDC\n`;
  }

  // ── Section 2: Closed ──
  const closedOrders = database.prepare(`
    SELECT id, decisionId, clobTokenId, side, price, size, status, filledSize,
           closed_price, realized_pnl, updatedAt
    FROM follow_orders
    WHERE status IN ('SETTLED', 'EXPERT_CLOSED', 'STOP_LOSS')
    ORDER BY updatedAt DESC
    LIMIT 10
  `).all();

  let closedSection = '\n📈 *已平仓 (Closed)*\n';

  if (closedOrders.length === 0) {
    closedSection += '暂无已平仓订单。\n';
  } else {
    let totalRealized = 0;

    for (const order of closedOrders) {
      const realizedPnl = order.realized_pnl || 0;
      totalRealized += realizedPnl;

      const sign = realizedPnl >= 0 ? '+' : '';
      const closePrice = order.closed_price !== null ? ` → ${order.closed_price}` : '';
      const statusLabel = order.status === 'EXPERT_CLOSED' ? '🔔 专家平仓' :
                          order.status === 'STOP_LOSS' ? '🛑 止损' : '✅ 已结算';

      closedSection += `${statusLabel} ${order.clobTokenId}\n` +
        `  ${order.side} ${order.size} @ ${order.price}${closePrice} | PnL: ${sign}${realizedPnl.toFixed(2)}\n`;
    }

    const sign = totalRealized >= 0 ? '+' : '';
    closedSection += `\n💰 总已实现 PnL: ${sign}${totalRealized.toFixed(2)} USDC\n`;
  }

  // ── Summary ──
  // Recalculate totals for accuracy
  const realizedRow = database.prepare(`
    SELECT COALESCE(SUM(realized_pnl), 0) as total_realized
    FROM follow_orders
    WHERE status IN ('SETTLED', 'EXPERT_CLOSED', 'STOP_LOSS')
  `).get();

  let totalUnrealizedPnl = 0;
  for (const order of openOrders) {
    if (order.filledSize > 0) {
      const currentPrice = await fetchClobMidpoint(order.clobTokenId);
      if (currentPrice) {
        totalUnrealizedPnl += (currentPrice - order.price) * order.filledSize;
      }
    }
  }

  const realizedSign = realizedRow.total_realized >= 0 ? '+' : '';
  const unrealizedSign = totalUnrealizedPnl >= 0 ? '+' : '';

  const summary =
    `\n━━━━━━━━━━━━━━━━━━━\n` +
    `📋 *汇总*\n` +
    `总已实现 PnL: ${realizedSign}${realizedRow.total_realized.toFixed(2)} USDC\n` +
    `总未实现 PnL: ${unrealizedSign}${totalUnrealizedPnl.toFixed(2)} USDC`;

  return openSection + closedSection + summary;
}

// ─── /help Command ───────────────────────────────────────────────────────────

function buildHelpMessage() {
  return (
    '🤖 *Polymarket 跟单机器人*\n\n' +
    '*可用命令:*\n' +
    '/start — 启动机器人\n' +
    '/help — 显示此帮助信息\n' +
    '/status — 查看运行状态\n' +
    '/positions — 查看持仓和 PnL 详情\n' +
    '/decisions — 查看最新专家决策\n' +
    '/pause — 暂停跟单\n' +
    '/resume — 恢复跟单\n\n' +
    '*持仓管理:*\n' +
    '• 自动止损: 回撤超过 20% 自动平仓\n' +
    '• 专家平仓跟随: 专家平仓时自动结算\n' +
    '• 防重复入场: 已平仓标的重新入场需确认'
  );
}

// ─── Command Handler Router ──────────────────────────────────────────────────

/**
 * Handle incoming commands.
 * @param {string} command - The command string (e.g., "/positions")
 * @returns {Promise<string|null>} Response message or null if not handled.
 */
async function handleCommand(command) {
  const cmd = command.split(' ')[0].toLowerCase();

  switch (cmd) {
    case '/positions':
      return await buildPositionsMessage();
    case '/help':
      return buildHelpMessage();
    default:
      return null;
  }
}

module.exports = {
  buildPositionsMessage,
  buildHelpMessage,
  handleCommand,
};
