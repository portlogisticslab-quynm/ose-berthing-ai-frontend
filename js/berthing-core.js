/*!
 * Berthing AI Advisory System — shared core (browser + Node.js backend)
 * Version 3.5.0 — © 2026 portlogistics.vn
 *
 * This single file is loaded by the browser UI (window.BerthingCore) and by the
 * Node.js backend (require('./berthing-core')). Every physical definition, derived
 * feature, rule-risk formula, hybrid-risk inference step, geometry shield and the
 * synthetic-data generator live here, so frontend and backend can never drift apart.
 *
 * COORDINATE / ANGLE CONVENTION (used everywhere in this system)
 *   - Local berth frame in metres. Berth face is the line X = 0; water side is X > 0.
 *   - Target berth position is Y = 0 (centre of the berth).
 *   - Angles are MATHEMATICAL degrees: 0° = +X (pointing away from the berth, seaward),
 *     90° = +Y, counter-clockwise positive, always reported in (-180, 180].
 *     A vessel moving straight toward the berth has COG = 180°.
 *     A vessel lying parallel to the berth has Heading = +90° or -90°.
 *   - Positive ROT = counter-clockwise turn (deg/s).
 *   This is NOT the nautical convention (0° = North, clockwise). Convert real AIS data
 *   into this local berth frame before loading it.
 *
 * Advisory / research / teaching prototype only. Not for automatic vessel control.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BerthingCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '3.6.5';
  /** Semantic version of the derived features / rule-risk definitions. Risk models trained
   *  with a different FEATURE_SCHEMA must be retrained (their inputs mean something else). */
  const FEATURE_SCHEMA = '3.5';
  const ANGLE_CONVENTION = 'math-deg: 0=+X (seaward), 90=+Y, CCW positive, range (-180,180]; berth face X=0';

  const BERTH = Object.freeze({
    lineX_m: 0,
    targetY_m: 0,
    defaultBeam_m: 24,
    fenderClearance_m: 1.0,
    parallelHeadings_deg: Object.freeze([90, -90]),
    alignStartSideClearance_m: 90,
    finalStartSideClearance_m: 35,
    corridorHalfWidth_m: 30,
    completion: Object.freeze({
      sideClearance_m: 1.5, longitudinalOffset_m: 8, headingError_deg: 5,
      speed_mps: 0.25, lateralSpeed_mps: 0.10, rot_degps: 0.20,
    }),
  });

  const RISK_LEVELS = Object.freeze(['Normal', 'Caution', 'Warning', 'Critical']);
  const RULE_THRESHOLDS = Object.freeze({ t1: 45, t2: 65, t3: 82 });

  const REQUIRED_COLUMNS = Object.freeze([
    'CaseID', 'Time_s', 'X_m', 'Y_m', 'Speed_mps', 'Heading_deg', 'COG_deg',
    'LOA_m', 'Beam_m', 'Draft_m', 'WindSpeed_mps', 'CurrentSpeed_mps', 'ROT_degps',
  ]);

  /** Inputs of the Random-Forest / Gradient-Boosting risk model (schema 3.5). */
  const RISK_FEATURES = Object.freeze([
    'Speed_mps', 'SpeedExcess_mps', 'ApproachAngle_deg', 'BerthHeadingError_deg',
    'LateralSpeed_mps', 'BerthingVelocity_mps', 'AbsROT_degps', 'SideClearance_m',
    'CorridorDeviation_m', 'WindSpeed_mps', 'CurrentSpeed_mps', 'LOA_m', 'Beam_m',
    'Draft_m', 'DataQualityScore',
  ]);

  const CAUSE_KEYS = Object.freeze(['SpeedCause', 'AngleCause', 'LateralCause', 'ROTCause', 'CorridorCause', 'EnvironmentCause']);
  const CAUSE_NAMES = Object.freeze({
    SpeedCause: 'Speed too high for distance to berth',
    AngleCause: 'Approach angle / berth alignment',
    LateralCause: 'Lateral / berthing velocity',
    ROTCause: 'Heading / ROT instability',
    CorridorCause: 'Corridor deviation',
    EnvironmentCause: 'Wind / current',
  });

  /** Trajectory network I/O schema (unchanged since 3.4.21, so trained LSTM/GRU stay loadable). */
  const TRAJ_INPUT_FEATURES = Object.freeze(['X_m', 'Y_m', 'Speed_mps', 'sinHeading', 'cosHeading', 'sinCOG', 'cosCOG', 'ROT_degps', 'WindSpeed_mps', 'CurrentSpeed_mps', 'LOA_m', 'Beam_m', 'Draft_m']);
  const TRAJ_TARGET_CHANNELS = Object.freeze(['DeltaX_m', 'DeltaY_m', 'Speed_mps', 'DeltaHeadingStep_deg', 'DeltaCOGStep_deg', 'SideClearanceToBerth_m']);

  // ------------------------------------------------------------------ math helpers
  const rad = (x) => x * Math.PI / 180;
  const deg = (x) => x * 180 / Math.PI;
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function wrap180(a) { a = Number(a); if (!Number.isFinite(a)) return NaN; a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; }
  function angle360(a) { a = Number(a) || 0; return ((a % 360) + 360) % 360; }
  function circAbsErr(a, b) { return Math.abs(wrap180(Number(a) - Number(b))); }
  function num(v, d = NaN) { const x = Number(v); return Number.isFinite(x) ? x : d; }
  function mean(a) { const b = a.filter(Number.isFinite); return b.length ? b.reduce((x, y) => x + y, 0) / b.length : NaN; }
  function median(a) { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return NaN; const m = Math.floor(b.length / 2); return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
  function blendAngleDeg(a, b, w) {
    const ar = rad(a), br = rad(b);
    const x = (1 - w) * Math.cos(ar) + w * Math.cos(br), y = (1 - w) * Math.sin(ar) + w * Math.sin(br);
    return wrap180(deg(Math.atan2(y, x)));
  }
  /** Deterministic PRNG (mulberry32). */
  function makeRng(seed) {
    let a = (Number(seed) >>> 0) || 0x9e3779b9;
    const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    rnd.normal = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    rnd.uniform = (lo, hi) => lo + (hi - lo) * rnd();
    return rnd;
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------------ berth geometry
  function vesselBeam(r) { const b = Number(r?.Beam_m); return Number.isFinite(b) && b > 0 ? b : BERTH.defaultBeam_m; }
  function contactCenterX(beam) { return BERTH.lineX_m + Number(beam) / 2 + BERTH.fenderClearance_m; }
  function sideClearanceToBerth(x, beam) { return Number(x) - BERTH.lineX_m - Number(beam) / 2 - BERTH.fenderClearance_m; }
  function longitudinalOffsetToBerth(y) { return Math.abs(Number(y) - BERTH.targetY_m); }
  function berthHeadingError(h) { return Math.min(...BERTH.parallelHeadings_deg.map((b) => circAbsErr(h, b))); }
  function nearestBerthParallelHeading(h) { return BERTH.parallelHeadings_deg.slice().sort((x, y) => circAbsErr(x, h) - circAbsErr(y, h))[0]; }
  function berthPhaseFromClearance(d) {
    if (d <= BERTH.finalStartSideClearance_m) return 'FINAL BERTHING';
    if (d <= BERTH.alignStartSideClearance_m) return 'ALIGNING';
    return 'APPROACH';
  }
  function terminalAlignmentWeightFromClearance(d) {
    d = Number(d);
    if (d >= BERTH.alignStartSideClearance_m) return 0;
    if (d <= BERTH.completion.sideClearance_m) return 1;
    return clamp((BERTH.alignStartSideClearance_m - d) / (BERTH.alignStartSideClearance_m - BERTH.completion.sideClearance_m), 0, 1);
  }

  // ------------------------------------------------------------------ vessel limits
  /** Advisory operating limits that scale with vessel size (simplified, PIANC-style ranges). */
  function vesselLimits(row) {
    const loa = num(row?.LOA_m, 180);
    const designBerthingVelocity_mps = loa >= 300 ? 0.10 : loa >= 200 ? 0.12 : 0.15;
    const maxROT_degps = loa >= 300 ? 0.30 : loa >= 200 ? 0.40 : 0.60;
    const brakingDecel_mps2 = loa >= 300 ? 0.010 : loa >= 200 ? 0.014 : 0.020;
    const tugROT_degps = loa >= 300 ? 0.25 : loa >= 200 ? 0.35 : 0.50;
    return { LOA_m: loa, designBerthingVelocity_mps, maxROT_degps, brakingDecel_mps2, tugROT_degps };
  }
  /** Maximum advisable speed over ground as a function of side clearance d (m). */
  function allowedSpeed(d) { return 0.25 + 2.1 * Math.pow(clamp((Number(d) - 30) / 850, 0, 1), 0.65); }
  /** Half-width of the approach funnel: 30 m in the final berthing zone, widening seaward. */
  function corridorHalfWidth(d) { return BERTH.corridorHalfWidth_m + 0.20 * Math.max(0, Number(d) - BERTH.finalStartSideClearance_m); }
  /** Maximum advisable berthing (normal-to-berth) velocity as a function of side clearance d (m). */
  function allowedBerthingVelocity(d, lim) { return lim.designBerthingVelocity_mps + 0.008 * Math.max(0, Number(d)); }

  // ------------------------------------------------------------------ derived features + rule risk
  function computeRowFeatures(r) {
    const beam = vesselBeam(r), lim = vesselLimits(r);
    const d = sideClearanceToBerth(r.X_m, beam), dPos = Math.max(0, d);
    const cX = contactCenterX(beam);
    r.SideClearance_m = d;
    r.LongitudinalOffset_m = longitudinalOffsetToBerth(r.Y_m);
    r.DistanceToBerth_m = Math.hypot(dPos, r.Y_m - BERTH.targetY_m);
    r.BerthingPhase = berthPhaseFromClearance(d);
    const bearing = deg(Math.atan2(BERTH.targetY_m - r.Y_m, cX - r.X_m));
    const trackDir = r.Speed_mps >= 0.3 ? r.COG_deg : r.Heading_deg;
    r.ApproachAngle_deg = circAbsErr(trackDir, bearing);
    r.BerthHeadingError_deg = berthHeadingError(r.Heading_deg);
    const drift = rad(wrap180(r.COG_deg - r.Heading_deg));
    r.LateralSpeed_mps = r.Speed_mps * Math.abs(Math.sin(drift));
    r.LongitudinalSpeed_mps = r.Speed_mps * Math.abs(Math.cos(drift));
    r.BerthingVelocity_mps = Math.max(0, -r.Speed_mps * Math.cos(rad(r.COG_deg)));
    r.AbsROT_degps = Math.abs(r.ROT_degps);
    r.SafetyCorridorY_m = Math.abs(r.Y_m - BERTH.targetY_m);
    r.CorridorHalfWidth_m = corridorHalfWidth(dPos);
    r.CorridorDeviation_m = Math.max(0, r.SafetyCorridorY_m - r.CorridorHalfWidth_m);
    r.AllowedSpeed_mps = allowedSpeed(dPos);
    r.SpeedExcess_mps = r.Speed_mps - r.AllowedSpeed_mps;
    r.AllowedBerthingVelocity_mps = allowedBerthingVelocity(dPos, lim);
    r.DesignBerthingVelocity_mps = lim.designBerthingVelocity_mps;
    r.MaxROT_degps = lim.maxROT_degps;

    // --- risk causes (0..1)
    r.SpeedCause = clamp((r.Speed_mps - r.AllowedSpeed_mps) / (0.4 * r.AllowedSpeed_mps + 0.15), 0, 1);
    const trackCause = (dPos > BERTH.finalStartSideClearance_m && r.Speed_mps >= 0.3) ? clamp((r.ApproachAngle_deg - 12) / 30, 0, 1) : 0;
    const allowedHeadingErr = 5 + 85 * clamp((dPos - 25) / 110, 0, 1);
    const alignCause = dPos < 150 ? clamp((r.BerthHeadingError_deg - allowedHeadingErr) / 20, 0, 1) : 0;
    r.AngleCause = Math.max(trackCause, alignCause);
    r.LateralCause = dPos <= BERTH.alignStartSideClearance_m
      ? clamp((r.BerthingVelocity_mps - r.AllowedBerthingVelocity_mps) / (2 * lim.designBerthingVelocity_mps), 0, 1)
      : clamp((r.LateralSpeed_mps - 0.30) / 0.60, 0, 1);
    r.ROTCause = clamp((r.AbsROT_degps - lim.maxROT_degps) / lim.maxROT_degps, 0, 1);
    r.CorridorCause = clamp(r.CorridorDeviation_m / 60, 0, 1);
    r.EnvironmentCause = clamp(0.05 * num(r.WindSpeed_mps, 0) + 0.4 * num(r.CurrentSpeed_mps, 0), 0, 1);

    const weighted = 0.25 * r.SpeedCause + 0.22 * r.AngleCause + 0.23 * r.LateralCause + 0.12 * r.ROTCause + 0.12 * r.CorridorCause + 0.06 * r.EnvironmentCause;
    const kinematicPeak = 0.88 * Math.max(r.SpeedCause * (dPos < 300 ? 1 : 0.75), r.LateralCause * (dPos <= BERTH.finalStartSideClearance_m ? 1 : 0.75));
    const geometricPeak = 0.72 * Math.max(r.AngleCause, r.ROTCause, r.CorridorCause);
    r.RuleRiskScore = clamp(100 * Math.max(weighted, kinematicPeak, geometricPeak), 0, 100);
    r.RiskScore = r.RuleRiskScore / 100;
    r.RiskLevel = RISK_LEVELS[classFromThresholds(r.RuleRiskScore, RULE_THRESHOLDS)];
    r.MainRiskCause = mainRiskCause(r);
    return r;
  }
  function mainRiskCause(r) {
    let best = null, bestV = 0;
    for (const k of CAUSE_KEYS) { const v = Number(r[k]) || 0; if (v > bestV) { bestV = v; best = k; } }
    return best && bestV >= 0.05 ? CAUSE_NAMES[best] : '';
  }

  /**
   * Normalise numeric columns, derive ROT where missing, compute data quality and all
   * derived features + rule risk. Mutates the row objects in place and returns them.
   * Provided ROT_degps values are kept (AIS/ECDIS ROT); only missing ROT is derived.
   */
  function completeFeatures(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows || [];
    const byCase = new Map();
    for (const r of rows) {
      r.CaseID = num(r.CaseID, 1); r.Time_s = num(r.Time_s, 0);
      r.X_m = num(r.X_m); r.Y_m = num(r.Y_m); r.Speed_mps = num(r.Speed_mps);
      r.Heading_deg = wrap180(num(r.Heading_deg)); r.COG_deg = wrap180(num(r.COG_deg, r.Heading_deg));
      const rot = num(r.ROT_degps, NaN);
      r._rotProvided = Number.isFinite(rot); r.ROT_degps = rot;
      r.LOA_m = num(r.LOA_m, 180); r.Beam_m = num(r.Beam_m, 30); r.Draft_m = num(r.Draft_m, 10);
      r.WindSpeed_mps = num(r.WindSpeed_mps, 0); r.CurrentSpeed_mps = num(r.CurrentSpeed_mps, 0);
      if (!byCase.has(r.CaseID)) byCase.set(r.CaseID, []);
      byCase.get(r.CaseID).push(r);
    }
    for (const arr of byCase.values()) {
      arr.sort((a, b) => a.Time_s - b.Time_s);
      const dts = [];
      for (let i = 1; i < arr.length; i++) if (arr[i].Time_s > arr[i - 1].Time_s) dts.push(arr[i].Time_s - arr[i - 1].Time_s);
      const md = median(dts) || 5;
      arr.forEach((r, i) => {
        if (!r._rotProvided) {
          const dt = i ? Math.max(1e-9, r.Time_s - arr[i - 1].Time_s) : md;
          r.ROT_degps = i ? wrap180(r.Heading_deg - arr[i - 1].Heading_deg) / dt : 0;
          r.ROTSource = 'Derived from Heading difference';
        } else r.ROTSource = 'Input';
        // data quality
        const miss = [r.X_m, r.Y_m, r.Speed_mps, r.Heading_deg].filter((x) => !Number.isFinite(x)).length / 4;
        const speedBad = (r.Speed_mps < 0 || r.Speed_mps > 8) ? 1 : 0;
        let jump = 0, inconsistent = 0;
        if (i) {
          const p = arr[i - 1], dt = r.Time_s - p.Time_s;
          const ds = Math.hypot(r.X_m - p.X_m, r.Y_m - p.Y_m);
          if (ds > 80) jump = 1;
          if (dt > 0 && dt <= 30) {
            const vxy = ds / dt, vRef = 0.5 * (r.Speed_mps + p.Speed_mps);
            if (Math.abs(vxy - vRef) > Math.max(0.4, 0.6 * vRef)) inconsistent = 1;
          }
        }
        r._jumpBad = jump;
        r.DataQualityScore = clamp(1 - 0.45 * miss - 0.25 * speedBad - 0.15 * jump - 0.10 * inconsistent, 0, 1);
        r.DataQualityFlag = r.DataQualityScore < 0.5 ? 'Poor' : r.DataQualityScore < 0.8 ? 'Check' : 'OK';
        computeRowFeatures(r);
      });
    }
    for (const r of rows) delete r._rotProvided;
    return rows;
  }

  // ------------------------------------------------------------------ hybrid risk inference
  function featureList(M) { return Array.isArray(M?.features) && M.features.length ? M.features : RISK_FEATURES; }
  function featureVector(r, stats, features = RISK_FEATURES) {
    return features.map((k, i) => { let v = Number(r[k]); if (!Number.isFinite(v)) v = stats.mean[i]; return (v - stats.mean[i]) / (stats.std[i] || 1); });
  }
  function treePredict(t, x) { while (!t.leaf) t = x[t.f] <= t.th ? t.left : t.right; return t.pred; }
  function rfProba(model, x) { const c = [0, 0, 0, 0]; model.trees.forEach((t) => c[treePredict(t, x)]++); return c.map((v) => v / model.trees.length); }
  function gbPredict(model, x) { let p = model.base; model.stumps.forEach((st) => { p += model.learningRate * (x[st.f] <= st.th ? st.lv : st.rv); }); return clamp(p, 0, 3); }
  function softClassProb(v, temp = 0.55) { const a = [0, 1, 2, 3].map((k) => Math.exp(-Math.abs(v - k) / temp)), s = a.reduce((x, y) => x + y, 0); return a.map((x) => x / s); }
  function rawMLProb(r, M) {
    const x = featureVector(r, M.featureStats, featureList(M)), p1 = rfProba(M.randomForest, x), p2 = softClassProb(gbPredict(M.gradientBoosting, x));
    const p = p1.map((v, k) => 0.55 * v + 0.45 * p2[k]), s = p.reduce((a, b) => a + b, 0) || 1;
    return p.map((v) => v / s);
  }
  function applyPlatt(m, s) { const z = clamp(m.A * s + m.B, -30, 30); return 1 / (1 + Math.exp(-z)); }
  function applyIsotonic(m, s) { if (!m.blocks?.length) return s; let best = m.blocks[0]; for (const b of m.blocks) { best = b; if (s <= b.hi) break; } return best.p; }
  function calibratedProb(cal, raw) {
    if (!cal) return raw;
    // Probability floor keeps log-loss finite when a one-vs-rest calibrator becomes very sharp.
    const p = raw.map((s, k) => clamp(cal.method === 'isotonic' ? applyIsotonic(cal.models[k], s) : applyPlatt(cal.models[k], s), 1e-4, 1 - 1e-4));
    const sum = p.reduce((a, b) => a + b, 0) || 1;
    return p.map((v) => v / sum);
  }
  function expectedRiskClassFromProb(p) { return p.reduce((s, v, k) => s + k * v, 0); }
  function ordinalClass(score, thr) { return score < thr.t1 ? 0 : score < thr.t2 ? 1 : score < thr.t3 ? 2 : 3; }
  function classFromThresholds(score, thr) {
    const s = Number(score), t1 = Number(thr?.t1 ?? 45), t2 = Number(thr?.t2 ?? 65), t3 = Number(thr?.t3 ?? 82);
    return s >= t3 ? 3 : s >= t2 ? 2 : s >= t1 ? 1 : 0;
  }
  function hybridThresholds(M) {
    const t = M?.hybridThresholds;
    if (t && [t.t1, t.t2, t.t3].every((v) => Number.isFinite(Number(v)))) return t;
    return { ...RULE_THRESHOLDS, source: 'fixed-default' };
  }
  function hybridRiskClass(h, mlOrdinalClass, p, rule, thr) {
    let c = classFromThresholds(h, thr);
    const pWarn = Number(p?.[2] || 0), pCrit = Number(p?.[3] || 0);
    if (c < 2 && mlOrdinalClass >= 2 && (pWarn + pCrit) >= 0.78 && rule >= thr.t2) c = 2;
    const critSupport = Math.max(thr.t2, thr.t3 - 2);
    if (c < 3 && mlOrdinalClass === 3 && pCrit >= 0.82 && rule >= thr.t3 && h >= critSupport) c = 3;
    return c;
  }
  /** Is this risk model usable with the current feature definitions? */
  function riskModelCompatibility(M) {
    if (!M) return { ok: false, reason: 'No risk model.' };
    if (!M.featureStats?.mean || !M.randomForest?.trees || !M.gradientBoosting?.stumps) return { ok: false, reason: 'Risk model metadata/trees are incomplete.' };
    if (String(M.featureSchema || '') !== FEATURE_SCHEMA)
      return { ok: false, reason: `Risk model uses feature schema "${M.featureSchema || 'pre-3.5'}"; this version requires "${FEATURE_SCHEMA}". Retrain the Hybrid Risk Model.` };
    if (featureList(M).length !== M.featureStats.mean.length) return { ok: false, reason: 'Risk model feature list and statistics do not match.' };
    return { ok: true };
  }
  /** Hybrid (rule + calibrated ML) risk for one featured row. Without a compatible model → rule only. */
  function hybridRisk(r, M) {
    const rule = Number(r.RuleRiskScore);
    if (!M || !riskModelCompatibility(M).ok) {
      return { score: rule, level: RISK_LEVELS[classFromThresholds(rule, RULE_THRESHOLDS)], mode: 'RULE-ONLY', prob: null, mlScore: NaN, ruleWeight: 1 };
    }
    const p = calibratedProb(M.calibration, rawMLProb(r, M));
    const expected = expectedRiskClassFromProb(p), mlScore = 100 * expected / 3;
    const mlc = ordinalClass(expected, M.ordinalThresholds || { t1: 0.75, t2: 1.4, t3: 2.0 });
    const F = M.fusion || {};
    const q = Number.isFinite(Number(r.DataQualityScore)) ? Number(r.DataQualityScore) : 1;
    const rw = Math.min(F.maxRuleWeight ?? 0.90, (F.ruleBaseWeight ?? 0.42) + (F.poorQualityBoost ?? 0.35) * (q < 0.75) + (F.criticalRuleBoost ?? 0.20) * (rule >= 82));
    let h = rw * rule + (1 - rw) * mlScore;
    if (q < 0.5) h = Math.max(h, rule);
    h = clamp(h, 0, 100);
    const thr = hybridThresholds(M);
    const cls = hybridRiskClass(h, mlc, p, rule, thr);
    return { score: h, level: RISK_LEVELS[cls], mode: 'HYBRID', prob: p, expected, mlScore, mlOrdinalClass: mlc, ruleWeight: rw };
  }
  /** Apply hybrid risk to a featured row in place (adds the standard prediction columns). */
  function applyHybridRisk(r, M) {
    const h = hybridRisk(r, M);
    r.HybridRiskScore = h.score;
    r.PredictedRiskLevel = h.level;
    r.RiskPredictionMode = h.mode;
    r.MLRiskScore = h.mlScore;
    r.RuleWeight = h.ruleWeight;
    if (h.prob) {
      [r.MLProb_Normal, r.MLProb_Caution, r.MLProb_Warning, r.MLProb_Critical] = h.prob;
      r.MLExpectedClass = h.expected; r.MLOrdinalClass = h.mlOrdinalClass; r.MLOrdinalLevel = RISK_LEVELS[h.mlOrdinalClass];
      r.RiskConfidence = Math.max(...h.prob) * (Number(r.DataQualityScore) || 1);
    } else {
      ['MLProb_Normal', 'MLProb_Caution', 'MLProb_Warning', 'MLProb_Critical', 'MLExpectedClass', 'MLOrdinalClass', 'MLOrdinalLevel', 'RiskConfidence'].forEach((k) => { delete r[k]; });
    }
    return r;
  }

  // ------------------------------------------------------------------ recommendations
  function recommendationFor(r) {
    const level = r.PredictedRiskLevel || r.RiskLevel || RISK_LEVELS[classFromThresholds(r.RuleRiskScore, RULE_THRESHOLDS)];
    const d = Math.max(0, num(r.SideClearance_m, 999));
    if (Number(r.DataQualityScore) < 0.5) return { severity: 'DataQuality', text: 'Data quality poor: verify AIS/DGPS/heading sensors before any operational judgement.' };
    const causes = CAUSE_KEYS.map((k) => [k, Number(r[k]) || 0]).sort((a, b) => b[1] - a[1]);
    const top = causes[0][1] >= 0.05 ? causes[0][0] : null;
    const f = (x, n = 2) => Number(x).toFixed(n);
    const advice = {
      SpeedCause: `reduce speed over ground from ${f(r.Speed_mps)} to ≤ ${f(r.AllowedSpeed_mps)} m/s for ${f(d, 0)} m side clearance`,
      AngleCause: d < 150
        ? `rotate toward berth-parallel heading (error ${f(r.BerthHeadingError_deg, 1)}°; tug assistance as required)`
        : `correct course toward the berth approach line (track error ${f(r.ApproachAngle_deg, 1)}°)`,
      LateralCause: d <= BERTH.alignStartSideClearance_m
        ? `reduce berthing velocity from ${f(r.BerthingVelocity_mps, 3)} to ≤ ${f(r.AllowedBerthingVelocity_mps, 3)} m/s (design ${f(r.DesignBerthingVelocity_mps, 2)} m/s at contact)`
        : `counter the lateral drift of ${f(r.LateralSpeed_mps)} m/s (wind/current set)`,
      ROTCause: `stabilise heading: |ROT| ${f(Math.abs(r.ROT_degps), 2)} °/s exceeds ${f(r.MaxROT_degps, 2)} °/s`,
      CorridorCause: `return to the approach funnel (|Y| ${f(r.SafetyCorridorY_m, 1)} m, limit ${f(r.CorridorHalfWidth_m, 0)} m at this distance)`,
      EnvironmentCause: 'environmental loads are high: confirm tug power and mooring readiness',
    };
    if (level === 'Critical') return { severity: 'Critical', text: `CRITICAL: ${top ? advice[top] : 'high-risk berthing state'}; request immediate pilot/master attention and consider aborting the approach.` };
    if (level === 'Warning') return { severity: 'Warning', text: `WARNING: ${top ? advice[top] : 'increase monitoring'}; prepare corrective manoeuvre.` };
    if (level === 'Caution') return { severity: 'Caution', text: `CAUTION: ${top ? advice[top] : 'maintain low speed and monitor approach'}.` };
    return { severity: 'Normal', text: 'Normal: continue current manoeuvre under standard monitoring.' };
  }

  // ------------------------------------------------------------------ trajectory helpers
  function trajRawFeature(r) {
    return [r.X_m, r.Y_m, r.Speed_mps, Math.sin(rad(r.Heading_deg)), Math.cos(rad(r.Heading_deg)), Math.sin(rad(r.COG_deg)), Math.cos(rad(r.COG_deg)),
      r.ROT_degps, r.WindSpeed_mps, r.CurrentSpeed_mps, r.LOA_m, r.Beam_m, r.Draft_m].map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  }
  function normVec(v, s) { return v.map((x, i) => (x - s.mean[i]) / (s.std[i] || 1)); }
  function rawTrajTarget(anchor, prev, r) {
    return [Number(r.X_m) - Number(anchor.X_m), Number(r.Y_m) - Number(anchor.Y_m), Number(r.Speed_mps),
      wrap180(Number(r.Heading_deg) - Number(prev.Heading_deg)), wrap180(Number(r.COG_deg) - Number(prev.COG_deg)),
      sideClearanceToBerth(Number(r.X_m), vesselBeam(r || anchor))].map((v) => (Number.isFinite(v) ? v : 0));
  }
  /** Decode a flat H×6 normalised network output into absolute future vessel states. */
  function decodeStatePrediction(pred, last, H, targetStats, dt_s = 5) {
    const mu = targetStats.mean, sd = targetStats.std, out = [];
    const x0 = Number(last.X_m), y0 = Number(last.Y_m);
    let heading = Number(last.Heading_deg), cog = Number(last.COG_deg);
    if (![x0, y0, heading, cog].every(Number.isFinite)) throw new Error(`Invalid trajectory decoder anchor: X=${x0}, Y=${y0}, Heading=${heading}, COG=${cog}.`);
    if (mu?.length !== 6 || sd?.length !== 6) throw new Error('Trajectory decoder requires 6-channel targetStats.');
    for (let k = 0; k < H; k++) {
      const z = Array.from(pred).slice(k * 6, k * 6 + 6);
      if (z.length !== 6) throw new Error(`Trajectory output is incomplete at horizon step ${k + 1}.`);
      const q = z.map((v, j) => Number(v) * Number(sd[j]) + Number(mu[j]));
      if (!q.every(Number.isFinite)) throw new Error(`Non-finite trajectory prediction at horizon step ${k + 1}.`);
      const dH = wrap180(q[3]), dC = wrap180(q[4]);
      heading = wrap180(heading + dH); cog = wrap180(cog + dC);
      out.push({ X_m: x0 + q[0], Y_m: y0 + q[1], Speed_mps: Math.max(0, q[2]), Heading_deg: heading, COG_deg: cog,
        ROT_degps: dH / Math.max(1e-9, Number(dt_s) || 5), DeltaHeadingStep_deg: dH, DeltaCOGStep_deg: dC, PredictedSideClearanceToBerth_m: q[5] });
    }
    return out;
  }
  /** Constant-velocity / constant-ROT kinematic baseline (ROT limited to the vessel's advisory maximum). */
  function kinematicStates(last, H, dt = 5) {
    const lim = vesselLimits(last), rot = clamp(num(last.ROT_degps, 0), -lim.maxROT_degps, lim.maxROT_degps);
    let x = last.X_m, y = last.Y_m; const out = [];
    for (let k = 0; k < H; k++) {
      x += last.Speed_mps * dt * Math.cos(rad(last.COG_deg));
      y += last.Speed_mps * dt * Math.sin(rad(last.COG_deg));
      out.push({ X_m: x, Y_m: y, Speed_mps: last.Speed_mps, Heading_deg: wrap180(last.Heading_deg + rot * dt * (k + 1)), COG_deg: wrap180(last.COG_deg), ROT_degps: rot,
        DeltaHeadingStep_deg: rot * dt, DeltaCOGStep_deg: 0, PredictedSideClearanceToBerth_m: NaN });
    }
    return out;
  }

  // ------------------------------------------------------------------ progressive geometry shield
  function applyBerthAlignmentForecast(states, anchorRow) {
    if (!states?.length) return states || [];
    const beam = vesselBeam(anchorRow || states[0]), cX = contactCenterX(beam);
    let prevX = Number(anchorRow?.X_m), prevSp = Math.max(0, Number(anchorRow?.Speed_mps) || 0);
    let prevH = Number.isFinite(Number(anchorRow?.Heading_deg)) ? Number(anchorRow.Heading_deg) : -90;
    let prevC = Number.isFinite(Number(anchorRow?.COG_deg)) ? Number(anchorRow.COG_deg) : 180;
    if (!Number.isFinite(prevX)) prevX = cX + 25;
    return states.map((s) => {
      const r = { ...s };
      const rawX = Number(r.X_m), rawY = Number(r.Y_m), rawSp = Math.max(0, Number(r.Speed_mps) || 0);
      const rawH = Number(r.Heading_deg), rawC = Number(r.COG_deg), rawR = Number(r.ROT_degps) || 0;
      const rawClear = sideClearanceToBerth(rawX, beam), predSide = Number(r.PredictedSideClearanceToBerth_m);
      const byX = Number.isFinite(rawClear) && rawClear < 0, bySide = Number.isFinite(predSide) && predSide < 0, pen = byX || bySide;
      Object.assign(r, {
        RawX_forecast_m: rawX, RawY_forecast_m: rawY, RawSpeed_forecast_mps: rawSp, RawHeading_forecast_deg: rawH, RawCOG_forecast_deg: rawC, RawROT_forecast_degps: rawR,
        RawSideClearanceToBerth_m: rawClear, PredictedSideClearanceToBerth_m: predSide,
        SideClearanceConsistencyError_m: Number.isFinite(predSide) && Number.isFinite(rawClear) ? predSide - rawClear : NaN,
        GeometryViolation: pen,
        GeometryViolationType: pen ? (byX && bySide ? 'BERTH_PENETRATION_X_AND_SIDE_TARGET' : byX ? 'BERTH_PENETRATION_X' : 'NEGATIVE_PREDICTED_SIDE_CLEARANCE') : '',
        GeometryCorrectionApplied: false,
      });
      let sx = rawX, ss = rawSp, sh = rawH, sc = rawC, sr = rawR;
      if (Number.isFinite(rawClear) && rawClear < BERTH.finalStartSideClearance_m) {
        const q = clamp((BERTH.finalStartSideClearance_m - Math.max(rawClear, 0)) / BERTH.finalStartSideClearance_m, 0, 1);
        const targetX = cX + ((1 - q) * Math.max(rawClear, 0) + q * 0.10), bx = clamp(0.35 + 0.65 * q, 0, 1);
        sx = Math.max((1 - bx) * rawX + bx * targetX, cX + 0.05);
        ss = Math.min(rawSp, Math.max(0.08, (1 - q) * Math.min(rawSp, 0.40) + q * 0.10));
        sh = blendAngleDeg(rawH, nearestBerthParallelHeading(rawH), clamp(0.35 + 0.60 * q, 0, 1));
        if (circAbsErr(rawC, sh) > 110 && ss > 0.18) sc = blendAngleDeg(rawC, sh, 0.12 + 0.18 * q);
        sr = rawR * (1 - 0.80 * q);
        if (Math.abs(sx - rawX) > 0.01 || Math.abs(ss - rawSp) > 0.005 || circAbsErr(sh, rawH) > 0.1) r.GeometryCorrectionApplied = true;
      }
      if (pen) {
        const qp = clamp(Math.abs(rawClear) / 10, 0, 1);
        sx = Math.max(cX + 0.05, 0.70 * prevX + 0.30 * (cX + 0.05));
        ss = Math.max(0.10, prevSp - (0.03 + 0.04 * qp));
        sh = blendAngleDeg(prevH, nearestBerthParallelHeading(prevH), 0.40 + 0.35 * qp);
        sc = blendAngleDeg(prevC, rawC, 0.35);
        sr = rawR * (1 - 0.75 * qp);
        r.GeometryCorrectionApplied = true;
      }
      r.X_m = sx; r.Y_m = rawY; r.Speed_mps = Math.max(0, ss); r.Heading_deg = wrap180(sh); r.COG_deg = wrap180(sc); r.ROT_degps = sr;
      const clr = sideClearanceToBerth(sx, beam);
      r.SideClearanceToBerth_m = clr;
      r.LongitudinalOffset_m = longitudinalOffsetToBerth(rawY);
      r.BerthHeadingError_deg = berthHeadingError(r.Heading_deg);
      r.TerminalAlignmentWeight = terminalAlignmentWeightFromClearance(Math.max(clr, 0));
      r.BerthingPhase = pen ? 'GEOMETRY SHIELD' : berthPhaseFromClearance(clr);
      r.ContactCenterX_m = cX;
      prevX = r.X_m; prevSp = r.Speed_mps; prevH = r.Heading_deg; prevC = r.COG_deg;
      return r;
    });
  }

  /** Turn shielded future states into forecast rows with future risk (shared by browser + backend). */
  function buildForecastRows(states, last, dt, modelName, riskModel) {
    return states.map((p, k) => {
      const r = {
        CaseID: last.CaseID, Time_s: Number(last.Time_s) + (k + 1) * dt, X_m: p.X_m, Y_m: p.Y_m, Speed_mps: p.Speed_mps,
        Heading_deg: p.Heading_deg, COG_deg: p.COG_deg, ROT_degps: p.ROT_degps, LOA_m: last.LOA_m, Beam_m: last.Beam_m, Draft_m: last.Draft_m,
        WindSpeed_mps: last.WindSpeed_mps, CurrentSpeed_mps: last.CurrentSpeed_mps,
        DataQualityScore: Number.isFinite(Number(last.DataQualityScore)) ? Number(last.DataQualityScore) : 1,
      };
      computeRowFeatures(r);
      const h = hybridRisk(r, riskModel);
      const out = {
        HorizonStep: k + 1, CaseID: r.CaseID, Time_s: r.Time_s, TrajectoryModel: String(modelName).toUpperCase(),
        X_forecast_m: r.X_m, Y_forecast_m: r.Y_m, Speed_forecast_mps: r.Speed_mps, Heading_forecast_deg: r.Heading_deg, COG_forecast_deg: r.COG_deg, ROT_forecast_degps: r.ROT_degps,
        DeltaHeadingStep_deg: Number(p.DeltaHeadingStep_deg || 0), DeltaCOGStep_deg: Number(p.DeltaCOGStep_deg || 0), ROTSource: 'Derived from DeltaHeadingStep / dt',
        ContactCenterX_m: p.ContactCenterX_m, RawX_forecast_m: p.RawX_forecast_m, RawY_forecast_m: p.RawY_forecast_m, RawSpeed_forecast_mps: p.RawSpeed_forecast_mps,
        RawHeading_forecast_deg: p.RawHeading_forecast_deg, RawCOG_forecast_deg: p.RawCOG_forecast_deg, RawROT_forecast_degps: p.RawROT_forecast_degps,
        RawSideClearanceToBerth_m: p.RawSideClearanceToBerth_m, PredictedSideClearanceToBerth_m: p.PredictedSideClearanceToBerth_m,
        SideClearanceConsistencyError_m: p.SideClearanceConsistencyError_m, SideClearanceToBerth_m: p.SideClearanceToBerth_m, LongitudinalOffset_m: p.LongitudinalOffset_m,
        BerthingPhase: p.BerthingPhase, BerthHeadingError_deg: p.BerthHeadingError_deg, TerminalAlignmentWeight: p.TerminalAlignmentWeight,
        GeometryViolation: !!p.GeometryViolation, GeometryViolationType: p.GeometryViolationType || '', GeometryCorrectionApplied: !!p.GeometryCorrectionApplied,
        DistanceToBerth_m: r.DistanceToBerth_m, ApproachAngle_deg: r.ApproachAngle_deg, LateralSpeed_mps: r.LateralSpeed_mps, BerthingVelocity_mps: r.BerthingVelocity_mps,
        CorridorDeviation_m: r.CorridorDeviation_m, RuleRiskScore: r.RuleRiskScore, FutureRiskScore: h.score, ForecastRiskFlag: h.level,
        RiskForecastType: h.mode === 'HYBRID' ? 'Hybrid forecast' : 'Rule forecast (no compatible ML risk model)', MainRiskCause: r.MainRiskCause,
      };
      if (out.GeometryViolation) {
        out.PreShieldFutureRiskScore = out.FutureRiskScore;
        out.FutureRiskScore = 100; out.ForecastRiskFlag = 'Critical';
        out.RiskForecastType += ' + Geometry Shield Critical override'; out.MainRiskCause = 'Berth geometry penetration';
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ final berthing alignment policy (advisory simulation)
  function simulatePolicy(startState = {}, opts = {}) {
    const beam = vesselBeam(startState), lim = vesselLimits(startState), cX = contactCenterX(beam);
    const dt = opts.dt_s || 5, maxSteps = opts.maxSteps || 750;
    let x = num(startState.X_m, 850), y = num(startState.Y_m, 75), sp = clamp(num(startState.Speed_mps, 2.2), 0, 4);
    if (sideClearanceToBerth(x, beam) < 2) x = cX + 2;
    let cog = Number.isFinite(Number(startState.COG_deg)) ? wrap180(startState.COG_deg) : wrap180(deg(Math.atan2(BERTH.targetY_m - y, cX - x)));
    let hd = Number.isFinite(Number(startState.Heading_deg)) ? wrap180(startState.Heading_deg) : wrap180(cog + 12);
    let rot = 0; const A = []; let noProgress = 0, prevClear = Infinity, completed = false;
    for (let k = 0; k < maxSteps; k++) {
      const sideClear = sideClearanceToBerth(x, beam), longOff = longitudinalOffsetToBerth(y), phase = berthPhaseFromClearance(sideClear);
      const targetBearing = wrap180(deg(Math.atan2(BERTH.targetY_m - y, cX - x))), finalH = nearestBerthParallelHeading(hd);
      const targetSp = sideClear > 500 ? 2.0 : sideClear > 300 ? 1.6 : sideClear > 150 ? 1.1 : sideClear > 90 ? 0.70 : sideClear > 35 ? 0.40 : sideClear > 12 ? 0.22 : Math.max(0.06, lim.designBerthingVelocity_mps * 0.8);
      const cogLim = phase === 'APPROACH' ? 2.0 : 2.8;
      cog = wrap180(cog + clamp(0.30 * wrap180(targetBearing - cog), -cogLim, cogLim));
      const targetHeading = phase === 'APPROACH' ? blendAngleDeg(hd, cog, 0.50) : finalH;
      const rotLimit = (sp < 1.2 ? Math.max(lim.maxROT_degps, lim.tugROT_degps) : lim.maxROT_degps);
      const dHead = clamp(0.30 * wrap180(targetHeading - hd), -rotLimit * dt, rotLimit * dt);
      rot = dHead / dt; hd = wrap180(hd + dHead);
      const e = targetSp - sp;
      if (e < -0.03) sp = Math.max(targetSp, sp - (phase === 'APPROACH' ? 0.08 : phase === 'ALIGNING' ? 0.05 : 0.025));
      else if (e > 0.04) sp = Math.min(targetSp, sp + (phase === 'APPROACH' ? 0.05 : 0.012));
      else sp += 0.25 * e;
      const drift = wrap180(cog - hd);
      let lateral = sp * Math.abs(Math.sin(rad(drift)));
      if (phase === 'FINAL BERTHING' && lateral > 0.10) { sp = Math.max(0.03, sp * 0.88); lateral = sp * Math.abs(Math.sin(rad(drift))); }
      const hErr = berthHeadingError(hd);
      const risk = clamp(100 * (0.18 * clamp((sp - 0.25) / 1.5, 0, 1) + 0.22 * clamp(hErr / 35, 0, 1) + 0.24 * clamp((lateral - 0.08) / 0.70, 0, 1)
        + 0.16 * clamp(Math.abs(rot) / 1.5, 0, 1) + 0.10 * clamp(Math.abs(drift) / 80, 0, 1) + 0.10 * clamp(Math.max(0, longOff - 8) / 60, 0, 1)), 0, 100);
      x += sp * dt * Math.cos(rad(cog)); y += sp * dt * Math.sin(rad(cog));
      const newClear = sideClearanceToBerth(x, beam), newLong = longitudinalOffsetToBerth(y);
      const C = BERTH.completion;
      const done = newClear <= C.sideClearance_m && newClear >= -0.5 && newLong <= C.longitudinalOffset_m && berthHeadingError(hd) <= C.headingError_deg
        && sp <= C.speed_mps && lateral <= C.lateralSpeed_mps && Math.abs(rot) <= C.rot_degps;
      A.push({ Time_s: k * dt, X_m: x, Y_m: y, Beam_m: beam, LOA_m: lim.LOA_m, Speed_mps: sp, TargetSpeed_mps: targetSp, Heading_deg: hd, COG_deg: cog, ROT_degps: rot,
        HeadingCOGDrift_deg: drift, BerthingPhase: phase, BerthHeadingTarget_deg: finalH, BerthHeadingError_deg: berthHeadingError(hd),
        SideClearanceToBerth_m: newClear, LongitudinalOffset_m: newLong, LateralSpeed_mps: lateral, RiskScore: risk, CompletionFlag: done ? 'BERTHING COMPLETED' : '' });
      if (done) { completed = true; break; }
      if (newClear < -1.0 || Math.abs(y) > 180) break;
      if (newClear >= prevClear - 0.03) noProgress++; else noProgress = 0;
      prevClear = newClear;
      if (noProgress >= 50 && newClear > BERTH.finalStartSideClearance_m) { cog = targetBearing; sp = Math.max(sp, Math.min(0.65, targetSp)); noProgress = 0; }
    }
    const last = A[A.length - 1];
    let result = 'STOPPED';
    if (completed) result = 'BERTHING COMPLETED';
    else if (last && last.SideClearanceToBerth_m < -0.5) result = 'FAILED — BERTH PENETRATION';
    else if (last && last.SideClearanceToBerth_m <= BERTH.completion.sideClearance_m) result = 'CONTACT ZONE REACHED — ALIGNMENT NOT YET SAFE';
    else if (A.length >= maxSteps) result = 'STOPPED — MAXIMUM SIMULATION TIME';
    return { result, rows: A, beam, start: { X_m: A.length ? A[0].X_m : x, Y_m: A.length ? A[0].Y_m : y } };
  }

  // ------------------------------------------------------------------ synthetic data generator
  const SCENARIOS = Object.freeze(['nominal', 'overspeed', 'hard_landing', 'late_turn', 'drift', 'oscillation']);

  /**
   * Physically consistent synthetic berthing manoeuvres.
   * Positions are integrated from speed/course; heading follows a rate-limited first-order
   * ROT model whose limits scale with LOA (tug assistance below 1.2 m/s); deceleration is
   * limited per vessel class. About 30 % of cases contain an injected hazard scenario.
   * Returns { rows, groundTruth, cases, meta }. groundTruth labels are OUTCOME-BASED
   * (computed from the noise-free future state over the next 60 s), i.e. independent of the
   * rule-risk formula — they play the role of expert / incident labels for the demo.
   */
  function generateSyntheticDataset(opts = {}) {
    const numCases = opts.numCases ?? 250, dt = opts.dt_s ?? 5, h = 1, seed = opts.seed ?? 20260830;
    const rows = [], groundTruth = [], cases = [];
    let rnd = makeRng(seed);
    const pickScenario = () => {
      const u = rnd();
      return u < 0.70 ? 'nominal' : u < 0.77 ? 'overspeed' : u < 0.84 ? 'hard_landing' : u < 0.90 ? 'late_turn' : u < 0.95 ? 'drift' : 'oscillation';
    };
    for (let c = 1; c <= numCases; c++) {
      rnd = makeRng((Number(seed) >>> 0) + c * 7919); // independent, reproducible stream per case
      const scenario = opts.scenario || pickScenario();
      const cls = rnd();
      let loa, beam, draft;
      if (cls < 0.34) { loa = rnd.uniform(120, 150); beam = rnd.uniform(20, 26); draft = rnd.uniform(7, 9); }
      else if (cls < 0.70) { loa = rnd.uniform(200, 280); beam = rnd.uniform(32, 42); draft = rnd.uniform(10, 13.5); }
      else { loa = rnd.uniform(320, 400); beam = rnd.uniform(45, 60); draft = rnd.uniform(13, 16); }
      const lim = vesselLimits({ LOA_m: loa });
      let wind = Math.max(0, 7 + 4 * rnd.normal()), current = Math.max(0, 0.35 + 0.2 * rnd.normal());
      if (scenario === 'drift') { wind = rnd.uniform(13, 19); current = rnd.uniform(0.6, 1.0); }
      const setDir = rnd.uniform(-180, 180), windDir = rnd.uniform(-180, 180);
      const leeway = 0.010 * (beam / 40);
      const drift0 = [current * Math.cos(rad(setDir)) + leeway * wind * Math.cos(rad(windDir)), current * Math.sin(rad(setDir)) + leeway * wind * Math.sin(rad(windDir))];
      const comp = scenario === 'drift' ? rnd.uniform(0.35, 0.55) : rnd.uniform(0.75, 0.92);
      const cX = contactCenterX(beam);
      let x = rnd.uniform(850, 1030), y = rnd.uniform(-140, 140);
      const yAim = (scenario === 'drift' ? 0 : 6 * rnd.normal());
      let psi = wrap180(deg(Math.atan2(yAim - y, cX + 40 - x)) + 4 * rnd.normal()), chi = psi;
      let u = rnd.uniform(1.9, 2.4), rot = 0;
      const side = rnd() < 0.5 ? 90 : -90;
      const rotTug = Math.max(lim.tugROT_degps, lim.maxROT_degps);
      let dTurn = clamp(60 + 0.45 * 90 / rotTug, 90, 300) * rnd.uniform(0.95, 1.20);
      if (scenario === 'late_turn') dTurn *= rnd.uniform(0.30, 0.50);
      const Kpsi = scenario === 'oscillation' ? rnd.uniform(0.30, 0.45) : rnd.uniform(0.03, 0.05);
      const Trot = scenario === 'oscillation' ? 35 + loa / 12 : 8 + loa / 40;
      const oscAmp = scenario === 'oscillation' ? rnd.uniform(12, 20) : 0, oscPeriod = rnd.uniform(60, 100);
      const speedBias = scenario === 'overspeed' ? rnd.uniform(0.40, 0.85) : 0.06 * rnd.normal();
      const decelFactor = scenario === 'overspeed' ? 0.55 : scenario === 'hard_landing' ? 0.7 : 1;
      const vbContact = lim.designBerthingVelocity_mps * (scenario === 'hard_landing' ? rnd.uniform(2.6, 4.0) : scenario === 'overspeed' ? rnd.uniform(1.6, 2.8) : rnd.uniform(0.6, 1.0));
      const truth = [];
      let contact = null, holdSteps = 0, tRec = 0;
      const maxT = 3600;
      for (let t = 0; t <= maxT; t += h) {
        const d = x - cX;
        // ---------------- pilot / tug controller
        let psiDes, chiDes, uDes;
        const vProfile = 0.2 + 2.0 * Math.pow(clamp((d - 60) / 850, 0, 1), 0.75);
        if (contact) { psiDes = psi; chiDes = chi; uDes = 0; }
        else if (d > dTurn) {
          chiDes = deg(Math.atan2(yAim - y, cX + 40 - x)); psiDes = chiDes;
          uDes = vProfile * (1 + (d < 450 ? speedBias : 0.3 * speedBias));
        } else {
          psiDes = side;
          const herr = circAbsErr(psi, side);
          chiDes = deg(Math.atan2(yAim * clamp(d / dTurn, 0, 1) - y, cX - x));
          if (herr > 8) uDes = Math.min(vProfile * (1 + speedBias), 0.45 * (1 + Math.max(0, speedBias)));
          else uDes = vbContact + (0.42 - vbContact) * Math.pow(clamp(d / 90, 0, 1), 0.8) * (1 + Math.max(0, speedBias));
        }
        if (oscAmp && !contact && d > 20) psiDes = wrap180(psiDes + oscAmp * Math.sin(2 * Math.PI * t / oscPeriod));
        // heading dynamics (first-order ROT with rate limit)
        const rotLim = u < 1.2 ? Math.max(rotTug, clamp(deg(u / (1.8 * loa)), 0.02, 0.9)) : clamp(deg(u / (1.8 * loa)), 0.02, 0.9);
        const rotCmd = contact ? 0 : clamp(Kpsi * wrap180(psiDes - psi), -rotLim * 1.6, rotLim * 1.6);
        rot += (rotCmd - rot) * h / Trot;
        rot = clamp(rot, -rotLim * (scenario === 'oscillation' ? 2.6 : 1.05), rotLim * (scenario === 'oscillation' ? 2.6 : 1.05));
        psi = wrap180(psi + rot * h);
        // course (direction of motion through water)
        const chiRate = u > 0.8 ? Math.max(rotLim * 1.5, 0.3) : 2.0;
        chi = wrap180(chi + clamp(wrap180(chiDes - chi), -chiRate * h, chiRate * h));
        // speed
        const decel = lim.brakingDecel_mps2 * decelFactor;
        u += clamp(0.05 * (uDes - u), -decel * h, 0.02 * h);
        u = Math.max(0, u);
        // ground velocity incl. partially compensated environmental drift (tugs compensate more when slow)
        const compNow = contact ? 1 : (u < 0.6 ? Math.min(0.97, comp + 0.15) : comp);
        let vx = u * Math.cos(rad(chi)) + (1 - compNow) * drift0[0], vy = u * Math.sin(rad(chi)) + (1 - compNow) * drift0[1];
        if (contact) { vx = 0; vy = 0; u = 0; rot = 0; }
        x += vx * h; y += vy * h;
        const dNew = x - cX;
        if (!contact && dNew <= 0.2) {
          contact = { t, vb: Math.max(0, -vx), headingErr: berthHeadingError(psi) };
          x = cX + 0.2;
        }
        if (t % dt === 0) {
          const sog = Math.hypot(vx, vy);
          truth.push({ t, x, y, psi, rot, u, vx, vy, sog, d: x - cX });
          const cogTrue = sog > 1e-4 ? deg(Math.atan2(vy, vx)) : psi;
          const sigmaCog = Math.min(25, 0.5 + 1.5 * (0.2 / Math.max(sog, 0.02)));
          rows.push({
            CaseID: c, Time_s: tRec * dt,
            X_m: x + 0.3 * rnd.normal(), Y_m: y + 0.3 * rnd.normal(),
            Speed_mps: Math.max(0, sog + 0.02 * rnd.normal()),
            Heading_deg: wrap180(psi + 0.3 * rnd.normal()),
            COG_deg: wrap180(cogTrue + sigmaCog * rnd.normal()),
            LOA_m: loa, Beam_m: beam, Draft_m: draft, WindSpeed_mps: wind, CurrentSpeed_mps: current,
            ROT_degps: rot + 0.03 * rnd.normal(),
            ScenarioType: scenario,
          });
          tRec++;
          if (contact) { holdSteps++; if (holdSteps > 6) break; }
        }
        if (!contact && Math.abs(y) > 160 && x - cX < 300) break; // approach aborted (far outside the funnel near the berth)
      }
      // ---------------- outcome-based ground truth (noise-free future, 60 s look-ahead)
      const K = Math.round(60 / dt);
      const caseRows = rows.slice(rows.length - truth.length);
      truth.forEach((s, i) => {
        let cls = 0;
        const win = truth.slice(i, Math.min(truth.length, i + K + 1));
        if (contact && contact.t >= s.t && contact.t <= s.t + 60) {
          const r = contact.vb / lim.designBerthingVelocity_mps;
          cls = Math.max(cls, r >= 2.5 ? 3 : r >= 1.6 ? 2 : r >= 1.2 ? 1 : 0);
          cls = Math.max(cls, contact.headingErr >= 25 ? 3 : contact.headingErr >= 12 ? 2 : contact.headingErr >= 7 ? 1 : 0);
        }
        if (s.d > 0.5) {
          const vb = Math.max(0, -s.vx), vbD = lim.designBerthingVelocity_mps;
          if (vb > vbD) {
            const req = (vb * vb - vbD * vbD) / (2 * Math.max(s.d, 1)), ratio = req / (lim.brakingDecel_mps2 * 1.3);
            cls = Math.max(cls, ratio >= 1.6 ? 3 : ratio >= 1.0 ? 2 : ratio >= 0.7 ? 1 : 0);
          }
        }
        const maxY = Math.max(...win.map((w) => Math.abs(w.y)));
        if (s.d < 250) cls = Math.max(cls, maxY > 90 ? 3 : maxY > 60 ? 2 : maxY > 40 ? 1 : 0);
        const maxRot = Math.max(...win.map((w) => Math.abs(w.rot))) / lim.maxROT_degps;
        cls = Math.max(cls, maxRot >= 2.5 ? 2 : maxRot >= 1.6 ? 1 : 0);
        if (s.d < 25) { const he = berthHeadingError(s.psi); cls = Math.max(cls, he > 35 ? 3 : he > 20 ? 2 : 0); }
        let label = cls, conf = rnd.uniform(0.78, 0.96);
        if (rnd() < 0.04) { label = clamp(cls + (rnd() < 0.5 ? -1 : 1), 0, 3); conf = rnd.uniform(0.55, 0.75); }
        const incident = (contact && contact.t >= s.t && contact.t <= s.t + 60 && contact.vb / lim.designBerthingVelocity_mps >= 2.5) || (s.d < 250 && maxY > 90);
        groundTruth.push({ CaseID: c, Time_s: caseRows[i].Time_s, ExpertRiskClass: label, ExpertRiskLevel: RISK_LEVELS[label],
          NearMiss: label >= 2 ? 1 : 0, Incident: incident ? 1 : 0, PilotIntervention: label >= 2 && rnd() < 0.6 ? 1 : 0,
          ExpertConfidence: Number(conf.toFixed(3)), LabelSource: 'Synthetic outcome-based (60 s look-ahead)' });
      });
      cases.push({ CaseID: c, ScenarioType: scenario, LOA_m: loa, Beam_m: beam, records: truth.length,
        contactVelocity_mps: contact ? contact.vb : NaN, designBerthingVelocity_mps: lim.designBerthingVelocity_mps,
        contactHeadingError_deg: contact ? contact.headingErr : NaN, reachedBerth: !!contact });
    }
    return { rows, groundTruth, cases, meta: { version: VERSION, seed, numCases, dt_s: dt, angleConvention: ANGLE_CONVENTION } };
  }

  return {
    VERSION, FEATURE_SCHEMA, ANGLE_CONVENTION, BERTH, RISK_LEVELS, RULE_THRESHOLDS, REQUIRED_COLUMNS, RISK_FEATURES, CAUSE_KEYS, CAUSE_NAMES,
    TRAJ_INPUT_FEATURES, TRAJ_TARGET_CHANNELS, SCENARIOS,
    rad, deg, clamp, wrap180, angle360, circAbsErr, num, mean, median, blendAngleDeg, makeRng, escapeHtml,
    vesselBeam, contactCenterX, corridorHalfWidth, sideClearanceToBerth, longitudinalOffsetToBerth, berthHeadingError, nearestBerthParallelHeading,
    berthPhaseFromClearance, terminalAlignmentWeightFromClearance, vesselLimits, allowedSpeed, allowedBerthingVelocity,
    computeRowFeatures, completeFeatures, mainRiskCause,
    featureList, featureVector, treePredict, rfProba, gbPredict, softClassProb, rawMLProb, applyPlatt, applyIsotonic, calibratedProb,
    expectedRiskClassFromProb, ordinalClass, classFromThresholds, hybridThresholds, hybridRiskClass, riskModelCompatibility, hybridRisk, applyHybridRisk,
    recommendationFor, trajRawFeature, normVec, rawTrajTarget, decodeStatePrediction, kinematicStates,
    applyBerthAlignmentForecast, buildForecastRows, simulatePolicy, generateSyntheticDataset,
  };
});
