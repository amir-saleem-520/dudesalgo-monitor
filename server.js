const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin:'*', methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type','X-API-Key','Authorization','x-api-key'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

const SnapshotSchema = new mongoose.Schema({
  accountLogin:Number,accountName:String,server:String,broker:String,
  balance:Number,equity:Number,margin:Number,freeMargin:Number,marginLevel:Number,
  profit:Number,leverage:Number,openPositions:Array,symbolStats:Array,
  timestamp:{type:Date,default:Date.now}
});
const TradeSchema = new mongoose.Schema({
  accountLogin:Number,ticket:{type:Number,unique:true},symbol:String,type:String,
  lots:Number,price:Number,profit:Number,swap:Number,commission:Number,
  magic:Number,comment:String,time:Date
});
const StrategySchema = new mongoose.Schema({
  accountLogin:Number,analysisTime:{type:Date,default:Date.now},
  strategies:Array,sessionAnalysis:Object,performanceSummary:Object,aiSummary:String
});

const Snapshot = mongoose.model('Snapshot', SnapshotSchema);
const Trade    = mongoose.model('Trade',    TradeSchema);
const Strategy = mongoose.model('Strategy', StrategySchema);

const API_KEY = process.env.API_KEY || 'dudesalgo_secret_key_2026';

function requireApiKey(req,res,next){
  const key = req.headers['x-api-key'] || req.body?.apiKey;
  if(key!==API_KEY) return res.status(401).json({error:'Invalid API key'});
  next();
}

app.get('/',(req,res)=>res.json({status:"Dude's Algo Monitor running",time:new Date()}));

app.post('/api/report', requireApiKey, async(req,res)=>{
  try{
    const body=req.body;
    if(!body||!body.account) return res.status(400).json({error:'No account data'});
    const {account,openPositions=[],closedTrades=[],symbolStats=[]}=body;
    await Snapshot.create({accountLogin:account.login,accountName:account.name,server:account.server,broker:account.broker,balance:account.balance,equity:account.equity,margin:account.margin,freeMargin:account.freeMargin,marginLevel:account.marginLevel,profit:account.profit,leverage:account.leverage,openPositions,symbolStats,timestamp:new Date(account.timestamp*1000)});
    for(const trade of closedTrades){
      try{ await Trade.create({accountLogin:account.login,ticket:trade.ticket,symbol:trade.symbol,type:trade.type,lots:trade.lots,price:trade.price,profit:trade.profit,swap:trade.swap,commission:trade.commission,magic:trade.magic,comment:trade.comment,time:new Date(trade.time*1000)}); }catch(e){}
    }
    runStrategyAnalysis(account.login).catch(console.error);
    console.log(`📊 Account ${account.login} | Bal:${account.balance} | Open:${openPositions.length} | History:${closedTrades.length}`);
    res.json({status:'ok',received:new Date().toISOString()});
  }catch(err){console.error('Report error:',err.message);res.status(500).json({error:err.message});}
});

app.get('/api/dashboard/:accountLogin', async(req,res)=>{
  try{
    const login=parseInt(req.params.accountLogin);
    const latest=await Snapshot.findOne({accountLogin:login}).sort({timestamp:-1});
    const equityCurve=await Snapshot.find({accountLogin:login}).sort({timestamp:-1}).limit(200).select('equity balance profit timestamp');
    const trades=await Trade.find({accountLogin:login}).sort({time:-1}).limit(500);
    const strategy=await Strategy.findOne({accountLogin:login}).sort({analysisTime:-1});
    res.json({latest,equityCurve:equityCurve.reverse(),trades,strategy});
  }catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/accounts',async(req,res)=>{
  try{
    const accounts=await Snapshot.aggregate([{$sort:{timestamp:-1}},{$group:{_id:'$accountLogin',login:{$first:'$accountLogin'},name:{$first:'$accountName'},broker:{$first:'$broker'},balance:{$first:'$balance'},equity:{$first:'$equity'},profit:{$first:'$profit'},lastSeen:{$first:'$timestamp'}}}]);
    res.json(accounts);
  }catch(err){res.status(500).json({error:err.message});}
});

async function runStrategyAnalysis(accountLogin){
  const trades=await Trade.find({accountLogin}).sort({time:1});
  if(trades.length<3)return;
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
    if(lots.length>1){const ratios=[];for(let i=1;i<lots.length;i++)ratios.push(lots[i]/lots[i-1]);const avg=ratios.reduce((s,r)=>s+r,0)/ratios.length;if(avg>=1.8&&avg<=2.2){lotPattern='martingale';lotMultiplier=avg.toFixed(2);}else if(avg>1){lotPattern='scaling';lotMultiplier=avg.toFixed(2);}}
    const timeGroups={};for(const t of mt){const r=Math.round(t.time.getTime()/5000)*5000;timeGroups[r]=(timeGroups[r]||0)+1;}
    const basketClose=Math.max(...Object.values(timeGroups))>=3;
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
    if(sp.length>=3){const gaps=[];for(let i=1;i<sp.length;i++)gaps.push(sp[i]-sp[i-1]);const avg=gaps.reduce((s,g)=>s+g,0)/gaps.length;const con=gaps.filter(g=>Math.abs(g-avg)<avg*0.4).length;if(con>=gaps.length*0.5)gridAnalysis={detected:true,avgSpacingPips:(avg/0.1).toFixed(0),priceRangeMin:Math.min(...sp).toFixed(3),priceRangeMax:Math.max(...sp).toFixed(3),levelsDetected:sp.length,consistency:((con/gaps.length)*100).toFixed(0)+'%'};}
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

app.listen(PORT,()=>console.log(`\n✅ Dude's Algo Monitor LIVE on port ${PORT}\n`));
