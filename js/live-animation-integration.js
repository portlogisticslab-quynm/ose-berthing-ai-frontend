/* Animation tab: "Live Berthing" mode replays the current Live Berthing test event with the same to-scale plan view
 * (overview + contact zoom) as the Live Berthing tab; "CaseID" mode keeps the original base-trajectory animation. */
'use strict';
(() => {
  const el = (id) => document.getElementById(id);
  const mode = el('animMode'), testSelect = el('animLiveEvent'), animStatus = el('animStatus'), animInfo = el('animInfo');
  const animSpeed = el('animSpeed'), notes = el('animNotes'), hint = el('animLiveHint'), title = el('animTitle'), grid = el('animGrid');
  const legacyNotes = notes.innerHTML;
  const isLive = () => mode.value === 'live';
  const LIVE_NOTES = `Mặt bằng vẽ theo tỷ lệ từ 2 khoảng cách BRT (góc = atan((d2 − d1)/s)); thân tàu đặt giữa hai cảm biến vì BRT không đo vị trí dọc bến.<br>
    Nét đứt đỏ: vị trí – góc chạm bến dự báo; xám: vị trí mỗi 60 s; khung tím: vùng phóng to; viền tàu theo mức cảnh báo đã phát.<br>
    Khi chạm bến: đệm co lại theo độ nén, mũi tên là phản lực vào bến. Số liệu và dự báo dùng chung với tab Live Berthing.`;

  function syncTestList() {
    const source = el('liveEvent');
    const values = Array.from(source.options).map((o) => [o.value, o.textContent]);
    if (values.length !== testSelect.options.length || values.some((x, i) => x[0] !== testSelect.options[i]?.value)) {
      testSelect.replaceChildren(...values.map(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }));
    }
    testSelect.value = source.value;
  }
  function paint() {
    if (!isLive() || !el('animation').classList.contains('active')) return;
    syncTestList();
    if (!LIVE.ev || !LIVE.live) {
      const c = el('animCanvas'), { ctx, w, h } = prepCanvas(c);
      ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#334155'; ctx.font = '16px Segoe UI, Arial';
      ctx.fillText('Bấm "Sinh & train 150 sự kiện" (hoặc nạp ZIP ở tab Live Berthing), rồi chọn sự kiện và ▶ Start.', 20, 50);
      animInfo.textContent = 'Chưa có dữ liệu Live Berthing.';
      animStatus.textContent = 'Chờ dữ liệu Live Berthing';
      return;
    }
    const ev = LIVE.ev, b = ev.brt, i = LIVE.idx, done = i >= b.length - 1, f = LIVE.live;
    const lvl = (typeof alertAt === 'function' ? alertAt(b[i].t)?.alertName : null) || f.levelName;
    drawLivePlan(ev, i, f, done, lvl, ['animCanvas', 'animZoom']);
    animStatus.textContent = `${ev.meta.eventId} • t = ${b[i].t} / ${b[b.length - 1].t} s • ${LEVEL_TXT[lvl]} • ${LIVE.timer ? 'đang phát' : 'tạm dừng'}`;
    animInfo.textContent = el('liveState')?.textContent || '';
  }
  window.renderLiveAnimation = paint;

  function updateMode() {
    pauseAnimation(); pauseLive();
    document.querySelectorAll('.anim-live-only').forEach((x) => { x.hidden = !isLive(); });
    grid.classList.toggle('single', !isLive());
    notes.innerHTML = isLive() ? LIVE_NOTES : legacyNotes;
    hint.textContent = isLive() ? 'Dùng chung sự kiện, cảm biến, dự báo, thời gian và cảnh báo với tab Live Berthing (kể cả gửi Port-SHM nếu đã bật).'
      : 'Chế độ CaseID dùng bộ dữ liệu quỹ đạo nền (nút Data bên trái).';
    title.textContent = isLive() ? 'Live Berthing – phát lại sự kiện test (mặt bằng theo tỷ lệ)' : 'Berthing animation – selected CaseID';
    if (isLive()) { animSpeed.value = String(LIVE.speed); paint(); } else resetAnimation();
  }
  let userChose = false;
  mode.addEventListener('change', () => { userChose = true; updateMode(); });
  // switch to the Live replay automatically once Live Berthing data exist (unless the user picked a mode)
  window.onLiveDataset = () => { if (!userChose && mode.value !== 'live') { mode.value = 'live'; updateMode(); } };
  testSelect.addEventListener('change', () => { el('liveEvent').value = testSelect.value; liveSelect(); });
  const oldStart = ACTIONS.animStart, oldPause = ACTIONS.animPause, oldReset = ACTIONS.animReset;
  ACTIONS.animStart = () => (isLive() ? playLive() : oldStart());
  ACTIONS.animPause = () => (isLive() ? (pauseLive(), paint()) : oldPause());
  ACTIONS.animReset = () => (isLive() ? resetLive() : oldReset());
  ACTIONS.animGotoLive = () => showTab('live', document.querySelector('.tabbtn[data-tab="live"]'));
  animSpeed.addEventListener('change', () => {
    if (!isLive()) return;
    LIVE.speed = Number(animSpeed.value) || 30;
    const ls = el('liveSpeed'); if ([...ls.options].some((o) => o.value === animSpeed.value)) ls.value = animSpeed.value;
  });
  document.querySelector('.tabbtn[data-tab="animation"]').addEventListener('click', () => setTimeout(paint, 0));
  el('liveEvent').addEventListener('change', () => { syncTestList(); paint(); });
  window.addEventListener('resize', () => setTimeout(paint, 0));
  updateMode();
})();
