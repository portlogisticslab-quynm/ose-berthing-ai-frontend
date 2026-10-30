/* Berthing AI Advisory System — browser application (V3.5.0).
 * Shared physics / features / risk / shield / policy live in js/berthing-core.js (window.BerthingCore),
 * which is byte-identical to backend/berthing-core.js.  Angle convention: see berthing-core.js header. */
'use strict';
const BC=window.BerthingCore;
const APP_VERSION=BC.VERSION;
const S={
  data:[],dataSource:'',syntheticMeta:null,
  riskModel:null,riskSource:'',riskModelRejected:'',
  trajModel:null,trajSource:'',
  policyModel:null,forecast:[],forecastSource:'',validation:null,policySim:[],logs:[],
  groundTruth:new Map(),gtSource:'',riskCV:null,lastRiskRun:null,
  trajTraining:{cancel:false,running:false},anim:{timer:null,index:0,paused:true,caseId:null}
};
function logMsg(s){const t=new Date().toLocaleString(); S.logs.unshift(`${t} | ${s}`); if(S.logs.length>500)S.logs.length=500; document.getElementById('logText').textContent=S.logs.join('\n'); document.getElementById('status').textContent=s;}
const escapeHtml=BC.escapeHtml;

function updateDataReadiness(){
  const baseRows=S.data.length;
  const gtCount=S.groundTruth?.size||0;
  const matched=baseRows?S.data.filter(r=>Number.isFinite(Number(r.ExpertRiskClass))).length:0;
  const featured=baseRows>0&&Number.isFinite(Number(S.data[0].RuleRiskScore));
  const gtLabel=S.gtSource==='synthetic'?'synthetic outcome labels':S.gtSource==='file'?'expert file':'';
  const el=document.getElementById('dataReadiness');
  if(el){
    el.innerHTML=
      `Base trajectory data: <b>${baseRows?baseRows.toLocaleString()+' rows'+(S.dataSource==='synthetic'?' (synthetic)':''):'NOT LOADED'}</b><br>`+
      `Features + data quality: <b>${featured?'computed ✓':'—'}</b><br>`+
      `Ground Truth: <b>${gtCount?gtCount.toLocaleString()+' labels, '+matched.toLocaleString()+' matched'+(gtLabel?' – '+escapeHtml(gtLabel):''):'NOT LOADED'}</b><br>`+
      `Risk training labels: <b>${!baseRows?'—':matched>=100?'independent Ground Truth':'rule-derived fallback (not independent)'}</b>`;
  }
  updateWorkflowState();
}
function showTab(id,b){document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tabbtn').forEach(x=>x.classList.remove('active'));document.getElementById(id).classList.add('active');if(b)b.classList.add('active');}
const {rad,deg,wrap180,angle360,circAbsErr,mean,median,clamp,num}=BC;
function randn(){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)}


function setWait(title,msg,pct,opts={}){
  const ov=document.getElementById('waitOverlay');
  document.getElementById('waitTitle').textContent=title||'Processing...';
  document.getElementById('waitMsg').textContent=msg||'Please wait.';
  const p=clamp(Number(pct)||0,0,100);
  document.getElementById('waitBar').style.width=p+'%';
  document.getElementById('waitPct').textContent=Math.round(p)+'%';
  const cb=document.getElementById('waitCancelBtn');
  if(cb){
    if(opts.cancellable!==undefined)cb.hidden=!opts.cancellable;
    else cb.hidden=!S.trajTraining.running;
    cb.disabled=!!S.trajTraining.cancel;
    cb.textContent=S.trajTraining.cancel?'Cancelling…':'Cancel training';
  }
  ov.classList.add('show');
}
function hideWait(){
  document.getElementById('waitOverlay').classList.remove('show');
  const cb=document.getElementById('waitCancelBtn');if(cb)cb.hidden=true;
}
async function runWithWait(title,steps,fn){
  try{
    setWait(title,steps?.[0]||'Preparing...',5);
    await new Promise(r=>setTimeout(r,80));
    const result=await fn();
    setWait(title,'Completed.',100);
    await new Promise(r=>setTimeout(r,220));
    return result;
  } catch(err) {
    console.error(err);
    const msg=(err&&err.message)?err.message:String(err);
    setOperationStatus(`${title} failed: ${msg}`,true);
    alert(`${title} failed:\n${msg}`);
  } finally {
    hideWait();
    updateWorkflowState();
  }
}

/** Removes every prediction / recommendation column derived from a previous model run. */
function clearPredictionColumns(){
  const keys=['HybridRiskScore','PredictedRiskLevel','RiskPredictionMode','MLRiskScore','RuleWeight','MLProb_Normal','MLProb_Caution','MLProb_Warning','MLProb_Critical',
    'MLExpectedClass','MLOrdinalClass','MLOrdinalLevel','RiskConfidence','RiskDecisionMode','RecommendationSeverity','Recommendation','RiskEngine'];
  S.data.forEach(r=>keys.forEach(k=>{delete r[k]}));
  S.lastRiskRun=null;
}

function generateSynthetic(){
  const seed=(Date.now()>>>0);
  const ds=BC.generateSyntheticDataset({numCases:250,dt_s:5,seed});
  S.data=ds.rows; S.dataSource='synthetic'; S.syntheticMeta={meta:ds.meta,cases:ds.cases,groundTruth:ds.groundTruth};
  S.forecast=[];S.validation=null;S.policySim=[];S.lastRiskRun=null;
  // Synthetic outcome-based labels act as independent Ground Truth for the demo workflow.
  S.groundTruth=new Map(ds.groundTruth.map(g=>[gtKey(g.CaseID,g.Time_s),g])); S.gtSource='synthetic';
  completeFeatures(false); updateRiskPlotVisibility();
  const scen=ds.cases.reduce((m,c)=>(m[c.ScenarioType]=(m[c.ScenarioType]||0)+1,m),{});
  const gt=ds.groundTruth.reduce((m,g)=>(m[g.ExpertRiskLevel]=(m[g.ExpertRiskLevel]||0)+1,m),{});
  const rl=S.data.reduce((m,r)=>(m[r.RiskLevel]=(m[r.RiskLevel]||0)+1,m),{});
  setOperationStatus(`Synthetic data generated: ${ds.cases.length} cases, ${ds.rows.length.toLocaleString()} rows (dt=${ds.meta.dt_s}s, seed ${seed}).`);
  logMsg(`Scenarios: ${Object.entries(scen).map(([k,v])=>`${k} ${v}`).join(', ')}. Ground Truth (outcome-based): ${BC.RISK_LEVELS.map(l=>`${l} ${gt[l]||0}`).join(', ')}. Rule risk: ${BC.RISK_LEVELS.map(l=>`${l} ${rl[l]||0}`).join(', ')}.`);
  if(S.riskModel||S.trajModel)logMsg('Existing trained/loaded models were kept. Retrain them if they were trained on different data.');
}


function parseRiskLabel(v){
  if(v===null||v===undefined||v==='') return null;
  if(Number.isFinite(Number(v))){
    const n=Number(v); if(n>=0&&n<=3)return Math.round(n);
  }
  const s=String(v).trim().toLowerCase();
  if(s==='normal'||s==='safe')return 0;
  if(s==='caution'||s==='attention')return 1;
  if(s==='warning'||s==='near-miss'||s==='nearmiss')return 2;
  if(s==='critical'||s==='incident'||s==='collision')return 3;
  return null;
}
function gtKey(caseId,time_s){return `${Number(caseId)}|${Number(time_s)}`}
function mergeGroundTruthIntoData(){
  let matched=0;
  S.data.forEach(r=>{
    const g=S.groundTruth.get(gtKey(r.CaseID,r.Time_s));
    if(g){
      r.ExpertRiskClass=g.ExpertRiskClass;
      r.ExpertRiskLevel=['Normal','Caution','Warning','Critical'][g.ExpertRiskClass];
      r.NearMiss=num(g.NearMiss,0); r.Incident=num(g.Incident,0);
      r.PilotIntervention=num(g.PilotIntervention,0);
      r.ExpertConfidence=num(g.ExpertConfidence,NaN);
      matched++;
    }
  });
  const el=document.getElementById('groundTruthStatus');
  if(el){
    const src=S.gtSource==='synthetic'
      ?'Source: synthetic OUTCOME-BASED labels from the generator (60 s look-ahead on the noise-free state:\n  contact velocity vs design, stopping margin, funnel breach, ROT, alignment at contact).\n  They are independent of the rule-risk formula.'
      :'Source: expert / observed labels file.';
    el.textContent=S.groundTruth.size
      ? `Ground Truth loaded: ${S.groundTruth.size} labelled records.\n${src}\nMatched to current data: ${matched} rows.\nTraining target: ExpertRiskClass when ≥100 rows match, otherwise rule-derived fallback.`
      : 'No Ground Truth loaded. Training will use rule-derived labels as fallback — the ML model will then only re-learn the rule.';
  }
  updateDataReadiness();
  return matched;
}
async function loadGroundTruth(ev){
  const f=ev.target.files[0]; if(!f)return;
  try{
    let rows;
    if(f.name.toLowerCase().endsWith('.csv')) rows=parseCSV(await f.text());
    else{
      if(typeof XLSX==='undefined')throw new Error('XLSX library unavailable.');
      const wb=XLSX.read(await f.arrayBuffer()),ws=wb.Sheets[wb.SheetNames[0]];
      rows=XLSX.utils.sheet_to_json(ws,{defval:''});
    }
    const map=new Map(); let valid=0;
    rows.forEach(r=>{
      const cid=r.CaseID??r.caseid??r.case_id, t=r.Time_s??r.time_s??r.Time;
      const raw=r.ExpertRiskClass??r.ExpertRiskLevel??r.RiskLabel??r.Label??r.label;
      const cls=parseRiskLabel(raw);
      if(Number.isFinite(Number(cid))&&Number.isFinite(Number(t))&&cls!==null){
        map.set(gtKey(cid,t),{
          ExpertRiskClass:cls,
          NearMiss:r.NearMiss??0, Incident:r.Incident??0,
          PilotIntervention:r.PilotIntervention??0,
          ExpertConfidence:r.ExpertConfidence??''
        }); valid++;
      }
    });
    S.groundTruth=map; S.gtSource='file';
    S.data.forEach(r=>{['ExpertRiskClass','ExpertRiskLevel','NearMiss','Incident','PilotIntervention','ExpertConfidence'].forEach(k=>{delete r[k]})});
    const matched=mergeGroundTruthIntoData();
    updateDataReadiness();
    if(!S.data.length){
      alert('Ground Truth labels were loaded successfully, but base trajectory data is still missing.\n\nPlease click Generate Synthetic Data or Load CSV/XLSX Data before Train Hybrid Risk Model.');
      logMsg(`Loaded Ground Truth: ${valid} labels. Base trajectory data is still required.`);
    } else {
      logMsg(`Loaded Ground Truth: ${valid} labels; ${matched} matched rows.`);
    }
  }catch(e){setOperationStatus('Ground Truth load failed: '+e.message,true);alert('Load Ground Truth failed:\n\n'+e.message)}
  ev.target.value='';
}
function riskTrainingClass(r){
  return Number.isFinite(Number(r.ExpertRiskClass)) ? Number(r.ExpertRiskClass) : riskClassFromScore(r.RuleRiskScore);
}
function labelSourceSummary(rows){
  const exp=rows.filter(r=>Number.isFinite(Number(r.ExpertRiskClass))).length;
  return {expert:exp,fallback:rows.length-exp};
}

function riskModelingRows(){
  const expert=S.data.filter(r=>Number.isFinite(Number(r.ExpertRiskClass)));
  // Independent Ground Truth is used whenever enough labels match; otherwise rule-derived fallback.
  if(expert.length>=100)return {rows:expert,mode:'expert',expertCount:expert.length};
  return {rows:S.data,mode:'fallback',expertCount:expert.length};
}
/** Per-case even sampling plus all minority-class rows (capped), so rare Warning/Critical states survive sampling. */
function sampleRowsStratified(rows,perCase=24,maxPerClass=2500,seed=97531){
  const base=sampleRowsByCase(rows,perCase),seen=new Set(base);
  const rnd=BC.makeRng(seed),out=[...base];
  for(const k of [1,2,3]){
    const pool=rows.filter(r=>riskTrainingClass(r)===k&&!seen.has(r));
    const have=out.filter(r=>riskTrainingClass(r)===k).length;
    const take=Math.max(0,Math.min(pool.length,maxPerClass-have));
    for(let i=pool.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]]}
    for(let i=0;i<take;i++){out.push(pool[i]);seen.add(pool[i])}
  }
  return out;
}

function completeFeatures(doLog=true,doRefresh=true){
 if(!S.data.length){logMsg('No data loaded.');return}
 BC.completeFeatures(S.data);
 mergeGroundTruthIntoData(); if(doRefresh)refreshAll();
 if(doLog)setOperationStatus(`Features recomputed. Mean data quality ${(100*mean(S.data.map(r=>r.DataQualityScore))).toFixed(1)}%; ${S.data.filter(r=>r.DataQualityFlag!=='OK').length} row(s) flagged.`);
 updateDataReadiness();
}



const RISK_FEATURES=BC.RISK_FEATURES;

function riskClassFromScore(s){return BC.classFromThresholds(s,BC.RULE_THRESHOLDS)}
function shuffleIdx(n,seed=1234567){
  let a=Array.from({length:n},(_,i)=>i),x=seed>>>0;
  const rnd=()=>{x=(1664525*x+1013904223)>>>0;return x/4294967296};
  for(let i=n-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]]}
  return a;
}
function sampleRowsByCase(rows,maxPerCase=32){
  const by={};rows.forEach(r=>(by[r.CaseID]??=[]).push(r));
  const out=[];
  Object.values(by).forEach(a=>{
    a.sort((x,y)=>x.Time_s-y.Time_s);
    if(a.length<=maxPerCase){out.push(...a);return}
    for(let k=0;k<maxPerCase;k++)out.push(a[Math.round(k*(a.length-1)/(maxPerCase-1))]);
  });
  return out;
}
function featureVector(r,stats){return BC.featureVector(r,stats,RISK_FEATURES)}
function computeFeatureStats(rows){
  const meanA=[],stdA=[];
  RISK_FEATURES.forEach(k=>{
    const vals=rows.map(r=>Number(r[k])).filter(Number.isFinite),m=mean(vals);
    const v=mean(vals.map(x=>(x-m)*(x-m)));
    meanA.push(Number.isFinite(m)?m:0);stdA.push(Math.sqrt(Number.isFinite(v)?v:0)||1);
  }); return {mean:meanA,std:stdA};
}
function giniFromCounts(c){const n=c.reduce((a,b)=>a+b,0);if(!n)return 0;let s=1;c.forEach(v=>{const p=v/n;s-=p*p});return s}
function classCounts(y,idx){const c=[0,0,0,0];idx.forEach(i=>c[y[i]]++);return c}
function buildTree(X,y,idx,depth,maxDepth,minLeaf,mtry,rng){
  const counts=classCounts(y,idx),maj=counts.indexOf(Math.max(...counts));
  if(depth>=maxDepth||idx.length<2*minLeaf||counts.filter(x=>x>0).length<=1)return {leaf:true,pred:maj,counts};
  const p=X[0].length,features=[];
  while(features.length<Math.min(mtry,p)){const f=Math.floor(rng()*p);if(!features.includes(f))features.push(f)}
  let best=null,parent=giniFromCounts(counts);
  for(const f of features){
    const vals=idx.map(i=>X[i][f]).sort((a,b)=>a-b),cand=[];
    for(let q=1;q<=7;q++){const pos=Math.floor(q*vals.length/8);if(pos>0&&pos<vals.length)cand.push((vals[pos-1]+vals[pos])/2)}
    for(const th of cand){
      const L=[],R=[];idx.forEach(i=>(X[i][f]<=th?L:R).push(i));
      if(L.length<minLeaf||R.length<minLeaf)continue;
      const g=(L.length*giniFromCounts(classCounts(y,L))+R.length*giniFromCounts(classCounts(y,R)))/idx.length;
      const gain=parent-g;if(!best||gain>best.gain)best={f,th,L,R,gain};
    }
  }
  if(!best||best.gain<1e-6)return {leaf:true,pred:maj,counts};
  return {leaf:false,f:best.f,th:best.th,gain:best.gain,
    left:buildTree(X,y,best.L,depth+1,maxDepth,minLeaf,mtry,rng),
    right:buildTree(X,y,best.R,depth+1,maxDepth,minLeaf,mtry,rng)};
}
function treePredict(t,x){while(!t.leaf)t=x[t.f]<=t.th?t.left:t.right;return t.pred}
function collectImportance(t,imp){if(!t||t.leaf)return;imp[t.f]+=t.gain||0;collectImportance(t.left,imp);collectImportance(t.right,imp)}
function trainRandomForest(X,y,opt={}){
  const nTrees=opt.nTrees||20,maxDepth=opt.maxDepth||7,minLeaf=opt.minLeaf||10,
        mtry=opt.mtry||Math.max(2,Math.floor(Math.sqrt(X[0].length))),
        balanced=opt.balanced!==false;
  let seed=opt.seed||24681357;const rnd=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296};
  const trees=[],importance=Array(X[0].length).fill(0),n=X.length;
  const byClass=[0,1,2,3].map(k=>y.map((v,i)=>v===k?i:-1).filter(i=>i>=0));
  const nonEmpty=byClass.filter(a=>a.length);
  const targetPerClass=nonEmpty.length?Math.min(opt.maxPerClass||Infinity,Math.max(...nonEmpty.map(a=>a.length))):0;

  for(let t=0;t<nTrees;t++){
    let idx=[];
    if(balanced && nonEmpty.length>=2){
      for(let k=0;k<4;k++){
        const pool=byClass[k];
        if(!pool.length)continue;
        for(let j=0;j<targetPerClass;j++)idx.push(pool[Math.floor(rnd()*pool.length)]);
      }
      // shuffle balanced bootstrap
      for(let i=idx.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[idx[i],idx[j]]=[idx[j],idx[i]]}
    }else{
      idx=Array.from({length:n},()=>Math.floor(rnd()*n));
    }
    const tree=buildTree(X,y,idx,0,maxDepth,minLeaf,mtry,rnd);trees.push(tree);collectImportance(tree,importance);
  }
  const s=importance.reduce((a,b)=>a+b,0)||1;
  return {
    type:'BalancedRandomForestClassifier',trees,
    importance:importance.map(v=>v/s),
    params:{nTrees,maxDepth,minLeaf,mtry,balanced,targetPerClass}
  };
}
function stumpFit(X,residual,idx,minLeaf=18){
  let best=null,p=X[0].length;
  for(let f=0;f<p;f++){
    const vals=idx.map(i=>X[i][f]).sort((a,b)=>a-b),cand=[];
    for(let q=1;q<=8;q++){const pos=Math.floor(q*vals.length/9);if(pos>0&&pos<vals.length)cand.push((vals[pos-1]+vals[pos])/2)}
    for(const th of cand){
      const L=idx.filter(i=>X[i][f]<=th),R=idx.filter(i=>X[i][f]>th);
      if(L.length<minLeaf||R.length<minLeaf)continue;
      const lv=mean(L.map(i=>residual[i])),rv=mean(R.map(i=>residual[i]));
      const err=L.reduce((s,i)=>s+(residual[i]-lv)**2,0)+R.reduce((s,i)=>s+(residual[i]-rv)**2,0);
      if(!best||err<best.err)best={f,th,lv,rv,err};
    }
  } return best||{f:0,th:0,lv:0,rv:0,err:0};
}
function trainGradientBoosting(X,y,opt={}){
  const nEst=opt.nEstimators||20,lr=opt.learningRate||0.12,minLeaf=opt.minLeaf||18;
  const base=mean(y),pred=Array(y.length).fill(base),stumps=[],idx=Array.from({length:y.length},(_,i)=>i),importance=Array(X[0].length).fill(0);
  for(let m=0;m<nEst;m++){
    const res=y.map((v,i)=>v-pred[i]),st=stumpFit(X,res,idx,minLeaf);stumps.push(st);importance[st.f]+=1;
    for(let i=0;i<pred.length;i++)pred[i]+=lr*(X[i][st.f]<=st.th?st.lv:st.rv);
  }
  const s=importance.reduce((a,b)=>a+b,0)||1;
  return {type:'GradientBoostingRiskRegressor',base,stumps,learningRate:lr,importance:importance.map(v=>v/s),params:{nEstimators:nEst,learningRate:lr,minLeaf}};
}
function rawMLProb(r,stats,rf,gb){return BC.rawMLProb(r,{featureStats:stats,randomForest:rf,gradientBoosting:gb,features:RISK_FEATURES})}
/** Platt scaling: 1-D logistic regression fitted with Newton's method and Platt's smoothed targets. */
function fitPlatt(scores,labels){
  const n1=labels.filter(v=>v===1).length,n0=labels.length-n1;
  const tPos=(n1+1)/(n1+2),tNeg=1/(n0+2);
  const t=labels.map(v=>v===1?tPos:tNeg);
  let A=1,B=Math.log((n1+1)/(n0+1));
  for(let it=0;it<100;it++){
    let gA=0,gB=0,hAA=1e-9,hAB=0,hBB=1e-9;
    for(let i=0;i<scores.length;i++){
      const z=clamp(A*scores[i]+B,-30,30),p=1/(1+Math.exp(-z)),e=p-t[i],w=Math.max(p*(1-p),1e-9);
      gA+=e*scores[i];gB+=e;hAA+=w*scores[i]*scores[i];hAB+=w*scores[i];hBB+=w;
    }
    const det=hAA*hBB-hAB*hAB;
    if(Math.abs(det)<1e-12)break;
    const dA=(hBB*gA-hAB*gB)/det,dB=(hAA*gB-hAB*gA)/det;
    A-=dA;B-=dB;
    if(Math.abs(dA)<1e-7&&Math.abs(dB)<1e-7)break;
  }
  return {type:'platt',A,B};
}
function applyPlatt(m,s){const z=clamp(m.A*s+m.B,-30,30);return 1/(1+Math.exp(-z))}
function fitIsotonic(scores,labels){
  const pairs=scores.map((s,i)=>({s,y:labels[i]})).sort((a,b)=>a.s-b.s),blocks=[];
  pairs.forEach(p=>{
    blocks.push({lo:p.s,hi:p.s,sum:p.y,n:1});
    while(blocks.length>=2){
      const b=blocks[blocks.length-1],a=blocks[blocks.length-2];
      if(a.sum/a.n<=b.sum/b.n)break;
      blocks.splice(blocks.length-2,2,{lo:a.lo,hi:b.hi,sum:a.sum+b.sum,n:a.n+b.n});
    }
  });
  return {type:'isotonic',blocks:blocks.map(b=>({lo:b.lo,hi:b.hi,p:b.sum/b.n}))};
}
function applyIsotonic(m,s){
  if(!m.blocks.length)return s;
  let best=m.blocks[0];for(const b of m.blocks){best=b;if(s<=b.hi)break}return best.p;
}
function fitCalibration(rows,stats,rf,gb,method){
  const raw=rows.map(r=>rawMLProb(r,stats,rf,gb)),models=[];
  for(let k=0;k<4;k++){
    const sc=raw.map(p=>p[k]),lab=rows.map(r=>riskTrainingClass(r)===k?1:0);
    models.push(method==='isotonic'?fitIsotonic(sc,lab):fitPlatt(sc,lab));
  }
  return {method,models};
}
function calibratedProb(cal,raw){return BC.calibratedProb(cal,raw)}
function aucBinary(scores,labels){
  const arr=scores.map((s,i)=>({s,y:labels[i]})).sort((a,b)=>a.s-b.s);
  let n0=labels.filter(x=>x===0).length,n1=labels.length-n0;if(!n0||!n1)return NaN;
  let rankSum=0,i=0;
  while(i<arr.length){
    let j=i;while(j+1<arr.length&&arr[j+1].s===arr[i].s)j++;
    const avg=(i+j+2)/2;for(let k=i;k<=j;k++)if(arr[k].y===1)rankSum+=avg;i=j+1;
  }
  return (rankSum-n1*(n1+1)/2)/(n1*n0);
}

function expectedRiskClassFromProb(p){
  return p.reduce((s,v,k)=>s+k*v,0);
}
function ordinalClass(score,thr){
  return score<thr.t1?0:score<thr.t2?1:score<thr.t3?2:3;
}
function calcClassMetricsFromPred(truth,pred){
  const cm=Array.from({length:4},()=>Array(4).fill(0));
  for(let i=0;i<truth.length;i++)cm[truth[i]][pred[i]]++;
  const per=[];
  for(let k=0;k<4;k++){
    const tp=cm[k][k];
    const fp=cm.reduce((s,row,i)=>s+(i===k?0:row[k]),0);
    const fn=cm[k].reduce((s,v,j)=>s+(j===k?0:v),0);
    const precision=tp/(tp+fp||1),recall=tp/(tp+fn||1);
    const f1=2*precision*recall/(precision+recall||1);
    per.push({precision,recall,f1});
  }
  const acc=cm.reduce((s,row,i)=>s+row[i],0)/(truth.length||1);
  const macroF1=mean(per.map(x=>x.f1));
  return {cm,per,acc,macroF1};
}
function optimizeOrdinalThresholds(rows,stats,rf,gb,cal){
  const scores=[],truth=[];
  rows.forEach(r=>{
    const raw=rawMLProb(r,stats,rf,gb);
    const p=calibratedProb(cal,raw);
    scores.push(expectedRiskClassFromProb(p));
    truth.push(riskTrainingClass(r));
  });

  let bestFeasible=null,bestRelaxed=null,bestFallback=null;
  const hasCritical=truth.some(v=>v===3);

  // Keep T3 fine resolution, but now reward Critical precision explicitly.
  for(let t1=.10;t1<=1.20+1e-9;t1+=.10){
    for(let t2=Math.max(t1+.20,.40);t2<=2.10+1e-9;t2+=.08){
      for(let t3=Math.max(t2+.12,.80);t3<=2.80+1e-9;t3+=.02){
        const thr={
          t1:Number(t1.toFixed(4)),
          t2:Number(t2.toFixed(4)),
          t3:Number(t3.toFixed(4))
        };
        const pred=scores.map(s=>ordinalClass(s,thr));
        const m=calcClassMetricsFromPred(truth,pred);

        const recallWarn=m.per[2].recall;
        const recallCrit=m.per[3].recall;
        const precisionCrit=m.per[3].precision;
        const f1Crit=m.per[3].f1;

        // Objective balances overall class quality with safety and false-alarm control.
        const objective=
          0.45*m.macroF1 +
          0.15*recallWarn +
          0.25*recallCrit +
          0.15*precisionCrit;

        const candidate={
          ...thr,objective,metrics:m,
          recallWarn,recallCrit,precisionCrit,f1Crit
        };

        // Preferred operating point: Critical Recall >= 85%.
        const feasible=!hasCritical || recallCrit>=0.85;

        // If the preferred constraint is impossible, keep a relaxed safety floor.
        const relaxed=!hasCritical || recallCrit>=0.70;

        if(feasible && (!bestFeasible || objective>bestFeasible.objective)){
          bestFeasible=candidate;
        }
        if(relaxed && (!bestRelaxed || objective>bestRelaxed.objective)){
          bestRelaxed=candidate;
        }
        if(!bestFallback || objective>bestFallback.objective){
          bestFallback=candidate;
        }
      }
    }
  }

  const best=bestFeasible||bestRelaxed||bestFallback;
  return best||{
    t1:.75,t2:1.40,t3:2.00,objective:0,metrics:null,
    recallWarn:0,recallCrit:0,precisionCrit:0,f1Crit:0
  };
}

function criticalThresholdDiagnostics(rows,stats,rf,gb,cal,thr){
  const critScores=[],nonCritScores=[];
  rows.forEach(r=>{
    const p=calibratedProb(cal,rawMLProb(r,stats,rf,gb));
    const s=expectedRiskClassFromProb(p);
    if(riskTrainingClass(r)===3)critScores.push(s); else nonCritScores.push(s);
  });
  const q=(a,p)=>{
    if(!a.length)return NaN;
    const b=[...a].sort((x,y)=>x-y),pos=(b.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos);
    return lo===hi?b[lo]:b[lo]*(hi-pos)+b[hi]*(pos-lo);
  };
  return {
    t3:thr.t3,
    criticalCount:critScores.length,
    criticalMin:critScores.length?Math.min(...critScores):NaN,
    criticalMedian:q(critScores,.5),
    criticalQ25:q(critScores,.25),
    criticalQ75:q(critScores,.75),
    nonCriticalQ95:q(nonCritScores,.95)
  };
}

function ordinalProbabilityMetrics(rows,stats,rf,gb,cal,thr){
  const truth=[],pred=[],probs=[],scores=[];
  rows.forEach(r=>{
    const p=calibratedProb(cal,rawMLProb(r,stats,rf,gb));
    const s=expectedRiskClassFromProb(p);
    probs.push(p);scores.push(s);truth.push(riskTrainingClass(r));pred.push(ordinalClass(s,thr));
  });
  const cls=calcClassMetricsFromPred(truth,pred);
  const perClass=[];
  for(let k=0;k<4;k++){
    const auc=aucBinary(probs.map(p=>p[k]),truth.map(t=>t===k?1:0));
    perClass.push({...cls.per[k],auc});
  }
  let brier=0,logloss=0;
  for(let i=0;i<truth.length;i++){
    for(let k=0;k<4;k++)brier+=(probs[i][k]-(truth[i]===k?1:0))**2;
    logloss-=Math.log(Math.max(1e-12,probs[i][truth[i]]));
  }
  brier/=Math.max(1,truth.length*4);logloss/=Math.max(1,truth.length);
  return {acc:cls.acc,macroF1:cls.macroF1,brier,logloss,cm:cls.cm,perClass,scores,truth,pred};
}

function probabilityMetrics(rows,stats,rf,gb,cal){
  const cm=Array.from({length:4},()=>Array(4).fill(0)),probs=[],truth=[];
  rows.forEach(r=>{
    const p=calibratedProb(cal,rawMLProb(r,stats,rf,gb)),t=riskTrainingClass(r),pred=p.indexOf(Math.max(...p));
    cm[t][pred]++;probs.push(p);truth.push(t);
  });
  const perClass=[];
  for(let k=0;k<4;k++){
    const tp=cm[k][k],fp=cm.reduce((s,row,i)=>s+(i===k?0:row[k]),0),fn=cm[k].reduce((s,v,j)=>s+(j===k?0:v),0);
    const precision=tp/(tp+fp||1),recall=tp/(tp+fn||1),f1=2*precision*recall/(precision+recall||1);
    const auc=aucBinary(probs.map(p=>p[k]),truth.map(t=>t===k?1:0));
    perClass.push({precision,recall,f1,auc});
  }
  const acc=cm.reduce((s,row,i)=>s+row[i],0)/(rows.length||1);
  const macroF1=mean(perClass.map(x=>x.f1));
  let brier=0,logloss=0;
  for(let i=0;i<truth.length;i++){
    for(let k=0;k<4;k++)brier+=(probs[i][k]-(truth[i]===k?1:0))**2;
    logloss-=Math.log(Math.max(1e-12,probs[i][truth[i]]));
  }
  brier/=Math.max(1,truth.length*4);logloss/=Math.max(1,truth.length);
  return {acc,macroF1,brier,logloss,cm,perClass};
}
/**
 * Group K-fold CV by CaseID. Inside every fold the training cases are split again into a fitting part
 * and a calibration part; calibration + ordinal thresholds are fitted on the calibration part only,
 * and metrics are computed on the untouched test fold (no test-fold leakage).
 */
async function groupCrossValidate(rows,kFolds,mode){
  const ids=[...new Set(rows.map(r=>r.CaseID))].sort((a,b)=>a-b),order=shuffleIdx(ids.length,31031).map(i=>ids[i]);
  const folds=Array.from({length:kFolds},()=>[]);order.forEach((id,i)=>folds[i%kFolds].push(id));
  // Fitting rows: minority classes over-sampled. Calibration/test rows: representative (even per case),
  // so calibrated probabilities and thresholds reflect the real class prevalence.
  const pick=(rs,f)=>mode==='expert'?sampleRowsStratified(rs,14,1200,100+f):sampleRowsByCase(rs,12);
  const rep=(rs)=>sampleRowsByCase(rs,30);
  const method=document.getElementById('calibrationSelect').value;
  const scores=[];
  for(let f=0;f<kFolds;f++){
    setWait('Train Hybrid Risk Model',`Group CV fold ${f+1}/${kFolds} (calibration fitted inside the training cases)...`,15+f*30/Math.max(1,kFolds));
    await new Promise(r=>setTimeout(r,10));
    const testSet=new Set(folds[f]);
    const trainIds=order.filter(id=>!testSet.has(id)),nCal=Math.max(1,Math.round(trainIds.length*.2)),calSet=new Set(trainIds.slice(0,nCal));
    const fitRows=pick(rows.filter(r=>!testSet.has(r.CaseID)&&!calSet.has(r.CaseID)),f);
    const calRows=rep(rows.filter(r=>calSet.has(r.CaseID)));
    const teRows=rep(rows.filter(r=>testSet.has(r.CaseID)));
    if(!fitRows.length||!calRows.length||!teRows.length)continue;
    const stats=computeFeatureStats(fitRows),X=fitRows.map(r=>featureVector(r,stats)),y=fitRows.map(r=>riskTrainingClass(r));
    const rf=trainRandomForest(X,y,{nTrees:10,maxDepth:6,minLeaf:8,seed:100+f,balanced:true,maxPerClass:2500});
    const gb=trainGradientBoosting(X,y,{nEstimators:12,learningRate:.14,minLeaf:10});
    const cal=fitCalibration(calRows,stats,rf,gb,method);
    const opt=optimizeOrdinalThresholds(calRows,stats,rf,gb,cal);
    scores.push(ordinalProbabilityMetrics(teRows,stats,rf,gb,cal,opt));
  }
  return {folds:scores.length,accuracy:mean(scores.map(s=>s.acc)),macroF1:mean(scores.map(s=>s.macroF1)),brier:mean(scores.map(s=>s.brier)),
    criticalRecall:mean(scores.map(s=>s.perClass[3].recall)),details:scores};
}
function fmtPct(v){return Number.isFinite(v)?(100*v).toFixed(1)+'%':'N/A'}
async function trainRisk(){
  if(!S.data.length) throw new Error('Base trajectory data is not loaded. Use Generate Synthetic Data or Load CSV/XLSX Data first.');
  clearPredictionColumns();
  updateRiskPlotVisibility();
  completeFeatures(false,false);mergeGroundTruthIntoData();updateDataReadiness();
  const source=riskModelingRows(),modelRows=source.rows;
  const ids=[...new Set(modelRows.map(r=>r.CaseID))].sort((a,b)=>a-b);
  if(ids.length<10) throw new Error('Not enough labelled CaseIDs for risk training (need ≥ 10).');
  // Split by CaseID: 70 % fit / 15 % calibration (probabilities + thresholds) / 15 % untouched test.
  const order=shuffleIdx(ids.length,20260825).map(i=>ids[i]);
  const nTr=Math.max(1,Math.floor(order.length*.70)),nCal=Math.max(1,Math.floor(order.length*.15));
  const trainIds=new Set(order.slice(0,nTr)),calIds=new Set(order.slice(nTr,nTr+nCal)),testIds=new Set(order.slice(nTr+nCal));
  const pick=(rs,seed)=>source.mode==='expert'?sampleRowsStratified(rs,24,2500,seed):sampleRowsByCase(rs,20);
  const trainRows=pick(modelRows.filter(r=>trainIds.has(r.CaseID)),11);
  // Calibration and test rows are representative (even sampling per case, no class over-sampling).
  const calRows=sampleRowsByCase(modelRows.filter(r=>calIds.has(r.CaseID)),60);
  const testRows=sampleRowsByCase(modelRows.filter(r=>testIds.has(r.CaseID)),60);
  const labelInfo=labelSourceSummary(trainRows.concat(calRows,testRows));
  const stats=computeFeatureStats(trainRows),X=trainRows.map(r=>featureVector(r,stats)),y=trainRows.map(r=>riskTrainingClass(r));
  const kFolds=clamp(Number(document.getElementById('cvFolds').value)||5,3,10);
  setWait('Train Hybrid Risk Model',source.mode==='expert'
    ? `Using ${modelRows.length.toLocaleString()} independent Ground Truth rows (${S.gtSource||'file'})...`
    : 'No sufficient Ground Truth; using rule-derived fallback labels...',10);
  await new Promise(r=>setTimeout(r,60));
  S.riskCV=await groupCrossValidate(modelRows,kFolds,source.mode);

  setWait('Train Hybrid Risk Model','Training final Random Forest...',52);await new Promise(r=>setTimeout(r,15));
  const rf=trainRandomForest(X,y,{nTrees:20,maxDepth:7,minLeaf:10,balanced:true,maxPerClass:3000});
  setWait('Train Hybrid Risk Model','Training final Gradient Boosting...',66);await new Promise(r=>setTimeout(r,15));
  const gb=trainGradientBoosting(X,y,{nEstimators:24,learningRate:.10,minLeaf:14});
  const method=document.getElementById('calibrationSelect').value;
  setWait('Train Hybrid Risk Model',`${method==='platt'?'Platt':'Isotonic'} calibration on the calibration cases...`,76);await new Promise(r=>setTimeout(r,15));
  const cal=fitCalibration(calRows,stats,rf,gb,method);
  setWait('Train Hybrid Risk Model','Optimising ordinal thresholds on the calibration cases...',82);await new Promise(r=>setTimeout(r,20));
  const ordinalOpt=optimizeOrdinalThresholds(calRows,stats,rf,gb,cal);

  const M={type:'HybridBalancedRFGB-OrdinalCalibrated',appVersion:APP_VERSION,featureSchema:BC.FEATURE_SCHEMA,features:[...RISK_FEATURES],
    angleConvention:BC.ANGLE_CONVENTION,trainedAt:new Date().toISOString(),featureStats:stats,
    randomForest:rf,gradientBoosting:gb,calibration:cal,ordinalThresholds:{t1:ordinalOpt.t1,t2:ordinalOpt.t2,t3:ordinalOpt.t3},ordinalObjective:ordinalOpt.objective,
    labelSource:{mode:source.mode,gtSource:source.mode==='expert'?(S.gtSource||'file'):'rule',...labelInfo},
    split:{trainCases:trainIds.size,calibrationCases:calIds.size,testCases:testIds.size},
    fusion:{ruleBaseWeight:.42,poorQualityBoost:.35,criticalRuleBoost:.20,maxRuleWeight:.90},
    hybridThresholds:{...BC.RULE_THRESHOLDS,source:'fixed-default'}};

  // Hybrid class thresholds are calibrated on the calibration cases (never on the data being predicted).
  setWait('Train Hybrid Risk Model','Calibrating Hybrid class thresholds against Ground Truth...',88);await new Promise(r=>setTimeout(r,20));
  if(source.mode==='expert'){
    const calScored=calRows.map(r=>({ExpertRiskClass:Number(r.ExpertRiskClass),HybridRiskScore:BC.hybridRisk(r,M).score}));
    M.hybridThresholds=optimizeHybridThresholds(calScored);
  }else M.hybridThresholds={...BC.RULE_THRESHOLDS,source:'fixed-default (rule-label fallback: no independent labels to calibrate against)'};

  setWait('Train Hybrid Risk Model','Evaluating on untouched test cases...',94);await new Promise(r=>setTimeout(r,20));
  const metrics=ordinalProbabilityMetrics(testRows,stats,rf,gb,cal,ordinalOpt);
  const critDiag=criticalThresholdDiagnostics(testRows,stats,rf,gb,cal,ordinalOpt);
  const truthT=testRows.map(r=>riskTrainingClass(r));
  const hybT=testRows.map(r=>BC.RISK_LEVELS.indexOf(BC.hybridRisk(r,M).level));
  const ruleT=testRows.map(r=>riskClassFromScore(r.RuleRiskScore));
  const hm=metrics4(truthT,hybT),rm=metrics4(truthT,ruleT);
  M.metrics={ml:metrics,hybrid:hm,rule:rm};M.criticalDiagnostics=critDiag;M.riskCV=S.riskCV;
  S.riskModel=M;S.riskSource='browser-trained';S.riskModelRejected='';

  const names=BC.RISK_LEVELS,fallbackNote=source.mode==='expert'?'':
`
NOTE: labels are RULE-DERIVED (no independent Ground Truth matched).
The ML part then only re-learns the rule; these numbers measure agreement
with the rule, NOT real-world predictive accuracy.`;
  document.getElementById('riskMetrics').textContent=
`HOLD-OUT TEST (${testIds.size} unseen CaseIDs, ${testRows.length} rows)
Label source: ${source.mode==='expert'?'independent Ground Truth ('+(S.gtSource==='synthetic'?'synthetic outcome-based':'expert file')+')':'RULE-DERIVED FALLBACK'}${fallbackNote}

Final Hybrid decision (what Predict Risk outputs):
  Accuracy ${fmtPct(hm.accuracy)} | Macro F1 ${fmtPct(hm.macroF1)}
  Critical recall ${fmtPct(hm.per[3].recall)} | Critical precision ${fmtPct(hm.per[3].precision)}
  Warning recall ${fmtPct(hm.per[2].recall)}
Rule-only baseline:
  Accuracy ${fmtPct(rm.accuracy)} | Macro F1 ${fmtPct(rm.macroF1)} | Critical recall ${fmtPct(rm.per[3].recall)}

ML ordinal model (calibrated, ${method==='platt'?'Platt':'Isotonic'}):
  Thresholds T1=${ordinalOpt.t1.toFixed(2)} T2=${ordinalOpt.t2.toFixed(2)} T3=${ordinalOpt.t3.toFixed(2)}
  Accuracy ${fmtPct(metrics.acc)} | Macro F1 ${fmtPct(metrics.macroF1)} | Brier ${metrics.brier.toFixed(4)} | Log loss ${metrics.logloss.toFixed(4)}
  Critical score Q25/Median/Q75: ${[critDiag.criticalQ25,critDiag.criticalMedian,critDiag.criticalQ75].map(v=>Number.isFinite(v)?v.toFixed(2):'N/A').join(' / ')} | Non-critical Q95 ${Number.isFinite(critDiag.nonCriticalQ95)?critDiag.nonCriticalQ95.toFixed(2):'N/A'}

Per-class (ML ordinal):
${names.map((n,i)=>`  ${n.padEnd(8)} P ${fmtPct(metrics.perClass[i].precision)} | R ${fmtPct(metrics.perClass[i].recall)} | F1 ${fmtPct(metrics.perClass[i].f1)} | AUC ${Number.isFinite(metrics.perClass[i].auc)?metrics.perClass[i].auc.toFixed(3):'N/A'}`).join('\n')}

Hybrid confusion matrix (rows = truth, cols = predicted N/C/W/Cr):
${hm.cm.map((a,i)=>'  '+names[i].padEnd(8)+a.join('\t')).join('\n')}`;
  document.getElementById('riskCVReport').textContent=
`GROUP ${S.riskCV.folds}-FOLD CROSS-VALIDATION BY CaseID
(calibration + thresholds fitted inside each fold's training cases)
Mean accuracy: ${fmtPct(S.riskCV.accuracy)}
Mean Macro F1: ${fmtPct(S.riskCV.macroF1)}
Mean Critical recall: ${fmtPct(S.riskCV.criticalRecall)}
Mean Brier: ${Number.isFinite(S.riskCV.brier)?S.riskCV.brier.toFixed(4):'N/A'}

Label source: ${source.mode==='expert'?'INDEPENDENT GROUND TRUTH':'RULE-DERIVED FALLBACK'}
Ground Truth rows used: ${labelInfo.expert}
Rule-derived fallback rows used: ${labelInfo.fallback}`;
  const t=M.hybridThresholds,v=t.validation||{};
  document.getElementById('riskConfig').textContent=
`HYBRID RISK MODEL (feature schema ${BC.FEATURE_SCHEMA})
ML = Balanced Random Forest + Gradient Boosting (${RISK_FEATURES.length} features)
Calibration = ${method==='platt'?'Platt':'Isotonic'}; ordinal score = Σ k·P(class=k)
Hybrid = w_rule × RuleRisk + (1 − w_rule) × MLRisk
  base w_rule 0.42; +0.35 if DataQuality < 0.75; +0.20 if RuleRisk ≥ 82; max 0.90
  hard safety floor (Hybrid ≥ Rule) when DataQuality < 0.50
Hybrid class thresholds T1/T2/T3 = ${t.t1}/${t.t2}/${t.t3}
  source: ${t.source}${t.n?` (n=${t.n})`:''}
  ${Number.isFinite(v.criticalRecall)?`calibration-set Critical recall ${fmtPct(v.criticalRecall)}, precision ${fmtPct(v.criticalPrecision)}`:''}
Split: ${M.split.trainCases} fit / ${M.split.calibrationCases} calibration / ${M.split.testCases} test cases`;
  document.getElementById('riskReport').textContent='Hybrid Risk Model trained in this browser session. Run Predict Risk to score the data.';
  updateRiskPlotVisibility();
  setOperationStatus(`Hybrid Risk Model trained (${source.mode==='expert'?'Ground Truth':'rule-label fallback'}). Test Macro F1 ${fmtPct(hm.macroF1)}, Critical recall ${fmtPct(hm.per[3].recall)}.`);
}

function setOperationStatus(text,isError=false,isWarning=false){
  const el=document.getElementById('operationStatus');
  if(el){
    el.textContent=(isError?'ERROR: ':isWarning?'WARNING: ':'')+text;
    el.classList.toggle('st-error',!!isError);el.classList.toggle('st-warning',!isError&&!!isWarning);
  }
  logMsg((isError?'ERROR: ':isWarning?'WARNING: ':'')+text);
  updateWorkflowState();
}


function trajectoryStateIntegrity(){
  const M=S.trajModel;
  const problems=[];
  if(!M)problems.push('No trajectory model in this browser session.');
  if(M){
    if(!M.lstm)problems.push('LSTM is missing.');
    if(!M.gru)problems.push('GRU is missing.');
    if(!M.featureStats?.mean||M.featureStats.mean.length!==13)problems.push('featureStats must contain 13 means.');
    if(!M.targetStats?.mean||M.targetStats.mean.length!==6)problems.push('targetStats must contain 6 means.');
    if(!Array.isArray(M.outputChannels)||M.outputChannels.length!==6)problems.push('outputChannels must contain 6 channels.');
    const expected=TRAJ_TARGET_CHANNELS.length*Number(M.H||0);
    const lo=M.lstm?.outputs?.[0]?.shape?.at(-1);
    const go=M.gru?.outputs?.[0]?.shape?.at(-1);
    if(expected&&lo!==expected)problems.push(`LSTM output ${lo} != expected ${expected}.`);
    if(expected&&go!==expected)problems.push(`GRU output ${go} != expected ${expected}.`);
  }
  return {ok:problems.length===0,problems};
}

function trajectoryReadiness(){
  const integ=trajectoryStateIntegrity();
  if(!integ.ok)return {ok:false,reason:integ.problems.join(' ')};
  const M=S.trajModel;
  const a=selectedCase();
  if(!a.length)return {ok:false,reason:'No valid CaseID is selected in the operational input.'};
  if(a.length<Number(M.inputLen||20))return {ok:false,reason:`Selected CaseID has ${a.length} rows; at least ${M.inputLen||20} are required.`};
  return {ok:true,rows:a.length,caseId:a[0].CaseID};
}
function riskReadiness(){
  if(!S.riskModel)return {ok:false,reason:S.riskModelRejected||'No Hybrid Risk Model in this browser session.'};
  return BC.riskModelCompatibility(S.riskModel);
}

/** Inference engine selected in the sidebar: 'auto' | 'browser' | 'server'. */
function engineChoice(){return document.getElementById('engineSelect')?.value||'auto'}
function serverAvailable(){return typeof ServerBridge!=='undefined'&&ServerBridge.isConfigured()}

/** Local (browser) risk scoring: hybrid if a compatible model is in this session, otherwise rule only. */
function predictRiskLocal(){
  const M=riskReadiness().ok?S.riskModel:null;
  S.data.forEach(r=>{BC.applyHybridRisk(r,M);r.RiskEngine='Browser session';r.RiskDecisionMode=M?'Calibrated Hybrid (thresholds from training calibration set)':'Rule only';});
  return {engine:'browser',mode:M?'HYBRID':'RULE-ONLY',model:M?{trainedAt:M.trainedAt,source:S.riskSource,labelSource:M.labelSource?.mode,thresholds:BC.hybridThresholds(M)}:null,
    reason:M?'':riskReadiness().reason};
}

async function safePredictRisk(){
  try{
    if(!S.data.length)throw new Error('Load or generate base trajectory data first.');
    completeFeatures(false,false);
    const choice=engineChoice();
    let engine=choice;
    if(choice==='auto'){
      if(riskReadiness().ok)engine='browser';
      else if(serverAvailable()&&await ServerBridge.riskModelReady())engine='server';
      else engine='browser';
    }
    setOperationStatus(`Predict Risk running on ${S.data.length.toLocaleString()} rows (${engine==='server'?'server approved model':'browser session'})...`);
    setWait('Predict Risk',`Scoring ${S.data.length.toLocaleString()} rows (${engine==='server'?'server approved model':'browser session'})...`,30);
    await new Promise(r=>setTimeout(r,60));
    const run=engine==='server'?await ServerBridge.predictRisk():predictRiskLocal();
    S.lastRiskRun={...run,at:new Date().toISOString(),rows:S.data.length};
    renderRiskReport();
    showTab('risk',document.querySelector('.tabbtn[data-tab=risk]'));
    refreshAll();updateRiskPlotVisibility();drawRiskPlots();
    const c=BC.RISK_LEVELS.map(l=>`${l} ${S.data.filter(r=>r.PredictedRiskLevel===l).length}`).join(', ');
    if(run.mode==='HYBRID')setOperationStatus(`Hybrid Risk completed (${run.engine==='server'?'server approved model':'browser session model'}): ${c}.`);
    else setOperationStatus(`Predict Risk ran in RULE-ONLY mode — no compatible ML risk model (${run.reason||'none loaded'}). Results are rule scores, not Hybrid AI: ${c}.`,false,true);
  }catch(err){
    console.error('safePredictRisk error',err);
    const msg=err?.message||String(err);
    setOperationStatus('Predict Risk failed: '+msg,true);
    alert('Predict Risk failed:\n\n'+msg);
  }finally{hideWait()}
}
function predictRisk(){return safePredictRisk()}

function renderRiskReport(){
  const R=S.lastRiskRun;if(!R)return;
  const t=R.model?.thresholds||BC.RULE_THRESHOLDS;
  const count=l=>S.data.filter(r=>r.PredictedRiskLevel===l).length;
  document.getElementById('riskReport').textContent=
`RISK PREDICTION — ${R.mode==='HYBRID'?'HYBRID (rule + calibrated ML)':'RULE-ONLY (no ML)'}
Engine: ${R.engine==='server'?'Server approved model ('+(R.serverUrl||'')+')':'Browser session'}
${R.mode==='HYBRID'
  ?`Model trained: ${R.model?.trainedAt||'—'} | labels: ${R.model?.labelSource||'—'}
Hybrid thresholds T1/T2/T3 = ${t.t1}/${t.t2}/${t.t3} (${t.source||'model'})`
  :`Reason: ${R.reason||'no compatible risk model'}
Rule thresholds 45/65/82. Train step 6, load a trained ZIP, or use a server with an approved model to obtain Hybrid AI risk.`}
Rows predicted: ${R.rows.toLocaleString()}
Mean Rule Risk: ${mean(S.data.map(r=>r.RuleRiskScore)).toFixed(1)}
Mean Hybrid/Final Risk: ${mean(S.data.map(r=>r.HybridRiskScore)).toFixed(1)}
${R.mode==='HYBRID'?`Mean ML Risk: ${mean(S.data.map(r=>r.MLRiskScore)).toFixed(1)}\n`:''}
Predicted counts:
${BC.RISK_LEVELS.map(l=>`${l.padEnd(8)} ${count(l)}`).join('\n')}
Warning/Critical points: ${count('Warning')+count('Critical')}`;
}

async function safeForecastFuture(){
  try{
    if(!S.data.length)throw new Error('Load or generate base trajectory data first.');
    const a=selectedCase();
    if(!a.length)throw new Error('Select a valid CaseID.');
    const choice=engineChoice();
    let engine=choice;
    if(choice==='auto'){
      if(trajectoryStateIntegrity().ok)engine='browser';
      else if(serverAvailable()&&await ServerBridge.trajModelReady())engine='server';
      else throw new Error('No trajectory model available: train step 8 in this browser, load a trained demo ZIP, or connect to a server with an approved model.');
    }
    if(engine==='browser'){
      const tr=trajectoryReadiness();
      if(!tr.ok)throw new Error(tr.reason);
      setOperationStatus(`Forecast running in the browser for CaseID ${tr.caseId} using the last ${S.trajModel.inputLen} of ${tr.rows} observed rows...`);
      await forecastFuture();
    }else{
      setOperationStatus(`Forecast running on the server for CaseID ${a[0].CaseID}...`);
      await ServerBridge.forecast(a);
    }
    if(!S.forecast?.length)throw new Error('Forecast returned no rows.');
    const F=S.forecast,geom=F.filter(r=>r.GeometryViolation).length,high=F.filter(r=>['Warning','Critical'].includes(r.ForecastRiskFlag)).length;
    setOperationStatus(`Forecast completed (${S.forecastSource}): ${F.length} steps, ${high} Warning/Critical point(s), ${geom} raw geometry violation(s).`,false,geom>0);
  }catch(err){
    console.error('safeForecastFuture error',err);
    const msg=err?.message||String(err);
    setOperationStatus('Forecast failed: '+msg,true);
    alert('Forecast Future Vessel State + Risk failed:\n\n'+msg);
  }finally{hideWait()}
}

function selectedCase(){
  if(!S.data.length)return [];
  const sel=document.getElementById('caseSelect');
  let id=Number(sel?.value);
  const ids=[...new Set(S.data.map(r=>Number(r.CaseID)).filter(Number.isFinite))].sort((a,b)=>a-b);
  if(!Number.isFinite(id)||!ids.includes(id)){
    id=ids[0];
    if(sel&&Number.isFinite(id))sel.value=String(id);
  }
  if(!Number.isFinite(id))return [];
  return S.data
    .filter(r=>Number(r.CaseID)===id)
    .sort((a,b)=>Number(a.Time_s)-Number(b.Time_s));
}


function setTrajectoryTrainingState(running){
  S.trajTraining.running=running;
  S.trajTraining.cancel=false;
  const cb=document.getElementById('waitCancelBtn');
  if(cb){cb.hidden=!running;cb.disabled=false;cb.textContent='Cancel training';}
}
function cancelTrajectoryTraining(){
  if(!S.trajTraining.running)return;
  S.trajTraining.cancel=true;
  const cb=document.getElementById('waitCancelBtn');
  if(cb){cb.disabled=true;cb.textContent='Cancelling…';}
  logMsg('Trajectory training cancellation requested — stopping after the current batch...');
}
function checkTrajectoryCancelled(){
  if(S.trajTraining.cancel) throw new Error('Trajectory training cancelled by user.');
}
async function yieldUI(ms=0){
  await tf.nextFrame();
  if(ms>0)await new Promise(r=>setTimeout(r,ms));
  checkTrajectoryCancelled();
}

function trajRawFeature(r){return BC.trajRawFeature(r)}
function computeArrayStats(arrays){
  const p=arrays[0].length,mu=Array(p).fill(0),sd=Array(p).fill(1);
  for(let j=0;j<p;j++){const v=arrays.map(a=>a[j]);mu[j]=mean(v);sd[j]=Math.sqrt(mean(v.map(x=>(x-mu[j])**2)))||1}
  return {mean:mu,std:sd};
}
function normVec(v,s){return BC.normVec(v,s)}
function createTrajectorySplit(){
  const ids=[...new Set(S.data.map(r=>r.CaseID))].sort((a,b)=>a-b),ord=shuffleIdx(ids.length,31031).map(i=>ids[i]);
  const nTr=Math.floor(.70*ord.length),nVa=Math.floor(.15*ord.length);
  return {train:new Set(ord.slice(0,nTr)),val:new Set(ord.slice(nTr,nTr+nVa)),test:new Set(ord.slice(nTr+nVa))};
}


const TRAJ_TARGET_CHANNELS=BC.TRAJ_TARGET_CHANNELS;
function rawTrajTarget(anchor,prev,r){return BC.rawTrajTarget(anchor,prev,r)}

function computeTargetStats(rawTargets,H){
  const C=TRAJ_TARGET_CHANNELS.length;
  if(C!==6)throw new Error(`Internal target schema error: expected 6 channels, found ${C}.`);

  const mu=Array(C).fill(0),sd=Array(C).fill(1);
  for(let c=0;c<C;c++){
    const vals=[];
    rawTargets.forEach(row=>{
      for(let k=0;k<H;k++){
        const v=Number(row[k*C+c]);
        if(Number.isFinite(v))vals.push(v);
      }
    });
    mu[c]=vals.length?mean(vals):0;
    sd[c]=vals.length?Math.sqrt(mean(vals.map(v=>(v-mu[c])**2))):1;
    if(!Number.isFinite(sd[c])||sd[c]<1e-9)sd[c]=1;
  }
  return {
    mean:mu,
    std:sd,
    channels:[...TRAJ_TARGET_CHANNELS],
    schema:'6ch-step-to-step-angle-sideclearance-ROT-derived'
  };
}
function normTargetFlat(raw,stats){
  const C=TRAJ_TARGET_CHANNELS.length;
  return raw.map((v,i)=>(v-stats.mean[i%C])/(stats.std[i%C]||1));
}
function denormTargetAt(flat,k,stats){
  const C=TRAJ_TARGET_CHANNELS.length,out=[];
  for(let c=0;c<C;c++){
    const i=k*C+c;
    out.push(flat[i]*(stats.std[c]||1)+stats.mean[c]);
  }
  return out;
}
function decodeStatePrediction(pred,anchorArg,H,targetStats,dt_s=5){return BC.decodeStatePrediction(pred,anchorArg?.last||anchorArg,H,targetStats,dt_s)}

async function makeTrajectorySequences(caseSet,inputLen,H,minStride=3,stats=null,targetStats=null,maxSeq=5000){
  const by={};
  S.data.filter(r=>caseSet.has(r.CaseID)).forEach(r=>(by[r.CaseID]??=[]).push(r));
  const seq=[],rawY=[],meta=[],rawFeat=[];
  let caseCounter=0,totalWindows=0;

  for(const a0 of Object.values(by)){
    const a=a0.sort((x,y)=>x.Time_s-y.Time_s);
    for(const r of a) rawFeat.push(trajRawFeature(r));
    totalWindows+=Math.max(0,a.length-inputLen-H+1);
    caseCounter++;
    if(caseCounter%20===0) await yieldUI();
  }
  const fs=stats||computeArrayStats(rawFeat);
  // Stride chosen so that every case contributes windows while respecting maxSeq.
  const stride=Math.max(minStride,Math.ceil(totalWindows/Math.max(1,maxSeq)));

  caseCounter=0;
  for(const a0 of Object.values(by)){
    const a=a0.sort((x,y)=>x.Time_s-y.Time_s);
    for(let s=0;s+inputLen+H<=a.length;s+=stride){
      const input=a.slice(s,s+inputLen).map(r=>normVec(trajRawFeature(r),fs));
      const last=a[s+inputLen-1],future=a.slice(s+inputLen,s+inputLen+H);
      const out=[];
      let prev=last;
      for(const r of future){
        out.push(...rawTrajTarget(last,prev,r));
        prev=r;
      }
      seq.push(input); rawY.push(out);
      meta.push({caseId:last.CaseID,lastX:last.X_m,lastY:last.Y_m,last:last,future});
      if(seq.length>=maxSeq) break;
    }
    caseCounter++;
    if(caseCounter%10===0){
      setWait('Train Multi-State LSTM/GRU',`Preparing multi-state sequences... ${seq.length.toLocaleString()} built`,12);
      await yieldUI();
    }
    if(seq.length>=maxSeq) break;
  }
  const ts=targetStats||computeTargetStats(rawY,H);
  if(!ts?.mean||ts.mean.length!==6||!ts?.std||ts.std.length!==6){
    throw new Error(`Trajectory targetStats generation failed: mean=${ts?.mean?.length||0}, std=${ts?.std?.length||0}; expected 6/6.`);
  }
  if(!Array.isArray(ts.channels)||ts.channels.length!==6){
    ts.channels=[...TRAJ_TARGET_CHANNELS];
  }
  const Y=rawY.map(a=>normTargetFlat(a,ts));
  const expectedDim=6*H;
  const bad=Y.findIndex(row=>row.length!==expectedDim||row.some(v=>!Number.isFinite(v)));
  if(bad>=0)throw new Error(`Trajectory normalized target row ${bad} is invalid; expected ${expectedDim} finite values.`);
  return {X:seq,Y,meta,featureStats:fs,targetStats:ts};
}


const TRAJ_LOSS_V3421={ // loss weights (name kept for compatibility)
  // 6 neural targets including true beam-aware SideClearanceToBerth.
  wXY:.22,
  wSpeed:.09,
  wHeading:.18,
  wCOG:.13,
  wSideClearance:.16,
  wPhysicsXY:.08,
  wPhysicsROT:.06,
  wHeadingCOG:.04,
  wPenetration:.04,
  physicsSpeedScale_mps:.25,
  physicsROTScale_degps:3.0,
  sideClearanceScale_m:5.0,
  defaultDt_s:5.0
};
function circularVectorLossTF(trueSin,trueCos,predSin,predCos){
  const eps=1e-6;
  const tn=tf.sqrt(tf.add(tf.add(tf.square(trueSin),tf.square(trueCos)),eps));
  const pn=tf.sqrt(tf.add(tf.add(tf.square(predSin),tf.square(predCos)),eps));
  const dot=tf.add(tf.mul(tf.div(trueSin,tn),tf.div(predSin,pn)),tf.mul(tf.div(trueCos,tn),tf.div(predCos,pn)));
  return tf.mean(tf.sub(1,tf.clipByValue(dot,-1,1)));
}
function makePhysicsAwareMultiTaskLoss(H,targetStats,dt_s=5){
  const mu=targetStats.mean.map(Number);
  const sd=targetStats.std.map(v=>Math.max(1e-9,Number(v)));
  const C=TRAJ_LOSS_V3421;
  const denorm=(z,j)=>tf.add(tf.mul(z,sd[j]),mu[j]);

  return function(yTrue,yPred){
    return tf.tidy(()=>{
      const T=tf.reshape(yTrue,[-1,H,6]);
      const P=tf.reshape(yPred,[-1,H,6]);
      const t=j=>tf.slice(T,[0,0,j],[-1,-1,1]).squeeze([2]);
      const p=j=>tf.slice(P,[0,0,j],[-1,-1,1]).squeeze([2]);

      // Supervised normalized losses.
      const lXY=tf.mean(tf.add(
        tf.square(tf.sub(p(0),t(0))),
        tf.square(tf.sub(p(1),t(1)))
      ));
      const lSpeed=tf.mean(tf.square(tf.sub(p(2),t(2))));
      const lHeading=tf.mean(tf.square(tf.sub(p(3),t(3))));
      const lCOG=tf.mean(tf.square(tf.sub(p(4),t(4))));
      const lSideClearance=tf.mean(tf.square(tf.sub(p(5),t(5))));

      // Physical values.
      const dx=denorm(p(0),0);
      const dy=denorm(p(1),1);
      const speed=tf.maximum(denorm(p(2),2),0);
      const dHeadStep=denorm(p(3),3);

      // Stepwise XY displacement consistency.
      const z=tf.zerosLike(tf.slice(dx,[0,0],[-1,1]));
      const dxPrev=tf.concat([z,tf.slice(dx,[0,0],[-1,H-1])],1);
      const dyPrev=tf.concat([z,tf.slice(dy,[0,0],[-1,H-1])],1);
      const incX=tf.sub(dx,dxPrev);
      const incY=tf.sub(dy,dyPrev);

      const vXY=tf.div(tf.sqrt(tf.add(tf.square(incX),tf.square(incY))),dt_s);
      const lPhysXY=tf.mean(
        tf.square(tf.div(tf.sub(vXY,speed),C.physicsSpeedScale_mps))
      );

      // ROT consistency derived from DeltaHeadingStep / dt.
      const trueROT=tf.div(denorm(t(3),3),dt_s);
      const predROT=tf.div(dHeadStep,dt_s);
      const lPhysROT=tf.mean(
        tf.square(tf.div(tf.sub(predROT,trueROT),C.physicsROTScale_degps))
      );

      // Heading/COG drift consistency.
      const trueDriftStep=tf.sub(t(4),t(3));
      const predDriftStep=tf.sub(p(4),p(3));
      const lHeadingCOG=tf.mean(tf.square(tf.sub(predDriftStep,trueDriftStep)));

      // TRUE berth-geometry learning:
      // predicted side clearance is a neural output in metres.
      const predSide=denorm(p(5),5);

      // Penalize negative predicted clearance directly.
      const penetration=tf.maximum(tf.neg(predSide),0);
      const lPenetration=tf.mean(
        tf.square(tf.div(penetration,C.sideClearanceScale_m))
      );

      return tf.addN([
        tf.mul(C.wXY,lXY),
        tf.mul(C.wSpeed,lSpeed),
        tf.mul(C.wHeading,lHeading),
        tf.mul(C.wCOG,lCOG),
        tf.mul(C.wSideClearance,lSideClearance),
        tf.mul(C.wPhysicsXY,lPhysXY),
        tf.mul(C.wPhysicsROT,lPhysROT),
        tf.mul(C.wHeadingCOG,lHeadingCOG),
        tf.mul(C.wPenetration,lPenetration)
      ]);
    });
  };
}
function trajectorySelectionScore(m){
  const drift=Number.isFinite(m.DriftAngle_MAE)?m.DriftAngle_MAE:90;
  return .23*(m.ADE/10)+.11*(m.FDE/20)+.08*(m.MAE_Speed/.20)
       + .19*(m.MAE_Heading/30)+.14*(m.MAE_COG/20)+.12*(m.RMSE_ROT/3)
       + .13*(drift/25);
}
function classFromThresholds(score,thr){
  const s=Number(score),t1=Number(thr?.t1??45),t2=Number(thr?.t2??65),t3=Number(thr?.t3??82);
  return s>=t3?3:s>=t2?2:s>=t1?1:0;
}
function confusion4(actual,pred){
  const cm=Array.from({length:4},()=>[0,0,0,0]);
  for(let i=0;i<actual.length;i++)cm[actual[i]][pred[i]]++;
  return cm;
}
function classPRF4(cm,k){
  const tp=cm[k][k];
  let fp=0,fn=0;
  for(let i=0;i<4;i++)if(i!==k){fp+=cm[i][k];fn+=cm[k][i];}
  const precision=tp/Math.max(1,tp+fp),recall=tp/Math.max(1,tp+fn);
  const f1=(precision+recall)>0?2*precision*recall/(precision+recall):0;
  return {precision,recall,f1};
}
function metrics4(actual,pred){
  const cm=confusion4(actual,pred),per=[0,1,2,3].map(k=>classPRF4(cm,k));
  const macroF1=per.reduce((s,x)=>s+x.f1,0)/4;
  const accuracy=actual.reduce((s,a,i)=>s+(a===pred[i]?1:0),0)/Math.max(1,actual.length);
  return {cm,per,macroF1,accuracy};
}
function optimizeHybridThresholds(rows){
  const expert=rows.filter(r=>Number.isFinite(Number(r.ExpertRiskClass))&&Number.isFinite(Number(r.HybridRiskScore)));
  if(expert.length<40)return {
    t1:45,t2:65,t3:82,
    source:'fixed-default (fewer than 40 Ground Truth rows in the calibration set)',
    n:expert.length,
    constraints:{criticalShareMax:.15,warningCriticalShareMax:.35,criticalRecallMin:.75}
  };

  const actual=expert.map(r=>Math.max(0,Math.min(3,Number(r.ExpertRiskClass)|0)));
  const scores=expert.map(r=>Number(r.HybridRiskScore));
  const allScores=rows.filter(r=>Number.isFinite(Number(r.HybridRiskScore))).map(r=>Number(r.HybridRiskScore));
  const smin=Math.floor(Math.min(...scores)),smax=Math.ceil(Math.max(...scores));

  const LIMIT_CRIT=.15;
  const LIMIT_HIGH=.35;
  const MIN_CRIT_RECALL=.75;

  let bestFeasible=null;
  let bestFallback=null;

  for(let t1=Math.max(20,smin);t1<=Math.min(55,smax-8);t1+=1){
    for(let t2=t1+3;t2<=Math.min(70,smax-4);t2+=1){
      for(let t3=t2+3;t3<=smax;t3+=1){
        const thr={t1,t2,t3};
        const pred=scores.map(s=>classFromThresholds(s,thr));
        const M=metrics4(actual,pred);
        const rw=M.per[2].recall;
        const rc=M.per[3].recall;
        const pc=M.per[3].precision;

        const allPred=allScores.map(s=>classFromThresholds(s,thr));
        const nAll=Math.max(1,allPred.length);
        const critShare=allPred.filter(x=>x===3).length/nAll;
        const highShare=allPred.filter(x=>x>=2).length/nAll;

        const objective=.45*M.macroF1+.20*rw+.25*rc+.10*pc;

        const hardFeasible=
          rc>=MIN_CRIT_RECALL &&
          critShare<=LIMIT_CRIT &&
          highShare<=LIMIT_HIGH;

        const violation=
          Math.max(0,MIN_CRIT_RECALL-rc)*2.0 +
          Math.max(0,critShare-LIMIT_CRIT)*3.0 +
          Math.max(0,highShare-LIMIT_HIGH)*2.0;

        const cand={
          t1,t2,t3,M,rw,rc,pc,critShare,highShare,
          objective,hardFeasible,violation
        };

        if(hardFeasible){
          if(!bestFeasible || cand.objective>bestFeasible.objective){
            bestFeasible=cand;
          }
        }else{
          // Fallback: minimize total constraint violation first, then maximize objective.
          if(!bestFallback ||
             cand.violation<bestFallback.violation-1e-12 ||
             (Math.abs(cand.violation-bestFallback.violation)<1e-12 && cand.objective>bestFallback.objective)){
            bestFallback=cand;
          }
        }
      }
    }
  }

  const best=bestFeasible||bestFallback;
  if(!best)return {
    t1:45,t2:65,t3:82,
    source:'fixed-default-search-failed',
    n:expert.length,
    constraints:{criticalShareMax:LIMIT_CRIT,warningCriticalShareMax:LIMIT_HIGH,criticalRecallMin:MIN_CRIT_RECALL}
  };

  return {
    t1:best.t1,t2:best.t2,t3:best.t3,
    source:best.hardFeasible?'calibrated on Ground Truth (calibration cases, constraints met)':'calibrated on Ground Truth (calibration cases, minimum-violation fallback)',
    n:expert.length,
    objective:best.objective,
    hardFeasible:best.hardFeasible,
    totalViolation:best.violation,
    constraints:{
      criticalShareMax:LIMIT_CRIT,
      warningCriticalShareMax:LIMIT_HIGH,
      criticalRecallMin:MIN_CRIT_RECALL
    },
    validation:{
      accuracy:best.M.accuracy,
      macroF1:best.M.macroF1,
      warningRecall:best.rw,
      criticalRecall:best.rc,
      criticalPrecision:best.pc,
      criticalShare:best.critShare,
      warningCriticalShare:best.highShare,
      confusionMatrix:best.M.cm
    }
  };
}
function buildSeqModel(kind,inputLen,nFeat,H,targetStats,dt_s=5){
  const m=tf.sequential();
  const common={units:32,inputShape:[inputLen,nFeat],dropout:.10,recurrentDropout:0,returnSequences:false};
  if(kind==='lstm')m.add(tf.layers.lstm(common));else m.add(tf.layers.gru(common));
  m.add(tf.layers.dense({units:64,activation:'relu'}));
  m.add(tf.layers.dropout({rate:.08}));
  m.add(tf.layers.dense({units:6*H}));
  m.compile({optimizer:tf.train.adam(.001),loss:makePhysicsAwareMultiTaskLoss(H,targetStats,dt_s)});
  return m;
}


function physicsConsistencyMetrics(states,dt_s=5,actualRows=null){
  if(!states?.length)return {SpeedFromXY_MAE:NaN,COGFromXY_MAE:NaN,ROTExceedShare:NaN};
  let es=0,ec=0,n=0,nc=0,exceed=0;
  const lim=BC.vesselLimits(actualRows?.[0]||{}).maxROT_degps;
  for(let k=1;k<states.length;k++){
    const a=states[k-1],b=states[k],dx=b.X_m-a.X_m,dy=b.Y_m-a.Y_m;
    const vxy=Math.hypot(dx,dy)/Math.max(1e-9,dt_s);
    es+=Math.abs(vxy-b.Speed_mps);n++;
    if(vxy>0.3){ec+=circAbsErr(deg(Math.atan2(dy,dx)),b.COG_deg);nc++;}
  }
  for(const s of states)if(Math.abs(Number(s.ROT_degps))>1.5*lim)exceed++;
  return {SpeedFromXY_MAE:es/Math.max(1,n),COGFromXY_MAE:nc?ec/nc:NaN,ROTExceedShare:exceed/states.length};
}

function headingCOGDriftMetrics(predStates,actualRows){
  const n=Math.min(predStates?.length||0,actualRows?.length||0);
  if(!n)return {DriftAngle_MAE:NaN,PredMeanAbsDrift:NaN,ActualMeanAbsDrift:NaN};
  let e=0,pa=0,aa=0;
  for(let i=0;i<n;i++){
    const pd=wrap180(Number(predStates[i].COG_deg)-Number(predStates[i].Heading_deg));
    const ad=wrap180(Number(actualRows[i].COG_deg)-Number(actualRows[i].Heading_deg));
    e+=circAbsErr(pd,ad); pa+=Math.abs(pd); aa+=Math.abs(ad);
  }
  return {DriftAngle_MAE:e/n,PredMeanAbsDrift:pa/n,ActualMeanAbsDrift:aa/n};
}

function stateMetrics(predStates,actualRows){
  let ade=0,fde=0,seXY=0,nxy=0,seROT=0;
  let eSpeed=0,eHead=0,eCog=0;
  const H=Math.min(predStates.length,actualRows.length)||1;
  for(let k=0;k<H;k++){
    const p=predStates[k],a=actualRows[k];
    const dx=p.X_m-a.X_m,dy=p.Y_m-a.Y_m,d=Math.hypot(dx,dy);
    ade+=d; if(k===H-1) fde=d;
    seXY+=dx*dx+dy*dy;nxy+=2;
    eSpeed+=Math.abs(p.Speed_mps-a.Speed_mps);
    eHead+=circAbsErr(p.Heading_deg,a.Heading_deg);
    eCog+=circAbsErr(p.COG_deg,a.COG_deg);
    seROT+=(p.ROT_degps-a.ROT_degps)**2;
  }
  return {
    ADE:ade/H,FDE:fde,RMSE:Math.sqrt(seXY/Math.max(1,nxy)),
    MAE_Speed:eSpeed/H,MAE_Heading:eHead/H,MAE_COG:eCog/H,
    RMSE_ROT:Math.sqrt(seROT/H),
    ...physicsConsistencyMetrics(predStates,actualRows.length>1?Math.max(1e-9,actualRows[1].Time_s-actualRows[0].Time_s):5,actualRows),
    ...headingCOGDriftMetrics(predStates,actualRows)
  };
}

function trajectoryMetricsFromArrays(predNorm,dataset,H){
  const sums={
    ADE:0,FDE:0,RMSE2:0,MAE_Speed:0,MAE_Heading:0,MAE_COG:0,RMSE_ROT2:0,
    SpeedFromXY_MAE:0,COGFromXY_MAE:0,ROTExceedShare:0,
    DriftAngle_MAE:0,PredMeanAbsDrift:0,ActualMeanAbsDrift:0
  };
  const n=dataset.Y.length||1;
  for(let i=0;i<n;i++){
    const pred=decodeStatePrediction(
      predNorm[i],
      dataset.meta[i],
      H,
      dataset.targetStats,
      dataset.meta[i]?.future?.length>1
        ?Math.max(1e-9,Number(dataset.meta[i].future[1].Time_s)-Number(dataset.meta[i].future[0].Time_s))
        :5
    );
    const m=stateMetrics(pred,dataset.meta[i].future);
    sums.ADE+=m.ADE;sums.FDE+=m.FDE;
    sums.RMSE2+=m.RMSE*m.RMSE;
    sums.MAE_Speed+=m.MAE_Speed;sums.MAE_Heading+=m.MAE_Heading;sums.MAE_COG+=m.MAE_COG;
    sums.RMSE_ROT2+=m.RMSE_ROT*m.RMSE_ROT;
    sums.SpeedFromXY_MAE+=Number.isFinite(m.SpeedFromXY_MAE)?m.SpeedFromXY_MAE:0;
    sums.COGFromXY_MAE+=Number.isFinite(m.COGFromXY_MAE)?m.COGFromXY_MAE:0;
    sums.ROTExceedShare+=Number.isFinite(m.ROTExceedShare)?m.ROTExceedShare:0;
    sums.DriftAngle_MAE+=Number.isFinite(m.DriftAngle_MAE)?m.DriftAngle_MAE:0;
    sums.PredMeanAbsDrift+=Number.isFinite(m.PredMeanAbsDrift)?m.PredMeanAbsDrift:0;
    sums.ActualMeanAbsDrift+=Number.isFinite(m.ActualMeanAbsDrift)?m.ActualMeanAbsDrift:0;
  }
  return {
    ADE:sums.ADE/n,FDE:sums.FDE/n,RMSE:Math.sqrt(sums.RMSE2/n),
    MAE_Speed:sums.MAE_Speed/n,MAE_Heading:sums.MAE_Heading/n,MAE_COG:sums.MAE_COG/n,
    RMSE_ROT:Math.sqrt(sums.RMSE_ROT2/n),
    SpeedFromXY_MAE:sums.SpeedFromXY_MAE/n,
    COGFromXY_MAE:sums.COGFromXY_MAE/n,
    ROTExceedShare:sums.ROTExceedShare/n,
    DriftAngle_MAE:sums.DriftAngle_MAE/n,
    PredMeanAbsDrift:sums.PredMeanAbsDrift/n,
    ActualMeanAbsDrift:sums.ActualMeanAbsDrift/n
  };
}

function kinematicStates(meta,H){
  const last=meta.last,dt=meta.future?.length?Math.max(1e-6,meta.future[0].Time_s-last.Time_s):5;
  return BC.kinematicStates(last,H,dt);
}
function kinematicDatasetMetrics(ds,H){
  const sums={
    ADE:0,FDE:0,RMSE2:0,MAE_Speed:0,MAE_Heading:0,MAE_COG:0,RMSE_ROT2:0,
    SpeedFromXY_MAE:0,COGFromXY_MAE:0,ROTExceedShare:0,
    DriftAngle_MAE:0,PredMeanAbsDrift:0,ActualMeanAbsDrift:0
  };
  const n=ds.meta.length||1;
  ds.meta.forEach(meta=>{
    const m=stateMetrics(kinematicStates(meta,H),meta.future);
    sums.ADE+=m.ADE;sums.FDE+=m.FDE;sums.RMSE2+=m.RMSE*m.RMSE;
    sums.MAE_Speed+=m.MAE_Speed;sums.MAE_Heading+=m.MAE_Heading;sums.MAE_COG+=m.MAE_COG;
    sums.RMSE_ROT2+=m.RMSE_ROT*m.RMSE_ROT;
    sums.SpeedFromXY_MAE+=Number.isFinite(m.SpeedFromXY_MAE)?m.SpeedFromXY_MAE:0;
    sums.COGFromXY_MAE+=Number.isFinite(m.COGFromXY_MAE)?m.COGFromXY_MAE:0;
    sums.ROTExceedShare+=Number.isFinite(m.ROTExceedShare)?m.ROTExceedShare:0;
    sums.DriftAngle_MAE+=Number.isFinite(m.DriftAngle_MAE)?m.DriftAngle_MAE:0;
    sums.PredMeanAbsDrift+=Number.isFinite(m.PredMeanAbsDrift)?m.PredMeanAbsDrift:0;
    sums.ActualMeanAbsDrift+=Number.isFinite(m.ActualMeanAbsDrift)?m.ActualMeanAbsDrift:0;
  });
  return {
    ADE:sums.ADE/n,FDE:sums.FDE/n,RMSE:Math.sqrt(sums.RMSE2/n),
    MAE_Speed:sums.MAE_Speed/n,MAE_Heading:sums.MAE_Heading/n,MAE_COG:sums.MAE_COG/n,
    RMSE_ROT:Math.sqrt(sums.RMSE_ROT2/n),
    SpeedFromXY_MAE:sums.SpeedFromXY_MAE/n,
    COGFromXY_MAE:sums.COGFromXY_MAE/n,
    ROTExceedShare:sums.ROTExceedShare/n,
    DriftAngle_MAE:sums.DriftAngle_MAE/n,
    PredMeanAbsDrift:sums.PredMeanAbsDrift/n,
    ActualMeanAbsDrift:sums.ActualMeanAbsDrift/n
  };
}

async function fitTFModel(model,name,train,val,epochs=18){
  checkTrajectoryCancelled();
  let tx=null,ty=null,vx=null,vy=null,bestWeights=null;
  try{
    setWait('Train Multi-State LSTM/GRU',`Allocating tensors for ${name}...`,name==='LSTM'?28:58);
    await yieldUI();
    tx=tf.tensor3d(train.X); ty=tf.tensor2d(train.Y);
    vx=tf.tensor3d(val.X); vy=tf.tensor2d(val.Y);
    let best=Infinity,pat=0;
    await model.fit(tx,ty,{
      epochs,batchSize:32,validationData:[vx,vy],shuffle:true,verbose:0,
      callbacks:{onEpochEnd:async(epoch,logs)=>{
        checkTrajectoryCancelled();
        const vl=logs.val_loss??logs.loss;
        const base=name==='LSTM'?32:62,span=22;
        setWait('Train Multi-State LSTM/GRU',
          `${name} epoch ${epoch+1}/${epochs} • val_loss=${Number(vl).toFixed(5)}`,
          Math.min(88,base+(epoch+1)*span/epochs));
        if(vl<best-1e-5){
          best=vl;pat=0;
          if(bestWeights)bestWeights.forEach(w=>w.dispose());
          bestWeights=model.getWeights().map(w=>w.clone());
        }else pat++;
        await yieldUI();
        if(pat>=6)model.stopTraining=true;
      }}
    });
    if(bestWeights)model.setWeights(bestWeights);
  } finally {
    [tx,ty,vx,vy].forEach(t=>{if(t)t.dispose()});
    if(bestWeights)bestWeights.forEach(w=>w.dispose());
    await yieldUI();
  }
}
async function predictTF(model,ds,chunkSize=256){
  const out=[];
  for(let s=0;s<ds.X.length;s+=chunkSize){
    checkTrajectoryCancelled();
    const x=tf.tensor3d(ds.X.slice(s,s+chunkSize));
    const p=model.predict(x),arr=await p.array();
    out.push(...arr);x.dispose();p.dispose();await yieldUI();
  }
  return out;
}
function fmtMetric(v,d=3){return Number.isFinite(Number(v))?Number(v).toFixed(d):'N/A'}
function metricLine(name,m){
  return `${name}: ADE ${fmtMetric(m.ADE,2)} m | FDE ${fmtMetric(m.FDE,2)} m | XY-RMSE ${fmtMetric(m.RMSE,2)} m
       Speed MAE ${fmtMetric(m.MAE_Speed,3)} m/s | Heading MAE ${fmtMetric(m.MAE_Heading,2)}° | COG MAE ${fmtMetric(m.MAE_COG,2)}° | ROT RMSE ${fmtMetric(m.RMSE_ROT,3)} °/s
       Physics: |Vxy−V| ${fmtMetric(m.SpeedFromXY_MAE,3)} m/s | COGxy MAE ${fmtMetric(m.COGFromXY_MAE,2)}° | steps with |ROT| > 1.5×limit ${Number.isFinite(m.ROTExceedShare)?(100*m.ROTExceedShare).toFixed(1)+'%':'N/A'}
       Heading↔COG drift: MAE ${fmtMetric(m.DriftAngle_MAE,2)}° | Pred |drift| ${fmtMetric(m.PredMeanAbsDrift,2)}° | Actual |drift| ${fmtMetric(m.ActualMeanAbsDrift,2)}°`;
}

async function trainTrajectory(){
  if(!S.data.length)throw new Error('Load or generate base trajectory data first.');
  if(typeof tf==='undefined')throw new Error('TensorFlow.js could not load. An internet connection is required on first load.');
  setTrajectoryTrainingState(true);
  try{
    await tf.ready();
    logMsg(`TensorFlow.js backend: ${tf.getBackend()}`);
    completeFeatures(false,false);
    const inputLen=clamp(Number(document.getElementById('trajInputLen').value)||20,10,40);
    const H=clamp(Number(document.getElementById('horizon').value)||12,3,24);
    const split=createTrajectorySplit();

    setWait('Train Multi-State LSTM/GRU','Preparing multi-state sequences...',8);
    await yieldUI();
    const tr=await makeTrajectorySequences(split.train,inputLen,H,3,null,null,5000);
    checkTrajectoryCancelled();
    const va=await makeTrajectorySequences(split.val,inputLen,H,3,tr.featureStats,tr.targetStats,1500);
    checkTrajectoryCancelled();
    const te=await makeTrajectorySequences(split.test,inputLen,H,3,tr.featureStats,tr.targetStats,2000);
    if(!tr.X.length||!va.X.length||!te.X.length) throw new Error('Not enough trajectory sequences for training (cases too short for input window + horizon?).');

    const nf=tr.X[0][0].length;
    const allDt=[];
    const byCase={};S.data.forEach(r=>(byCase[r.CaseID]??=[]).push(r));
    Object.values(byCase).forEach(a=>{a.sort((x,y)=>x.Time_s-y.Time_s);for(let i=1;i<a.length;i++){const d=a[i].Time_s-a[i-1].Time_s;if(d>0&&d<120)allDt.push(d)}});
    const dt_s=allDt.length?median(allDt):TRAJ_LOSS_V3421.defaultDt_s;
    setWait('Train Multi-State LSTM/GRU',
      `Dataset ready: ${tr.X.length} train / ${va.X.length} val / ${te.X.length} test`,22);
    await yieldUI(50);

    const lstm=buildSeqModel('lstm',inputLen,nf,H,tr.targetStats,dt_s);
    setWait('Train Multi-State LSTM/GRU','Training LSTM with physics-aware multi-task loss...',28);
    await fitTFModel(lstm,'LSTM',tr,va,24);
    setWait('Train Multi-State LSTM/GRU','Evaluating LSTM multi-state forecast...',54);
    const lp=await predictTF(lstm,te,256),lm=trajectoryMetricsFromArrays(lp,te,H);
    await yieldUI();

    const gru=buildSeqModel('gru',inputLen,nf,H,tr.targetStats,dt_s);
    setWait('Train Multi-State LSTM/GRU','Training GRU with physics-aware multi-task loss...',60);
    await fitTFModel(gru,'GRU',tr,va,24);
    setWait('Train Multi-State LSTM/GRU','Evaluating GRU multi-state forecast...',86);
    const gp=await predictTF(gru,te,256),gm=trajectoryMetricsFromArrays(gp,te,H);

    setWait('Train Multi-State LSTM/GRU','Evaluating kinematic baseline...',92);
    await yieldUI();
    const km=kinematicDatasetMetrics(te,H);
    const selectionScores={lstm:trajectorySelectionScore(lm),gru:trajectorySelectionScore(gm),kinematic:trajectorySelectionScore(km)};
    const best=Object.entries(selectionScores).sort((a,b)=>a[1]-b[1])[0][0];

    const oldTraj=S.trajModel;
    S.trajModel={
      type:'MultiState-LSTM-GRU',appVersion:APP_VERSION,schemaVersion:APP_VERSION,angleConvention:BC.ANGLE_CONVENTION,
      trainedAt:new Date().toISOString(),inputLen,H,
      testCaseIds:[...split.test].sort((a,b)=>a-b),trainCaseIds:[...split.train].sort((a,b)=>a-b),
      featureStats:tr.featureStats,targetStats:tr.targetStats,
      outputChannels:[...TRAJ_TARGET_CHANNELS],
      split:{trainCases:split.train.size,valCases:split.val.size,testCases:split.test.size,
             trainSeq:tr.X.length,valSeq:va.X.length,testSeq:te.X.length},
      lstm,gru,metrics:{lstm:lm,gru:gm,kinematic:km},bestModel:best,selectionScores,
      lossConfig:{...TRAJ_LOSS_V3421,dt_s,objective:'berth-geometry-aware multi-task + circular heading/COG + physics XY/ROT + Heading-COG drift consistency + berth penetration penalty'},
      runtime:{backend:tf.getBackend(),stride:'adaptive (min 3)',maxTrainSeq:5000,maxValSeq:1500,maxTestSeq:2000,
               units:32,denseUnits:64,batchSize:32,maxEpochs:24,earlyStoppingPatience:6,
               optimizer:'Adam',learningRate:.001}
    };

    S.trajSource='browser-trained';
    try{
      if(oldTraj?.lstm&&oldTraj.lstm!==lstm)oldTraj.lstm.dispose();
      if(oldTraj?.gru&&oldTraj.gru!==gru)oldTraj.gru.dispose();
    }catch(_){}

    document.getElementById('trajMetrics').textContent=
`MULTI-STATE TEST METRICS — ${split.test.size} unseen CaseIDs
TensorFlow.js backend: ${tf.getBackend()}
Input: ${inputLen} steps × 13 features
Forecast: ${H} steps × 6 target channels = ${6*H} outputs
Targets: ΔX, ΔY, Speed, ΔHeading/step, ΔCOG/step, SideClearanceToBerth
(Heading/COG are reconstructed by accumulating the step deltas; ROT = ΔHeading/dt)
Train/Val/Test cases: ${split.train.size}/${split.val.size}/${split.test.size}
Sequences: ${tr.X.length}/${va.X.length}/${te.X.length}

${metricLine('LSTM',lm)}
${metricLine('GRU ',gm)}
${metricLine('KIN ',km)}

Auto Select (composite state score, lower is better): ${best.toUpperCase()}
Selection score: LSTM ${selectionScores.lstm.toFixed(3)} | GRU ${selectionScores.gru.toFixed(3)} | Kinematic ${selectionScores.kinematic.toFixed(3)}`;

    document.getElementById('trajReport').textContent=
`MULTI-STATE TRAINING COMPLETED (browser session)

Architecture:
Past state = ${inputLen}×13 → LSTM/GRU (32 units) → Dense 64 ReLU → ${H}×6 outputs
Target channels = ΔX, ΔY, Speed, ΔHeading/step, ΔCOG/step, SideClearanceToBerth

Loss: berth-geometry-aware multi-task objective — supervised targets + XY/Speed consistency,
ROT consistency, Heading–COG drift consistency and a berth-penetration penalty.
Train/Validation/Test split is performed by CaseID before sequence construction.
Validation (step 9) is out-of-sample only for the ${split.test.size} test CaseIDs.

The trained models are active in this browser session immediately:
Predict / Forecast use them without uploading anything.
Use "Save trained models as demo" to keep them, or "Publish to server" (admin) to make them
the approved server model.`;

    setWait('Train Multi-State LSTM/GRU','Completed successfully.',100);
    await new Promise(r=>setTimeout(r,250));
    try{
      setWait('Train Multi-State LSTM/GRU','Caching trained model in this browser...',96);
      await persistActiveModelsToBrowserDemo({silent:true});
      updateModelLoadStatus({note:'Trained LSTM/GRU cached in this browser ✓ — use "Save trained models as demo" for a portable ZIP'});
    }catch(autoSaveErr){
      console.warn('Automatic Browser Demo save failed',autoSaveErr);
      logMsg('Trajectory training succeeded, but the browser cache save failed: '+(autoSaveErr?.message||autoSaveErr));
    }
    updateModelLoadStatus();
    setOperationStatus(`Multi-state LSTM/GRU trained in this browser. Auto Select = ${best.toUpperCase()}. Ready for Validate / Forecast.`);
  }catch(err){
    if((err?.message||'').includes('cancelled')) setOperationStatus('Trajectory training cancelled. The previous model (if any) is unchanged.',false,true);
    else{
      console.error(err);setOperationStatus('Trajectory training failed: '+(err?.message||String(err)),true);
      alert('Multi-State LSTM/GRU training failed:\n\n'+(err?.message||String(err)));
    }
  }finally{setTrajectoryTrainingState(false);hideWait();updateWorkflowState();}
}

function selectedTrajectoryModel(){
  if(!S.trajModel)return 'kinematic';
  const v=document.getElementById('trajModelSelect').value;
  return v==='auto'?S.trajModel.bestModel:v;
}

async function predictTrajectoryWindow(a,anchor,modelName){
  const M=S.trajModel,inputLen=M.inputLen,H=M.H,start=anchor-inputLen+1;
  const seq=a.slice(start,anchor+1).map(r=>normVec(trajRawFeature(r),M.featureStats));
  const last=a[anchor];
  let dtPred=5;
  if(a.length>1){
    const ds=a.slice(1).map((r,i)=>Number(r.Time_s)-Number(a[i].Time_s)).filter(v=>v>0&&v<120);
    if(ds.length)dtPred=median(ds)||5;
  }
  if(modelName==='kinematic')return BC.kinematicStates(last,H,dtPred);
  const model=modelName==='lstm'?M.lstm:M.gru;
  const x=tf.tensor3d([seq]),p=model.predict(x),arr=(await p.array())[0];
  x.dispose();p.dispose();
  return decodeStatePrediction(arr,last,H,M.targetStats,dtPred);
}

function renderForecastStateTable(F){
  const el=document.getElementById('forecastStateTable');
  if(!el)return;
  if(!F?.length){el.innerHTML='';return;}
  const cols=[
    ['Time_s','Time'],
    ['X_forecast_m','X'],
    ['Y_forecast_m','Y'],
    ['Speed_forecast_mps','Speed'],
    ['Heading_forecast_deg','Heading'],
    ['COG_forecast_deg','COG'],
    ['ROT_forecast_degps','ROT'],
    ['RawSideClearanceToBerth_m','Raw SideClr'],
    ['SideClearanceToBerth_m','Shielded SideClr'],
    ['LongitudinalOffset_m','Long.Offset'],
    ['BerthingPhase','Phase'],
    ['BerthHeadingError_deg','Hdg Err'],
    ['GeometryViolation','Geom.Violation'],
    ['ForecastRiskFlag','Risk']
  ];
  let h='<div class="tablewrap"><table><thead><tr>'+
    cols.map(c=>`<th>${c[1]}</th>`).join('')+
    '</tr></thead><tbody>';
  for(const r of F){
    h+='<tr>'+cols.map(c=>{
      const v=r[c[0]];
      if(typeof v==='number')return `<td>${Number.isFinite(v)?v.toFixed(2):''}</td>`;
      if(typeof v==='boolean')return `<td>${v?'TRUE':'FALSE'}</td>`;
      if(c[0]==='ForecastRiskFlag'&&BC.RISK_LEVELS.includes(v))return `<td><span class="badge ${v}">${v}</span></td>`;
      return `<td>${escapeHtml(v??'')}</td>`;
    }).join('')+'</tr>';
  }
  h+='</tbody></table></div>';
  el.innerHTML=h;
}

async function validateTrajectory(){
  if(!S.trajModel)throw new Error('No trajectory model in this browser session. Train step 8 or load a trained demo ZIP first.');
  const a=selectedCase(),M=S.trajModel;
  if(a.length<M.inputLen+M.H)throw new Error(`Selected CaseID has ${a.length} rows; validation needs at least ${M.inputLen+M.H}.`);
  const cid=Number(a[0].CaseID);
  const testIds=Array.isArray(M.testCaseIds)?M.testCaseIds.map(Number):null;
  const sampleType=!testIds?'UNKNOWN (model metadata has no train/test split — treat as possibly in-sample)'
    :testIds.includes(cid)?'OUT-OF-SAMPLE (CaseID is in the held-out test set)'
    :M.trainCaseIds?.map(Number).includes(cid)?'IN-SAMPLE (CaseID was used for training — optimistic)':'IN-SAMPLE/VALIDATION (not a test CaseID — optimistic)';
  const modelName=selectedTrajectoryModel(),anchor=a.length-M.H-1;
  const pred=await predictTrajectoryWindow(a,anchor,modelName),actual=a.slice(anchor+1,anchor+1+M.H);
  if(pred.length!==M.H)throw new Error(`Validation predicted ${pred.length} steps; expected ${M.H}.`);
  const badPred=pred.findIndex(p=>![p.X_m,p.Y_m,p.Speed_mps,p.Heading_deg,p.COG_deg,p.ROT_degps].every(Number.isFinite));
  if(badPred>=0)throw new Error(`Validation contains non-finite predicted state at horizon step ${badPred+1}.`);
  const m=stateMetrics(pred,actual);

  const validationRows=actual.map((aRow,k)=>{
    const p=pred[k];
    const posErr=Math.hypot(p.X_m-aRow.X_m,p.Y_m-aRow.Y_m);
    return {
      CaseID:aRow.CaseID,
      HorizonStep:k+1,
      Time_s:aRow.Time_s,
      TrajectoryModel:modelName.toUpperCase(),

      Actual_X_m:aRow.X_m,
      Predicted_X_m:p.X_m,
      Error_X_m:p.X_m-aRow.X_m,
      AbsError_X_m:Math.abs(p.X_m-aRow.X_m),

      Actual_Y_m:aRow.Y_m,
      Predicted_Y_m:p.Y_m,
      Error_Y_m:p.Y_m-aRow.Y_m,
      AbsError_Y_m:Math.abs(p.Y_m-aRow.Y_m),
      PositionError_m:posErr,

      Actual_Speed_mps:aRow.Speed_mps,
      Predicted_Speed_mps:p.Speed_mps,
      Error_Speed_mps:p.Speed_mps-aRow.Speed_mps,
      AbsError_Speed_mps:Math.abs(p.Speed_mps-aRow.Speed_mps),

      Actual_Heading_deg:aRow.Heading_deg,
      Predicted_Heading_deg:p.Heading_deg,
      CircularError_Heading_deg:wrap180(p.Heading_deg-aRow.Heading_deg),
      AbsCircularError_Heading_deg:circAbsErr(p.Heading_deg,aRow.Heading_deg),

      Actual_COG_deg:aRow.COG_deg,
      Predicted_COG_deg:p.COG_deg,
      CircularError_COG_deg:wrap180(p.COG_deg-aRow.COG_deg),
      AbsCircularError_COG_deg:circAbsErr(p.COG_deg,aRow.COG_deg),

      Actual_ROT_degps:aRow.ROT_degps,
      Predicted_ROT_degps:p.ROT_degps,
      Error_ROT_degps:p.ROT_degps-aRow.ROT_degps,
      AbsError_ROT_degps:Math.abs(p.ROT_degps-aRow.ROT_degps)
    };
  });

  const summary={
    Version:APP_VERSION,
    ValidationType:'Historical hold-out window on selected CaseID',
    SampleType:sampleType,
    CaseID:a[0].CaseID,
    TrajectoryModel:modelName.toUpperCase(),
    InputLength_steps:M.inputLen,
    Horizon_steps:M.H,
    Anchor_Time_s:a[anchor].Time_s,
    ADE_m:m.ADE,
    FDE_m:m.FDE,
    XY_RMSE_m:m.RMSE,
    Speed_MAE_mps:m.MAE_Speed,
    Heading_Circular_MAE_deg:m.MAE_Heading,
    COG_Circular_MAE_deg:m.MAE_COG,
    ROT_RMSE_degps:m.RMSE_ROT,
    ValidationTimestamp:new Date().toISOString()
  };
  S.validation={summary,rows:validationRows,actual,pred,history:a.slice(0,anchor+1)};

  drawTrajectoryValidation(a.slice(0,anchor+1),actual,pred.map(p=>[p.X_m,p.Y_m]));
  document.getElementById('trajReport').textContent=
`MULTI-STATE HISTORICAL VALIDATION — ${modelName.toUpperCase()}
CaseID: ${a[0].CaseID}
Sample type: ${sampleType}
${testIds&&!testIds.includes(cid)?`For an unbiased check select one of the ${testIds.length} test CaseIDs, e.g. ${testIds.slice(0,8).join(', ')}${testIds.length>8?' …':''}
`:''}
Observed input: ${M.inputLen} steps
Forecast horizon: ${M.H} steps

Trajectory:
ADE = ${m.ADE.toFixed(2)} m
FDE = ${m.FDE.toFixed(2)} m
XY RMSE = ${m.RMSE.toFixed(2)} m

Future vessel state:
Speed MAE = ${m.MAE_Speed.toFixed(3)} m/s
Heading circular MAE = ${m.MAE_Heading.toFixed(2)}°
COG circular MAE = ${m.MAE_COG.toFixed(2)}°
ROT RMSE = ${m.RMSE_ROT.toFixed(3)} °/s

Validation data are now stored in memory for:
• Export Validation Results CSV
• Export Validation Actual vs Predicted CSV

Actual future (green) and predicted future (red dashed) are shown together.`;
  setOperationStatus(`Validation completed with ${modelName.toUpperCase()} on CaseID ${cid} — ${sampleType.split(' (')[0]}: ADE ${m.ADE.toFixed(2)} m, FDE ${m.FDE.toFixed(2)} m.`,false,!sampleType.startsWith('OUT'));
}

async function forecastFuture(){
  if(!S.trajModel)throw new Error('No trajectory model in this browser session.');
  const a=selectedCase(),M=S.trajModel;
  if(a.length<M.inputLen)throw new Error(`At least ${M.inputLen} observed points are required.`);
  let modelName=selectedTrajectoryModel();
  if(modelName==='lstm'&&!M.lstm)modelName=M.gru?'gru':'kinematic';
  if(modelName==='gru'&&!M.gru)modelName=M.lstm?'lstm':'kinematic';
  const anchor=a.length-1,last=a[anchor];
  let dt=median(a.slice(1).map((r,i)=>r.Time_s-a[i].Time_s).filter(v=>v>0&&v<120))||5;
  const predRaw=await predictTrajectoryWindow(a,anchor,modelName);
  const pred=BC.applyBerthAlignmentForecast(predRaw,last);
  const riskM=riskReadiness().ok?S.riskModel:null;
  const F=BC.buildForecastRows(pred,last,dt,modelName,riskM);
  S.forecast=F;S.forecastSource=`browser ${modelName.toUpperCase()}`;
  drawTrajectory(a,null,F);renderForecastStateTable(F);
  renderForecastReport(F,{engine:'Browser session',model:modelName,inputLen:M.inputLen,H:M.H,dt,riskMode:riskM?'Hybrid':'Rule (no compatible ML risk model)'});
}
function renderForecastReport(F,info){
  const fin=v=>v.filter(Number.isFinite),last=F[F.length-1]||{};
  const n=F.filter(r=>['Warning','Critical'].includes(r.ForecastRiskFlag)).length;
  const rawClr=fin(F.map(r=>Number(r.RawSideClearanceToBerth_m))),predClr=fin(F.map(r=>Number(r.PredictedSideClearanceToBerth_m)));
  const cons=fin(F.map(r=>Math.abs(Number(r.SideClearanceConsistencyError_m)))),safe=fin(F.map(r=>Number(r.SideClearanceToBerth_m)));
  document.getElementById('trajReport').textContent=
`FUTURE COMPLETE VESSEL-STATE FORECAST
Engine: ${info.engine} | Model: ${String(info.model).toUpperCase()}
Observed input: last ${info.inputLen} steps | Horizon: ${info.H} steps (~${(info.H*info.dt).toFixed(0)} s)
Risk: ${info.riskMode}

Closest distance to berth target: ${Math.min(...F.map(r=>r.DistanceToBerth_m)).toFixed(1)} m
Final side clearance: ${Number(last.SideClearanceToBerth_m).toFixed(1)} m | final longitudinal offset ${Number(last.LongitudinalOffset_m).toFixed(1)} m
Final phase: ${last.BerthingPhase||'—'} | final berth-heading error ${Number(last.BerthHeadingError_deg||0).toFixed(1)}°
Final speed: ${Number(last.Speed_forecast_mps||0).toFixed(3)} m/s | berthing velocity ${Number(last.BerthingVelocity_mps||0).toFixed(3)} m/s
Maximum future risk: ${Math.max(...F.map(r=>r.FutureRiskScore)).toFixed(1)} | Warning/Critical points: ${n}

Geometry check of the RAW network output:
  violations ${F.filter(r=>r.GeometryViolation).length}/${F.length} | min raw side clearance ${rawClr.length?Math.min(...rawClr).toFixed(2):'N/A'} m
  min predicted side-clearance channel ${predClr.length?Math.min(...predClr).toFixed(2):'N/A'} m | mean |consistency error| ${cons.length?mean(cons).toFixed(2):'N/A'} m
  corrections applied by the shield ${F.filter(r=>r.GeometryCorrectionApplied).length} | min shielded side clearance ${safe.length?Math.min(...safe).toFixed(2):'N/A'} m

Terminal alignment layer: inside ${BC.BERTH.finalStartSideClearance_m} m side clearance the forecast is progressively
blended toward a berth-parallel (±90°) heading and a 0.10 m/s contact speed. If the RAW forecast crosses
the berth line the step is flagged GeometryViolation=TRUE and its risk is forced to Critical — a
forecast that needs many shield corrections should not be trusted.

Angle convention: ${BC.ANGLE_CONVENTION}
Only observed data up to the current point are used as model input.`;
}


const BERTH_V3417=BC.BERTH;
const {nearestBerthParallelHeading,berthHeadingError,vesselBeam,sideClearanceToBerth,longitudinalOffsetToBerth,berthPhaseFromClearance,blendAngleDeg,terminalAlignmentWeightFromClearance}=BC;
function applyBerthAlignmentForecast(states,anchorRow){return BC.applyBerthAlignmentForecast(states,anchorRow)}
function trainPolicy(){
  S.policyModel={
    type:'BeamAware-FinalBerthingAlignment-AdvisoryPolicy',appVersion:APP_VERSION,
    phases:['APPROACH','ALIGNING','FINAL BERTHING'],
    berthGeometry:{...BERTH_V3417},
    actions:[
      'Track approach speed','Decelerate','Correct COG toward berth',
      'Rotate vessel parallel to berth','Reduce side clearance',
      'Reduce lateral speed','Stabilize ROT','Hold final berth alignment'
    ],
    maxSteps:750,dt_s:5,trainedAt:new Date().toISOString()
  };
  document.getElementById('policyReport').textContent=
`BEAM-AWARE FINAL BERTHING POLICY initialized.

Geometry:
Berth line: X = ${BERTH_V3417.lineX_m} m
Vessel reference point: center of vessel
Default Beam if unavailable: ${BERTH_V3417.defaultBeam_m} m
Nominal fender clearance: ${BERTH_V3417.fenderClearance_m} m

Side clearance:
D_side = X_center - X_berth - Beam/2 - FenderClearance

BERTHING COMPLETED only when ALL conditions hold:
Side clearance <= ${BERTH_V3417.completion.sideClearance_m} m
Longitudinal offset <= ${BERTH_V3417.completion.longitudinalOffset_m} m
Heading error <= ${BERTH_V3417.completion.headingError_deg}°
Speed <= ${BERTH_V3417.completion.speed_mps} m/s
Lateral speed <= ${BERTH_V3417.completion.lateralSpeed_mps} m/s
|ROT| <= ${BERTH_V3417.completion.rot_degps} °/s

Berth-parallel headings: ±90° (angle convention: ${BC.ANGLE_CONVENTION})
The simulation starts from the latest observed state of the selected CaseID.

Advisory/simulation only; not for automatic vessel control.`;
  setOperationStatus('Final berthing alignment policy initialized.');
}
function simulatePolicy(){
  if(!S.policyModel)trainPolicy();
  const a=selectedCase();
  const start=a.length?a[a.length-1]:(S.data?.[0]||{});
  const sim=BC.simulatePolicy(start,{dt_s:5,maxSteps:750});
  const A=sim.rows;
  if(!A.length)throw new Error('Policy simulation produced no steps.');
  S.policySim=A;
  drawBerthingAlignment(document.getElementById('policyCanvas'),A);
  const last=A[A.length-1];
  document.getElementById('policyReport').textContent=
`BEAM-AWARE FINAL BERTHING SIMULATION (advisory)

Start: ${a.length?`latest observed state of CaseID ${start.CaseID} (t=${Number(start.Time_s).toFixed(0)} s)`:'default approach state (no CaseID data)'}
Result: ${sim.result}
Beam used: ${sim.beam.toFixed(2)} m | LOA ${Number(last.LOA_m).toFixed(0)} m
Final side clearance to berth: ${last.SideClearanceToBerth_m.toFixed(2)} m
Final longitudinal offset: ${last.LongitudinalOffset_m.toFixed(2)} m
Final Heading: ${last.Heading_deg.toFixed(1)}° (berth-parallel target ${last.BerthHeadingTarget_deg.toFixed(0)}°, error ${last.BerthHeadingError_deg.toFixed(2)}°)
Final COG: ${last.COG_deg.toFixed(1)}° | Heading–COG drift ${last.HeadingCOGDrift_deg.toFixed(1)}°
Final speed: ${last.Speed_mps.toFixed(3)} m/s | lateral speed ${last.LateralSpeed_mps.toFixed(3)} m/s | ROT ${last.ROT_degps.toFixed(3)} °/s
Steps: ${A.length} | simulated time ${(A.length*5/60).toFixed(1)} min

Heading changes are limited by the vessel's advisory ROT (tug-assisted below 1.2 m/s).
Completion uses the actual vessel Beam geometry rather than point-target distance.`;
  setOperationStatus(`Final berthing simulation: ${sim.result}; side clearance ${last.SideClearanceToBerth_m.toFixed(2)} m.`,false,sim.result!=='BERTHING COMPLETED');
}

function generateRecommendations(){
  if(!S.data.length)throw new Error('Load or generate data first.');
  const hasPred=S.data.some(r=>!!r.PredictedRiskLevel);
  S.data.forEach(r=>{const rec=BC.recommendationFor(r);r.RecommendationSeverity=rec.severity;r.Recommendation=rec.text;});
  refreshTable();
  const n=S.data.filter(r=>['Warning','Critical'].includes(r.RecommendationSeverity)).length;
  setOperationStatus(`Recommendations generated for ${S.data.length.toLocaleString()} rows (${n} Warning/Critical) based on ${hasPred?`Predict Risk results (${S.lastRiskRun?.mode||'—'})`:'RULE risk levels — run Predict Risk first for Hybrid results'}.`,false,!hasPred);
}


function drawAnimationFrame(){
  const a=selectedCase();
  const c=document.getElementById('animCanvas');
  if(!c || !a.length) return;

  const idx=clamp(S.anim.index,0,a.length-1);
  const track=a.slice(0,idx+1).map(r=>[r.X_m,r.Y_m]);

  // Base trajectory and berth/corridor.
  drawXY(c,track,[],true);

  // Draw current vessel marker and heading arrow over the base canvas.
  const rect=c.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  const ctx=c.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=c.width/dpr,h=c.height/dpr;

  const all=a.map(r=>[r.X_m,r.Y_m]).concat([[0,-90],[0,90],[20,0]]);
  let xs=all.map(p=>p[0]), ys=all.map(p=>p[1]);
  let xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  let px=(xmax-xmin)*.08||1,py=(ymax-ymin)*.12||1;
  xmin-=px;xmax+=px;ymin-=py;ymax+=py;
  const X=x=>40+(x-xmin)/(xmax-xmin)*(w-60);
  const Y=y=>h-30-(y-ymin)/(ymax-ymin)*(h-50);

  const r=a[idx],cx=X(r.X_m),cy=Y(r.Y_m);
  const ang=rad(r.Heading_deg);
  const L=24;
  const dx=L*Math.cos(ang),dy=-L*Math.sin(ang);

  ctx.save();
  ctx.translate(cx,cy);
  ctx.rotate(-ang);
  ctx.fillStyle='#dc2626';
  ctx.beginPath();
  ctx.moveTo(14,0);
  ctx.lineTo(-9,-7);
  ctx.lineTo(-6,0);
  ctx.lineTo(-9,7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle='#dc2626';
  ctx.lineWidth=2;
  ctx.beginPath();
  ctx.moveTo(cx,cy);
  ctx.lineTo(cx+dx,cy+dy);
  ctx.stroke();

  const risk=r.HybridRiskScore??r.RuleRiskScore;
  document.getElementById('animStatus').textContent=
    `CaseID ${r.CaseID} • step ${idx+1}/${a.length} • t=${Number(r.Time_s).toFixed(0)} s`;

  document.getElementById('animInfo').textContent =
`CaseID: ${r.CaseID}
Time: ${Number(r.Time_s).toFixed(1)} s
X: ${Number(r.X_m).toFixed(2)} m
Y: ${Number(r.Y_m).toFixed(2)} m
Speed: ${Number(r.Speed_mps).toFixed(3)} m/s
Heading: ${Number(r.Heading_deg).toFixed(2)}°
COG: ${Number(r.COG_deg).toFixed(2)}°
Heading–COG difference: ${Math.abs(wrap180(r.Heading_deg-r.COG_deg)).toFixed(2)}°
ROT: ${Number(r.ROT_degps).toFixed(3)} deg/s
Side clearance: ${Number(r.SideClearance_m).toFixed(1)} m (${r.BerthingPhase||'—'})
Approach (track) angle: ${Number(r.ApproachAngle_deg).toFixed(2)}° | berth-heading error ${Number(r.BerthHeadingError_deg).toFixed(1)}°
Lateral (transverse) speed: ${Number(r.LateralSpeed_mps).toFixed(3)} m/s
Berthing velocity (toward berth): ${Number(r.BerthingVelocity_mps).toFixed(3)} m/s${Number(r.SideClearance_m)<=BC.BERTH.alignStartSideClearance_m?` (allowed ${Number(r.AllowedBerthingVelocity_mps).toFixed(3)})`:' (limit applies inside 90 m)'}
Speed allowed at this distance: ${Number(r.AllowedSpeed_mps).toFixed(2)} m/s
Funnel deviation: ${Number(r.CorridorDeviation_m).toFixed(2)} m
Risk score: ${Number(risk).toFixed(1)} (${r.PredictedRiskLevel?r.RiskPredictionMode||'predicted':'rule'})
Risk level: ${r.PredictedRiskLevel||r.RiskLevel}${r.MainRiskCause?`\nMain cause: ${r.MainRiskCause}`:''}`;
}

function startAnimation(){
  const a=selectedCase();
  if(!a.length) return logMsg('No CaseID data available for animation.');
  const cid=Number(document.getElementById('caseSelect').value);

  if(S.anim.caseId!==cid || S.anim.index>=a.length-1){
    S.anim.index=0;
    S.anim.caseId=cid;
  }
  pauseAnimation();
  S.anim.paused=false;
  drawAnimationFrame();

  const playback=Number(document.getElementById('animSpeed').value)||5;
  let dts=[];
  for(let i=1;i<a.length;i++){
    const dt=a[i].Time_s-a[i-1].Time_s;
    if(dt>0) dts.push(dt);
  }
  const dataDt=median(dts)||5;
  const interval=Math.max(35,(dataDt*1000)/playback);

  S.anim.timer=setInterval(()=>{
    if(S.anim.paused) return;
    if(S.anim.index>=a.length-1){
      pauseAnimation();
      document.getElementById('animStatus').textContent += ' • Completed';
      return;
    }
    S.anim.index++;
    drawAnimationFrame();
  },interval);

  logMsg(`Animation started for CaseID ${cid} at ${playback}×.`);
}

function pauseAnimation(){
  S.anim.paused=true;
  if(S.anim.timer){
    clearInterval(S.anim.timer);
    S.anim.timer=null;
  }
}

function resetAnimation(){
  pauseAnimation();
  S.anim.index=0;
  S.anim.caseId=Number(document.getElementById('caseSelect').value)||null;
  drawAnimationFrame();
  const el=document.getElementById('animStatus');
  if(el) el.textContent='Ready.';
}

function changeAnimationSpeed(){
  const wasRunning=!S.anim.paused;
  if(wasRunning) startAnimation();
}


function refreshAll(){refreshCaseList();refreshDashboard();refreshTable();drawRiskPlots();resetAnimation()}
function refreshCaseList(){
  const sel=document.getElementById('caseSelect');
  if(!sel)return;
  const old=Number(sel.value);
  const ids=[...new Set(S.data.map(r=>Number(r.CaseID)).filter(Number.isFinite))].sort((a,b)=>a-b);
  sel.replaceChildren(...ids.map(x=>{const o=document.createElement('option');o.value=String(x);o.textContent=String(x);return o}));
  if(ids.includes(old)) sel.value=String(old);
  else if(ids.length) sel.value=String(ids[0]);
}
function refreshDashboard(){
  if(!S.data.length)return;
  const a=selectedCase();
  document.getElementById('kCases').textContent=new Set(S.data.map(r=>r.CaseID)).size;
  document.getElementById('kRisk').textContent=S.data.filter(r=>['Warning','Critical'].includes(r.PredictedRiskLevel||r.RiskLevel)).length.toLocaleString();
  const lbl=document.getElementById('kRiskLabel');if(lbl)lbl.textContent=S.lastRiskRun?`Warning / Critical (${S.lastRiskRun.mode==='HYBRID'?'Hybrid':'Rule-only'})`:'Warning / Critical (rule)';
  const ml=document.getElementById('kMeanRiskLabel');if(ml)ml.textContent=S.lastRiskRun?.mode==='HYBRID'?'Mean Hybrid Risk':'Mean Rule Risk';
  document.getElementById('kDQ').textContent=(100*mean(S.data.map(r=>r.DataQualityScore))).toFixed(1)+'%';
  document.getElementById('kMeanRisk').textContent=mean(S.data.map(r=>r.HybridRiskScore??r.RuleRiskScore)).toFixed(1);
  if(a.length) drawDashboard(a);
}
function refreshTable(){const div=document.getElementById('tableWrap');if(!S.data.length){div.innerHTML='<div class="note" style="padding:14px">No base trajectory data loaded. Use Generate Synthetic Data or Load CSV/XLSX Data.</div>';return}const a=selectedCase();const src=a.length?a:S.data;const cols=[...new Set(src.slice(0,50).flatMap(Object.keys))].filter(k=>!k.startsWith('_'));const rows=src.slice(0,300);div.innerHTML=`<table><thead><tr>${cols.map(c=>`<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${cols.map(c=>{const v=r[c];if(typeof v==='number')return `<td>${Number.isFinite(v)?v.toFixed(3):''}</td>`;if((c==='PredictedRiskLevel'||c==='RiskLevel'||c==='ExpertRiskLevel')&&BC.RISK_LEVELS.includes(v))return `<td><span class="badge ${v}">${v}</span></td>`;return `<td>${escapeHtml(v??'')}</td>`}).join('')}</tr>`).join('')}</tbody></table><div class="note" style="padding:8px">Showing ${rows.length} of ${src.length} rows${a.length?` for CaseID ${escapeHtml(a[0].CaseID)}`:''} (dataset: ${S.data.length.toLocaleString()} rows). Export CSV for the full table.</div>`}

function prepCanvas(c){const dpr=window.devicePixelRatio||1,rect=c.getBoundingClientRect();if(rect.width>0){c.width=Math.max(300,rect.width*dpr);c.height=Math.max(180,(parseInt(getComputedStyle(c).height)||300)*dpr)}const ctx=c.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);return {ctx,w:c.width/dpr,h:c.height/dpr}}
function drawXY(c,pts,pts2=[],berth=false){const {ctx,w,h}=prepCanvas(c);ctx.clearRect(0,0,w,h);const all=pts.concat(pts2);if(!all.length)return;let xs=all.map(p=>p[0]).concat(berth?[0,20]:[]),ys=all.map(p=>p[1]).concat(berth?[-90,90,30,-30]:[]);let xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys),px=(xmax-xmin)*.08||1,py=(ymax-ymin)*.12||1;xmin-=px;xmax+=px;ymin-=py;ymax+=py;const X=x=>40+(x-xmin)/(xmax-xmin)*(w-60),Y=y=>h-30-(y-ymin)/(ymax-ymin)*(h-50);ctx.strokeStyle='#e2e8f0';ctx.lineWidth=1;for(let i=0;i<6;i++){ctx.beginPath();ctx.moveTo(40+i*(w-60)/5,20);ctx.lineTo(40+i*(w-60)/5,h-30);ctx.stroke()}
 if(berth){ctx.strokeStyle='#111827';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(X(0),Y(-90));ctx.lineTo(X(0),Y(90));ctx.stroke();ctx.setLineDash([6,5]);ctx.strokeStyle='#94a3b8';[30,-30].forEach(v=>{ctx.beginPath();ctx.moveTo(X(xmin),Y(v));ctx.lineTo(X(xmax),Y(v));ctx.stroke()});ctx.setLineDash([]);ctx.fillStyle='#111827';ctx.beginPath();ctx.arc(X(20),Y(0),5,0,2*Math.PI);ctx.fill()}
 const path=(p,col,dash)=>{ctx.strokeStyle=col;ctx.lineWidth=2;ctx.setLineDash(dash||[]);ctx.beginPath();p.forEach((q,i)=>i?ctx.lineTo(X(q[0]),Y(q[1])):ctx.moveTo(X(q[0]),Y(q[1])));ctx.stroke();ctx.setLineDash([])};path(pts,'#2563eb');if(pts2.length)path(pts2,'#dc2626',[7,5]);
}
function drawBerthingAlignment(c,A){
  if(!A?.length)return;
  const pts=A.map(r=>[r.X_m,r.Y_m]);
  drawXY(c,pts,[],true);
  const {ctx,w,h}=prepCanvas(c);
  const xs=pts.map(p=>p[0]).concat([0,20]),ys=pts.map(p=>p[1]).concat([-90,90,30,-30]);
  let xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  const px=(xmax-xmin)*.08||1,py=(ymax-ymin)*.12||1;xmin-=px;xmax+=px;ymin-=py;ymax+=py;
  const X=x=>40+(x-xmin)/(xmax-xmin)*(w-60),Y=y=>h-30-(y-ymin)/(ymax-ymin)*(h-50);

  const last=A[A.length-1];
  const cx=X(last.X_m),cy=Y(last.Y_m);
  const scale=24;

  function arrow(angleDeg,len,stroke,label,offsetY=0){
    const a=rad(angleDeg);
    const ex=cx+len*Math.cos(a),ey=cy-len*Math.sin(a);
    ctx.strokeStyle=stroke;ctx.fillStyle=stroke;ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(ex,ey);ctx.stroke();
    const ah=7,aa=Math.atan2(ey-cy,ex-cx);
    ctx.beginPath();ctx.moveTo(ex,ey);
    ctx.lineTo(ex-ah*Math.cos(aa-.45),ey-ah*Math.sin(aa-.45));
    ctx.lineTo(ex-ah*Math.cos(aa+.45),ey-ah*Math.sin(aa+.45));
    ctx.closePath();ctx.fill();
    ctx.font='12px sans-serif';ctx.fillText(label,ex+5,ey+offsetY);
  }

  // Vessel body axis along Heading
  const hrad=rad(last.Heading_deg),L=34,B=Math.max(8,Math.min(18,(Number(last.Beam_m)||24)*.45));
  ctx.save();ctx.translate(cx,cy);ctx.rotate(-hrad);
  ctx.strokeStyle='#111827';ctx.lineWidth=2;ctx.strokeRect(-L/2,-B/2,L,B);
  ctx.restore();

  arrow(last.Heading_deg,scale,'#dc2626','Heading',-4);
  arrow(last.COG_deg,scale*.85,'#2563eb','COG',13);

  ctx.fillStyle=last.CompletionFlag?'#15803d':'#92400e';
  ctx.font='bold 12px sans-serif';
  ctx.fillText(last.CompletionFlag||last.BerthingPhase,cx+8,cy-15);
  ctx.fillStyle='#334155';ctx.font='11px sans-serif';
  if(Number.isFinite(last.SideClearanceToBerth_m)){
    ctx.fillText(`Side clearance ${last.SideClearanceToBerth_m.toFixed(1)} m`,cx+8,cy+28);
  }
}


function drawSeries(c,series,ymin=null,ymax=null){const {ctx,w,h}=prepCanvas(c);ctx.clearRect(0,0,w,h);const all=series.flatMap(s=>s.v).filter(Number.isFinite);if(!all.length)return;let lo=ymin??Math.min(...all),hi=ymax??Math.max(...all);if(hi===lo)hi=lo+1;ctx.strokeStyle='#e2e8f0';for(let i=0;i<5;i++){const y=20+i*(h-45)/4;ctx.beginPath();ctx.moveTo(35,y);ctx.lineTo(w-10,y);ctx.stroke()}const cols=['#2563eb','#059669','#dc2626','#d97706'];series.forEach((s,k)=>{ctx.strokeStyle=cols[k%cols.length];ctx.lineWidth=2;ctx.beginPath();s.v.forEach((v,i)=>{const x=35+i/(Math.max(1,s.v.length-1))*(w-50),y=h-25-(v-lo)/(hi-lo)*(h-45);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke()})}
function drawDashboard(a){drawXY(document.getElementById('mapCanvas'),a.map(r=>[r.X_m,r.Y_m]),[],true);drawSeries(document.getElementById('riskCanvas'),[{v:a.map(r=>r.HybridRiskScore??r.RuleRiskScore)}],0,100);drawSeries(document.getElementById('speedCanvas'),[{v:a.map(r=>r.Speed_mps)},{v:a.map(r=>r.BerthingVelocity_mps)},{v:a.map(r=>r.AllowedSpeed_mps)}])}
function hasHybridRiskPrediction(){
  return S.data.some(r=>!!r.PredictedRiskLevel);
}
function updateRiskPlotVisibility(){
  const grid=document.getElementById('riskPlotGrid');
  const status=document.getElementById('riskPlotStatus');
  if(!grid||!status)return;
  if(!hasHybridRiskPrediction()){
    grid.style.display='none';
    status.innerHTML=S.riskModel
      ?'<b>A Hybrid Risk Model is available, but prediction has not been run yet.</b><br>Run Predict Risk to generate the risk charts.'
      :'<b>No risk prediction yet.</b><br>Train the Hybrid Risk Model (step 6) or load a trained ZIP, then run Predict Risk. Without a model, Predict Risk runs in clearly-labelled RULE-ONLY mode.';
  }else{
    grid.style.display='grid';
    const R=S.lastRiskRun;
    status.innerHTML=R?.mode==='HYBRID'
      ?`<b>Hybrid AI prediction available</b> (${R.engine==='server'?'server approved model':'browser session model'}). Charts use PredictedRiskLevel and HybridRiskScore.`
      :'<b>RULE-ONLY prediction</b> — no compatible ML risk model was used. Charts show rule-based levels.';
  }
}
function drawRiskPlots(){
  updateRiskPlotVisibility();
  if(!hasHybridRiskPrediction()) return;

  const levels=['Normal','Caution','Warning','Critical'];
  const cnt=levels.map(l=>S.data.filter(r=>r.PredictedRiskLevel===l).length);
  drawBars(document.getElementById('riskCountCanvas'),levels,cnt);

  const ns=['SpeedCause','AngleCause','LateralCause','ROTCause','CorridorCause','EnvironmentCause'];
  const lab=['Speed','Angle','Lateral','ROT','Corridor','Environment'];

  // Weight each cause by the final risk score so the plot shows contribution to the predicted risk.
  const vals=ns.map(n=>mean(S.data.map(r=>{
    const h=Number(r.HybridRiskScore);
    const c=Number(r[n]);
    return Number.isFinite(h)&&Number.isFinite(c)?c*(h/100):NaN;
  })));
  drawBars(document.getElementById('causeCanvas'),lab,vals,0,1);
}
function drawBars(c,labels,vals,lo=0,hi=null){const {ctx,w,h}=prepCanvas(c);ctx.clearRect(0,0,w,h);hi=hi??Math.max(...vals,1);const bw=(w-60)/vals.length*.65;vals.forEach((v,i)=>{const x=45+i*(w-60)/vals.length,bh=(v-lo)/(hi-lo)*(h-60);ctx.fillStyle=['#16a34a','#f59e0b','#f97316','#dc2626','#2563eb'][i%5];ctx.fillRect(x,h-35-bh,bw,bh);ctx.fillStyle='#334155';ctx.font='11px Segoe UI';ctx.fillText(labels[i],x,h-18);ctx.fillText(Number(v).toFixed(v<2?2:0),x,h-40-bh)})}
function drawTrajectory(a,pred,F){
  const actual=finiteXYPoints((a||[]).map(r=>[r.X_m,r.Y_m]));
  const second=F
    ? finiteXYPoints(F.map(r=>[r.X_forecast_m,r.Y_forecast_m]))
    : pred
      ? finiteXYPoints(pred.map(r=>[
          Number.isFinite(Number(r.X_m))?r.X_m:r.X,
          Number.isFinite(Number(r.Y_m))?r.Y_m:r.Y
        ]))
      : [];
  drawXY(document.getElementById('trajCanvas'),actual,second,true);
  // Geometry violation details are shown in the forecast table/report; shielded XY is drawn.
}

function finiteXYPoints(points){
  return (points||[]).filter(p=>
    Array.isArray(p) &&
    p.length>=2 &&
    Number.isFinite(Number(p[0])) &&
    Number.isFinite(Number(p[1]))
  ).map(p=>[Number(p[0]),Number(p[1])]);
}

function drawTrajectoryValidation(history,actualFuture,predFuture){
  const c=document.getElementById('trajCanvas');
  const {ctx,w,h}=prepCanvas(c);ctx.clearRect(0,0,w,h);

  const hist=finiteXYPoints((history||[]).map(r=>[r.X_m,r.Y_m]));
  const act=finiteXYPoints((actualFuture||[]).map(r=>[r.X_m,r.Y_m]));
  const pred=finiteXYPoints((predFuture||[]).map(p=>Array.isArray(p)?[p[0],p[1]]:[p.X_m,p.Y_m]));

  const all=hist.concat(act).concat(pred);
  if(!all.length){
    ctx.fillStyle='#b91c1c';ctx.font='bold 14px Segoe UI';
    ctx.fillText('No finite trajectory points available for plotting.',55,55);
    return;
  }

  let xs=all.map(p=>p[0]).concat([0,20]),
      ys=all.map(p=>p[1]).concat([-90,90,30,-30]);
  let xmin=Math.min(...xs),xmax=Math.max(...xs),
      ymin=Math.min(...ys),ymax=Math.max(...ys);
  let px=(xmax-xmin)*.08||1,py=(ymax-ymin)*.12||1;
  xmin-=px;xmax+=px;ymin-=py;ymax+=py;

  const X=x=>40+(x-xmin)/(xmax-xmin)*(w-60);
  const Y=y=>h-30-(y-ymin)/(ymax-ymin)*(h-50);

  ctx.strokeStyle='#e2e8f0';ctx.lineWidth=1;
  for(let i=0;i<6;i++){
    ctx.beginPath();
    ctx.moveTo(40+i*(w-60)/5,20);
    ctx.lineTo(40+i*(w-60)/5,h-30);
    ctx.stroke();
  }

  // Berth line + corridor
  ctx.strokeStyle='#111827';ctx.lineWidth=4;
  ctx.beginPath();ctx.moveTo(X(0),Y(-90));ctx.lineTo(X(0),Y(90));ctx.stroke();

  ctx.setLineDash([6,5]);ctx.strokeStyle='#94a3b8';
  [30,-30].forEach(v=>{
    ctx.beginPath();ctx.moveTo(X(xmin),Y(v));ctx.lineTo(X(xmax),Y(v));ctx.stroke();
  });
  ctx.setLineDash([]);

  const path=(p,col,dash,lw=2)=>{
    if(!p.length)return;
    ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.setLineDash(dash||[]);
    ctx.beginPath();
    p.forEach((q,i)=>i?ctx.lineTo(X(q[0]),Y(q[1])):ctx.moveTo(X(q[0]),Y(q[1])));
    ctx.stroke();ctx.setLineDash([]);
  };
  path(hist,'#2563eb',[],2.2);
  path(act,'#059669',[],2.2);
  path(pred,'#dc2626',[7,5],2.2);

  const mark=(p,col,r=3)=>{
    ctx.fillStyle=col;
    p.forEach(q=>{
      ctx.beginPath();ctx.arc(X(q[0]),Y(q[1]),r,0,2*Math.PI);ctx.fill();
    });
  };
  mark(act,'#059669',2.8);
  mark(pred,'#dc2626',2.6);

  if(hist.length&&act.length){
    ctx.strokeStyle='#64748b';ctx.lineWidth=1.5;ctx.setLineDash([3,3]);
    ctx.beginPath();ctx.moveTo(X(hist.at(-1)[0]),Y(hist.at(-1)[1]));
    ctx.lineTo(X(act[0][0]),Y(act[0][1]));ctx.stroke();ctx.setLineDash([]);
  }
  if(hist.length&&pred.length){
    ctx.strokeStyle='#f59e0b';ctx.lineWidth=1.3;ctx.setLineDash([2,4]);
    ctx.beginPath();ctx.moveTo(X(hist.at(-1)[0]),Y(hist.at(-1)[1]));
    ctx.lineTo(X(pred[0][0]),Y(pred[0][1]));ctx.stroke();ctx.setLineDash([]);
  }

  const legend=[
    ['Observed history','#2563eb',false],
    ['Actual future','#059669',false],
    ['Predicted future','#dc2626',true]
  ];
  let lx=55,ly=28;ctx.font='12px Segoe UI';
  legend.forEach((it,i)=>{
    const yy=ly+i*18;
    ctx.strokeStyle=it[1];ctx.lineWidth=2;ctx.setLineDash(it[2]?[7,5]:[]);
    ctx.beginPath();ctx.moveTo(lx,yy);ctx.lineTo(lx+22,yy);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#334155';ctx.fillText(it[0],lx+28,yy+4);
  });

  // Diagnostics in the plot itself.
  ctx.fillStyle='#475569';ctx.font='11px Segoe UI';
  ctx.fillText(`History ${hist.length} pts | Actual ${act.length} pts | Predicted ${pred.length} pts`,55,h-10);
}


function normalizeHeaderName(s){
  return String(s??'')
    .replace(/^\uFEFF/,'')
    .trim()
    .replace(/\s+/g,'');
}
function detectDelimiter(text){
  const first=(text.replace(/^\uFEFF/,'').split(/\r?\n/).find(x=>x.trim())||'');
  const cand=[',',';','\t'];
  let best=',',score=-1;
  for(const d of cand){
    let n=0,q=false;
    for(let i=0;i<first.length;i++){
      const ch=first[i];
      if(ch==='"') q=!q;
      else if(ch===d&&!q) n++;
    }
    if(n>score){score=n;best=d}
  }
  return best;
}
function parseDelimitedLine(line,delimiter){
  const out=[];let s='',q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(q&&line[i+1]==='"'){s+='"';i++}
      else q=!q;
    }else if(ch===delimiter&&!q){
      out.push(s);s='';
    }else s+=ch;
  }
  out.push(s);
  return out;
}
function parseCSV(text){
  if(typeof text!=='string'||!text.trim()) throw new Error('CSV file is empty.');
  text=text.replace(/^\uFEFF/,'');
  const delimiter=detectDelimiter(text);
  const lines=text.split(/\r?\n/).filter((x,i)=>i===0||x.trim()!=='');
  if(lines.length<2) throw new Error('CSV must contain a header and at least one data row.');

  const rawHeaders=parseDelimitedLine(lines[0],delimiter);
  const headers=rawHeaders.map(normalizeHeaderName);
  if(headers.some(h=>!h)) throw new Error('CSV contains an empty column name.');

  const out=new Array(lines.length-1);
  for(let r=1;r<lines.length;r++){
    const a=parseDelimitedLine(lines[r],delimiter);
    const o={};
    for(let c=0;c<headers.length;c++) o[headers[c]]=a[c]??'';
    out[r-1]=o;
  }
  return out;
}
function validateBaseDataSchema(rows){
  if(!Array.isArray(rows)||!rows.length) throw new Error('No data rows were parsed.');
  const required=[
    'CaseID','Time_s','X_m','Y_m','Speed_mps','Heading_deg','COG_deg',
    'LOA_m','Beam_m','Draft_m','WindSpeed_mps','CurrentSpeed_mps','ROT_degps'
  ];
  const cols=Object.keys(rows[0]);
  const missing=required.filter(c=>!cols.includes(c));
  if(missing.length) throw new Error('Missing required columns: '+missing.join(', '));

  let invalid=0;
  const numericCols=required;
  const nCheck=Math.min(rows.length,5000);
  for(let i=0;i<nCheck;i++){
    for(const c of numericCols){
      const v=Number(rows[i][c]);
      if(!Number.isFinite(v)){invalid++;break}
    }
  }
  if(invalid>0) throw new Error(`Found ${invalid} invalid rows within the first ${nCheck} rows.`);
  return {required,cols};
}
function summarizeBaseData(rows){
  const ids=new Set(),times=[],dts=[],by={};
  rows.forEach(r=>{
    const cid=Number(r.CaseID),t=Number(r.Time_s);
    if(Number.isFinite(cid))ids.add(cid);
    if(Number.isFinite(t))times.push(t);
    (by[cid]??=[]).push(t);
  });
  Object.values(by).forEach(a=>{
    a.sort((x,y)=>x-y);
    for(let i=1;i<a.length;i++){const d=a[i]-a[i-1];if(d>0)dts.push(d)}
  });
  return {
    rows:rows.length,
    cases:ids.size,
    tmin:times.length?Math.min(...times):NaN,
    tmax:times.length?Math.max(...times):NaN,
    dt:median(dts)
  };
}
function reportLoadedFile(fileName,summary,cols){
  const el=document.getElementById('fileLoadReport');
  if(!el)return;
  el.innerHTML=
    `<b>CSV/XLSX loaded successfully</b><br>`+
    `File: ${escapeHtml(fileName)}<br>`+
    `Rows: ${summary.rows.toLocaleString()}<br>`+
    `Cases: ${summary.cases}<br>`+
    `Columns: ${cols.length}<br>`+
    `Time range: ${Number(summary.tmin).toFixed(0)}–${Number(summary.tmax).toFixed(0)} s<br>`+
    `Median dt: ${Number(summary.dt).toFixed(2)} s`;
}
async function loadFile(ev){
  const input=ev.target,f=input.files?.[0];
  if(!f)return;
  const report=document.getElementById('fileLoadReport');
  try{
    if(report)report.innerHTML=`Loading <b>${escapeHtml(f.name)}</b>...`;
    setWait('Load Base Data',`Reading ${f.name}...`,8);
    await new Promise(r=>setTimeout(r,20));

    let parsed;
    const name=f.name.toLowerCase();
    if(name.endsWith('.csv')||name.endsWith('.txt')){
      const txt=await f.text();
      setWait('Load Base Data','Parsing CSV...',30);
      await new Promise(r=>setTimeout(r,20));
      parsed=parseCSV(txt);
    }else if(name.endsWith('.xlsx')||name.endsWith('.xls')){
      if(typeof XLSX==='undefined') throw new Error('XLSX library could not load. Check internet connection or use CSV.');
      const buf=await f.arrayBuffer();
      setWait('Load Base Data','Reading first Excel sheet...',30);
      await new Promise(r=>setTimeout(r,20));
      const wb=XLSX.read(buf,{type:'array'}),ws=wb.Sheets[wb.SheetNames[0]];
      parsed=XLSX.utils.sheet_to_json(ws,{defval:'',raw:true});
      parsed=parsed.map(r=>{
        const o={};
        Object.entries(r).forEach(([k,v])=>o[normalizeHeaderName(k)]=v);
        return o;
      });
    }else{
      throw new Error('Unsupported file type. Please use CSV, XLSX or XLS.');
    }

    setWait('Load Base Data',`Validating ${parsed.length.toLocaleString()} rows...`,52);
    await new Promise(r=>setTimeout(r,20));
    const schema=validateBaseDataSchema(parsed);
    const summary=summarizeBaseData(parsed);

    // Assign new base data only after successful parsing and validation.
    // IMPORTANT:
    // Preserve already-trained / already-loaded Risk and Trajectory models.
    // Loading operational input data must NOT delete neural-network weights.
    const preservedRiskModel=S.riskModel;
    const preservedTrajModel=S.trajModel;
    const preservedPolicyModel=S.policyModel;

    S.data=parsed;S.dataSource='file';S.syntheticMeta=null;
    S.riskModel=preservedRiskModel;
    S.trajModel=preservedTrajModel;
    S.policyModel=preservedPolicyModel;
    // Synthetic labels belong to the synthetic dataset only (CaseID/Time keys would collide).
    if(S.gtSource==='synthetic'){S.groundTruth=new Map();S.gtSource='';}

    // New input invalidates only outputs derived from the previous dataset.
    S.forecast=[];
    S.validation=null;
    S.policySim=[];
    S.lastRiskRun=null;

    setWait('Load Base Data','Computing data quality and derived features...',72);
    await new Promise(r=>setTimeout(r,30));
    completeFeatures(false,false);
    mergeGroundTruthIntoData();
    updateDataReadiness();

    setWait('Load Base Data','Refreshing dashboard and table...',92);
    await new Promise(r=>setTimeout(r,20));
    refreshCaseList();
    refreshDashboard();
    refreshTable();
    drawRiskPlots();

    reportLoadedFile(f.name,summary,schema.cols);

    // Explicitly report whether the preserved model is ready to forecast this dataset.
    if(S.trajModel){
      const expectedFeatures=13;
      const inputOK=Number(S.trajModel.inputLen)>0;
      const outputOK=Array.isArray(S.trajModel.outputChannels) && S.trajModel.outputChannels.length===6;
      const tfOK=!!S.trajModel.lstm && !!S.trajModel.gru;
      const enoughRows=[...new Set(S.data.map(r=>r.CaseID))].some(cid =>
        S.data.filter(r=>r.CaseID===cid).length >= Number(S.trajModel.inputLen)
      );
      const ready=inputOK && outputOK && tfOK && enoughRows;
      updateModelLoadStatus({
        metadata:true,
        risk:!!S.riskModel,
        lstm:!!S.trajModel.lstm,
        gru:!!S.trajModel.gru,
        ready,
        note: ready
          ? `Input loaded and preserved model retained. Ready to forecast ${summary.cases} case(s).`
          : `Model retained, but input/model readiness check failed. Need ≥${S.trajModel.inputLen||20} rows per CaseID and a complete 6-channel model.`
      });
    }

    logMsg(`Loaded ${f.name}: ${summary.rows.toLocaleString()} rows, ${summary.cases} cases, Time ${summary.tmin}–${summary.tmax}s, dt≈${Number(summary.dt).toFixed(2)}s.${S.trajModel?' Loaded trajectory model preserved.':''}`);
    const rotHigh=S.data.filter(r=>Math.abs(r.ROT_degps)>3).length;
    if(rotHigh>0.05*S.data.length)logMsg(`NOTE: ${rotHigh} rows have |ROT| > 3 °/s. Check units (ROT_degps must be degrees per SECOND, AIS ROT is usually degrees per minute) and the angle convention (${BC.ANGLE_CONVENTION}).`);
    const preservedCheck=trajectoryStateIntegrity();
    if(S.trajModel && !preservedCheck.ok){
      setOperationStatus('Loaded input, but preserved trajectory model became invalid: '+preservedCheck.problems.join(' '),true);
    }
    const trReady=trajectoryReadiness();
    const riskReady=riskReadiness();
    setOperationStatus(`Input loaded: ${summary.rows} rows / ${summary.cases} case(s). Browser trajectory model: ${trReady.ok?'READY':'not ready ('+trReady.reason+')'} Browser risk model: ${riskReady.ok?'READY':'not ready ('+riskReady.reason+')'}`);
    setWait('Load Base Data','Loaded successfully.',100);
    await new Promise(r=>setTimeout(r,150));
  }catch(e){
    console.error('loadFile error',e);
    const msg=e?.message||String(e);
    if(report)report.innerHTML=`<b style="color:#b91c1c">Load failed:</b><br>${escapeHtml(msg)}`;
    setOperationStatus('Loading base data failed (previous data kept): '+msg,true);
    alert('Load CSV/XLSX Data failed:\n\n'+msg);
  }finally{
    hideWait();
    input.value='';
  }
}

function toCSV(rows){if(!rows.length)return'';const cols=[...new Set(rows.flatMap(Object.keys))].filter(k=>!k.startsWith('_'));const esc=v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};return cols.join(',')+'\n'+rows.map(r=>cols.map(c=>esc(r[c])).join(',')).join('\n')}
function download(name,text,type='text/csv'){const b=new Blob([text],{type}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

async function exportSyntheticData(){
  if(S.dataSource!=='synthetic'||!S.syntheticMeta)throw new Error('The current table is not generated synthetic data. Click "1. Generate Synthetic Data" first.');
  if(typeof JSZip==='undefined')throw new Error('JSZip is not available.');
  const base=[...BC.REQUIRED_COLUMNS,'ScenarioType'];
  const rows=S.data.map(r=>{const o={};base.forEach(k=>{o[k]=r[k]});return o;});
  const gt=S.syntheticMeta.groundTruth;
  const zip=new JSZip(),stamp=Date.now();
  zip.file('synthetic_berthing_input.csv',toCSV(rows));
  zip.file('synthetic_ground_truth_labels.csv',toCSV(gt));
  zip.file('synthetic_cases.csv',toCSV(S.syntheticMeta.cases));
  zip.file('README.txt',
`Berthing AI ${APP_VERSION} — synthetic dataset
Seed: ${S.syntheticMeta.meta.seed} | cases: ${S.syntheticMeta.cases.length} | dt: ${S.syntheticMeta.meta.dt_s} s

synthetic_berthing_input.csv      — base input (load with step 3). ScenarioType is for analysis only.
synthetic_ground_truth_labels.csv — outcome-based labels (load with step 4).
synthetic_cases.csv               — one row per case: scenario, contact velocity, design berthing velocity.

Angle convention: ${BC.ANGLE_CONVENTION}
Positions are integrated from speed/course; heading follows a rate-limited ROT model scaled by LOA.
Labels: worst outcome in the next 60 s of the noise-free simulation (contact velocity vs design,
stopping margin, funnel breach, ROT, alignment at contact), with 4 % label noise.`);
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`berthing_synthetic_dataset_${stamp}.zip`;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),30000);
  setOperationStatus(`Exported synthetic dataset ZIP: ${rows.length.toLocaleString()} input rows + ${gt.length.toLocaleString()} labels.`);
}




const MODEL_LOAD_V349={
  files:{
    metadata:null,
    lstmJson:null,
    lstmBin:null,
    gruJson:null,
    gruBin:null
  },
  metadata:null,
  lstmModel:null,
  gruModel:null,
  activated:false
};

function fileNameOrEmpty(f){return f?f.name:'EMPTY'}

function onModelSlotChanged(slot,input){
  const f=input?.files?.[0]||null;
  MODEL_LOAD_V349.files[slot]=f;
  MODEL_LOAD_V349.activated=false;
  updateModelLoadStatus({
    note:f?`${slot} selected: ${f.name}`:`${slot} cleared.`
  });
}


const DEMO_MODEL_STORE_V34161={
  lstm:'indexeddb://berthing-ai-demo-lstm',
  gru:'indexeddb://berthing-ai-demo-gru',
  metadataKey:'berthing-ai-demo-metadata'
};

function buildCurrentDemoMetadata(){
  if(!S.trajModel)throw new Error('No active trajectory model is available.');
  const M=S.trajModel;
  return {
    appVersion:APP_VERSION,
    featureSchema:BC.FEATURE_SCHEMA,
    angleConvention:BC.ANGLE_CONVENTION,
    savedAt:new Date().toISOString(),
    riskModel:S.riskModel&&BC.riskModelCompatibility(S.riskModel).ok?S.riskModel:null,
    policyModel:S.policyModel||null,
    trajModel:{
      type:M.type||'MultiState-LSTM-GRU',
      schemaVersion:M.schemaVersion||APP_VERSION,
      appVersion:M.appVersion||null,
      testCaseIds:M.testCaseIds||null,
      trainCaseIds:M.trainCaseIds||null,
      trainedAt:M.trainedAt||null,
      inputLen:Number(M.inputLen),
      H:Number(M.H),
      inputFeatureCount:13,
      targetChannelCount:6,
      expectedOutputDimension:TRAJ_TARGET_CHANNELS.length*Number(M.H),
      featureStats:M.featureStats,
      targetStats:M.targetStats,
      outputChannels:Array.isArray(M.outputChannels)&&M.outputChannels.length===6
        ?M.outputChannels:[...TRAJ_TARGET_CHANNELS],
      split:M.split||null,
      metrics:M.metrics||null,
      bestModel:M.bestModel||'gru',
      selectionScores:M.selectionScores||null,
      lossConfig:M.lossConfig||null,
      runtime:M.runtime||{}
    }
  };
}


async function persistActiveModelsToBrowserDemo({silent=false}={}){
  if(typeof tf==='undefined')throw new Error('TensorFlow.js is not available.');
  const check=trajectoryStateIntegrity();
  if(!check.ok)throw new Error('Trajectory runtime is not ready: '+check.problems.join(' '));
  if(!S.trajModel?.lstm||!S.trajModel?.gru)throw new Error('Both LSTM and GRU must be active.');

  try{await tf.io.removeModel(DEMO_MODEL_STORE_V34161.lstm);}catch(_){}
  try{await tf.io.removeModel(DEMO_MODEL_STORE_V34161.gru);}catch(_){}

  await S.trajModel.lstm.save(DEMO_MODEL_STORE_V34161.lstm);
  await S.trajModel.gru.save(DEMO_MODEL_STORE_V34161.gru);

  const metadata=buildCurrentDemoMetadata();
  localStorage.setItem(DEMO_MODEL_STORE_V34161.metadataKey,JSON.stringify(metadata));

  if(!silent){
    updateModelLoadStatus({note:'Browser demo saved successfully ✓ (6-channel model)'});
  }
  return metadata;
}

async function captureTfjsModelFiles(model,baseName){
  let captured=null;
  const handler=tf.io.withSaveHandler(async artifacts=>{
    captured=artifacts;
    return {modelArtifactsInfo:tf.io.getModelArtifactsInfoForJSON(artifacts)};
  });
  await model.save(handler);
  if(!captured)throw new Error(`Could not capture ${baseName} model artifacts.`);
  const weightsName=`${baseName}.weights.bin`;
  const modelJson={
    format:captured.format||'layers-model',
    generatedBy:captured.generatedBy||`TensorFlow.js tfjs-layers v${tf?.version?.tfjs||''}`,
    convertedBy:captured.convertedBy??null,
    modelTopology:captured.modelTopology,
    weightsManifest:[{paths:[weightsName],weights:captured.weightSpecs||[]}]
  };
  if(captured.trainingConfig!==undefined)modelJson.trainingConfig=captured.trainingConfig;
  if(captured.userDefinedMetadata!==undefined)modelJson.userDefinedMetadata=captured.userDefinedMetadata;
  if(captured.signature!==undefined)modelJson.signature=captured.signature;
  return {jsonName:`${baseName}.json`,jsonText:JSON.stringify(modelJson),binName:weightsName,binData:captured.weightData};
}

const MODEL_FILE_TAG=`v${APP_VERSION.replace(/\./g,'')}`;

/** Builds the single-ZIP trained package (metadata + LSTM JSON/BIN + GRU JSON/BIN). */
async function buildDemoZipBlob(){
  if(!S.trajModel)throw new Error('No trajectory model in this browser session. Train step 8 or load a trained ZIP first.');
  if(typeof JSZip==='undefined')throw new Error('JSZip is not available.');
  if(typeof tf==='undefined')throw new Error('TensorFlow.js is not available.');
  const check=trajectoryStateIntegrity();
  if(!check.ok)throw new Error('Trajectory model is not ready: '+check.problems.join(' '));
  const M=S.trajModel;
  setOperationStatus('Packaging trained models: capturing LSTM...');
  const lstmFiles=await captureTfjsModelFiles(M.lstm,`berthing_${MODEL_FILE_TAG}_lstm`);
  setOperationStatus('Packaging trained models: capturing GRU...');
  const gruFiles=await captureTfjsModelFiles(M.gru,`berthing_${MODEL_FILE_TAG}_gru`);
  const metadata=buildCurrentDemoMetadata();
  metadata.demoPackageType=`BerthingAI-${APP_VERSION}-SingleZIP`;
  metadata.modelFiles={lstmJson:lstmFiles.jsonName,lstmWeights:lstmFiles.binName,gruJson:gruFiles.jsonName,gruWeights:gruFiles.binName};
  const zip=new JSZip();
  zip.file('berthing_ai_demo_metadata.json',JSON.stringify(metadata,null,2));
  zip.file(lstmFiles.jsonName,lstmFiles.jsonText);
  zip.file(lstmFiles.binName,lstmFiles.binData);
  zip.file(gruFiles.jsonName,gruFiles.jsonText);
  zip.file(gruFiles.binName,gruFiles.binData);
  zip.file('README.txt',
`Berthing AI ${APP_VERSION} trained model package

Contents: metadata (+ Hybrid Risk Model if one was trained), LSTM JSON/BIN, GRU JSON/BIN.
Browser: click "Load trained demo ZIP" and select this ZIP (no extraction needed).
Server : an administrator can publish it with "Publish trained model to server" or
         deploy it as the approved model (MODEL_PATH / MODEL_URL on the backend).

Feature schema: ${BC.FEATURE_SCHEMA}
Angle convention: ${BC.ANGLE_CONVENTION}
`);
  setOperationStatus('Packaging trained models: building ZIP...');
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
  return {blob,metadata,fileName:`berthing_ai_${MODEL_FILE_TAG}_trained_${Date.now()}.zip`};
}
function downloadBlob(blob,name){
  const a=document.createElement('a'),url=URL.createObjectURL(blob);
  a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function saveTrainedModelsAsDemo(){
  try{
    const {blob,fileName,metadata}=await buildDemoZipBlob();
    downloadBlob(blob,fileName);
    try{await persistActiveModelsToBrowserDemo({silent:true});}catch(_){}
    updateModelLoadStatus({note:`Trained ZIP saved ✓ ${fileName}`});
    setOperationStatus(`Trained model ZIP saved: ${fileName} (risk model ${metadata.riskModel?'included':'not included'}). Load it later with "Load trained demo ZIP".`);
  }catch(err){
    console.error('saveTrainedModelsAsDemo',err);
    const msg=err?.message||String(err);
    setOperationStatus('Save trained ZIP failed: '+msg,true);
    alert('SAVE TRAINED MODEL ZIP FAILED\n\n'+msg);
  }
}
async function saveModels(){return saveTrainedModelsAsDemo()}

function parseVersion(v){const m=String(v||'').match(/(\d+)\.(\d+)\.(\d+)/);return m?[+m[1],+m[2],+m[3]]:null}
function versionAtLeast(v,min){const a=parseVersion(v),b=parseVersion(min);if(!a||!b)return false;for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i]}return true}
function packageVersion(pkg){return pkg?.appVersion||pkg?.version||pkg?.trajModel?.appVersion||pkg?.trajModel?.schemaVersion||''}

/** Validates trajectory metadata of a trained package (ZIP or five-slot). Returns a list of errors. */
function validateTrajMetadata(pkg){
  const errors=[];
  const M=pkg?.trajModel;
  if(!M){errors.push('Missing trajModel metadata.');return errors}
  const ver=packageVersion(pkg);
  if(!versionAtLeast(ver,'3.4.2'))errors.push(`Incompatible package version "${ver||'unknown'}". A 3.4.2 or newer multi-state package is required.`);
  if(!Number.isFinite(Number(M.inputLen))||Number(M.inputLen)<1)errors.push('Invalid inputLen.');
  if(Number(M.inputFeatureCount||13)!==13)errors.push(`Input feature count ${M.inputFeatureCount} != 13.`);
  const tc=Number(M.targetChannelCount??M.outputChannels?.length??M.targetStats?.mean?.length);
  if(tc!==6)errors.push(`Target channel count ${tc} != 6.`);
  const expected=6*Number(M.H);
  if(!Number.isFinite(expected)||expected<=0)errors.push('Invalid forecast horizon H.');
  if(!M.featureStats?.mean||M.featureStats.mean.length!==13||!M.featureStats?.std||M.featureStats.std.length!==13)errors.push('featureStats must contain 13 means and 13 stds.');
  if(!M.targetStats?.mean||M.targetStats.mean.length!==6||!M.targetStats?.std||M.targetStats.std.length!==6)errors.push('targetStats must contain 6 means and 6 stds.');
  return errors;
}
function validateLoadedTFModel(model,label,M){
  const errors=[];
  if(!model){errors.push(`${label} model missing.`);return errors;}
  const inShape=model?.inputs?.[0]?.shape||[],outShape=model?.outputs?.[0]?.shape||[];
  const expectedOut=6*Number(M.H);
  if(inShape.length<3)errors.push(`${label} input shape invalid: ${JSON.stringify(inShape)}.`);
  if(Number(inShape.at(-2))!==Number(M.inputLen))errors.push(`${label} sequence length ${inShape.at(-2)} != ${M.inputLen}.`);
  if(Number(inShape.at(-1))!==13)errors.push(`${label} input features ${inShape.at(-1)} != 13.`);
  if(Number(outShape.at(-1))!==expectedOut)errors.push(`${label} output ${outShape.at(-1)} != ${expectedOut}.`);
  const probe=tf.zeros([1,Number(M.inputLen),13]),p=model.predict(probe),po=p.shape.at(-1);probe.dispose();p.dispose();
  if(po!==expectedOut)errors.push(`${label} sanity prediction output ${po} != ${expectedOut}.`);
  return errors;
}
/** Accepts a risk model from a package only if its feature schema matches this version. */
function acceptRiskModel(pkg,sourceKind){
  const R=pkg?.riskModel||null;
  if(!R){S.riskModel=null;S.riskSource='';S.riskModelRejected='The package contains no Hybrid Risk Model.';return}
  const c=BC.riskModelCompatibility(R);
  if(c.ok){S.riskModel=R;S.riskSource=sourceKind;S.riskModelRejected='';}
  else{S.riskModel=null;S.riskSource='';S.riskModelRejected=c.reason;}
}
/** Installs LSTM/GRU + metadata as the active browser-session trajectory model. */
function activateTrajectoryPackage(pkg,lstm,gru,sourceKind,sourceName){
  const M=pkg.trajModel,old=S.trajModel;
  const ver=packageVersion(pkg);
  S.trajModel={
    type:M.type||'MultiState-LSTM-GRU',schemaVersion:M.schemaVersion||ver,appVersion:ver,trainedAt:M.trainedAt||null,
    inputLen:Number(M.inputLen),H:Number(M.H),inputFeatureCount:13,targetChannelCount:6,expectedOutputDimension:6*Number(M.H),
    featureStats:M.featureStats,targetStats:{...M.targetStats,channels:[...TRAJ_TARGET_CHANNELS]},outputChannels:[...TRAJ_TARGET_CHANNELS],
    split:M.split||null,testCaseIds:M.testCaseIds||null,trainCaseIds:M.trainCaseIds||null,metrics:M.metrics||null,
    bestModel:['lstm','gru','kinematic'].includes(String(M.bestModel).toLowerCase())?String(M.bestModel).toLowerCase():'gru',
    selectionScores:M.selectionScores||null,lossConfig:M.lossConfig||null,runtime:M.runtime||{},lstm,gru,sourceName
  };
  const check=trajectoryStateIntegrity();
  if(!check.ok){S.trajModel=old;throw new Error('Model activation failed: '+check.problems.join(' '));}
  try{if(old?.lstm&&old.lstm!==lstm)old.lstm.dispose();if(old?.gru&&old.gru!==gru)old.gru.dispose();}catch(_){}
  S.trajSource=sourceKind;
  acceptRiskModel(pkg,sourceKind);
  S.policyModel=pkg.policyModel||S.policyModel||null;
  const legacy=!versionAtLeast(ver,'3.5.0');
  document.getElementById('trajMetrics').textContent=
`TRAINED MODEL LOADED INTO THIS BROWSER SESSION
Source: ${sourceName}
Package version: ${ver||'unknown'}${legacy?'  ← trained before 3.5.0 on the previous (non-physical) synthetic generator: retraining is recommended':''}
Trajectory runtime: ACTIVE ✓ (LSTM + GRU)
Input: ${S.trajModel.inputLen} × 13 | Output: ${S.trajModel.H} × 6 = ${6*S.trajModel.H}
Best model: ${String(S.trajModel.bestModel).toUpperCase()}
Held-out test CaseIDs in metadata: ${S.trajModel.testCaseIds?S.trajModel.testCaseIds.length:'not recorded (validation sample type unknown)'}
Hybrid Risk Model: ${S.riskModel?'ACTIVE ✓':'not used — '+S.riskModelRejected}`;
  return {legacy};
}

async function loadTrainedDemo(){
  const inp=document.getElementById('demoZipInput');
  if(!inp)throw new Error('Demo ZIP input control is missing.');
  inp.value='';
  inp.click();
}
async function onDemoZipChosen(event){
  let lstm=null,gru=null;
  const file=event?.target?.files?.[0];
  try{
    if(!file)return;
    if(typeof JSZip==='undefined')throw new Error('JSZip is not available.');
    if(typeof tf==='undefined')throw new Error('TensorFlow.js is not available.');
    await tf.ready();
    setWait('Load trained demo ZIP',`Reading ${file.name}...`,10);
    const zip=await JSZip.loadAsync(file);
    const names=Object.keys(zip.files).filter(n=>!zip.files[n].dir);
    const metaName=names.find(n=>/demo_metadata\.json$/i.test(n))||names.find(n=>/metadata\.json$/i.test(n));
    if(!metaName)throw new Error('ZIP does not contain a metadata JSON.');
    const pkg=JSON.parse(await zip.file(metaName).async('string'));
    const errs=validateTrajMetadata(pkg);
    if(errs.length)throw new Error('Metadata validation failed:\n'+errs.join('\n'));
    const M=pkg.trajModel,mf=pkg.modelFiles||M.modelFiles||{};
    const findFile=(preferred,rx)=>(preferred&&zip.file(preferred))?preferred:names.find(n=>rx.test(n));
    const lj=findFile(mf.lstmJson,/lstm.*\.json$/i),lb=findFile(mf.lstmWeights,/lstm.*\.bin$/i),gj=findFile(mf.gruJson,/gru.*\.json$/i),gb=findFile(mf.gruWeights,/gru.*\.bin$/i);
    if(!lj||!lb||!gj||!gb)throw new Error('ZIP is incomplete. Required: LSTM JSON/BIN and GRU JSON/BIN.');
    const asFile=async(name,type)=>new File([await zip.file(name).async('blob')],name,{type});
    setWait('Load trained demo ZIP','Loading LSTM...',40);
    lstm=await tf.loadLayersModel(tf.io.browserFiles([await asFile(lj,'application/json'),await asFile(lb,'application/octet-stream')]));
    setWait('Load trained demo ZIP','Loading GRU...',65);
    gru=await tf.loadLayersModel(tf.io.browserFiles([await asFile(gj,'application/json'),await asFile(gb,'application/octet-stream')]));
    const e2=[...validateLoadedTFModel(lstm,'LSTM',M),...validateLoadedTFModel(gru,'GRU',M)];
    if(e2.length)throw new Error(e2.join('\n'));
    setWait('Load trained demo ZIP','Activating...',90);
    const {legacy}=activateTrajectoryPackage(pkg,lstm,gru,'browser-zip',file.name);
    try{await persistActiveModelsToBrowserDemo({silent:true});}catch(_){}
    updateModelLoadStatus({note:`Trained ZIP loaded ✓ ${file.name}`});
    setOperationStatus(`Trained ZIP loaded into this browser: trajectory ACTIVE, Hybrid Risk ${S.riskModel?'ACTIVE':'not used ('+S.riskModelRejected+')'}.${legacy?' Package predates 3.5.0 — retraining is recommended.':''}`,false,legacy||!S.riskModel);
  }catch(err){
    console.error('onDemoZipChosen',err);
    try{if(lstm&&S.trajModel?.lstm!==lstm)lstm.dispose();if(gru&&S.trajModel?.gru!==gru)gru.dispose();}catch(_){}
    const msg=err?.message||String(err);
    setOperationStatus('Load trained ZIP failed: '+msg,true);
    alert('LOAD TRAINED DEMO ZIP FAILED\n\n'+msg);
  }finally{
    hideWait();
    try{event.target.value='';}catch(_){}
  }
}

function clearModelSlots(){
  ['slotMetadata','slotLSTMJson','slotLSTMBin','slotGRUJson','slotGRUBin'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  MODEL_LOAD_V349.files={metadata:null,lstmJson:null,lstmBin:null,gruJson:null,gruBin:null};
  MODEL_LOAD_V349.metadata=null;
  MODEL_LOAD_V349.activated=false;
  updateModelLoadStatus({note:'All file slots cleared. Active models were not changed.'});
}

const SOURCE_LABEL={'browser-trained':'trained in this browser','browser-zip':'loaded from trained ZIP','browser-files':'loaded from five files'};
function updateModelLoadStatus(s={}){
  const el=document.getElementById('modelLoadStatus');
  if(!el)return;
  const f=MODEL_LOAD_V349.files,M=S.trajModel,trajOK=trajectoryStateIntegrity().ok,risk=riskReadiness();
  const slots=Object.values(f).some(Boolean)
    ?['','Five-slot loader: '+['metadata','lstmJson','lstmBin','gruJson','gruBin'].map(k=>`${k}=${f[k]?'✓':'—'}`).join(' ')]:[];
  const lines=[
    'BROWSER SESSION',
    `  Trajectory: ${trajOK?`ACTIVE ✓ (${SOURCE_LABEL[S.trajSource]||S.trajSource||'—'})`:'not loaded'}`,
    ...(trajOK?[`  Input ${M.inputLen} × 13 → output ${M.H} × 6 = ${6*M.H} | best ${String(M.bestModel).toUpperCase()}`]:[]),
    `  Hybrid Risk: ${risk.ok?`ACTIVE ✓ (${SOURCE_LABEL[S.riskSource]||S.riskSource||'—'})`:'not loaded'+(S.riskModelRejected?' — '+S.riskModelRejected:'')}`,
    '',
    'SERVER (approved model)',
    ...(typeof ServerBridge!=='undefined'?ServerBridge.statusLines():['  bridge not loaded']),
    ...slots,
    s.note?`\nNote: ${s.note}`:''
  ].filter(x=>x!==undefined);
  el.textContent=lines.join('\n').replace(/\n+$/,'');
  updateWorkflowState();
}

async function parseJSONFile(file,label){
  if(!file)throw new Error(`${label} file is not selected.`);
  try{return JSON.parse(await file.text())}
  catch(err){throw new Error(`${label} is not valid JSON: ${err?.message||err}`)}
}
async function activateLoadedModels(){
  let newLSTM=null,newGRU=null;
  const f=MODEL_LOAD_V349.files;
  try{
    const missing=[['metadata','Metadata JSON'],['lstmJson','LSTM model JSON'],['lstmBin','LSTM weights BIN'],['gruJson','GRU model JSON'],['gruBin','GRU weights BIN']].filter(([k])=>!f[k]).map(x=>x[1]);
    if(missing.length)throw new Error('Missing required file slot(s): '+missing.join(', ')+'.');
    if(typeof tf==='undefined')throw new Error('TensorFlow.js is not available.');
    await tf.ready();
    setWait('Activate Loaded Models','Validating metadata...',10);
    const pkg=await parseJSONFile(f.metadata,'Metadata JSON');
    const errs=validateTrajMetadata(pkg);
    if(errs.length)throw new Error('Metadata validation failed:\n'+errs.join('\n'));
    MODEL_LOAD_V349.metadata=pkg;
    const M=pkg.trajModel;
    for(const [k,label] of [['lstmJson','LSTM'],['gruJson','GRU']]){
      const j=await parseJSONFile(f[k],`${label} model JSON`);
      if(!j?.modelTopology||!Array.isArray(j?.weightsManifest))throw new Error(`${label} JSON is not a TensorFlow.js Layers model file.`);
    }
    setWait('Activate Loaded Models','Loading LSTM...',40);
    newLSTM=await tf.loadLayersModel(tf.io.browserFiles([f.lstmJson,f.lstmBin]));
    setWait('Activate Loaded Models','Loading GRU...',65);
    newGRU=await tf.loadLayersModel(tf.io.browserFiles([f.gruJson,f.gruBin]));
    const e2=[...validateLoadedTFModel(newLSTM,'LSTM',M),...validateLoadedTFModel(newGRU,'GRU',M)];
    if(e2.length)throw new Error(e2.join('\n'));
    const {legacy}=activateTrajectoryPackage(pkg,newLSTM,newGRU,'browser-files',f.metadata.name);
    MODEL_LOAD_V349.activated=true;
    updateModelLoadStatus({note:'Five-slot package activated ✓'});
    setOperationStatus(`Five-slot model package activated in this browser. Hybrid Risk ${S.riskModel?'ACTIVE':'not used ('+S.riskModelRejected+')'}.${legacy?' Package predates 3.5.0 — retraining is recommended.':''}`,false,legacy||!S.riskModel);
  }catch(err){
    console.error('activateLoadedModels',err);
    try{if(newLSTM&&S.trajModel?.lstm!==newLSTM)newLSTM.dispose();if(newGRU&&S.trajModel?.gru!==newGRU)newGRU.dispose();}catch(_){}
    MODEL_LOAD_V349.activated=false;
    const msg=err?.message||String(err);
    updateModelLoadStatus({note:'Activation failed: '+msg});
    setOperationStatus('Activate Loaded Models failed: '+msg,true);
    alert('ACTIVATE LOADED MODELS FAILED\n\n'+msg);
  }finally{hideWait()}
}

async function showRuntimeModelState(){
  if(typeof ServerBridge!=='undefined')await ServerBridge.refresh(false);
  updateModelLoadStatus();
  const integ=trajectoryStateIntegrity();
  const txt=
`RUNTIME MODEL STATE
${document.getElementById('modelLoadStatus').textContent}

Trajectory integrity: ${integ.ok?'OK ✓':integ.problems.join(' ')}
Operational rows: ${S.data?.length??0}
Selected case rows: ${selectedCase().length}
Inference engine setting: ${engineChoice()}`;
  document.getElementById('operationStatus').textContent=txt;
  alert(txt);
}

function exportFutureForecastCSV(){
  if(!S.forecast?.length)throw new Error('Run "Forecast Future Vessel State + Risk" before exporting the future forecast.');
  const rows=S.forecast.map((r,k)=>({Version:APP_VERSION,ForecastEngine:S.forecastSource,AngleConvention:'math deg, 0=+X, CCW',...r,HorizonStep:k+1}));
  download(`berthing_${MODEL_FILE_TAG}_future_forecast_${Date.now()}.csv`,toCSV(rows));
  setOperationStatus(`Exported future forecast CSV: ${rows.length} horizon rows.`);
}
function exportValidationResultsCSV(){
  if(!S.validation?.summary)throw new Error('Run "Validate Trajectory Models" before exporting validation results.');
  download(`berthing_${MODEL_FILE_TAG}_validation_metrics_${Date.now()}.csv`,toCSV([S.validation.summary]));
  setOperationStatus('Exported validation metrics CSV.');
}
function exportValidationActualPredictedCSV(){
  if(!S.validation?.rows?.length)throw new Error('Run "Validate Trajectory Models" before exporting Actual vs Predicted results.');
  download(`berthing_${MODEL_FILE_TAG}_validation_actual_vs_predicted_${Date.now()}.csv`,toCSV(S.validation.rows));
  setOperationStatus(`Exported Actual vs Predicted CSV: ${S.validation.rows.length} horizon rows.`);
}
function exportCSV(kind){
  let rows;
  if(kind==='policy')rows=S.policySim;
  else if(kind==='recommendations')rows=S.data.filter(r=>r.Recommendation).map(r=>({CaseID:r.CaseID,Time_s:r.Time_s,BerthingPhase:r.BerthingPhase,SideClearance_m:r.SideClearance_m,
    RuleRiskScore:r.RuleRiskScore,HybridRiskScore:r.HybridRiskScore,PredictedRiskLevel:r.PredictedRiskLevel||'',RiskPredictionMode:r.RiskPredictionMode||'not run',RiskEngine:r.RiskEngine||'',
    MainRiskCause:r.MainRiskCause,RecommendationSeverity:r.RecommendationSeverity,Recommendation:r.Recommendation}));
  else rows=S.data;
  if(!rows?.length)throw new Error(kind==='recommendations'?'Run "Generate Recommendations" first.':kind==='policy'?'Run "Simulate Final Berthing Alignment" first.':'Nothing to export.');
  const name=kind==='full'?'full_report':kind;
  download(`berthing_${MODEL_FILE_TAG}_${name}_${Date.now()}.csv`,toCSV(rows));
  setOperationStatus(`Exported ${name} CSV: ${rows.length.toLocaleString()} rows.`);
}

// ---------------------------------------------------------------- workflow gating + action dispatch
function workflowRules(){
  const hasData=S.data.length>0,localTraj=trajectoryStateIntegrity().ok;
  const sv=typeof ServerBridge!=='undefined'?ServerBridge.state:{};
  const serverTraj=!!sv.model?.loaded,eng=engineChoice();
  const trajFor=eng==='browser'?localTraj:eng==='server'?serverTraj:(localTraj||serverTraj);
  const tfOK=typeof tf!=='undefined';
  return {
    exportSynthetic:[S.dataSource==='synthetic','Generate synthetic data first (step 1).'],
    completeFeatures:[hasData,'Load or generate base data first.'],
    trainRisk:[hasData,'Load or generate base data first.'],
    predictRisk:[hasData&&(eng!=='server'||sv.reachable),hasData?'Server is not reachable — choose another inference engine.':'Load or generate base data first.'],
    trainTrajectory:[hasData&&tfOK,tfOK?'Load or generate base data first.':'TensorFlow.js failed to load (internet required).'],
    validateTrajectory:[hasData&&localTraj,'Needs data and a trajectory model in this browser (train step 8 or load a trained ZIP).'],
    forecastFuture:[hasData&&trajFor,!hasData?'Load or generate base data first.':eng==='server'?'The server has no approved trajectory model.':'No trajectory model: train step 8, load a trained ZIP, or use a server with an approved model.'],
    exportForecast:[S.forecast.length>0,'Run Forecast (step 10) first.'],
    exportValidation:[!!S.validation,'Run Validate (step 9) first.'],
    exportValidationAvP:[!!S.validation,'Run Validate (step 9) first.'],
    recommendations:[hasData,'Load or generate base data first.'],
    exportRecommendations:[S.data.some(r=>r.Recommendation),'Generate recommendations (step 16) first.'],
    exportPolicy:[S.policySim.length>0,'Run the berthing simulation (step 15) first.'],
    exportFull:[hasData,'Load or generate base data first.'],
    saveDemo:[localTraj,'No trajectory model in this browser session.'],
    saveModels:[localTraj,'No trajectory model in this browser session.'],
    publishServer:[localTraj&&!!sv.reachable,!localTraj?'No trajectory model in this browser session.':'Server is not reachable.'],
  };
}
function updateWorkflowState(){
  if(typeof document==='undefined')return;
  const rules=workflowRules(),busy=S.trajTraining.running;
  document.querySelectorAll('[data-action]').forEach(b=>{
    const r=rules[b.dataset.action];
    const ok=r?r[0]:true;
    b.disabled=busy&&b.dataset.action!=='cancelTraining'?true:!ok;
    if(r&&!ok)b.title=r[1];else b.removeAttribute('title');
  });
  const ind=document.getElementById('engineIndicator');
  if(ind){
    const sv=typeof ServerBridge!=='undefined'?ServerBridge.state:{};
    const loc=trajectoryStateIntegrity().ok||riskReadiness().ok;
    const eng=engineChoice();
    ind.textContent=eng==='browser'?'Browser session models only':eng==='server'?`Server approved model${sv.model?.loaded?'':' (none loaded)'}`
      :loc?'Auto → browser session models':sv.model?.loaded?'Auto → server approved model':'Auto → no ML model yet (risk = rule only)';
  }
}

const ACTIONS={
  generateSynthetic:()=>runWithWait('Generate Synthetic Data',['Simulating 250 berthing manoeuvres...'],async()=>{await new Promise(r=>setTimeout(r,30));generateSynthetic();}),
  exportSynthetic:()=>exportSyntheticData(),
  loadBaseFile:()=>document.getElementById('fileInput').click(),
  loadGroundTruth:()=>document.getElementById('labelInput').click(),
  completeFeatures:()=>completeFeatures(true),
  trainRisk:()=>runWithWait('Train Hybrid Risk Model',['Preparing labels and case split...'],()=>trainRisk()),
  predictRisk:()=>safePredictRisk(),
  trainTrajectory:()=>runWithWait('Train Multi-State LSTM/GRU',['Preparing multi-state sequences...'],()=>trainTrajectory()),
  validateTrajectory:()=>runWithWait('Validate Trajectory Models',['Running hold-out window...'],()=>validateTrajectory()),
  forecastFuture:()=>safeForecastFuture(),
  exportForecast:()=>exportFutureForecastCSV(),
  exportValidation:()=>exportValidationResultsCSV(),
  exportValidationAvP:()=>exportValidationActualPredictedCSV(),
  initPolicy:()=>runWithWait('Initialize Final Berthing Alignment Policy',['Applying safety constraints...'],()=>Promise.resolve(trainPolicy())),
  simulatePolicy:()=>simulatePolicy(),
  recommendations:()=>generateRecommendations(),
  exportRecommendations:()=>exportCSV('recommendations'),
  exportPolicy:()=>exportCSV('policy'),
  exportFull:()=>exportCSV('full'),
  saveDemo:()=>saveTrainedModelsAsDemo(),
  loadDemo:()=>loadTrainedDemo(),
  publishServer:()=>ServerBridge.publishModel(),
  saveModels:()=>saveModels(),
  activateLoadedModels:()=>activateLoadedModels(),
  clearModelSlots:()=>clearModelSlots(),
  showRuntimeModelState:()=>showRuntimeModelState(),
  checkServer:()=>ServerBridge.refresh(true),
  cancelTraining:()=>cancelTrajectoryTraining(),
  tab:(b)=>showTab(b.dataset.tab,b),
  animStart:()=>startAnimation(),
  animPause:()=>pauseAnimation(),
  animReset:()=>resetAnimation(),
};
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-action]');
  if(!b||b.disabled)return;
  const fn=ACTIONS[b.dataset.action];
  if(!fn)return;
  try{await fn(b)}
  catch(err){
    console.error(b.dataset.action,err);
    const msg=err?.message||String(err);
    setOperationStatus(`${b.textContent.trim()} failed: ${msg}`,true);
    alert(`${b.textContent.trim()} failed:\n\n${msg}`);
  }finally{updateWorkflowState()}
});
function bindInputs(){
  const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn)};
  on('fileInput','change',loadFile);
  on('labelInput','change',loadGroundTruth);
  on('demoZipInput','change',onDemoZipChosen);
  [['slotMetadata','metadata'],['slotLSTMJson','lstmJson'],['slotLSTMBin','lstmBin'],['slotGRUJson','gruJson'],['slotGRUBin','gruBin']]
    .forEach(([id,slot])=>on(id,'change',e=>onModelSlotChanged(slot,e.target)));
  on('caseSelect','change',()=>{refreshDashboard();refreshTable();resetAnimation();updateWorkflowState();});
  on('animSpeed','change',changeAnimationSpeed);
  on('engineSelect','change',()=>{updateWorkflowState();logMsg(`Inference engine set to: ${engineChoice()}.`)});
}

function selfCheck(){
  const requiredFns=['selectedCase','refreshDashboard','refreshTable','completeFeatures','loadFile','loadGroundTruth','trainRisk','safePredictRisk',
    'trainTrajectory','validateTrajectory','forecastFuture','safeForecastFuture','buildDemoZipBlob','activateLoadedModels','onModelSlotChanged',
    'clearModelSlots','showRuntimeModelState','exportFutureForecastCSV','exportValidationResultsCSV','exportValidationActualPredictedCSV','updateWorkflowState'];
  const missing=requiredFns.filter(n=>typeof window[n]!=='function');
  const problems=[];
  if(missing.length)problems.push('missing functions: '+missing.join(', '));
  if(!BC)problems.push('berthing-core.js not loaded');
  const htmlVer=document.documentElement.dataset.appVersion;
  if(htmlVer&&htmlVer!==APP_VERSION)problems.push(`index.html is ${htmlVer} but berthing-core.js is ${APP_VERSION} (stale cache?)`);
  if(problems.length){console.error('Self-check:',problems);logMsg('SELF-CHECK ERROR: '+problems.join('; '));}
  else console.log(`Berthing AI ${APP_VERSION} self-check OK`);
}

window.addEventListener('resize',()=>{if(S.data.length)refreshDashboard()});
bindInputs();
document.querySelectorAll('.app-version').forEach(el=>{el.textContent=APP_VERSION});
updateDataReadiness();updateModelLoadStatus();selfCheck();
logMsg(`Berthing AI ${APP_VERSION} initialized. Load or generate base trajectory data to begin. Models trained in this browser are used immediately; the server is used only for its approved model.`);
