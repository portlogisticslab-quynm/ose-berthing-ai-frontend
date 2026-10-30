/* Berthing AI — "Live Berthing" demo tab (3.6.0-demo).
 * Replays synthetic berthing events as if they were streaming from port-shm, forecasts the contact
 * state with uncertainty and propagates it through energy → fender → wharf displacement → alert.
 * All data are synthetic and all parameters illustrative (see LiveBerthingCore.assumptionsText()).
 */
'use strict';
const LB = window.LiveBerthingCore;
const LIVE = { ds: null, split: null, model: null, two: true, ev: null, idx: 0, timer: null, speed: 30, series: [], fender: LB.makeFender(), cfg: LB.DEFAULTS, live: null };
const $ = (id) => document.getElementById(id);
const fmt = (x, n = 2) => (Number.isFinite(Number(x)) ? Number(x).toFixed(n) : '—');
const LEVEL_TXT = { Normal: 'Bình thường', Caution: 'Chú ý', Warning: 'Cảnh báo', Critical: 'Nguy hiểm' };

function liveSetStatus(msg, isErr = false) { const el = $('liveStatus'); if (el) { el.textContent = msg; el.classList.toggle('st-error', isErr); } logMsg('[Live] ' + msg); }

// ------------------------------------------------------------------ dataset + model
async function liveGenerate() {
  const n = clamp(Number($('liveCount').value) || 150, 20, 400), seed = Number($('liveSeed').value) || 20261101;
  setWait('Live Berthing', `Generating ${n} synthetic berthing events...`, 20);
  await new Promise((r) => setTimeout(r, 40));
  try {
    LIVE.ds = LB.generateDataset({ count: n, seed });
    liveAfterDataset(`Generated ${n} synthetic events (seed ${seed}).`);
  } finally { hideWait(); }
}
function liveAfterDataset(msg) {
  LIVE.split = LB.splitEvents(LIVE.ds.events, 0.3, 99);
  LIVE.model = LB.trainForecaster(LIVE.split.train, LIVE.cfg);
  const testIds = new Set(LIVE.split.test.map((e) => e.meta.eventId));
  const sel = $('liveEvent');
  sel.replaceChildren(...LIVE.ds.events.filter((e) => testIds.has(e.meta.eventId)).map((e) => {
    const o = document.createElement('option'); o.value = e.meta.eventId;
    o.textContent = `${e.meta.eventId} · ${e.meta.vessel.type} ${e.meta.vessel.DWT / 1000}k DWT · ${e.meta.scenario} · ${LEVEL_TXT[e.impact.levelName]}`;
    return o;
  }));
  const cnt = (k) => LIVE.ds.events.filter((e) => e.impact.levelName === k).length;
  liveSetStatus(`${msg} Outcome levels: ${LB.LEVELS.map((l) => `${l} ${cnt(l)}`).join(', ')}. Forecaster trained on ${LIVE.split.train.length} events; ${LIVE.split.test.length} unseen test events available for replay.`);
  liveValidate();
  liveSelect();
  if (typeof window.onLiveDataset === 'function') window.onLiveDataset();
}
function liveValidate() {
  const lines = [`FORECASTER VALIDATION — ${LIVE.split.test.length} unseen test events (${LIVE.two ? '2 BRT sensors' : '1 BRT sensor'})`,
    'Dist(m)  MAE v(cm/s)  80%-band coverage  MAE angle(°)  Warning/Critical detected  False alarms'];
  for (const r of LB.validateForecaster(LIVE.model, LIVE.split.test, LIVE.cfg, LIVE.two)) {
    lines.push(`${String(r.D).padStart(6)}   ${fmt(100 * r.maeVelocity, 2).padStart(8)}   ${(fmt(100 * r.coverage80, 0) + ' %').padStart(10)}        ${fmt(r.maeAngle, 2).padStart(6)}       ${Number.isFinite(r.detection) ? (fmt(100 * r.detection, 0) + ' %').padStart(6) : '   n/a'} (${r.eventsWarnCrit} ev.)          ${Number.isFinite(r.falseAlarm) ? fmt(100 * r.falseAlarm, 0) + ' %' : 'n/a'}`);
  }
  lines.push('', 'Detection = share of Warning/Critical outcomes already flagged ≥ Warning at that distance.',
    'Late-braking and gust events typically become detectable only in the last 10–50 m — the lead time is short,', 'so real-time alerts must reach the berthing master / pilot, not only the port manager.');
  $('liveValidation').textContent = lines.join('\n');
}
function liveSelect() {
  pauseLive();
  if (SHM.enabled) SHM.eventId = '';   // a new session starts at the next ▶
  const id = $('liveEvent').value;
  LIVE.ev = LIVE.ds?.events.find((e) => e.meta.eventId === id) || null;
  if (!LIVE.ev) return;
  LIVE.idx = 0;
  // precompute the forecast every 5 s (only past data are used at each step)
  LIVE.series = [];
  const b = LIVE.ev.brt;
  // One forecast every 5 s of event time (400 Monte Carlo samples). This single series drives the forecast cards, the plan view,
  // the alert log and the frames sent to Port-SHM, so both apps always show identical numbers.
  for (let i = 0; i < b.length; i += 5) LIVE.series.push(LB.forecastAt(LIVE.model, LIVE.ev, i, LIVE.cfg, LIVE.fender, LIVE.two, 400, 3));
  if ((b.length - 1) % 5) LIVE.series.push(LB.forecastAt(LIVE.model, LIVE.ev, b.length - 1, LIVE.cfg, LIVE.fender, LIVE.two, 400, 3));
  applyHysteresis(LIVE.series);
  const slider = $('liveSlider'); slider.max = String(b.length - 1); slider.value = '0';
  liveRender();
}

/** Alert hysteresis: escalate immediately, de-escalate only after the lower level has held for HOLD_S seconds
 *  (avoids flapping messages to the port manager). Adds .alertLevel / .alertName to every series point. */
const HOLD_S = 30;
function applyHysteresis(series) {
  let cur = 0, lowSince = null;
  for (const s of series) {
    if (s.level >= cur) { cur = s.level; lowSince = null; }
    else { lowSince ??= s.t; if (s.t - lowSince >= HOLD_S) { cur = s.level; lowSince = null; } }
    s.alertLevel = cur; s.alertName = LB.LEVELS[cur];
  }
}
const alertAt = (t) => { let a = LIVE.series[0]; for (const s of LIVE.series) { if (s.t <= t) a = s; else break; } return a; };

// ------------------------------------------------------------------ Port-SHM relay (simulation, opt-in)
/* Every forecast frame (one per 5 s of event time, the same series that drives the alert log) is queued while the
 * replay is PLAYING and sent in batches (≤ 100 frames, ~1 request/s) through the Berthing AI backend relay, which
 * holds the Port-SHM gateway key. The contact outcome is sent with the last batch. Failed batches are retried with
 * back-off, so nothing is skipped at high replay speeds. Scrubbing/previewing never sends anything. */
const SHM = { enabled: false, token: '', session: '', eventId: '', queue: [], sentUpTo: -1, contactQueued: false,
  busy: false, sent: 0, expected: 0, fail: 0, nextTry: 0, lastStart: 0, lastLagMs: null, lastResult: '', note: '' };
const SHM_BATCH = 100, SHM_MIN_GAP_MS = 600;   // ≤ 100 requests/min → below the relay (300/min) and Port-SHM gateway (120/min) limits
let shmTimer = null;
function shmStatus(msg, isErr = false) { const e = $('liveShmStatus'); if (e) { e.textContent = msg; e.classList.toggle('st-error', isErr); } }
function shmSummary() {
  const lag = SHM.lastLagMs !== null ? ` · trễ gửi ${(SHM.lastLagMs / 1000).toFixed(1)} s` : '';
  return `Port-SHM – phiên ${SHM.session}: đã gửi ${SHM.sent}/${SHM.expected} bản tin${SHM.queue.length ? ` · chờ gửi ${SHM.queue.length}` : ''}${lag}${SHM.note ? ' · ' + SHM.note : ''}${SHM.lastResult ? ' · ' + SHM.lastResult : ''}`;
}
function shmNewSession() {
  SHM.session = 'sim_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  SHM.eventId = LIVE.ev?.meta.eventId || ''; SHM.sentUpTo = -1; SHM.contactQueued = false; SHM.lastResult = '';
  SHM.sent = 0; SHM.expected = LIVE.series.length + 1; SHM.lastLagMs = null; SHM.note = '';   // counters are per session
}
function shmFrame(s) {
  const Er = LIVE.fender.ratedEnergy;
  return { kind: 'frame', body: { source: 'berthing-ai', mode: 'simulation', session_id: SHM.session, event_id: SHM.eventId,
    structure_code: 'WH-P1', elapsed_s: s.t, event_ts: s.ts, distance_m: +Math.max(0, s.distance).toFixed(2),
    displacement_p50_mm: +s.displacement.p50.toFixed(3), displacement_p90_mm: +Math.max(s.displacement.p90, s.displacement.p50).toFixed(3),
    displacement_limit_mm: LIVE.cfg.wharf.displacementLimit, probability_exceedance: +s.probs.dispCritical.toFixed(4),
    alert_level: s.alertName, forecast_level: s.levelName, sensors: LIVE.two ? '2xBRT' : '1xBRT',
    velocity_p50_cms: +(100 * s.velocity.p50).toFixed(2), velocity_p90_cms: +(100 * s.velocity.p90).toFixed(2),
    ...(LIVE.two ? { angle_p50_deg: +s.angle.p50.toFixed(2) } : {}),
    energy_p90_kj: +s.energy.p90.toFixed(1), energy_ratio_p90: +(s.energy.p90 / Er).toFixed(4), reaction_p90_kn: +s.reaction.p90.toFixed(1),
    prob_energy_warning: +s.probs.energyWarning.toFixed(4), prob_energy_critical: +s.probs.energyCritical.toFixed(4) } };
}
function shmContact() {
  const ev = LIVE.ev, im = ev.impact, ms = ev.measured, b = ev.brt, last = b[b.length - 1];
  return { kind: 'contact', body: { source: 'berthing-ai', mode: 'simulation', session_id: SHM.session, event_id: SHM.eventId,
    structure_code: 'WH-P1', elapsed_s: last.t, event_ts: ms.ts, vessel: `${ev.meta.vessel.type} ${ev.meta.vessel.DWT / 1000}k DWT`,
    scenario: ev.meta.scenario, contact_velocity_cms: +(100 * im.contactVelocity).toFixed(2), contact_angle_deg: +im.contactAngle.toFixed(2),
    energy_kj: +im.energy.toFixed(1), energy_ratio: +(im.energy / LIVE.fender.ratedEnergy).toFixed(4), reaction_kn: +im.reaction.toFixed(1),
    displacement_mm: +im.displacement.toFixed(3), ...(Number.isFinite(ms.fnd) ? { measured_reaction_kn: ms.fnd } : {}),
    ...(Number.isFinite(ms.dsp_dx) ? { measured_dx_mm: ms.dsp_dx } : {}), displacement_limit_mm: LIVE.cfg.wharf.displacementLimit,
    actual_level: im.levelName, alert_level_issued: alertAt(last.t)?.alertName || 'Normal' } };
}
/** Queue the frames that became "known" up to the current replay time (called only while playing). */
function shmCollect() {
  if (!SHM.enabled || !LIVE.ev || SHM.eventId !== LIVE.ev.meta.eventId) return;
  const tNow = LIVE.ev.brt[LIVE.idx].t;
  const at = Date.now();
  for (const s of LIVE.series) if (s.t > SHM.sentUpTo && s.t <= tNow) { SHM.queue.push({ ...shmFrame(s), at }); SHM.sentUpTo = s.t; }
  if (LIVE.idx >= LIVE.ev.brt.length - 1 && !SHM.contactQueued) { SHM.queue.push({ ...shmContact(), at }); SHM.contactQueued = true; }
  shmSchedule();
}
/** Send as soon as allowed: at most one request in flight and ≥ SHM_MIN_GAP_MS between request starts. */
function shmSchedule() {
  if (!SHM.enabled || !SHM.queue.length || shmTimer) return;
  const wait = Math.max(0, SHM.nextTry - Date.now(), SHM.lastStart + SHM_MIN_GAP_MS - Date.now());
  shmTimer = setTimeout(() => { shmTimer = null; void shmFlush(); }, wait);
}
async function shmFlush() {
  if (!SHM.enabled || SHM.busy || !SHM.queue.length) return;
  if (Date.now() < SHM.nextTry || Date.now() < SHM.lastStart + SHM_MIN_GAP_MS) { shmSchedule(); return; }
  const base = (window.APP_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
  if (!base) { shmStatus('Chưa cấu hình API_BASE_URL (config.js)', true); return; }
  // one batch = frames of ONE session (+ that session's contact if it is next in the queue)
  const sid = SHM.queue[0].body.session_id, batch = [];
  for (const q of SHM.queue) { if (q.body.session_id !== sid || batch.length >= SHM_BATCH) break; batch.push(q); if (q.kind === 'contact') break; }
  const frames = batch.filter((q) => q.kind === 'frame').map((q) => q.body), contact = batch.find((q) => q.kind === 'contact')?.body;
  SHM.busy = true; SHM.lastStart = Date.now();
  try {
    const r = await fetch(base + '/api/port-shm/forecast/batch', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': SHM.token }, body: JSON.stringify({ frames, ...(contact ? { contact } : {}) }) });
    let j = {}; try { j = await r.json(); } catch { /* non-JSON */ }
    if (r.ok) {
      SHM.queue.splice(0, batch.length); SHM.sent += frames.length + (contact ? 1 : 0); SHM.fail = 0; SHM.nextTry = 0; SHM.note = '';
      SHM.lastLagMs = Date.now() - Math.min(...batch.map((q) => q.at));
      if (j.contact?.outcome) {
        const OUT = { warned: 'đã cảnh báo trước', missed: 'KHÔNG cảnh báo kịp', false_alarm: 'cảnh báo thừa', ok: 'bình thường' };
        SHM.lastResult = `kết quả chạm bến đã gửi (${OUT[j.contact.outcome] || j.contact.outcome})`;
      }
      shmStatus(shmSummary());
    } else if (r.status === 401 || r.status === 503) {
      SHM.enabled = false; const cb = $('liveShmEnabled'); if (cb) cb.checked = false;
      shmStatus(`Port-SHM: ${r.status === 401 ? 'Relay Token sai' : 'relay chưa bật trên server'} (HTTP ${r.status}) – đã tắt gửi.`, true);
    } else if (r.status === 429) {
      // rate limit: wait exactly what the server asks (Retry-After), no exponential back-off, not an error
      const ra = Number(r.headers.get('Retry-After')) || 2;
      SHM.nextTry = Date.now() + Math.min(10, Math.max(1, ra)) * 1000;
      SHM.note = `đang chờ giới hạn tốc độ ${Math.min(10, Math.max(1, ra))} s`;
      shmStatus(shmSummary());
    } else if (r.status === 422 || r.status === 413) {
      SHM.queue.splice(0, batch.length); SHM.fail++;
      shmStatus(`Port-SHM từ chối lô ${batch.length} bản tin (HTTP ${r.status}): ${String(j.detail ? JSON.stringify(j.detail) : '').slice(0, 160)}`, true);
    } else throw new Error(`HTTP ${r.status} ${String(j.detail || '').slice(0, 120)}`);
  } catch (err) {
    SHM.fail++; SHM.nextTry = Date.now() + Math.min(15000, 1000 * 2 ** Math.min(SHM.fail - 1, 4));
    shmStatus(`Port-SHM lỗi (${SHM.fail}): ${err.message} – sẽ gửi lại, đang chờ ${SHM.queue.length} bản tin.`, true);
  } finally { SHM.busy = false; shmSchedule(); }
}

// ------------------------------------------------------------------ player
function playLive() {
  if (!LIVE.ev) throw new Error('Generate or load a dataset and select an event first.');
  if (LIVE.timer) return;
  if (LIVE.idx >= LIVE.ev.brt.length - 1) LIVE.idx = 0;
  if (SHM.enabled && (LIVE.idx === 0 || SHM.eventId !== LIVE.ev.meta.eventId)) shmNewSession();
  LIVE.timer = setInterval(() => {
    LIVE.idx = Math.min(LIVE.ev.brt.length - 1, LIVE.idx + Math.max(1, Math.round(LIVE.speed / 5)));
    $('liveSlider').value = String(LIVE.idx);
    liveRender();
    shmCollect();
    if (LIVE.idx >= LIVE.ev.brt.length - 1) pauseLive();
  }, 200);
}
function pauseLive() { if (LIVE.timer) clearInterval(LIVE.timer); LIVE.timer = null; }
function resetLive() { pauseLive(); LIVE.idx = 0; $('liveSlider').value = '0'; liveRender(); }

// ------------------------------------------------------------------ rendering
function card(label, metric, value, unit, sub = '', cls = '') {
  return `<div class="shm-card ${cls}"><div class="shm-head"><span>${escapeHtml(label)}</span><span>${escapeHtml(metric)}</span></div>
    <div class="shm-val">${escapeHtml(value)}<small>${escapeHtml(unit)}</small></div><div class="shm-sub">${escapeHtml(sub)}</div></div>`;
}
function liveRender() {
  const ev = LIVE.ev; if (!ev) return;
  const b = ev.brt, i = LIVE.idx, now = b[i], done = i >= b.length - 1;
  const f = alertAt(now.t) || LB.forecastAt(LIVE.model, ev, i, LIVE.cfg, LIVE.fender, LIVE.two, 400, 3);   // latest 5-s forecast
  LIVE.live = f;
  const al = alertAt(now.t), lvl = al?.alertName || f.levelName;
  const e = f.observed.env, Er = LIVE.fender.ratedEnergy, dl = LIVE.cfg.wharf.displacementLimit;
  const m = ev.meta;
  // banner
  const banner = $('liveBanner');
  banner.className = `live-banner lvl-${lvl}`;
  banner.innerHTML = `<span class="badge ${lvl}">${LEVEL_TXT[lvl]}</span>
    <b>${escapeHtml(m.eventId)}</b> · ${escapeHtml(m.vessel.type)} ${m.vessel.DWT.toLocaleString()} DWT (${m.vessel.laden ? 'đầy tải' : 'ballast'}, Δ ${m.vessel.displacement.toLocaleString()} t, ${m.tugs} tàu lai)
    · t = ${now.t} s · cách bến ${fmt(Math.max(0, now.n1_distance), 1)} m<br>${escapeHtml(al && al.alertLevel > f.level ? `${LEVEL_TXT[lvl].toUpperCase()} (giữ mức cảnh báo): dự báo mới nhất là "${LEVEL_TXT[f.levelName]}" — chỉ hạ mức khi ổn định ≥ ${HOLD_S} s. ${f.recommendation}` : f.recommendation)}`;
  // port-shm style sensor cards
  const sub = `Trực tuyến · ${new Date(now.ts).toLocaleTimeString()}`;
  $('liveSensors').innerHTML = [
    card('WH-P1-BRT-N1', 'distance', fmt(Math.max(0, now.n1_distance), 1), ' m', sub, 'ok'),
    card('WH-P1-BRT-N1', 'velocity', fmt(now.n1_velocity, 2), ' cm/s', sub, 'ok'),
    LIVE.two ? card('WH-P1-BRT-N2', 'angle', fmt(now.angle, 1), '°', sub, 'ok') : card('WH-P1-BRT-N2', 'angle', '—', '', 'Chế độ 1 cảm biến: không đo góc', 'off'),
    card('ENV-WIND-N1', 'speed / from', `${fmt(e.windSpeed, 1)} / ${fmt(e.windFrom, 0)}°`, ' m/s', `Thành phần hướng vào bến ${fmt(f.observed.windOn, 1)} m/s`, 'ok'),
    card('ENV-CUR-N1', 'speed / to', `${fmt(e.currentSpeed, 2)} / ${fmt(e.currentTo, 0)}°`, ' m/s', `Thành phần hướng vào bến ${fmt(f.observed.curOn, 2)} m/s`, 'ok'),
    card('ENV-WAVE-N1', 'Hs / Tp', `${fmt(e.hs, 2)} / ${fmt(e.tp, 1)}`, ' m / s', sub, 'ok'),
    card('ENV-TIDE-N1', 'level', fmt(e.tide, 2), ' m', sub, 'ok'),
    done ? card('WH-P1-FND-N1', 'value (đo)', fmt(ev.measured.fnd, 1), ' kN', 'Theo sự kiện · khi chạm bến', 'ok') : card('WH-P1-FND-N1', 'value', '—', '', 'Chờ sự kiện chạm bến', 'off'),
    done ? card('WH-P1-DSP-N1', 'dx (đo)', fmt(ev.measured.dsp_dx, 2), ' mm', 'Theo sự kiện · khi chạm bến', 'ok') : card('WH-P1-DSP-N1', 'dx', '—', '', 'Chờ sự kiện chạm bến', 'off'),
  ].join('');
  // forecast cards
  const pE = (x) => `${fmt(x, 0)} kJ (${fmt((100 * x) / Er, 0)} % Er)`;
  $('liveForecast').innerHTML = [
    card('Dự báo vận tốc cập', 'P50 [P10–P90]', `${fmt(100 * f.velocity.p50, 1)}`, ' cm/s', `[${fmt(100 * f.velocity.p10, 1)} – ${fmt(100 * f.velocity.p90, 1)}] · thiết kế ${fmt(100 * LIVE.cfg.berth.designVelocity, 0)} cm/s`, 'fc'),
    card('Dự báo góc cập', 'P50 [P10–P90]', fmt(f.angle.p50, 1), '°', `[${fmt(f.angle.p10, 1)} – ${fmt(f.angle.p90, 1)}]${LIVE.two ? '' : ' · không đo góc'}`, 'fc'),
    card('Năng lượng cập (PIANC)', 'P50 / P90', pE(f.energy.p50), '', `P90 ${pE(f.energy.p90)} · P(≥0,85 Er) ${fmt(100 * f.probs.energyWarning, 0)} %`, 'fc'),
    card('Phản lực đệm', 'P50 / P90', `${fmt(f.reaction.p50, 0)} / ${fmt(f.reaction.p90, 0)}`, ' kN', `Rr ${LIVE.fender.ratedReaction} kN · độ nén P90 ${fmt(100 * f.deflectionRatio.p90, 0)} %`, 'fc'),
    card('Chuyển vị bến', 'P50 / P90', `${fmt(f.displacement.p50, 1)} / ${fmt(f.displacement.p90, 1)}`, ' mm', `Giới hạn ${dl} mm · P(≥ giới hạn) ${fmt(100 * f.probs.dispCritical, 0)} %`, 'fc'),
  ].join('');
  // charts
  drawLiveVelocity(ev, i, f, done);
  drawLiveProbability(i);
  drawLiveFender(f, done ? ev.impact : null);
  drawLivePlan(ev, i, f, done, lvl);
  if (typeof window.renderLiveAnimation === 'function') window.renderLiveAnimation();
  renderLiveState(ev, i, f, done, lvl);
  // alert log (level changes up to now)
  const log = [], series = LIVE.series.filter((s) => s.t <= now.t);
  let prev = -1;
  for (const s of series) { if (s.alertLevel !== prev) { log.push(s); prev = s.alertLevel; } }
  $('liveAlerts').textContent = log.length
    ? log.map((s) => `${new Date(s.ts).toLocaleTimeString()}  d=${fmt(Math.max(0, s.distance), 0).padStart(4)} m  ${s.alertName.padEnd(8)}  P(E≥0,85Er)=${fmt(100 * s.probs.energyWarning, 0)}%  P(E≥Er)=${fmt(100 * s.probs.energyCritical, 0)}%  P(δ≥lim)=${fmt(100 * s.probs.dispCritical, 0)}%`).join('\n')
    : 'Chưa có cảnh báo.';
  // outcome comparison
  if (done) {
    const im = ev.impact, ms = ev.measured, at = (D) => { const k = LB.indexAtDistance(ev, D); return k < 0 ? null : LB.forecastAt(LIVE.model, ev, k, LIVE.cfg, LIVE.fender, LIVE.two, 400, 5); };
    const rows = [[200, at(200)], [50, at(50)], [20, at(20)], [5, at(5)]].filter((x) => x[1]);
    $('liveOutcome').textContent =
`KẾT QUẢ KHI CHẠM BẾN (giá trị "thực" của sự kiện giả định)
Vận tốc cập ${fmt(100 * im.contactVelocity, 2)} cm/s · góc ${fmt(im.contactAngle, 1)}° · năng lượng ${fmt(im.energy, 0)} kJ (${fmt((100 * im.energy) / Er, 0)} % Er, Cm ${fmt(im.Cm, 2)}, Ce ${fmt(im.Ce, 2)})
Phản lực đệm tính ${fmt(im.reaction, 0)} kN · "đo" FND ${fmt(ms.fnd, 0)} kN · chuyển vị tính ${fmt(im.displacement, 2)} mm · "đo" DSP dx ${fmt(ms.dsp_dx, 2)} mm
Mức rủi ro thực tế: ${im.levelName} (${LEVEL_TXT[im.levelName]}) · kịch bản: ${m.scenario}

Dự báo trước đó:
${rows.map(([D, x]) => `  tại ${String(D).padStart(3)} m: v P50 ${fmt(100 * x.velocity.p50, 1)} cm/s [${fmt(100 * x.velocity.p10, 1)}–${fmt(100 * x.velocity.p90, 1)}] · E P90 ${fmt(x.energy.p90, 0)} kJ · mức ${x.levelName}`).join('\n')}`;
  } else $('liveOutcome').textContent = 'Kết quả sẽ hiện khi tàu chạm bến.';
  $('liveTime').textContent = `${now.t} / ${b[b.length - 1].t} s`;
}

function axes(ctx, w, h, X, Y, xt, yt, xl, yl) {
  ctx.strokeStyle = '#e2e8f0'; ctx.fillStyle = '#64748b'; ctx.font = '11px Segoe UI'; ctx.lineWidth = 1;
  for (const v of yt) { const y = Y(v); ctx.beginPath(); ctx.moveTo(44, y); ctx.lineTo(w - 10, y); ctx.stroke(); ctx.fillText(String(v), 4, y + 4); }
  for (const v of xt) { const x = X(v); ctx.fillText(String(v), x - 8, h - 8); }
  ctx.fillText(xl, w - 10 - ctx.measureText(xl).width, h - 20); if (yl) ctx.fillText(yl, 48, 14);
}

// ------------------------------------------------------------------ plan view (real-time trajectory, like the Animation tab)
const LEVEL_COLOR = { Normal: '#059669', Caution: '#ca8a04', Warning: '#ea580c', Critical: '#dc2626' };
const FENDER_SPACING = 20; // m, illustrative
/** Plan coordinates: x = distance seaward from the berth face (m), y = along the berth (m, up on screen).
 *  BRT-N1 sits on the berth edge at y = −s/2, BRT-N2 at y = +s/2. The vessel's berth-side hull line is drawn
 *  through the two measured distances; BRT does not measure the longitudinal position, so midship is drawn at y = 0. */
function hullFrame(d1, angDeg, s, L) {
  const A = (angDeg * Math.PI) / 180, e = [Math.sin(A), Math.cos(A)], n = [Math.cos(A), -Math.sin(A)];
  const u0 = s / 2 / Math.cos(A), M = [d1 + u0 * e[0], -s / 2 + u0 * e[1]];
  return { e, n, M, at: (u, w) => [M[0] + u * e[0] + w * n[0], M[1] + u * e[1] + w * n[1]] };
}
function vesselPolygon(fr, L, B) {
  // flat side must cover both BRT sensors (the hull line is defined by them)
  // (aft end of the flat side at BRT-N1 = the first-contact point, so the hull never crosses the berth face)
  const s2 = LIVE.cfg.berth.brtSpacing / 2, fa = Math.min(0.45 * L, s2), ff = Math.min(0.45 * L, Math.max(0.35 * L, s2 + 8));
  return [[-0.5 * L, 0.18 * B], [-fa, 0], [ff, 0], [0.5 * L, 0.5 * B], [ff, B], [-Math.max(fa, 0.35 * L), B], [-0.5 * L, 0.82 * B]].map(([u, w]) => fr.at(u, w));
}
function compassToPlan(c) { const th = (-(c - LIVE.cfg.berth.seawardNormalDeg) * Math.PI) / 180; return [Math.cos(th), Math.sin(th)]; }

/** Two synchronised plan panels: the overview (whole approach) always stays visible, the zoom panel follows
 *  the contact point (berth face + BRT-N1) so the fender impact can be seen at the same time. */
function drawLivePlan(ev, i, f, done, lvl, ids = ['livePlanCanvas', 'livePlanZoom']) {
  const zoom = drawPlanPanel(ids[1], true, ev, i, f, done, lvl, null);
  drawPlanPanel(ids[0], false, ev, i, f, done, lvl, zoom);
}
function drawPlanPanel(cid, close, ev, i, f, done, lvl, zoomBox) {
  const c = $(cid); if (!c || !c.offsetParent) return null;   // skip hidden tabs
  const { ctx, w, h } = prepCanvas(c); ctx.clearRect(0, 0, w, h);
  const b = ev.brt, now = b[i], m = ev.meta, L = m.vessel.LOA, B = m.vessel.B, s = LIVE.cfg.berth.brtSpacing;
  const d1 = Math.max(0, now.n1_distance), ang = LIVE.two ? now.angle : 0;
  // viewport (equal scale in x and y)
  let k, x0, yc;
  const padL = 46, padR = 14, padT = 14, padB = 26, W = w - padL - padR, H = h - padT - padB;
  if (close) { const xMax = clamp(d1 * 1.25 + B * 0.6 + 10, 45, 150); x0 = -8; k = W / (xMax - x0); yc = -s / 2; }
  else { const xMax = b[0].n1_distance + B + 60; x0 = -15; k = Math.min(W / (xMax - x0), H / (1.2 * Math.max(L, s + 40))); yc = 0; }
  const X = (x) => padL + (x - x0) * k, Y = (y) => padT + H / 2 - (y - yc) * k;
  const P = ([x, y]) => [X(x), Y(y)];
  const yTop = yc + H / 2 / k, yBot = yc - H / 2 / k, xEnd = x0 + W / k;
  // water + land
  ctx.fillStyle = '#eff6ff'; ctx.fillRect(padL, padT, W, H);
  ctx.fillStyle = '#d6d3d1'; ctx.fillRect(padL, padT, X(0) - padL, H);
  ctx.save(); ctx.beginPath(); ctx.rect(padL, padT, W, H); ctx.clip();
  // grid + distance rings
  ctx.strokeStyle = '#dbeafe'; ctx.lineWidth = 1; ctx.fillStyle = '#64748b'; ctx.font = '11px Segoe UI';
  const step = [5, 10, 20, 50, 100, 200].find((st) => st * k >= 55) || 200;
  for (let x = 0; x <= xEnd; x += step) { ctx.beginPath(); ctx.moveTo(X(x), padT); ctx.lineTo(X(x), padT + H); ctx.stroke(); }
  // berth face + fenders
  ctx.strokeStyle = '#111827'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(X(0), padT); ctx.lineTo(X(0), padT + H); ctx.stroke();
  const fH = LIVE.fender.H, contactY = -s / 2;
  for (let y = contactY - FENDER_SPACING * Math.ceil((contactY - yBot) / FENDER_SPACING); y <= yTop; y += FENDER_SPACING) {
    ctx.fillStyle = '#1f2937'; ctx.fillRect(X(0), Y(y) - Math.max(4, 2.5 * k) / 2, Math.max(3, fH * k), Math.max(4, 2.5 * k));
  }
  // BRT sensors + laser lines
  const sensors = LIVE.two ? [['N1', -s / 2, now.n1_distance], ['N2', s / 2, now.n2_distance]] : [['N1', -s / 2, now.n1_distance]];
  for (const [id, y, d] of sensors) {
    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(Math.max(0, d)), Y(y)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#dc2626'; ctx.beginPath(); ctx.moveTo(X(0) - 9, Y(y) - 6); ctx.lineTo(X(0) - 1, Y(y)); ctx.lineTo(X(0) - 9, Y(y) + 6); ctx.fill();
    ctx.fillStyle = '#7f1d1d'; ctx.font = '600 11px Segoe UI';
    if (!done && X(Math.max(0, d)) - X(0) > 120) ctx.fillText(`BRT-${id}  ${fmt(Math.max(0, d), 1)} m`, Math.min(X(Math.max(0, d) / 2) - 30, w - 140), Y(y) - 6);
  }
  // history ghosts (every 60 s), forecast ghosts at contact
  const drawPoly = (pts, fill, stroke, dash = [], lw = 1.5) => {
    ctx.beginPath(); pts.forEach((p, n) => { const [px, py] = P(p); n ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.setLineDash(dash); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); ctx.setLineDash([]); }
  };
  for (let j = i - 60; j >= 0 && j > i - 60 * 9; j -= 60) drawPoly(vesselPolygon(hullFrame(Math.max(0, b[j].n1_distance), LIVE.two ? b[j].angle : 0, s, L), L, B), null, 'rgba(100,116,139,.35)', [], 1);
  if (!done) {
    if (LIVE.two) drawPoly(vesselPolygon(hullFrame(0, f.angle.p90, s, L), L, B), null, 'rgba(220,38,38,.35)', [3, 4], 1);
    drawPoly(vesselPolygon(hullFrame(0, LIVE.two ? f.angle.p50 : 0, s, L), L, B), 'rgba(220,38,38,.05)', '#dc2626', [7, 5], 1.5);
  }
  // tugs (pushing on the seaward side)
  const fr = hullFrame(d1, ang, s, L);
  const nt = Math.max(1, m.tugs), us = nt === 1 ? [0] : nt === 2 ? [-0.25 * L, 0.25 * L] : [-0.3 * L, 0, 0.3 * L, 0.15 * L].slice(0, nt);
  for (const u of us) drawPoly([[u - 5, B + 2], [u + 5, B + 2], [u + 5, B + 28], [u, B + 32], [u - 5, B + 28]].map(([a, bb]) => fr.at(a, bb)), '#f59e0b', '#92400e', [], 1);
  // vessel
  drawPoly(vesselPolygon(fr, L, B), '#334155', LEVEL_COLOR[lvl], [], 3);
  drawPoly([[-0.45 * L, 0.2 * B], [-0.37 * L, 0.2 * B], [-0.37 * L, 0.8 * B], [-0.45 * L, 0.8 * B]].map(([u, ww]) => fr.at(u, ww)), '#e2e8f0', null);
  { // vessel name written along the hull axis
    const [mx, my] = P(fr.at(0.05 * L, 0.5 * B)), label = `${m.vessel.type} ${m.vessel.DWT / 1000}k DWT`;
    ctx.font = '600 12px Segoe UI';
    if (B * k > 13 && ctx.measureText(label).width < 0.6 * L * k) {
      ctx.save(); ctx.translate(mx, my); ctx.rotate(Math.atan2(-fr.e[1], fr.e[0])); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(label, 0, 4); ctx.restore();
    }
  }
  // overview: outline of the zoomed region
  if (zoomBox) {
    ctx.setLineDash([6, 4]); ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 1.5;
    const [ax, ay] = P([Math.max(zoomBox.x0, x0), zoomBox.yTop]), [bx2, by2] = P([zoomBox.xEnd, zoomBox.yBot]);
    ctx.strokeRect(ax, ay, bx2 - ax, by2 - ay); ctx.setLineDash([]);
    ctx.fillStyle = '#7c3aed'; ctx.font = '600 11px Segoe UI'; ctx.fillText('vùng phóng to', ax + 4, by2 + 13);
  }
  // contact: reaction arrow + flash
  if (done) {
    const im = ev.impact, col = LEVEL_COLOR[im.levelName], [cx, cy] = P([0, contactY]);
    const ph = Math.max(6, 2.5 * k), pw = Math.max(3, fH * (1 - Math.min(0.9, im.deflectionRatio)) * k);
    ctx.fillStyle = col; ctx.fillRect(cx, cy - ph / 2, pw, ph);
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, 16, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 26, 0, 2 * Math.PI); ctx.globalAlpha = 0.4; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(cx - 4, cy); ctx.lineTo(cx - 40, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 40, cy); ctx.lineTo(cx - 30, cy - 6); ctx.lineTo(cx - 30, cy + 6); ctx.fill();
  }
  ctx.restore();
  // frame, scale bar, axis labels
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.strokeRect(padL, padT, W, H);
  ctx.fillStyle = '#64748b'; ctx.font = '11px Segoe UI';
  for (let x = 0; x <= xEnd; x += step) if (X(x) < w - padR - 150) ctx.fillText(String(x), X(x) - 6, h - 10);
  ctx.fillText('khoảng cách ra biển (m)', w - padR - 130, h - 10);
  ctx.save(); ctx.translate(14, padT + H / 2 + 40); ctx.rotate(-Math.PI / 2); ctx.fillText('dọc mép bến (m)', 0, 0); ctx.restore();
  if (close && d1 > xEnd) {
    ctx.fillStyle = '#334155'; ctx.font = '600 12px Segoe UI'; const t = `tàu còn cách ${fmt(d1, 0)} m →`;
    ctx.fillText(t, padL + W - ctx.measureText(t).width - 8, padT + 18);
  }
  if (!close) {
  // compass + environment inset
  const ix = w - padR - 120, iy = padT + 8, R = 34, cxI = ix + 60, cyI = iy + 48;
  ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(ix, iy, 116, 116); ctx.strokeStyle = '#cbd5e1'; ctx.strokeRect(ix, iy, 116, 116);
  const arrow = (dir, len, col, label) => {
    const [dx, dy] = dir, ex = cxI + dx * len, ey = cyI - dy * len;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(cxI, cyI); ctx.lineTo(ex, ey); ctx.stroke();
    const a = Math.atan2(ey - cyI, ex - cxI); ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 8 * Math.cos(a - 0.4), ey - 8 * Math.sin(a - 0.4)); ctx.lineTo(ex - 8 * Math.cos(a + 0.4), ey - 8 * Math.sin(a + 0.4)); ctx.fill();
    if (label) { ctx.font = '600 10px Segoe UI'; ctx.fillText(label, ex + (dx >= 0 ? 3 : -12), ey + (dy >= 0 ? -3 : 10)); }
  };
  const e = f.observed.env;
  arrow(compassToPlan(0), R, '#0f172a', 'N');
  arrow(compassToPlan(e.windFrom + 180), clamp(8 + e.windSpeed * 1.6, 8, R), '#2563eb', '');
  arrow(compassToPlan(e.currentTo), clamp(8 + e.currentSpeed * 30, 8, R), '#0d9488', '');
  ctx.font = '10px Segoe UI'; ctx.fillStyle = '#2563eb'; ctx.fillText(`gió ${fmt(e.windSpeed, 1)} m/s`, ix + 4, iy + 100);
  ctx.fillStyle = '#0d9488'; ctx.fillText(`dòng ${fmt(e.currentSpeed, 2)} m/s`, ix + 4, iy + 112);
  }
  // legend
  ctx.font = '11px Segoe UI';
  const legend = close ? `Phóng to quanh điểm chạm (BRT-N1)${done ? ' · đệm co lại theo độ nén' : ' · nét đứt đỏ = chạm bến dự báo'}` : `Toàn cảnh · ${done ? 'đã chạm bến' : 'đỏ đứt = chạm bến dự báo (P50' + (LIVE.two ? ', mờ P90)' : ', góc 0°)')} · xám = mỗi 60 s`;
  ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(padL + 2, padT + H - 22, ctx.measureText(legend).width + 10, 18);
  ctx.fillStyle = '#334155'; ctx.fillText(legend, padL + 6, padT + H - 8);
  if (done && close) {
    const im = ev.impact, col = LEVEL_COLOR[im.levelName];
    const lines = [`CHẠM BẾN · ${LEVEL_TXT[im.levelName].toUpperCase()}`, `v ${fmt(100 * im.contactVelocity, 1)} cm/s · góc ${fmt(im.contactAngle, 1)}°`,
      `E ${fmt(im.energy, 0)} kJ (${fmt((100 * im.energy) / LIVE.fender.ratedEnergy, 0)} % Er)`, `R ${fmt(im.reaction, 0)} kN · δ bến ${fmt(im.displacement, 1)} mm`];
    ctx.font = '600 12px Segoe UI'; const bw = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16, bx = padL + 8, by = padT + 8;
    ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fillRect(bx, by, bw, 18 * lines.length + 8); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(bx, by, bw, 18 * lines.length + 8);
    lines.forEach((t, n) => { ctx.fillStyle = n ? '#0f172a' : col; ctx.font = n ? '12px Segoe UI' : '700 12px Segoe UI'; ctx.fillText(t, bx + 8, by + 18 + 18 * n); });
  }
  return { x0, xEnd, yBot, yTop };
}

function renderLiveState(ev, i, f, done, lvl) {
  const el = $('liveState'); if (!el) return;
  const b = ev.brt, now = b[i], v = Math.max(0.001, now.n1_velocity / 100), d = Math.max(0, now.n1_distance);
  const ttc = d / v;
  if (!done) {
    el.textContent =
`Thời điểm           ${new Date(now.ts).toLocaleTimeString()}   (t = ${now.t} s)
Khoảng cách BRT-N1  ${fmt(d, 1)} m${LIVE.two ? `   ·  BRT-N2 ${fmt(Math.max(0, now.n2_distance), 1)} m` : ''}
Vận tốc tiến vào    ${fmt(now.n1_velocity, 1)} cm/s
Góc tàu – mép bến   ${LIVE.two ? fmt(now.angle, 1) + '°' : 'không đo (1 BRT)'}
Ước tính chạm bến   sau ~${ttc > 3600 ? '>60 phút' : Math.round(ttc) + ' s'} (nếu giữ vận tốc hiện tại)
Tàu lai             ${ev.meta.tugs}

Dự báo khi chạm bến
  vận tốc  P50 ${fmt(100 * f.velocity.p50, 1)} cm/s  [P10 ${fmt(100 * f.velocity.p10, 1)} – P90 ${fmt(100 * f.velocity.p90, 1)}]
  góc      P50 ${fmt(f.angle.p50, 1)}°
  năng lượng P90 ${fmt(f.energy.p90, 0)} kJ (${fmt((100 * f.energy.p90) / LIVE.fender.ratedEnergy, 0)} % Er)
  phản lực P90 ${fmt(f.reaction.p90, 0)} kN · chuyển vị P90 ${fmt(f.displacement.p90, 1)} mm
Mức cảnh báo        ${LEVEL_TXT[lvl]} (${lvl})`;
  } else {
    const im = ev.impact, ms = ev.measured;
    el.textContent =
`ĐÃ CHẠM BẾN lúc ${new Date(ms.ts).toLocaleTimeString()}  (t = ${now.t} s)
Vận tốc cập         ${fmt(100 * im.contactVelocity, 1)} cm/s   (thiết kế ${fmt(100 * LIVE.cfg.berth.designVelocity, 0)} cm/s)
Góc cập             ${fmt(im.contactAngle, 1)}°
Năng lượng          ${fmt(im.energy, 0)} kJ = ${fmt((100 * im.energy) / LIVE.fender.ratedEnergy, 0)} % Er
Độ nén đệm          ${fmt(100 * im.deflectionRatio, 0)} %${im.bottomed ? '  ← ĐỆM BỊ NÉN HẾT (bottom-out)' : ''}
Phản lực đệm        ${fmt(im.reaction, 0)} kN   ("đo" FND ${fmt(ms.fnd, 0)} kN)
Chuyển vị bến       ${fmt(im.displacement, 2)} mm   ("đo" DSP dx ${fmt(ms.dsp_dx, 2)} mm, giới hạn ${LIVE.cfg.wharf.displacementLimit} mm)
Mức rủi ro thực tế  ${LEVEL_TXT[im.levelName]} (${im.levelName})
Mức cảnh báo đã phát ${LEVEL_TXT[lvl]} (${lvl})`;
  }
}

function drawLiveVelocity(ev, i, f, done) {
  const c = $('liveVelCanvas'); const { ctx, w, h } = prepCanvas(c); ctx.clearRect(0, 0, w, h);
  const b = ev.brt, dMax = Math.ceil(b[0].n1_distance / 50) * 50;
  const vMax = Math.max(60, ...b.slice(0, i + 1).map((x) => x.n1_velocity), 100 * f.velocity.p90 + 5);
  const X = (d) => 44 + (1 - d / dMax) * (w - 60), Y = (v) => h - 30 - (v / vMax) * (h - 50);
  axes(ctx, w, h, X, Y, [dMax, Math.round(dMax / 2), 100, 0], [0, 10, 20, Math.round(vMax / 2), Math.round(vMax)].filter((v, k, a) => a.indexOf(v) === k), 'khoảng cách tới bến (m)', '');
  // design velocity
  ctx.setLineDash([6, 4]); ctx.strokeStyle = '#d97706'; ctx.beginPath(); ctx.moveTo(44, Y(100 * LIVE.cfg.berth.designVelocity)); ctx.lineTo(w - 10, Y(100 * LIVE.cfg.berth.designVelocity)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#d97706'; ctx.fillText('vận tốc thiết kế', w - 110, Y(100 * LIVE.cfg.berth.designVelocity) - 4);
  // measured history
  ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.beginPath();
  for (let k = 0; k <= i; k += 2) { const x = X(b[k].n1_distance), y = Y(b[k].n1_velocity); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
  // forecast band at contact
  const x0 = X(0);
  ctx.fillStyle = 'rgba(220,38,38,.18)'; ctx.fillRect(x0 - 8, Y(100 * f.velocity.p90), 16, Y(100 * f.velocity.p10) - Y(100 * f.velocity.p90));
  ctx.fillStyle = '#dc2626'; ctx.beginPath(); ctx.arc(x0, Y(100 * f.velocity.p50), 4, 0, 2 * Math.PI); ctx.fill();
  ctx.setLineDash([3, 3]); ctx.strokeStyle = '#dc2626'; ctx.beginPath(); ctx.moveTo(X(b[i].n1_distance), Y(b[i].n1_velocity)); ctx.lineTo(x0, Y(100 * f.velocity.p50)); ctx.stroke(); ctx.setLineDash([]);
  if (done) { ctx.fillStyle = '#059669'; ctx.beginPath(); ctx.arc(x0, Y(100 * ev.impact.contactVelocity), 5, 0, 2 * Math.PI); ctx.fill(); }
  ctx.fillStyle = '#334155'; ctx.fillText('— đo BRT · ● dự báo P50 + dải P10–P90 tại điểm chạm' + (done ? ' · ● thực tế (xanh)' : ''), 50, 14);
}
function drawLiveProbability(i) {
  const c = $('liveProbCanvas'); const { ctx, w, h } = prepCanvas(c); ctx.clearRect(0, 0, w, h);
  const tEnd = LIVE.ev.brt[LIVE.ev.brt.length - 1].t, tNow = LIVE.ev.brt[i].t;
  const X = (t) => 44 + (t / tEnd) * (w - 60), Y = (p) => h - 30 - p * (h - 50);
  axes(ctx, w, h, X, Y, [0, Math.round(tEnd / 2), tEnd], [0, 0.2, 0.5, 1], 'thời gian (s)', '');
  ctx.setLineDash([5, 4]); ctx.strokeStyle = '#94a3b8'; ctx.beginPath(); ctx.moveTo(44, Y(LIVE.cfg.alert.probability)); ctx.lineTo(w - 10, Y(LIVE.cfg.alert.probability)); ctx.stroke(); ctx.setLineDash([]);
  const S = LIVE.series.filter((s) => s.t <= tNow);
  const lines = [['energyWarning', '#d97706', 'P(E ≥ 0,85 Er)'], ['energyCritical', '#dc2626', 'P(E ≥ Er)'], ['dispCritical', '#7c3aed', 'P(δ ≥ giới hạn)'], ['angleCaution', '#0891b2', 'P(góc ≥ 10°)']];
  lines.forEach(([k, col, lab], n) => {
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
    S.forEach((s, j) => { const x = X(s.t), y = Y(s.probs[k]); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ctx.fillStyle = col; ctx.fillText(lab, 50 + (n % 2) * 130, 12 + Math.floor(n / 2) * 14);
  });
}
function drawLiveFender(f, impact) {
  const c = $('liveFenderCanvas'); const { ctx, w, h } = prepCanvas(c); ctx.clearRect(0, 0, w, h);
  const F = LIVE.fender, rMax = 2.2 * F.ratedReaction;
  const X = (r) => 44 + (r / 0.9) * (w - 60), Y = (R) => h - 30 - (Math.min(R, rMax) / rMax) * (h - 50);
  axes(ctx, w, h, X, Y, [0, 0.36, 0.72, 0.9], [0, Math.round(F.ratedReaction / 2), F.ratedReaction, Math.round(rMax)], 'độ nén / chiều cao đệm', '');
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2; ctx.beginPath();
  F.curve.forEach(([x, y], k) => { const px = X(x), py = Y(y * F.ratedReaction); k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.stroke();
  ctx.setLineDash([4, 4]); ctx.strokeStyle = '#d97706'; ctx.beginPath(); ctx.moveTo(X(F.ratedDeflection), 20); ctx.lineTo(X(F.ratedDeflection), h - 30); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#d97706'; ctx.fillText(`định mức: Er ${F.ratedEnergy} kJ, Rr ${F.ratedReaction} kN`, 50, 28);
  const pt = (x, R, col, rr) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(Math.min(x, 0.9)), Y(R), rr, 0, 2 * Math.PI); ctx.fill(); };
  pt(f.deflectionRatio.p50, f.reaction.p50, '#dc2626', 4); pt(f.deflectionRatio.p90, f.reaction.p90, 'rgba(220,38,38,.45)', 6);
  if (impact) pt(impact.deflectionRatio, impact.reaction, '#059669', 5);
  ctx.fillStyle = '#334155'; ctx.fillText('● dự báo P50 (đỏ) · ● P90 (hồng)' + (impact ? ' · ● thực tế (xanh)' : ''), 50, 14);
}

// ------------------------------------------------------------------ exports / import
async function liveExportDataset() {
  if (!LIVE.ds) throw new Error('Generate a dataset first.');
  setWait('Export dataset', 'Building CSV files...', 30); await new Promise((r) => setTimeout(r, 40));
  try {
    const t = LB.datasetTables(LIVE.ds), zip = new JSZip();
    zip.file('events.csv', LB.toCSV(t.events));
    zip.file('brt_timeseries_1s.csv', LB.toCSV(t.brt));
    zip.file('env_timeseries_10s.csv', LB.toCSV(t.env));
    zip.file('impact_sensors.csv', LB.toCSV(t.sensors));
    zip.file('assumptions.txt', LB.assumptionsText(LIVE.cfg, LIVE.fender) + `\n\nSeed ${LIVE.ds.seed}; ${LIVE.ds.events.length} events. Column names follow port-shm channel naming (CHANNEL.metric_unit).\n`);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    downloadBlob(blob, `berthing_live_demo_dataset_${LIVE.ds.seed}.zip`);
    liveSetStatus(`Exported dataset ZIP (${t.events.length} events, ${t.brt.length.toLocaleString()} BRT rows).`);
  } finally { hideWait(); }
}
function liveExportAlerts() {
  if (!LIVE.series.length) throw new Error('Select an event first.');
  const rows = LIVE.series.map((s) => ({ event_id: LIVE.ev.meta.eventId, timestamp: s.ts, source: 'BERTHING-AI-LIVE', sensors: LIVE.two ? '2xBRT' : '1xBRT', distance_m: +s.distance.toFixed(1),
    alert_level: s.alertName, forecast_level: s.levelName, v_contact_p50_cms: +(100 * s.velocity.p50).toFixed(2), v_contact_p90_cms: +(100 * s.velocity.p90).toFixed(2), energy_p90_kJ: +s.energy.p90.toFixed(0),
    reaction_p90_kN: +s.reaction.p90.toFixed(0), displacement_p90_mm: +s.displacement.p90.toFixed(2), p_energy_ge_085Er: +s.probs.energyWarning.toFixed(3), p_energy_ge_Er: +s.probs.energyCritical.toFixed(3),
    p_disp_ge_limit: +s.probs.dispCritical.toFixed(3), recommendation: s.recommendation }));
  download(`berthing_live_alerts_${LIVE.ev.meta.eventId}.csv`, LB.toCSV(rows));
  liveSetStatus(`Exported ${rows.length} forecast/alert rows for ${LIVE.ev.meta.eventId} (port-shm alert format).`);
}
async function liveLoadZip(evn) {
  const file = evn.target.files?.[0]; if (!file) return;
  try {
    setWait('Load dataset ZIP', `Reading ${file.name}...`, 20);
    const zip = await JSZip.loadAsync(file);
    const read = async (n) => { const f = zip.file(n); if (!f) throw new Error(`${n} is missing in the ZIP.`); return parseCSV(await f.async('string')); };
    const [evs, brt, env, sen] = [await read('events.csv'), await read('brt_timeseries_1s.csv'), await read('env_timeseries_10s.csv'), await read('impact_sensors.csv')];
    const by = (rows) => rows.reduce((m, r) => ((m[r.event_id] ??= []).push(r), m), {});
    const B = by(brt), E = by(env), Sx = Object.fromEntries(sen.map((r) => [r.event_id, r]));
    const n = (x) => Number(x);
    const events = evs.map((r) => {
      const vp = LB.vesselParticulars(LB.VESSELS.find((v) => v.id === r.vessel_id) || LB.VESSELS[0], r.laden === 'true');
      const imp = LB.impactChain(vp, n(r.contact_velocity_mps), n(r.contact_angle_deg), LIVE.cfg, LIVE.fender, 0);
      return {
        meta: { eventId: r.event_id, scenario: r.scenario, start: r.start, vessel: { id: r.vessel_id, type: r.vessel_type, DWT: n(r.DWT), LOA: n(r.LOA_m), B: n(r.B_m), T: n(r.T_m), Cb: n(r.Cb), displacement: n(r.displacement_t), laden: r.laden === 'true' }, tugs: n(r.tugs), brtRange: n(r.brt_range_m) },
        brt: (B[r.event_id] || []).map((x) => ({ t: n(x.t_s), ts: x.timestamp, n1_distance: n(x['WH-P1-BRT-N1.distance_m']), n1_velocity: n(x['WH-P1-BRT-N1.velocity_cms']), n2_distance: n(x['WH-P1-BRT-N2.distance_m']), n2_velocity: n(x['WH-P1-BRT-N2.velocity_cms']), angle: n(x['BRT.angle_deg']) })),
        env: (E[r.event_id] || []).map((x) => ({ t: n(x.t_s), ts: x.timestamp, windSpeed: n(x['ENV-WIND-N1.speed_ms']), windFrom: n(x['ENV-WIND-N1.from_deg']), currentSpeed: n(x['ENV-CUR-N1.speed_ms']), currentTo: n(x['ENV-CUR-N1.to_deg']), hs: n(x['ENV-WAVE-N1.hs_m']), tp: n(x['ENV-WAVE-N1.tp_s']), tide: n(x['ENV-TIDE-N1.level_m']) })),
        impact: { contactVelocity: n(r.contact_velocity_mps), contactAngle: n(r.contact_angle_deg), ...imp, level: LB.LEVELS.indexOf(r.risk_level), levelName: r.risk_level },
        measured: { ts: r.contact_time, fnd: n(Sx[r.event_id]?.['WH-P1-FND-N1.value_kN']), dsp_dx: n(Sx[r.event_id]?.['WH-P1-DSP-N1.dx_mm']) },
      };
    }).filter((e) => e.brt.length > 30 && e.env.length);
    if (events.length < 20) throw new Error('At least 20 complete events are needed.');
    LIVE.ds = { seed: file.name, events };
    liveAfterDataset(`Loaded ${events.length} events from ${file.name}.`);
  } catch (err) { liveSetStatus('Load dataset failed: ' + err.message, true); alert('Load dataset ZIP failed:\n\n' + err.message); }
  finally { hideWait(); evn.target.value = ''; }
}

// ------------------------------------------------------------------ wiring
Object.assign(ACTIONS, {
  liveGenerate: () => liveGenerate(),
  liveLoad: () => $('liveZipInput').click(),
  livePlay: () => playLive(), livePause: () => pauseLive(), liveReset: () => resetLive(),
  liveExportDataset: () => liveExportDataset(), liveExportAlerts: () => liveExportAlerts(),
});
$('liveZipInput').addEventListener('change', liveLoadZip);
$('liveShmEnabled').addEventListener('change', (e) => {
  if (!e.target.checked) { SHM.enabled = false; SHM.token = ''; shmStatus(`Đã tắt gửi Port-SHM${SHM.queue.length ? ` (bỏ ${SHM.queue.length} bản tin chưa gửi)` : ''}.`); SHM.queue = []; return; }
  const entered = window.prompt('Nhập Relay Token thử nghiệm (KHÔNG phải khoá Gateway của Port-SHM). Token chỉ giữ trong bộ nhớ trang.');
  if (!entered || !entered.trim()) { e.target.checked = false; shmStatus('Chưa nhập Relay Token.'); return; }
  SHM.token = entered.trim(); SHM.enabled = true; SHM.eventId = ''; SHM.sent = 0; SHM.fail = 0; SHM.queue = []; SHM.nextTry = 0;
  shmStatus('Đã bật: bản tin chỉ gửi khi nhấn ▶ Phát (mỗi 5 s thời gian sự kiện, gửi theo lô).');
});
$('liveEvent').addEventListener('change', liveSelect);
$('liveSensorsMode').addEventListener('change', (e) => { LIVE.two = e.target.value === '2'; if (LIVE.model) { liveValidate(); liveSelect(); } });
$('liveSpeed').addEventListener('change', (e) => { LIVE.speed = Number(e.target.value) || 30; });
$('liveSlider').addEventListener('input', (e) => { pauseLive(); LIVE.idx = Number(e.target.value) || 0; liveRender(); });
$('liveAssumptions').textContent = LB.assumptionsText(LIVE.cfg, LIVE.fender);
window.addEventListener('resize', () => { if (LIVE.ev) liveRender(); });
