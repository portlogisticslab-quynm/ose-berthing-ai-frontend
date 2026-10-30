/*!
 * Berthing AI — Live Berthing demo core (browser + Node.js)
 * Version 3.6.0-demo — © 2026 portlogistics.vn
 *
 * Chain demonstrated: environment + BRT sensor stream (port-shm style)
 *   → forecast of contact velocity / berthing angle (with uncertainty)
 *   → berthing energy (PIANC WG 33 / WG 211 formulation)
 *   → fender deflection + reaction (generic normalised cone-fender curve)
 *   → wharf displacement (linear force–displacement placeholder model)
 *   → probability of exceeding limits → alert level for the port manager.
 *
 * ALL DATA AND PARAMETERS ARE ILLUSTRATIVE DEFAULTS FOR A DEMO.
 * Replace DEFAULTS.berth / fender / wharf / vessels with project values and the
 * force–displacement function with the calibrated model before any operational use.
 * Advisory / research prototype only. Not for automatic vessel control.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveBerthingCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '3.6.0-demo';
  const LEVELS = ['Normal', 'Caution', 'Warning', 'Critical'];

  // ------------------------------------------------------------------ defaults (illustrative)
  const VESSELS = [
    { id: 'GC10', type: 'General cargo', DWT: 10000, LOA: 140, B: 21.0, T: 8.5, Cb: 0.72, windHeight: 14, tugs: 1 },
    { id: 'CT20', type: 'Container', DWT: 20000, LOA: 180, B: 28.0, T: 10.5, Cb: 0.62, windHeight: 22, tugs: 2 },
    { id: 'BC30', type: 'Bulk carrier', DWT: 30000, LOA: 180, B: 30.0, T: 10.5, Cb: 0.82, windHeight: 12, tugs: 2 },
    { id: 'TK45', type: 'Tanker', DWT: 45000, LOA: 183, B: 32.2, T: 12.2, Cb: 0.82, windHeight: 13, tugs: 2 },
    { id: 'CT50', type: 'Container (design vessel)', DWT: 50000, LOA: 294, B: 32.3, T: 13.5, Cb: 0.62, windHeight: 28, tugs: 3 },
    { id: 'BC60', type: 'Bulk carrier', DWT: 60000, LOA: 200, B: 32.3, T: 12.8, Cb: 0.84, windHeight: 13, tugs: 3 },
  ];

  /** Generic normalised cone-fender curve: deflection / H → reaction / Rr (not a specific product). */
  const FENDER_CURVE = [
    [0.00, 0.00], [0.05, 0.30], [0.10, 0.55], [0.15, 0.74], [0.20, 0.88], [0.25, 0.97], [0.30, 1.00], [0.35, 1.00],
    [0.40, 0.98], [0.45, 0.96], [0.50, 0.95], [0.55, 0.94], [0.60, 0.94], [0.65, 0.96], [0.70, 0.99], [0.72, 1.00],
    [0.75, 1.12], [0.80, 1.45], [0.85, 2.00], [0.90, 3.00],
  ];

  const DEFAULTS = Object.freeze({
    berth: {
      name: 'Bến cầu tàu số 1 (demo)',
      seawardNormalDeg: 120,          // bearing (°N) of the seaward normal of the berth face
      waterDensity: 1.025,            // t/m³
      designVesselId: 'CT50',
      designVelocity: 0.15,           // m/s, PIANC (Brolsma) — difficult berthing, sheltered (illustrative)
      abnormalFactor: 1.5,            // Cab
      brtSpacing: 100,                // m, along-berth spacing of the two BRT sensors
      brtRangeMax: 600, brtRangeMin: 400, // m, sensor pick-up range depends on current
    },
    fender: { type: 'Generic cone fender (normalised curve)', ratedEnergy: 1350, ratedReaction: 1500, ratedDeflection: 0.72 },
    wharf: { stiffness: 120, displacementLimit: 20, frictionCoeff: 0.15, segmentMass: 4000 }, // kN/mm, mm, -, t
    alert: { probability: 0.20, energyCaution: 0.60, energyWarning: 0.85, energyCritical: 1.00, dispWarning: 0.80, dispCritical: 1.00, angleCaution: 10, angleWarning: 15 },
  });

  // ------------------------------------------------------------------ helpers
  const rad = (x) => (x * Math.PI) / 180, deg = (x) => (x * 180) / Math.PI;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const wrap360 = (a) => ((a % 360) + 360) % 360;
  function makeRng(seed) {
    let a = (Number(seed) >>> 0) || 0x9e3779b9;
    const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.normal = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    r.uniform = (lo, hi) => lo + (hi - lo) * r();
    r.pick = (arr) => arr[Math.floor(r() * arr.length)];
    return r;
  }
  function quantile(sorted, p) { if (!sorted.length) return NaN; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }

  // ------------------------------------------------------------------ vessel + PIANC berthing energy
  function vesselParticulars(v, laden = true, rho = DEFAULTS.berth.waterDensity) {
    const T = laden ? v.T : 0.6 * v.T;
    const Lpp = 0.96 * v.LOA;
    const displacement = v.Cb * Lpp * v.B * T * rho; // t
    return { ...v, laden, T, Lpp, displacement };
  }
  /**
   * Berthing energy E = ½·M·v²·Cm·Ce·Cs·Cc (kJ).
   * Cm: Vasco Costa 1 + 2T/B; Ce: radius-of-gyration formulation, quarter-point contact; Cs = Cc = 1 (open piled wharf).
   */
  function berthingEnergy(vp, v, angleDeg) {
    const M = vp.displacement; // t → E in kJ when v in m/s
    const Cm = 1 + (2 * vp.T) / vp.B;
    const K = (0.19 * vp.Cb + 0.11) * vp.Lpp;
    const x = vp.Lpp / 4, y = vp.B / 2, R = Math.hypot(x, y);
    const gamma = clamp(90 - deg(Math.atan2(y, x)) - Math.abs(angleDeg), 0, 90);
    const Ce = (K * K + R * R * Math.cos(rad(gamma)) ** 2) / (K * K + R * R);
    const E = 0.5 * M * v * v * Cm * Ce;
    return { E, Cm, Ce, Cs: 1, Cc: 1, M };
  }
  function designEnergy(cfg = DEFAULTS) {
    const vp = vesselParticulars(VESSELS.find((v) => v.id === cfg.berth.designVesselId), true);
    const e = berthingEnergy(vp, cfg.berth.designVelocity, 5);
    return { normal: e.E, abnormal: e.E * cfg.berth.abnormalFactor, vessel: vp, ...e };
  }

  // ------------------------------------------------------------------ fender
  function makeFender(f = DEFAULTS.fender) {
    // cumulative normalised energy (∫ R/Rr d(δ/H))
    const cum = [0];
    for (let i = 1; i < FENDER_CURVE.length; i++) {
      const [x0, y0] = FENDER_CURVE[i - 1], [x1, y1] = FENDER_CURVE[i];
      cum.push(cum[i - 1] + 0.5 * (y0 + y1) * (x1 - x0));
    }
    const iRated = FENDER_CURVE.findIndex((p) => p[0] >= f.ratedDeflection);
    const sRated = cum[iRated];
    const H = f.ratedEnergy / (f.ratedReaction * sRated); // m (kJ / kN)
    function reactionAt(dx) { // dx = δ/H
      for (let i = 1; i < FENDER_CURVE.length; i++) if (dx <= FENDER_CURVE[i][0]) {
        const [x0, y0] = FENDER_CURVE[i - 1], [x1, y1] = FENDER_CURVE[i];
        return y0 + (y1 - y0) * (dx - x0) / (x1 - x0);
      }
      return FENDER_CURVE[FENDER_CURVE.length - 1][1];
    }
    /** Deflection and reaction for an absorbed energy E (kJ). Beyond the curve end → bottomed out. */
    function response(E) {
      const s = E / (f.ratedReaction * H);
      for (let i = 1; i < FENDER_CURVE.length; i++) if (s <= cum[i]) {
        const [x0, y0] = FENDER_CURVE[i - 1], [x1, y1] = FENDER_CURVE[i];
        // solve ∫ linear segment = s - cum[i-1] for dx
        const need = s - cum[i - 1], m = (y1 - y0) / (x1 - x0);
        let dx;
        if (Math.abs(m) < 1e-9) dx = need / y0;
        else dx = (-y0 + Math.sqrt(Math.max(0, y0 * y0 + 2 * m * need))) / m;
        const xd = x0 + dx;
        return { deflectionRatio: xd, deflection: xd * H, reaction: reactionAt(xd) * f.ratedReaction, bottomed: false };
      }
      const last = FENDER_CURVE[FENDER_CURVE.length - 1];
      return { deflectionRatio: last[0], deflection: last[0] * H, reaction: f.ratedReaction * (last[1] + Math.min(2, (s - cum[cum.length - 1]) / 0.05)), bottomed: true };
    }
    return { ...f, H, curve: FENDER_CURVE, cumulative: cum, response, reactionAt };
  }

  // ------------------------------------------------------------------ wharf force → displacement (placeholder model)
  /** Linear equivalent-stiffness model with multiplicative model error. Replace with the calibrated correlation model. */
  function wharfDisplacement(F, w = DEFAULTS.wharf, eps = 0) {
    const dx = (F / w.stiffness) * (1 + eps);
    return { dx, dy: (w.frictionCoeff * F) / w.stiffness, dz: 0.05 * dx };
  }

  function impactChain(vp, v, angle, cfg, fender, eps = 0) {
    const e = berthingEnergy(vp, v, angle);
    const r = fender.response(e.E);
    const d = wharfDisplacement(r.reaction, cfg.wharf, eps);
    return { energy: e.E, Cm: e.Cm, Ce: e.Ce, deflection: r.deflection, deflectionRatio: r.deflectionRatio, reaction: r.reaction, bottomed: r.bottomed, displacement: d.dx, dy: d.dy, dz: d.dz };
  }
  function levelFromValues(x, cfg, fender) {
    const a = cfg.alert, er = x.energy / fender.ratedEnergy, dr = x.displacement / cfg.wharf.displacementLimit;
    let l = 0;
    if (er >= a.energyCaution || Math.abs(x.angle) >= a.angleCaution) l = 1;
    if (er >= a.energyWarning || dr >= a.dispWarning || Math.abs(x.angle) >= a.angleWarning) l = 2;
    if (er >= a.energyCritical || dr >= a.dispCritical || x.bottomed) l = 3;
    return l;
  }

  // ------------------------------------------------------------------ event simulator
  const SCENARIOS = ['nominal', 'strong_current', 'wind_onshore', 'late_braking', 'angle_large', 'overspeed'];
  function pickScenario(r) { const u = r(); return u < 0.60 ? 'nominal' : u < 0.70 ? 'strong_current' : u < 0.80 ? 'wind_onshore' : u < 0.88 ? 'late_braking' : u < 0.95 ? 'angle_large' : 'overspeed'; }

  /**
   * One berthing event: tug-assisted approach from the BRT pick-up range to contact.
   * Returns { meta, env[], brt[], impact, measured } — brt sampled at 1 s, env at 10 s.
   */
  function simulateEvent(id, seed, startTime, cfg = DEFAULTS, fender = makeFender(cfg.fender), forcedScenario = null) {
    const r = makeRng(seed);
    const scenario = forcedScenario || pickScenario(r);
    const vBase = r.pick(VESSELS);
    const vp = vesselParticulars(vBase, r() < 0.7, cfg.berth.waterDensity);
    const tugs = vBase.tugs + (r() < 0.2 ? 1 : 0);
    const onshoreTo = wrap360(cfg.berth.seawardNormalDeg + 180);
    // environment base
    let windSpeed = Math.max(0, 6 + 3 * r.normal()), windFrom = wrap360(r.uniform(0, 360));
    let curSpeed = Math.max(0, 0.25 + 0.12 * r.normal()), curTo = wrap360(r.uniform(0, 360));
    if (scenario === 'strong_current') { curSpeed = r.uniform(0.6, 1.0); curTo = wrap360(onshoreTo + r.uniform(-30, 30)); }
    if (scenario === 'wind_onshore') { windSpeed = r.uniform(15, 22); windFrom = wrap360(cfg.berth.seawardNormalDeg + r.uniform(-25, 25)); }
    const hs = clamp(0.15 + 0.04 * windSpeed + 0.1 * r.normal(), 0.1, 1.8), tp = clamp(5 + 0.25 * windSpeed + r.normal(), 4, 12);
    const tidePhase = r.uniform(0, 2 * Math.PI), tideMean = 1.6, tideAmp = 1.2;
    const onshore = (speed, toDir) => speed * Math.cos(rad(toDir - onshoreTo));
    // dynamics parameters
    const Mvirt = vp.displacement * 1000 * (1 + (2 * vp.T) / vp.B); // kg incl. added mass
    const brakeAcc = (tugs * 350e3) / Mvirt;                          // m/s², effective tug braking (≈ 35 t usable pull each)
    const sizeIdx = clamp(Math.log(vp.displacement / 15000) / Math.log(8), 0, 1);
    let vcPlan = clamp(0.13 - 0.06 * sizeIdx, 0.06, 0.16) * r.uniform(0.55, 1.0);
    if (scenario === 'overspeed') vcPlan *= r.uniform(2.2, 3.2);
    const comp = scenario === 'wind_onshore' ? r.uniform(0.25, 0.55) : scenario === 'strong_current' ? r.uniform(0.35, 0.6) : r.uniform(0.8, 0.95);
    const brakeStart = scenario === 'late_braking' ? r.uniform(6, 18) : -Infinity;
    const tugRamp = r.uniform(60, 100); let tBrake = null;
    const range = cfg.berth.brtRangeMax - (cfg.berth.brtRangeMax - cfg.berth.brtRangeMin) * clamp(curSpeed / 1.0, 0, 1);
    const d0 = range;
    const v0 = r.uniform(0.35, 0.65) * (1 - 0.35 * sizeIdx) + vcPlan;
    const a0 = r.uniform(4, 18), aPlan = scenario === 'angle_large' ? r.uniform(9, 16) : r.uniform(0.5, 4.5);
    const windArea = vp.LOA * vBase.windHeight * (vp.laden ? 0.8 : 1.15);
    let d = d0, v = v0, ang = a0, t = 0, gust = 0;
    const dt = 0.5, brt = [], env = [];
    const s = cfg.berth.brtSpacing;
    let contact = null;
    for (let k = 0; k < 20000 && !contact; k++) {
      // planned profile toward the berth
      let vt = vcPlan + (v0 - vcPlan) * Math.pow(clamp(d / d0, 0, 1), 0.65);
      // late braking: speed held until brakeStart, then tugs need tugRamp seconds to become effective
      let tugEff = 1;
      if (scenario === 'late_braking') {
        if (d > brakeStart) vt = Math.max(vt, vcPlan + 0.6 * (v0 - vcPlan));
        else { if (tBrake === null) tBrake = t; tugEff = clamp((t - tBrake) / tugRamp, 0, 1); }
      }
      // environmental drift accelerations toward berth (partly compensated by tugs)
      gust = 0.95 * gust + 0.05 * r.normal() * (scenario === 'wind_onshore' ? 3 : 1);
      const uw = Math.max(0, windSpeed + gust);
      const windTo = wrap360(windFrom + 180);
      const aWind = (0.5 * 1.225 * 1.0 * windArea * uw * uw * Math.cos(rad(windTo - onshoreTo))) / Mvirt;
      const nearFactor = clamp(1 - d / 150, 0, 1); // tugs lose effectiveness close to the berth face
      const aEnv = (1 - comp) * (aWind + (onshore(curSpeed, curTo) * 0.003)) * (0.3 + 0.7 * nearFactor);
      const aCmd = clamp((vt - v) / 15, -brakeAcc * tugEff, 0.6 * brakeAcc);
      v = Math.max(0.01, v + (aCmd + aEnv + 0.0004 * r.normal()) * dt);
      d -= v * dt;
      ang += ((aPlan - ang) * v * dt) / Math.max(40, 0.5 * d0) + 0.02 * r.normal();
      ang = clamp(ang, 0, 30);
      t += dt;
      if (Math.abs(t - Math.round(t)) < 1e-9) {
        const ts = new Date(startTime.getTime() + Math.round(t) * 1000).toISOString();
        const dFar = d + s * Math.tan(rad(ang));
        brt.push({ t: Math.round(t), ts, n1_distance: +(d + 0.05 * r.normal()).toFixed(3), n1_velocity: +(100 * v + 0.3 * r.normal()).toFixed(3),
          n2_distance: +(dFar + 0.05 * r.normal()).toFixed(3), n2_velocity: +(100 * v + 0.3 * r.normal()).toFixed(3) });
        brt[brt.length - 1].angle = +deg(Math.atan2(brt[brt.length - 1].n2_distance - brt[brt.length - 1].n1_distance, s)).toFixed(3);
        if (Math.round(t) % 10 === 0) {
          const tide = tideMean + tideAmp * Math.sin(tidePhase + (2 * Math.PI * t) / (12.42 * 3600));
          env.push({ t: Math.round(t), ts, windSpeed: +uw.toFixed(2), windFrom: +windFrom.toFixed(1), currentSpeed: +Math.max(0, curSpeed + 0.03 * r.normal()).toFixed(3),
            currentTo: +curTo.toFixed(1), hs: +Math.max(0.05, hs + 0.05 * r.normal()).toFixed(2), tp: +tp.toFixed(1), tide: +tide.toFixed(2) });
        }
      }
      if (d <= 0) contact = { t, v, angle: ang };
    }
    const impact = impactChain(vp, contact.v, contact.angle, cfg, fender, 0);
    const eps = 0.08 * r.normal();
    const disp = wharfDisplacement(impact.reaction, cfg.wharf, eps);
    const measured = {
      ts: new Date(startTime.getTime() + Math.round(contact.t) * 1000).toISOString(),
      fnd: +(impact.reaction * (1 + 0.04 * r.normal())).toFixed(1),
      dsp_dx: +disp.dx.toFixed(3), dsp_dy: +((r() < 0.5 ? -1 : 1) * disp.dy * (1 + 0.1 * r.normal())).toFixed(3), dsp_dz: +(disp.dz * (1 + 0.2 * r.normal())).toFixed(3),
      acc_peak: +(impact.reaction / cfg.wharf.segmentMass * (1 + 0.1 * r.normal())).toFixed(4),
      str: +(impact.reaction * 0.08 * (1 + 0.06 * r.normal())).toFixed(1),
    };
    const level = levelFromValues({ ...impact, angle: contact.angle }, cfg, fender);
    return {
      meta: { eventId: id, scenario, start: startTime.toISOString(), vessel: { id: vBase.id, type: vBase.type, DWT: vBase.DWT, LOA: vp.LOA, B: vp.B, T: +vp.T.toFixed(2), Cb: vp.Cb, displacement: Math.round(vp.displacement), laden: vp.laden }, tugs, brtRange: +d0.toFixed(0), durationSec: Math.round(contact.t) },
      env, brt,
      impact: { contactVelocity: contact.v, contactAngle: contact.angle, ...impact, level, levelName: LEVELS[level] },
      measured,
    };
  }

  function generateDataset({ count = 150, seed = 20261101, cfg = DEFAULTS } = {}) {
    const fender = makeFender(cfg.fender);
    const r = makeRng(seed);
    let time = new Date('2026-11-01T00:00:00+07:00');
    const events = [];
    for (let i = 1; i <= count; i++) {
      time = new Date(time.getTime() + Math.round(r.uniform(3, 9) * 3600) * 1000);
      events.push(simulateEvent(`EV${String(i).padStart(4, '0')}`, (seed >>> 0) + i * 104729, time, cfg, fender));
    }
    return { version: VERSION, seed, generatedAt: new Date().toISOString(), config: cfg, fender: { H: fender.H, ...cfg.fender }, design: designEnergy(cfg), events };
  }

  // ------------------------------------------------------------------ features at an observation time (only data up to that time)
  function envAt(ev, t) { let e = ev.env[0]; for (const x of ev.env) { if (x.t <= t) e = x; else break; } return e; }
  function observe(ev, idx, cfg = DEFAULTS, twoSensors = true) {
    const b = ev.brt, i = clamp(idx, 0, b.length - 1), w = 10;
    const i0 = Math.max(0, i - w), i1 = Math.max(0, i - 3 * w);
    const vNow = mean(b.slice(i0, i + 1).map((x) => x.n1_velocity)) / 100;
    const vPrev = mean(b.slice(i1, Math.max(i1 + 1, i - 2 * w + 1)).map((x) => x.n1_velocity)) / 100;
    const dtA = Math.max(1, b[i].t - b[Math.min(i1 + w / 2 | 0, i)].t);
    const acc = (vNow - vPrev) / Math.max(dtA, 1);
    const angle = twoSensors ? mean(b.slice(i0, i + 1).map((x) => x.angle)) : NaN;
    const e = envAt(ev, b[i].t);
    const onshoreTo = wrap360(cfg.berth.seawardNormalDeg + 180);
    const curOn = e.currentSpeed * Math.cos(rad(e.currentTo - onshoreTo));
    const windOn = e.windSpeed * Math.cos(rad(wrap360(e.windFrom + 180) - onshoreTo));
    const dist = b[i].n1_distance;
    return { distance: dist, vNow, acc, angle, curOn, windOn, wind2: Math.sign(windOn) * windOn * windOn, hs: e.hs,
      lnDisp: Math.log(ev.meta.vessel.displacement), tugs: ev.meta.tugs, laden: ev.meta.vessel.laden ? 1 : 0, env: e };
  }

  // ------------------------------------------------------------------ forecaster (ridge regression per distance checkpoint)
  const CHECKPOINTS = [400, 300, 200, 150, 100, 75, 50, 30, 20, 10, 5];
  const featV = (o, two) => [1, Math.log(Math.max(o.vNow, 0.01)), o.acc * 100, o.curOn, o.wind2 / 100, o.hs, o.lnDisp, o.tugs, o.laden, ...(two ? [o.angle / 10] : [])];
  const featA = (o, two) => [1, o.lnDisp, o.windOn / 10, o.curOn, ...(two ? [o.angle / 10] : [])];
  function solveRidge(X, y, lambda = 1e-2) {
    const p = X[0].length, A = Array.from({ length: p }, () => Array(p + 1).fill(0));
    for (let n = 0; n < X.length; n++) for (let i = 0; i < p; i++) { A[i][p] += X[n][i] * y[n]; for (let j = 0; j < p; j++) A[i][j] += X[n][i] * X[n][j]; }
    for (let i = 1; i < p; i++) A[i][i] += lambda * X.length;
    for (let c = 0; c < p; c++) { // Gauss-Jordan with partial pivoting
      let piv = c; for (let r2 = c + 1; r2 < p; r2++) if (Math.abs(A[r2][c]) > Math.abs(A[piv][c])) piv = r2;
      [A[c], A[piv]] = [A[piv], A[c]];
      const d = A[c][c] || 1e-12;
      for (let j = c; j <= p; j++) A[c][j] /= d;
      for (let r2 = 0; r2 < p; r2++) if (r2 !== c) { const f = A[r2][c]; for (let j = c; j <= p; j++) A[r2][j] -= f * A[c][j]; }
    }
    return A.map((row) => row[p]);
  }
  const dot = (w, x) => w.reduce((s, wi, i) => s + wi * x[i], 0);
  function indexAtDistance(ev, D) { const b = ev.brt; for (let i = 0; i < b.length; i++) if (b[i].n1_distance <= D) return i; return -1; }

  function trainForecaster(events, cfg = DEFAULTS) {
    const model = { version: VERSION, checkpoints: {}, trainedOn: events.length };
    for (const two of [true, false]) {
      const key = two ? 'twoSensors' : 'oneSensor';
      model.checkpoints[key] = [];
      for (const D of CHECKPOINTS) {
        const X = [], Xa = [], yv = [], ya = [];
        for (const ev of events) {
          const i = indexAtDistance(ev, D);
          if (i < 0) continue;
          const o = observe(ev, i, cfg, two);
          X.push(featV(o, two)); yv.push(Math.log(ev.impact.contactVelocity));
          Xa.push(featA(o, two)); ya.push(ev.impact.contactAngle);
        }
        if (X.length < 15) continue;
        const wv = solveRidge(X, yv), wa = solveRidge(Xa, ya);
        const rv = X.map((x, n) => yv[n] - dot(wv, x)), ra = Xa.map((x, n) => ya[n] - dot(wa, x));
        const sv = Math.sqrt(mean(rv.map((e) => e * e)) * X.length / Math.max(1, X.length - X[0].length));
        const sa = Math.sqrt(mean(ra.map((e) => e * e)) * Xa.length / Math.max(1, Xa.length - Xa[0].length));
        model.checkpoints[key].push({ D, wv, wa, sv, sa, n: X.length });
      }
    }
    return model;
  }
  function pickCheckpoint(model, two, d) {
    const list = model.checkpoints[two ? 'twoSensors' : 'oneSensor'];
    let best = list[0];
    for (const c of list) if (Math.abs(c.D - d) < Math.abs(best.D - d)) best = c;
    return best;
  }
  /** Probabilistic forecast at observation index idx (uses only BRT/env samples up to idx). */
  function forecastAt(model, ev, idx, cfg = DEFAULTS, fender = makeFender(cfg.fender), two = true, nSamples = 400, seed = 7) {
    const o = observe(ev, idx, cfg, two);
    const c = pickCheckpoint(model, two, o.distance);
    const muV = dot(c.wv, featV(o, two)), muA = dot(c.wa, featA(o, two));
    const r = makeRng(seed + idx);
    const vp = vesselParticulars(VESSELS.find((v) => v.id === ev.meta.vessel.id), ev.meta.vessel.laden, cfg.berth.waterDensity);
    const S = [];
    for (let k = 0; k < nSamples; k++) {
      const v = Math.exp(muV + c.sv * r.normal()), a = Math.abs(muA + c.sa * r.normal());
      const x = impactChain(vp, v, a, cfg, fender, 0.08 * r.normal());
      S.push({ v, a, ...x });
    }
    const q = (key, p) => quantile(S.map((s) => s[key]).sort((x, y) => x - y), p);
    const pr = (f) => S.filter(f).length / S.length;
    const A = cfg.alert, Er = fender.ratedEnergy, dl = cfg.wharf.displacementLimit;
    const probs = {
      energyCaution: pr((s) => s.energy >= A.energyCaution * Er), energyWarning: pr((s) => s.energy >= A.energyWarning * Er),
      energyCritical: pr((s) => s.energy >= A.energyCritical * Er || s.bottomed), dispWarning: pr((s) => s.displacement >= A.dispWarning * dl),
      dispCritical: pr((s) => s.displacement >= A.dispCritical * dl), angleCaution: pr((s) => s.a >= A.angleCaution), angleWarning: pr((s) => s.a >= A.angleWarning),
    };
    const P = A.probability;
    let level = 0;
    if (probs.energyCaution >= P || probs.angleCaution >= P) level = 1;
    if (probs.energyWarning >= P || probs.dispWarning >= P || probs.angleWarning >= P) level = 2;
    if (probs.energyCritical >= P || probs.dispCritical >= P) level = 3;
    const pct = (key) => ({ p10: q(key, 0.1), p50: q(key, 0.5), p90: q(key, 0.9) });
    return { t: ev.brt[idx].t, ts: ev.brt[idx].ts, distance: o.distance, observed: o, checkpoint: c.D, twoSensors: two,
      velocity: pct('v'), angle: pct('a'), energy: pct('energy'), reaction: pct('reaction'), displacement: pct('displacement'), deflectionRatio: pct('deflectionRatio'),
      probs, level, levelName: LEVELS[level], recommendation: recommendation(level, probs, o, cfg) };
  }
  function recommendation(level, probs, o, cfg) {
    if (level === 3) return 'NGUY HIỂM: dự báo vượt năng lượng/lực định mức đệm hoặc chuyển vị cho phép — yêu cầu tàu lai hãm ngay, giảm vận tốc tiến vào bến, cân nhắc dừng cập.';
    if (level === 2) return 'CẢNH BÁO: nguy cơ cao vượt ngưỡng — giảm vận tốc tiến vào bến, chỉnh góc cập song song mép bến, theo dõi sát.';
    if (level === 1) return 'CHÚ Ý: năng lượng hoặc góc cập dự báo tăng — duy trì vận tốc thấp, theo dõi.';
    return 'BÌNH THƯỜNG: tiếp tục theo dõi.';
  }

  /** Validation on held-out events: forecast accuracy, 80 % interval coverage, alert performance. */
  function validateForecaster(model, events, cfg = DEFAULTS, two = true) {
    const fender = makeFender(cfg.fender);
    const rows = [];
    for (const D of CHECKPOINTS) {
      const errs = [], cover = [], lvl = [], aerr = [], angHit = [];
      for (const ev of events) {
        const i = indexAtDistance(ev, D);
        if (i < 0) continue;
        const f = forecastAt(model, ev, i, cfg, fender, two, 200, 11);
        const vc = ev.impact.contactVelocity;
        errs.push(Math.abs(f.velocity.p50 - vc));
        cover.push(vc >= f.velocity.p10 && vc <= f.velocity.p90 ? 1 : 0);
        lvl.push([ev.impact.level, f.level]);
        aerr.push(Math.abs(f.angle.p50 - ev.impact.contactAngle));
        if (ev.impact.contactAngle >= cfg.alert.angleCaution) angHit.push(f.probs.angleCaution >= cfg.alert.probability ? 1 : 0);
      }
      const hit = lvl.filter(([a]) => a >= 2), fa = lvl.filter(([a]) => a < 2);
      rows.push({ D, n: errs.length, maeVelocity: mean(errs), coverage80: mean(cover), maeAngle: mean(aerr), angleDetection: angHit.length ? mean(angHit) : NaN,
        detection: hit.length ? hit.filter(([, p]) => p >= 2).length / hit.length : NaN,
        falseAlarm: fa.length ? fa.filter(([, p]) => p >= 2).length / fa.length : NaN, eventsWarnCrit: hit.length });
    }
    return rows;
  }
  function splitEvents(events, testShare = 0.3, seed = 99) {
    const r = makeRng(seed), idx = events.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const nTest = Math.round(events.length * testShare), test = new Set(idx.slice(0, nTest));
    return { train: events.filter((_, i) => !test.has(i)), test: events.filter((_, i) => test.has(i)) };
  }

  // ------------------------------------------------------------------ export helpers (port-shm style channel names)
  function toCSV(rows) { if (!rows.length) return ''; const c = Object.keys(rows[0]); const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }; return c.join(',') + '\n' + rows.map((r) => c.map((k) => esc(r[k])).join(',')).join('\n') + '\n'; }
  function datasetTables(ds) {
    const events = [], brt = [], env = [], sensors = [];
    for (const ev of ds.events) {
      const m = ev.meta, im = ev.impact;
      events.push({ event_id: m.eventId, scenario: m.scenario, start: m.start, contact_time: ev.measured.ts, vessel_id: m.vessel.id, vessel_type: m.vessel.type, DWT: m.vessel.DWT,
        LOA_m: m.vessel.LOA, B_m: m.vessel.B, T_m: m.vessel.T, Cb: m.vessel.Cb, displacement_t: m.vessel.displacement, laden: m.vessel.laden, tugs: m.tugs, brt_range_m: m.brtRange,
        contact_velocity_mps: +im.contactVelocity.toFixed(4), contact_angle_deg: +im.contactAngle.toFixed(2), energy_kJ: +im.energy.toFixed(1), Cm: +im.Cm.toFixed(3), Ce: +im.Ce.toFixed(3),
        fender_deflection_m: +im.deflection.toFixed(3), fender_reaction_kN: +im.reaction.toFixed(1), wharf_displacement_mm: +im.displacement.toFixed(3), risk_level: im.levelName });
      for (const b of ev.brt) brt.push({ event_id: m.eventId, timestamp: b.ts, t_s: b.t, 'WH-P1-BRT-N1.distance_m': b.n1_distance, 'WH-P1-BRT-N1.velocity_cms': b.n1_velocity,
        'WH-P1-BRT-N2.distance_m': b.n2_distance, 'WH-P1-BRT-N2.velocity_cms': b.n2_velocity, 'BRT.angle_deg': b.angle });
      for (const e of ev.env) env.push({ event_id: m.eventId, timestamp: e.ts, t_s: e.t, 'ENV-WIND-N1.speed_ms': e.windSpeed, 'ENV-WIND-N1.from_deg': e.windFrom,
        'ENV-CUR-N1.speed_ms': e.currentSpeed, 'ENV-CUR-N1.to_deg': e.currentTo, 'ENV-WAVE-N1.hs_m': e.hs, 'ENV-WAVE-N1.tp_s': e.tp, 'ENV-TIDE-N1.level_m': e.tide });
      const s = ev.measured;
      sensors.push({ event_id: m.eventId, timestamp: s.ts, 'WH-P1-FND-N1.value_kN': s.fnd, 'WH-P1-DSP-N1.dx_mm': s.dsp_dx, 'WH-P1-DSP-N1.dy_mm': s.dsp_dy, 'WH-P1-DSP-N1.dz_mm': s.dsp_dz,
        'WH-P1-ACC-N2.peak_ms2': s.acc_peak, 'WH-P1-STR-N2.value_ue': s.str });
    }
    return { events, brt, env, sensors };
  }
  function assumptionsText(cfg = DEFAULTS, fender = makeFender(cfg.fender)) {
    const de = designEnergy(cfg);
    return [
      `Live Berthing demo ${VERSION} — ALL VALUES ARE ILLUSTRATIVE DEFAULTS`,
      `Berth: ${cfg.berth.name}; seaward normal ${cfg.berth.seawardNormalDeg}°N; BRT spacing ${cfg.berth.brtSpacing} m; pick-up range ${cfg.berth.brtRangeMin}–${cfg.berth.brtRangeMax} m (shorter in strong current)`,
      `Design vessel: ${de.vessel.type} ${de.vessel.DWT} DWT, Δ ${Math.round(de.vessel.displacement)} t; design velocity ${cfg.berth.designVelocity} m/s; Cab ${cfg.berth.abnormalFactor}`,
      `Design energy: normal ${de.normal.toFixed(0)} kJ, abnormal ${de.abnormal.toFixed(0)} kJ (Cm ${de.Cm.toFixed(2)}, Ce ${de.Ce.toFixed(2)})`,
      `Fender: ${fender.type}; Er ${fender.ratedEnergy} kJ, Rr ${fender.ratedReaction} kN at ${Math.round(100 * fender.ratedDeflection)}% deflection; equivalent height H ${fender.H.toFixed(2)} m`,
      `Energy: E = ½·M·v²·Cm·Ce·Cs·Cc; Cm = 1 + 2T/B; Ce radius-of-gyration, quarter-point contact; Cs = Cc = 1`,
      `Wharf: δ = F/K, K ${cfg.wharf.stiffness} kN/mm (±8 % model error); allowable δ ${cfg.wharf.displacementLimit} mm  ← replace with the calibrated force–displacement model`,
      `Alerts: level raised when P(exceedance) ≥ ${Math.round(100 * cfg.alert.probability)} %; energy thresholds ${cfg.alert.energyCaution}/${cfg.alert.energyWarning}/${cfg.alert.energyCritical} × Er; displacement ${cfg.alert.dispWarning}/${cfg.alert.dispCritical} × limit; angle ${cfg.alert.angleCaution}°/${cfg.alert.angleWarning}°`,
    ].join('\n');
  }

  return { VERSION, LEVELS, VESSELS, FENDER_CURVE, DEFAULTS, SCENARIOS, CHECKPOINTS, makeRng, vesselParticulars, berthingEnergy, designEnergy, makeFender,
    wharfDisplacement, impactChain, levelFromValues, simulateEvent, generateDataset, observe, trainForecaster, forecastAt, validateForecaster, splitEvents,
    indexAtDistance, datasetTables, toCSV, assumptionsText };
});
