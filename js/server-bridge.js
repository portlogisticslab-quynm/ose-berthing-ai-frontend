/* Berthing AI — server bridge (V3.5.0).
 * The server is used ONLY for its approved model (deployed by an administrator).
 * Models trained or loaded in this browser are used locally and never require the server.
 */
'use strict';
const ServerBridge = (() => {
  const url = String(window.APP_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
  const state = { url, reachable: false, version: null, coreVersion: null, model: null, uploadEnabled: false, checkedAt: 0, error: '' };
  const TOKEN_KEY = 'berthing-ai-admin-token';

  function isConfigured() { return !!url; }

  async function call(path, opt = {}, timeoutMs = 75000) {
    if (!url) throw new Error('No server configured (config.js API_BASE_URL is empty).');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try { res = await fetch(url + path, { ...opt, signal: ctl.signal }); }
    catch (e) {
      throw new Error(e?.name === 'AbortError'
        ? `Server did not answer within ${Math.round(timeoutMs / 1000)} s (it may be waking up — free hosting sleeps when idle; retry in a minute).`
        : `Server unreachable (${e?.message || e}).`);
    } finally { clearTimeout(timer); }
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { detail: text.slice(0, 300) || `HTTP ${res.status}` }; }
    if (!res.ok) { const err = new Error(body?.detail || `HTTP ${res.status}`); err.status = res.status; throw err; }
    return body;
  }

  async function refresh(verbose = false) {
    if (!url) { state.error = 'not configured'; updateModelLoadStatus(); return state; }
    try {
      const h = await call('/api/health', {}, verbose ? 75000 : 20000);
      Object.assign(state, { reachable: true, version: h.version, coreVersion: h.coreVersion || null, model: h.model || null,
        uploadEnabled: !!h.modelUploadEnabled, checkedAt: Date.now(), error: '' });
      if (state.coreVersion && state.coreVersion !== BerthingCore.VERSION)
        state.error = `server core ${state.coreVersion} ≠ browser core ${BerthingCore.VERSION}`;
      if (verbose) setOperationStatus(`Server reachable (${url}) — version ${h.version}; approved model ${h.model?.loaded ? 'LOADED' : 'not loaded'}.`, false, !!state.error);
    } catch (e) {
      Object.assign(state, { reachable: false, model: null, checkedAt: Date.now(), error: e.message });
      if (verbose) setOperationStatus('Server check failed: ' + e.message, true);
    }
    updateModelLoadStatus();
    return state;
  }
  async function fresh() { if (Date.now() - state.checkedAt > 30000) await refresh(false); return state; }
  async function riskModelReady() { await fresh(); return !!(state.reachable && state.model?.riskModelCompatible); }
  async function trajModelReady() { await fresh(); return !!(state.reachable && state.model?.loaded); }

  function statusLines() {
    if (!url) return ['  not configured (config.js)'];
    if (!state.checkedAt) return [`  ${url}`, '  checking...'];
    if (!state.reachable) return [`  ${url}`, `  UNREACHABLE — ${state.error}`];
    const m = state.model || {};
    return [
      `  ${url} — v${state.version}${state.error ? ' ⚠ ' + state.error : ''}`,
      `  Trajectory: ${m.loaded ? `LOADED ✓ (${m.sourceName || 'approved package'}, ${m.inputLen}×13 → ${m.horizon}×6, best ${String(m.bestModel || 'auto').toUpperCase()})` : 'no approved model'}`,
      `  Hybrid Risk: ${m.riskModelCompatible ? 'LOADED ✓' : m.riskModel ? 'rejected — ' + (m.riskModelReason || 'incompatible') : 'not included (server risk = rule only)'}`,
      `  Model upload: ${state.uploadEnabled ? 'enabled (admin token required)' : 'disabled on this server'}`,
    ];
  }

  // ------------------------------------------------------------------ risk
  const RISK_OUT_KEYS = ['HybridRiskScore', 'PredictedRiskLevel', 'RiskPredictionMode', 'MLRiskScore', 'RuleWeight', 'MLProb_Normal', 'MLProb_Caution',
    'MLProb_Warning', 'MLProb_Critical', 'MLExpectedClass', 'MLOrdinalClass', 'MLOrdinalLevel', 'RiskConfidence'];
  function compactRow(r) { const o = {}; for (const k of BerthingCore.REQUIRED_COLUMNS) o[k] = r[k]; return o; }

  async function predictRisk() {
    await fresh();
    if (!state.reachable) throw new Error('Server is not reachable: ' + state.error);
    // Batches contain whole cases only, so per-case quality checks see complete tracks.
    const byCase = new Map();
    S.data.forEach((r, i) => { if (!byCase.has(r.CaseID)) byCase.set(r.CaseID, []); byCase.get(r.CaseID).push(i); });
    const batches = []; let cur = [];
    for (const idx of byCase.values()) { if (cur.length && cur.length + idx.length > 2500) { batches.push(cur); cur = []; } cur.push(...idx); }
    if (cur.length) batches.push(cur);
    let last = null;
    for (let b = 0; b < batches.length; b++) {
      setWait('Predict Risk (server)', `Batch ${b + 1}/${batches.length}: ${batches[b].length.toLocaleString()} rows...`, 5 + 90 * b / batches.length);
      const res = await call('/api/risk/predict', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: batches[b].map((i) => compactRow(S.data[i])) }) });
      if (!Array.isArray(res.rows) || res.rows.length !== batches[b].length) throw new Error(`Server batch ${b + 1} returned ${res.rows?.length || 0} rows; expected ${batches[b].length}.`);
      res.rows.forEach((o, k) => {
        const r = S.data[batches[b][k]];
        RISK_OUT_KEYS.forEach((key) => { if (o[key] === undefined || o[key] === null) delete r[key]; else r[key] = o[key]; });
        r.RiskEngine = 'Server approved model';
        r.RiskDecisionMode = o.RiskPredictionMode === 'HYBRID' ? 'Calibrated Hybrid (server)' : 'Rule only (server)';
      });
      last = res;
      await new Promise((r) => setTimeout(r, 0));
    }
    hideWait();
    return { engine: 'server', serverUrl: url, mode: last?.mode || 'RULE-ONLY', reason: last?.reason || '',
      model: last?.model ? { trainedAt: last.model.trainedAt, labelSource: last.model.labelSource, thresholds: last.model.thresholds } : null };
  }

  // ------------------------------------------------------------------ forecast
  async function forecast(caseRows) {
    await fresh();
    if (!state.model?.loaded) throw new Error('The server has no approved trajectory model.');
    const need = Number(state.model.inputLen) || 20;
    if (caseRows.length < need) throw new Error(`Selected CaseID has ${caseRows.length} rows; the server model needs ${need}.`);
    const model = document.getElementById('trajModelSelect')?.value || 'auto';
    setWait('Forecast (server)', `Sending the last ${need} observed rows of CaseID ${caseRows[0].CaseID}...`, 20);
    const res = await call('/api/forecast', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: caseRows.slice(-(need + 10)).map(compactRow), model }) });
    if (!Array.isArray(res.forecast) || !res.forecast.length) throw new Error('Server forecast returned no horizon rows.');
    S.forecast = res.forecast; S.forecastSource = `server ${String(res.model).toUpperCase()}`;
    drawTrajectory(caseRows, null, S.forecast); renderForecastStateTable(S.forecast);
    renderForecastReport(S.forecast, { engine: `Server approved model (${url})`, model: res.model, inputLen: res.inputLen, H: res.horizon, dt: res.dt_s,
      riskMode: res.riskMode === 'HYBRID' ? 'Hybrid (server model)' : 'Rule (server has no compatible ML risk model)' });
    hideWait();
  }

  // ------------------------------------------------------------------ publish (admin)
  async function publishModel() {
    await refresh(false);
    if (!state.reachable) throw new Error('Server is not reachable: ' + state.error);
    if (!state.uploadEnabled) throw new Error('Model upload is disabled on this server (ADMIN_TOKEN is not configured). Deploy the ZIP via MODEL_PATH / MODEL_URL instead.');
    let token = '';
    try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) {}
    if (!token) token = (prompt('Administrator token for publishing the approved server model:') || '').trim();
    if (!token) return;
    if (!confirm('Publish the model of this browser session as the APPROVED SERVER MODEL?\n\nIt will replace the current server model for ALL users.')) return;
    try {
      const { blob, fileName } = await buildDemoZipBlob();
      setWait('Publish trained model to server', `Uploading ${fileName}...`, 60);
      const fd = new FormData(); fd.append('file', new File([blob], fileName, { type: 'application/zip' }));
      const m = await call('/api/model/load', { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` } }, 120000);
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch (_) {}
      await refresh(false);
      setOperationStatus(`Published as approved server model: ${m.sourceName}; Hybrid Risk ${m.riskModelCompatible ? 'included' : 'not included'}.`);
    } catch (e) {
      if (e.status === 401 || e.status === 403) { try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) {} }
      throw e;
    } finally { hideWait(); }
  }

  window.addEventListener('load', () => setTimeout(() => refresh(false), 300));
  return { state, isConfigured, refresh, statusLines, riskModelReady, trajModelReady, predictRisk, forecast, publishModel };
})();
