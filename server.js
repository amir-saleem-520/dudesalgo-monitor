/**
 * ============================================================
 * DUDE'S ALGO — MT5 Account Intelligence Backend
 * ============================================================
 * Stack: Node.js + Express + MongoDB Atlas
 * Deploy: Railway (add env vars in Railway dashboard)
 * ============================================================
 */

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve dashboard

// ─── MongoDB Connection ───────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dudesalgo_monitor')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── Schemas ──────────────────────────────────────────────────

// Snapshot: saved every time the EA sends data
const SnapshotSchema = new mongoose.Schema({
  accountLogin:  Number,
  accountName:   String,
  server:        String,
  broker:        String,
  balance:       Number,
  equity:        Number,
  margin:        Number,
  freeMargin:    Number,
  marginLevel:   Number,
  profit:        Number,        // floating P&L right now
  leverage:      Number,
  openPositions: Array,         // full array of open trades
  symbolStats:   Array,         // per-symbol summary
  timestamp:     { type: Date, default: Date.now }
});

// Individual closed trade (deduplicated by ticket)
const TradeSchema = new mongoose.Schema({
  accountLogin: Number,
  ticket:       { type: Number, unique: true },
  symbol:       String,
  type:         String,         // BUY or SELL
  lots:         Number,
  price:        Number,
  profit:       Number,
  swap:         Number,
  commission:   Number,
  magic:        Number,
  comment:      String,
  time:         Date
});

// Strategy analysis result (computed and cached)
const StrategySchema = new mongoose.Schema({
  accountLogin:    Number,
  analysisTime:    { type: Date, default: Date.now },
  strategies:      Array,       // detected strategies per magic number
  gridAnalysis:    Object,      // grid spacing, lot progression
  sessionAnalysis: Object,      // what hours trades open
  performanceSummary: Object,   // win rate, PF, drawdown etc
  aiSummary:       String       // human-readable summary text
});

const Snapshot = mongoose.model('Snapshot', SnapshotSchema);
const Trade    = mongoose.model('Trade',    TradeSchema);
const Strategy = mongoose.model('Strategy', StrategySchema);

// ─── API Key Middleware ───────────────────────────────────────
const API_KEY = process.env.API_KEY || 'dudesalgo_secret_key_2026';

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.body?.apiKey;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
// ROUTE 1: Receive data from MT5 EA
// POST /api/report
// ═══════════════════════════════════════════════════════════════
app.post('/api/report', requireApiKey, async (req, res) => {
  try {
    const { account, openPositions, closedTrades, symbolStats } = req.body;

    if (!account) return res.status(400).json({ error: 'No account data' });

    // 1. Save snapshot
    await Snapshot.create({
      accountLogin:  account.login,
      accountName:   account.name,
      server:        account.server,
      broker:        account.broker,
      balance:       account.balance,
      equity:        account.equity,
      margin:        account.margin,
      freeMargin:    account.freeMargin,
      marginLevel:   account.marginLevel,
      profit:        account.profit,
      leverage:      account.leverage,
      openPositions: openPositions || [],
      symbolStats:   symbolStats   || [],
      timestamp:     new Date(account.timestamp * 1000)
    });

    // 2. Save new closed trades (skip duplicates)
    if (closedTrades && closedTrades.length > 0) {
      for (const trade of closedTrades) {
        try {
          await Trade.create({
            accountLogin: account.login,
            ticket:       trade.ticket,
            symbol:       trade.symbol,
            type:         trade.type,
            lots:         trade.lots,
            price:        trade.price,
            profit:       trade.profit,
            swap:         trade.swap,
            commission:   trade.commission,
            magic:        trade.magic,
            comment:      trade.comment,
            time:         new Date(trade.time * 1000)
          });
        } catch (e) {
          // Duplicate ticket — skip silently
        }
      }
    }

    // 3. Run strategy analysis (async, don't wait)
    runStrategyAnalysis(account.login).catch(console.error);

    res.json({ status: 'ok', received: new Date().toISOString() });

  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 2: Get dashboard data
// GET /api/dashboard/:accountLogin
// ═══════════════════════════════════════════════════════════════
app.get('/api/dashboard/:accountLogin', async (req, res) => {
  try {
    const login = parseInt(req.params.accountLogin);

    // Latest snapshot
    const latest = await Snapshot.findOne({ accountLogin: login })
      .sort({ timestamp: -1 });

    // Equity curve (last 200 snapshots)
    const equityCurve = await Snapshot.find({ accountLogin: login })
      .sort({ timestamp: -1 })
      .limit(200)
      .select('equity balance profit timestamp');

    // All closed trades
    const trades = await Trade.find({ accountLogin: login })
      .sort({ time: -1 })
      .limit(500);

    // Latest strategy analysis
    const strategy = await Strategy.findOne({ accountLogin: login })
      .sort({ analysisTime: -1 });

    res.json({
      latest:     latest,
      equityCurve: equityCurve.reverse(),
      trades:     trades,
      strategy:   strategy
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTE 3: Get all monitored accounts
// GET /api/accounts
// ═══════════════════════════════════════════════════════════════
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await Snapshot.aggregate([
      { $sort: { timestamp: -1 } },
      { $group: {
          _id: '$accountLogin',
          login:      { $first: '$accountLogin' },
          name:       { $first: '$accountName' },
          broker:     { $first: '$broker' },
          balance:    { $first: '$balance' },
          equity:     { $first: '$equity' },
          profit:     { $first: '$profit' },
          marginLevel: { $first: '$marginLevel' },
          lastSeen:   { $first: '$timestamp' }
      }}
    ]);
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// STRATEGY ANALYSIS ENGINE
// Runs after each data report — detects patterns automatically
// ═══════════════════════════════════════════════════════════════
async function runStrategyAnalysis(accountLogin) {

  const trades = await Trade.find({ accountLogin }).sort({ time: 1 });
  if (trades.length < 5) return; // Need minimum data

  // ── Group by Magic Number ──
  const byMagic = {};
  for (const t of trades) {
    const key = t.magic || 0;
    if (!byMagic[key]) byMagic[key] = [];
    byMagic[key].push(t);
  }

  const strategies = [];

  for (const [magic, magicTrades] of Object.entries(byMagic)) {

    const symbols   = [...new Set(magicTrades.map(t => t.symbol))];
    const totalPnL  = magicTrades.reduce((s, t) => s + t.profit, 0);
    const wins      = magicTrades.filter(t => t.profit > 0).length;
    const losses    = magicTrades.filter(t => t.profit < 0).length;
    const winRate   = (wins / magicTrades.length) * 100;

    const lots      = magicTrades.map(t => t.lots).sort((a,b) => a-b);
    const minLot    = Math.min(...lots);
    const maxLot    = Math.max(...lots);
    const uniqueLots = [...new Set(lots)];

    // ── Detect Lot Progression Pattern ──
    let lotPattern = 'fixed';
    let lotMultiplier = null;
    if (uniqueLots.length > 1) {
      // Check martingale (each level roughly doubles)
      const ratios = [];
      for (let i = 1; i < uniqueLots.length; i++) {
        ratios.push(uniqueLots[i] / uniqueLots[i-1]);
      }
      const avgRatio = ratios.reduce((s,r) => s+r, 0) / ratios.length;
      if (avgRatio >= 1.8 && avgRatio <= 2.2) {
        lotPattern    = 'martingale';
        lotMultiplier = avgRatio.toFixed(2);
      } else if (avgRatio > 1.0) {
        lotPattern    = 'scaling';
        lotMultiplier = avgRatio.toFixed(2);
      }
    }

    // ── Detect Basket Close (all trades close at same time) ──
    const closeTimes  = magicTrades.map(t => t.time.getTime());
    const timeGroups  = {};
    for (const ct of closeTimes) {
      const rounded = Math.round(ct / 5000) * 5000; // group within 5 seconds
      timeGroups[rounded] = (timeGroups[rounded] || 0) + 1;
    }
    const maxGroup    = Math.max(...Object.values(timeGroups));
    const basketClose = maxGroup >= 3; // 3+ trades close within 5 seconds = basket

    // ── Detect Session (what hours trades open most) ──
    const hourCounts = new Array(24).fill(0);
    for (const t of magicTrades) {
      const hour = new Date(t.time).getUTCHours();
      hourCounts[hour]++;
    }
    const peakHour    = hourCounts.indexOf(Math.max(...hourCounts));
    let   sessionName = 'All Sessions';
    if (peakHour >= 7  && peakHour <= 11) sessionName = 'London Session';
    if (peakHour >= 12 && peakHour <= 17) sessionName = 'New York Session';
    if (peakHour >= 0  && peakHour <= 5)  sessionName = 'Asian Session';

    // ── Detect Direction Bias ──
    const buys  = magicTrades.filter(t => t.type === 'BUY').length;
    const sells = magicTrades.filter(t => t.type === 'SELL').length;
    let   bias  = 'Balanced';
    if (buys  > sells * 1.5) bias = 'Long Bias';
    if (sells > buys  * 1.5) bias = 'Short Bias';

    // ── Detect Grid Pattern ──
    let gridAnalysis = null;
    const sellTrades  = magicTrades.filter(t => t.type === 'SELL').slice(-20);
    if (sellTrades.length >= 3) {
      const prices = sellTrades.map(t => t.price).sort((a,b) => a-b);
      const gaps   = [];
      for (let i = 1; i < prices.length; i++) {
        gaps.push(Math.round((prices[i] - prices[i-1]) * 10) / 10); // round to 0.1
      }
      const avgGap   = gaps.reduce((s,g) => s+g, 0) / gaps.length;
      const consistent = gaps.filter(g => Math.abs(g - avgGap) < avgGap * 0.3).length;
      const isGrid   = consistent >= gaps.length * 0.6;

      if (isGrid) {
        gridAnalysis = {
          detected:        true,
          avgSpacingPips:  (avgGap / 0.1).toFixed(0), // convert to pips for Gold
          priceMin:        Math.min(...prices).toFixed(3),
          priceMax:        Math.max(...prices).toFixed(3),
          levelsDetected:  prices.length,
          consistency:     ((consistent / gaps.length) * 100).toFixed(0) + '%'
        };
      }
    }

    // ── Classify Strategy Type ──
    let strategyType = 'Unknown';
    if (gridAnalysis?.detected && basketClose) strategyType = 'Grid EA with Basket TP';
    else if (gridAnalysis?.detected)           strategyType = 'Grid EA';
    else if (lotPattern === 'martingale')       strategyType = 'Martingale EA';
    else if (basketClose)                       strategyType = 'Basket Close EA';
    else if (lotPattern === 'fixed')            strategyType = 'Fixed Lot EA';

    // ── Profit Factor ──
    const grossProfit = magicTrades.filter(t=>t.profit>0).reduce((s,t)=>s+t.profit,0);
    const grossLoss   = Math.abs(magicTrades.filter(t=>t.profit<0).reduce((s,t)=>s+t.profit,0));
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞';

    strategies.push({
      magic:         parseInt(magic),
      tradeCount:    magicTrades.length,
      symbols,
      strategyType,
      lotPattern,
      lotMultiplier,
      minLot,
      maxLot,
      uniqueLotLevels: uniqueLots.length,
      basketClose,
      sessionName,
      bias,
      gridAnalysis,
      performance: {
        totalPnL:     totalPnL.toFixed(2),
        wins,
        losses,
        winRate:      winRate.toFixed(1),
        profitFactor,
        grossProfit:  grossProfit.toFixed(2),
        grossLoss:    grossLoss.toFixed(2),
        avgWin:       wins > 0 ? (grossProfit/wins).toFixed(2) : 0,
        avgLoss:      losses > 0 ? (grossLoss/losses).toFixed(2) : 0
      }
    });
  }

  // ── Session Analysis (account-wide) ──
  const hourMap = new Array(24).fill(0);
  for (const t of trades) hourMap[new Date(t.time).getUTCHours()]++;

  // ── Generate Human-Readable Summary ──
  const summaryLines = [];
  for (const s of strategies) {
    summaryLines.push(
      `Magic ${s.magic}: ${s.strategyType} on ${s.symbols.join('/')} — ` +
      `${s.performance.winRate}% win rate, PF ${s.performance.profitFactor}, ` +
      `${s.lotPattern} lots (${s.minLot}→${s.maxLot}), ` +
      `${s.basketClose ? 'basket close detected' : 'individual closes'}, ` +
      `${s.bias}, active in ${s.sessionName}.`
    );
  }

  await Strategy.create({
    accountLogin:    accountLogin,
    strategies,
    sessionAnalysis: { hourlyTrades: hourMap },
    performanceSummary: {
      totalTrades:   trades.length,
      totalPnL:      trades.reduce((s,t) => s+t.profit, 0).toFixed(2),
      symbols:       [...new Set(trades.map(t => t.symbol))]
    },
    aiSummary: summaryLines.join('\n\n')
  });
}

// ─── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   Dude's Algo Monitor Backend LIVE    ║
║   Port: ${PORT}                          ║
║   MongoDB: Connected                  ║
╚════════════════════════════════════════╝
  `);
});
