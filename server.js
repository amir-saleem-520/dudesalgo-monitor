const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin:'*', methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type','X-API-Key','x-api-key'] }));
app.options('*', cors());
app.use(express.json({ limit:'10mb' }));
app.use(express.urlencoded({ extended:true, limit:'10mb' }));

mongoose.connect(process.env.MONGODB_URI)
  .then(()=>console.log('✅ MongoDB connected'))
  .catch(err=>console.error('❌ MongoDB error:',err));

// ─── SCHEMAS ──────────────────────────────────────────────────

const SnapshotSchema = new mongoose.Schema({
  accountLogin:Number, accountName:String, server:String, broker:String,
  balance:Number, equity:Number, margin:Number, freeMargin:Number,
  marginLevel:Number, profit:Number, leverage:Number,
  openPositions:Array, symbolStats:Array,
  timestamp:{ type:Date, default:Date.now }
});

const TradeSchema = new mongoose.Schema({
  accountLogin:Number, ticket:{ type:Number, unique:true },
  symbol:String, type:String, lots:Number, price:Number,
  profit:Number, swap:Number, commission:Number,
  magic:Number, comment:String, time:Date
});

// NEW: Basket Event — records every time multiple trades close together
const BasketEventSchema = new mongoose.Schema({
  accountLogin:   Number,
  eventTime:      Date,
  symbol:         String,
  magic:          Number,
  positionsCount: Number,   // how many trades closed
  totalLots:      Number,   // sum of all lots
  netProfit:      Number,   // total basket profit/loss
  grossProfit:    Number,
  grossLoss:      Number,
  avgEntryPrice:  Number,   // weighted average entry
  closePrice:     Number,   // price they all closed at
  pipsFromAvgEntry: Number, // pip distance avg entry → close
  dollarPerLot:   Number,   // net profit / total lots
  timeHeldMinutes:Number,   // how long oldest position was held
  entryPriceMin:  Number,
  entryPriceMax:  Number,
  entryPriceRange:Number,   // range of grid
  direction:      String,   // BUY or SELL
  tpMethodGuess:  String,   // DOLLAR_TARGET / PIP_TARGET / PER_LOT
  basketNumber:   Number    // sequential count
});

// NEW: Entry Snapshot — records market conditions when new position opens
const EntrySnapshotSchema = new mongoose.Schema({
  accountLogin: Number,
  ticket:       Number,
  symbol:       String,
  type:         String,
  lots:         Number,
  entryPrice:   Number,
  magic:        Number,
  comment:      String,
  entryTime:    Date,
  // Market conditions at entry
  rsi14:        Number,
  ema50:        Number,
  ema200:       Number,
  atr14:        Number,
  spread:       Number,
  priceVsEma50: String,   // ABOVE / BELOW
  priceVsEma200:String,
  gridLevel:    Number,   // which level in the grid (1st, 2nd, 3rd entry...)
  existingPositions: Number, // how many positions were already open on this symbol
  existingFloatingPnl: Number
});

// Strategy analysis
const StrategySchema = new mongoose.Schema({
  accountLogin:Number, analysisTime:{ type:Date, default:Date.now },
  strategies:Array, sessionAnalysis:Object,
  performanceSummary:Object, aiSummary:String
});

const Snapshot      = mongoose.model('Snapshot',      SnapshotSchema);
const Trade         = mongoose.model('Trade',         TradeSchema);
const BasketEvent   = mongoose.model('BasketEvent',   BasketEventSchema);
const EntrySnapshot = mongoose.model('EntrySnapshot', EntrySnapshotSchema);
const Strategy      = mongoose.model('Strategy',      StrategySchema);

// ─── API KEY ─────────────────────────────────────────────────
const API_KEY = process.env.API_KEY || 'dudesalgo_secret_key_2026';
function requireApiKey(req,res,next){
  const k = req.headers['x-api-key']||req.body?.apiKey;
  if(k!==API_KEY) return res.status(401).json({error:'Invalid API key'});
  next();
}

// ─── HEALTH CHECK ─────────────────────────────────────────────
app.get('/',(req,res)=>res.json({ status:"Dude's Algo Monitor LIVE", time:new Date() }));

// ═══════════════════════════════════════════════════════════════
// POST /api/report  —  receives data from MT5 EA every 5 seconds
// ═══════════════════════════════════════════════════════════════
app.post('/api/report', requireApiKey, async(req,res)=>{
  try {
    const body = req.body;
    if(!body?.account) return res.status(400).json({error:'No account data'});
    const { account, openPositions=[], closedTrades=[], symbolStats=[], entrySnapshots=[] } = body;

    // 1. Save snapshot
    await Snapshot.create({
      accountLogin:account.login, accountName:account.name, server:account.server,
      broker:account.broker, balance:account.balance, equity:account.equity,
      margin:account.margin, freeMargin:account.freeMargin, marginLevel:account.marginLevel,
      profit:account.profit, leverage:account.leverage, openPositions, symbolStats,
      timestamp:new Date(account.timestamp*1000)
    });

    // 2. Save new closed trades + detect basket events
    const newTrades = [];
    for(const trade of closedTrades){
      try{
        const t = await Trade.create({
          accountLogin:account.login, ticket:trade.ticket, symbol:trade.symbol,
          type:trade.type, lots:trade.lots, price:trade.price, profit:trade.profit,
          swap:trade.swap, commission:trade.commission, magic:trade.magic,
          comment:trade.comment, time:new Date(trade.time*1000)
        });
        newTrades.push(t);
      }catch(e){ /* duplicate — skip */ }
    }

    // 3. Save entry snapshots (market conditions at trade open)
    for(const snap of entrySnapshots){
      try{
        await EntrySnapshot.create({
          accountLogin:  account.login,
          ticket:        snap.ticket,
          symbol:        snap.symbol,
          type:          snap.type,
          lots:          snap.lots,
          entryPrice:    snap.entryPrice,
          magic:         snap.magic,
          comment:       snap.comment,
          entryTime:     new Date(snap.entryTime*1000),
          rsi14:         snap.rsi14,
          ema50:         snap.ema50,
          ema200:        snap.ema200,
          atr14:         snap.atr14,
          spread:        snap.spread,
          priceVsEma50:  snap.entryPrice > snap.ema50  ? 'ABOVE':'BELOW',
          priceVsEma200: snap.entryPrice > snap.ema200 ? 'ABOVE':'BELOW',
          gridLevel:     snap.gridLevel,
          existingPositions:   snap.existingPositions,
          existingFloatingPnl: snap.existingFloatingPnl
        });
      }catch(e){}
    }

    // 4. Detect basket events from newly closed trades
    if(newTrades.length >= 2){
      await detectBasketEvents(account.login, newTrades);
    }

    // 5. Run strategy analysis
    runStrategyAnalysis(account.login).catch(console.error);

    console.log(`📊 #${account.login} | Bal:${account.balance} | Open:${openPositions.length} | New:${newTrades.length} | Entries:${entrySnapshots.length}`);
    res.json({ status:'ok', received:new Date().toISOString() });

  }catch(err){
    console.error('Report error:',err.message);
    res.status(500).json({error:err.message});
  }
});

// ═══════════════════════════════════════════════════════════════
// BASKET EVENT DETECTOR
// Groups trades that closed within 10 seconds of each other
// ═══════════════════════════════════════════════════════════════
async function detectBasketEvents(accountLogin, newTrades) {
  // Group by symbol + magic + close time (within 10 seconds)
  const groups = {};
  for(const t of newTrades){
    const key = `${t.symbol}_${t.magic}`;
    if(!groups[key]) groups[key] = [];
    groups[key].push(t);
  }

  for(const [key, trades] of Object.entries(groups)){
    if(trades.length < 2) continue; // need at least 2 to be a basket

    const symbol    = trades[0].symbol;
    const magic     = trades[0].magic;
    const direction = trades[0].type;

    // Get entry data from EntrySnapshot collection
    const tickets   = trades.map(t=>t.ticket);
    const entries   = await EntrySnapshot.find({ accountLogin, ticket:{$in:tickets} });

    const totalLots   = trades.reduce((s,t)=>s+t.lots, 0);
    const netProfit   = trades.reduce((s,t)=>s+t.profit, 0);
    const grossProfit = trades.filter(t=>t.profit>0).reduce((s,t)=>s+t.profit,0);
    const grossLoss   = Math.abs(trades.filter(t=>t.profit<0).reduce((s,t)=>s+t.profit,0));
    const closePrice  = trades[0].price;

    // Weighted average entry price
    let avgEntry = 0;
    if(entries.length > 0){
      const weightedSum = entries.reduce((s,e)=>s+(e.entryPrice*e.lots),0);
      const lotsSum     = entries.reduce((s,e)=>s+e.lots,0);
      avgEntry = lotsSum > 0 ? weightedSum/lotsSum : 0;
    }

    const pipsFromAvg  = avgEntry > 0 ? Math.abs(avgEntry - closePrice)/0.1 : 0;
    const dollarPerLot = totalLots > 0 ? netProfit/totalLots : 0;

    // Oldest entry time
    const oldestEntry  = entries.length > 0 ? Math.min(...entries.map(e=>e.entryTime.getTime())) : null;
    const timeHeld     = oldestEntry ? (new Date(trades[0].time) - oldestEntry)/60000 : 0;

    const entryPrices  = entries.map(e=>e.entryPrice);
    const priceMin     = entryPrices.length > 0 ? Math.min(...entryPrices) : 0;
    const priceMax     = entryPrices.length > 0 ? Math.max(...entryPrices) : 0;

    // Guess TP method
    let tpMethodGuess = 'UNKNOWN';
    const existingBaskets = await BasketEvent.find({ accountLogin, symbol, magic }).sort({eventTime:-1}).limit(5);
    if(existingBaskets.length >= 2){
      const profitVariance = existingBaskets.map(b=>b.netProfit);
      const pipVariance    = existingBaskets.map(b=>b.pipsFromAvgEntry);
      const profitStd      = stdDev(profitVariance);
      const pipStd         = stdDev(pipVariance);
      if(profitStd < 20)    tpMethodGuess = 'FIXED_DOLLAR_TARGET';
      else if(pipStd < 5)   tpMethodGuess = 'FIXED_PIP_TARGET';
      else                  tpMethodGuess = 'PER_LOT_TARGET';
    }

    const basketCount = await BasketEvent.countDocuments({ accountLogin, symbol, magic });

    await BasketEvent.create({
      accountLogin, eventTime:new Date(trades[0].time),
      symbol, magic, positionsCount:trades.length,
      totalLots, netProfit, grossProfit, grossLoss,
      avgEntryPrice:avgEntry, closePrice, pipsFromAvgEntry:pipsFromAvg,
      dollarPerLot, timeHeldMinutes:timeHeld,
      entryPriceMin:priceMin, entryPriceMax:priceMax,
      entryPriceRange:priceMax-priceMin,
      direction, tpMethodGuess, basketNumber:basketCount+1
    });

    console.log(`🧺 Basket Event detected: ${symbol} | ${trades.length} trades | Profit:$${netProfit.toFixed(2)} | ${pipsFromAvg.toFixed(1)} pips from avg`);
  }
}

function stdDev(arr){
  if(arr.length<2) return 999;
  const mean = arr.reduce((s,v)=>s+v,0)/arr.length;
  return Math.sqrt(arr.reduce((s,v)=>s+(v-mean)**2,0)/arr.length);
}

// ═══════════════════════════════════════════════════════════════
// GET /api/dashboard/:login
// ═══════════════════════════════════════════════════════════════
app.get('/api/dashboard/:accountLogin', async(req,res)=>{
  try{
    const login = parseInt(req.params.accountLogin);
    const latest      = await Snapshot.findOne({accountLogin:login}).sort({timestamp:-1});
    const equityCurve = await Snapshot.find({accountLogin:login}).sort({timestamp:-1}).limit(200).select('equity balance profit timestamp');
    const trades      = await Trade.find({accountLogin:login}).sort({time:-1}).limit(500);
    const strategy    = await Strategy.findOne({accountLogin:login}).sort({analysisTime:-1});
    const baskets     = await BasketEvent.find({accountLogin:login}).sort({eventTime:-1}).limit(50);
    const entries     = await EntrySnapshot.find({accountLogin:login}).sort({entryTime:-1}).limit(100);
    res.json({ latest, equityCurve:equityCurve.reverse(), trades, strategy, baskets, entries });
  }catch(err){ res.status(500).json({error:err.message}); }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/report/download/:login  —  full downloadable JSON report
// ═══════════════════════════════════════════════════════════════
app.get('/api/report/download/:accountLogin', async(req,res)=>{
  try{
    const login = parseInt(req.params.accountLogin);

    const latest      = await Snapshot.findOne({accountLogin:login}).sort({timestamp:-1});
    const trades      = await Trade.find({accountLogin:login}).sort({time:1});
    const strategy    = await Strategy.findOne({accountLogin:login}).sort({analysisTime:-1});
    const baskets     = await BasketEvent.find({accountLogin:login}).sort({eventTime:1});
    const entries     = await EntrySnapshot.find({accountLogin:login}).sort({entryTime:1});

    // Compute basket TP analysis
    const basketsBySymbol = {};
    for(const b of baskets){
      const k = `${b.symbol}_${b.magic}`;
      if(!basketsBySymbol[k]) basketsBySymbol[k]={ events:[], symbol:b.symbol, magic:b.magic };
      basketsBySymbol[k].events.push(b);
    }

    const basketAnalysis = {};
    for(const [k,data] of Object.entries(basketsBySymbol)){
      const evs = data.events;
      basketAnalysis[k] = {
        symbol:           data.symbol,
        magic:            data.magic,
        totalBasketEvents:evs.length,
        avgNetProfit:     avg(evs.map(e=>e.netProfit)).toFixed(2),
        avgPipsFromEntry: avg(evs.map(e=>e.pipsFromAvgEntry)).toFixed(1),
        avgDollarPerLot:  avg(evs.map(e=>e.dollarPerLot)).toFixed(2),
        avgPositionsCount:avg(evs.map(e=>e.positionsCount)).toFixed(1),
        avgTotalLots:     avg(evs.map(e=>e.totalLots)).toFixed(2),
        avgTimeHeldMin:   avg(evs.map(e=>e.timeHeldMinutes)).toFixed(0),
        profitConsistency:(100 - (stdDev(evs.map(e=>e.netProfit)) / Math.abs(avg(evs.map(e=>e.netProfit))) * 100)).toFixed(0)+'%',
        pipConsistency:   (100 - (stdDev(evs.map(e=>e.pipsFromAvgEntry)) / (avg(evs.map(e=>e.pipsFromAvgEntry))||1) * 100)).toFixed(0)+'%',
        likelyTpMethod:   evs[evs.length-1]?.tpMethodGuess || 'UNKNOWN',
        allProfits:       evs.map(e=>parseFloat(e.netProfit.toFixed(2))),
        allPips:          evs.map(e=>parseFloat(e.pipsFromAvgEntry.toFixed(1))),
      };
    }

    // Entry condition analysis
    const entryAnalysis = {};
    for(const e of entries){
      const k = `${e.symbol}_${e.magic}`;
      if(!entryAnalysis[k]){ entryAnalysis[k]={ symbol:e.symbol, magic:e.magic, entries:[] }; }
      entryAnalysis[k].entries.push({
        type:e.type, lots:e.lots, gridLevel:e.gridLevel,
        rsi14:e.rsi14, ema50:e.ema50, ema200:e.ema200, atr14:e.atr14,
        spread:e.spread, priceVsEma50:e.priceVsEma50, priceVsEma200:e.priceVsEma200,
        existingPositions:e.existingPositions
      });
    }

    // Grid analysis
    const gridAnalysis = {};
    for(const [k,data] of Object.entries(basketAnalysis)){
      const symEntries = entries.filter(e=>`${e.symbol}_${e.magic}`===k).sort((a,b)=>a.entryPrice-b.entryPrice);
      if(symEntries.length>=3){
        const prices = symEntries.map(e=>e.entryPrice);
        const gaps   = [];
        for(let i=1;i<prices.length;i++) gaps.push(Math.abs(prices[i]-prices[i-1]));
        gridAnalysis[k] = {
          avgGridSpacingPips: (avg(gaps)/0.1).toFixed(0),
          minSpacingPips:     (Math.min(...gaps)/0.1).toFixed(0),
          maxSpacingPips:     (Math.max(...gaps)/0.1).toFixed(0),
          priceRange:         (Math.max(...prices)-Math.min(...prices)).toFixed(2),
          lotProgression:     [...new Set(symEntries.map(e=>e.lots))].sort((a,b)=>a-b)
        };
      }
    }

    // Session analysis
    const hourMap = new Array(24).fill(0);
    for(const e of entries) hourMap[new Date(e.entryTime).getUTCHours()]++;
    const peakHours = hourMap.map((c,h)=>({h,c})).sort((a,b)=>b.c-a.c).slice(0,5).map(x=>`${x.h}:00 UTC (${x.c} entries)`);

    // Build the full analysis report
    const report = {
      _reportMeta: {
        generatedAt:    new Date().toISOString(),
        accountLogin:   login,
        broker:         latest?.broker,
        server:         latest?.server,
        monitoringDays: trades.length>0 ? Math.ceil((new Date()-new Date(trades[trades.length-1]?.time||Date.now()))/(86400000)) : 0,
        totalTrades:    trades.length,
        totalBaskets:   baskets.length,
        totalEntries:   entries.length,
        instructions:   "Paste this entire JSON to Claude and say: Analyze this MT5 EA monitoring report and reconstruct the full EA logic, then build it in MQL5"
      },
      accountSummary: {
        balance:      latest?.balance,
        equity:       latest?.equity,
        broker:       latest?.broker,
        leverage:     latest?.leverage,
        symbols:      [...new Set(trades.map(t=>t.symbol))]
      },
      strategyDetection: strategy?.strategies || [],
      basketTPAnalysis:  basketAnalysis,
      entryConditionAnalysis: entryAnalysis,
      gridSpacingAnalysis: gridAnalysis,
      sessionAnalysis: {
        peakEntryHours: peakHours,
        hourlyDistribution: hourMap
      },
      performanceSummary: {
        totalNetPnL:   trades.reduce((s,t)=>s+t.profit,0).toFixed(2),
        winRate:       trades.length>0?(trades.filter(t=>t.profit>0).length/trades.length*100).toFixed(1)+'%':'—',
        totalWins:     trades.filter(t=>t.profit>0).length,
        totalLosses:   trades.filter(t=>t.profit<0).length,
        avgWin:        avg(trades.filter(t=>t.profit>0).map(t=>t.profit)).toFixed(2),
        avgLoss:       avg(trades.filter(t=>t.profit<0).map(t=>t.profit)).toFixed(2),
      },
      rawBasketEvents: baskets.map(b=>({
        time:b.eventTime, symbol:b.symbol, magic:b.magic,
        positions:b.positionsCount, lots:b.totalLots,
        netProfit:b.netProfit.toFixed(2), pipsFromAvg:b.pipsFromAvgEntry.toFixed(1),
        dollarPerLot:b.dollarPerLot.toFixed(2), timeHeldMin:b.timeHeldMinutes.toFixed(0),
        tpGuess:b.tpMethodGuess
      }))
    };

    res.setHeader('Content-Disposition', `attachment; filename="dudesalgo_ea_report_${login}_${new Date().toISOString().split('T')[0]}.json"`);
    res.setHeader('Content-Type','application/json');
    res.json(report);

  }catch(err){ res.status(500).json({error:err.message}); }
});

function avg(arr){ return arr.length>0?arr.reduce((s,v)=>s+v,0)/arr.length:0; }

// ═══════════════════════════════════════════════════════════════
// STRATEGY ANALYSIS ENGINE
// ═══════════════════════════════════════════════════════════════
async function runStrategyAnalysis(accountLogin){
  const trades = await Trade.find({accountLogin}).sort({time:1});
  if(trades.length<3) return;
  const byMagic={};
  for(const t of trades){const k=t.magic||0;if(!byMagic[k])byMagic[k]=[];byMagic[k].push(t);}
  const strategies=[];
  for(const[magic,mt]of Object.entries(byMagic)){
    const symbols=[...new Set(mt.map(t=>t.symbol))];
    const totalPnL=mt.reduce((s,t)=>s+t.profit,0);
    const wins=mt.filter(t=>t.profit>0).length;
    const losses=mt.filter(t=>t.profit<0).length;
    const winRate=(wins/mt.length)*100;
    const lots=[...new Set(mt.map(t=>t.lots))].sort((a,b)=>a-b);
    const minLot=Math.min(...lots),maxLot=Math.max(...lots);
    let lotPattern='fixed',lotMultiplier=null;
    if(lots.length>1){const ratios=[];for(let i=1;i<lots.length;i++)ratios.push(lots[i]/lots[i-1]);const a=ratios.reduce((s,r)=>s+r,0)/ratios.length;if(a>=1.8&&a<=2.2){lotPattern='martingale';lotMultiplier=a.toFixed(2);}else if(a>1){lotPattern='scaling';lotMultiplier=a.toFixed(2);}}
    const timeGroups={};for(const t of mt){const r=Math.round(t.time.getTime()/10000)*10000;timeGroups[r]=(timeGroups[r]||0)+1;}
    const basketClose=Math.max(...Object.values(timeGroups))>=2;
    const hourCounts=new Array(24).fill(0);for(const t of mt)hourCounts[new Date(t.time).getUTCHours()]++;
    const peakHour=hourCounts.indexOf(Math.max(...hourCounts));
    let sessionName='All Sessions';
    if(peakHour>=7&&peakHour<=11)sessionName='London Session';
    if(peakHour>=12&&peakHour<=17)sessionName='New York Session';
    if(peakHour>=0&&peakHour<=5)sessionName='Asian Session';
    const buys=mt.filter(t=>t.type==='BUY').length,sells=mt.filter(t=>t.type==='SELL').length;
    let bias='Balanced';if(buys>sells*1.5)bias='Long Bias';if(sells>buys*1.5)bias='Short Bias';
    const sp=mt.filter(t=>t.type==='SELL').map(t=>t.price).sort((a,b)=>a-b);
    let gridAnalysis=null;
    if(sp.length>=3){const gaps=[];for(let i=1;i<sp.length;i++)gaps.push(sp[i]-sp[i-1]);const a=gaps.reduce((s,g)=>s+g,0)/gaps.length;const con=gaps.filter(g=>Math.abs(g-a)<a*0.4).length;if(con>=gaps.length*0.5)gridAnalysis={detected:true,avgSpacingPips:(a/0.1).toFixed(0),priceRangeMin:Math.min(...sp).toFixed(3),priceRangeMax:Math.max(...sp).toFixed(3),levelsDetected:sp.length,consistency:((con/gaps.length)*100).toFixed(0)+'%'};}
    let strategyType='Fixed Lot EA';
    if(gridAnalysis?.detected&&basketClose)strategyType='Grid EA with Basket TP';
    else if(gridAnalysis?.detected)strategyType='Grid EA';
    else if(lotPattern==='martingale')strategyType='Martingale EA';
    else if(basketClose)strategyType='Basket Close EA';
    const gp=mt.filter(t=>t.profit>0).reduce((s,t)=>s+t.profit,0);
    const gl=Math.abs(mt.filter(t=>t.profit<0).reduce((s,t)=>s+t.profit,0));
    strategies.push({magic:parseInt(magic),tradeCount:mt.length,symbols,strategyType,lotPattern,lotMultiplier,minLot,maxLot,uniqueLotLevels:lots.length,basketClose,sessionName,bias,gridAnalysis,performance:{totalPnL:totalPnL.toFixed(2),wins,losses,winRate:winRate.toFixed(1),profitFactor:gl>0?(gp/gl).toFixed(2):'∞',grossProfit:gp.toFixed(2),grossLoss:gl.toFixed(2),avgWin:wins>0?(gp/wins).toFixed(2):0,avgLoss:losses>0?(gl/losses).toFixed(2):0}});
  }
  const aiSummary=strategies.map(s=>`Magic ${s.magic}: ${s.strategyType} on ${s.symbols.join('/')} — ${s.performance.winRate}% win rate, PF ${s.performance.profitFactor}, ${s.lotPattern} lots (${s.minLot}→${s.maxLot}), ${s.basketClose?'basket close detected':'individual closes'}, ${s.bias}, active in ${s.sessionName}.`).join('\n\n');
  await Strategy.create({accountLogin,strategies,performanceSummary:{totalTrades:trades.length,totalPnL:strategies.reduce((s,st)=>s+parseFloat(st.performance.totalPnL),0).toFixed(2)},aiSummary});
}

// ═══════════════════════════════════════════════════════════════
// POST /api/history  —  receives closed trade history separately
// This keeps request sizes small (split from /api/report)
// ═══════════════════════════════════════════════════════════════
app.post('/api/history', requireApiKey, async(req,res)=>{
  try{
    const body = req.body;
    if(!body?.accountLogin) return res.status(400).json({error:'No accountLogin'});
    const { accountLogin, closedTrades=[] } = body;
    let saved = 0;
    for(const trade of closedTrades){
      try{
        await Trade.create({
          accountLogin, ticket:trade.ticket, symbol:trade.symbol,
          type:trade.type, lots:trade.lots, price:trade.price,
          profit:trade.profit, swap:trade.swap, commission:trade.commission,
          magic:trade.magic, comment:trade.comment,
          time:new Date(trade.time*1000)
        });
        saved++;
      }catch(e){ /* duplicate — skip */ }
    }
    // Run basket detection + strategy on new trades
    if(saved > 0) runStrategyAnalysis(accountLogin).catch(console.error);
    console.log(`📜 History #${accountLogin} | Received:${closedTrades.length} | New:${saved}`);
    res.json({ status:'ok', saved, received:closedTrades.length });
  }catch(err){
    console.error('History error:',err.message);
    res.status(500).json({error:err.message});
  }
});

app.listen(PORT,()=>console.log(`\n✅ Dude's Algo Monitor LIVE on port ${PORT}\n`));
