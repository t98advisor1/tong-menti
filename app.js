(function () {
  'use strict';

  var STORAGE_KEY = 'tong_menti_pro_v2';
  var CLIENT_ID_KEY = 'tong_menti_client_id_v1';
  var COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#0891b2', '#ef4444'];
  var TYPE_META = {
    wordcloud: { label: '워드 클라우드', defaultQ: '오늘 수업에서 가장 기억에 남는 핵심 키워드는 무엇인가요?' },
    poll: { label: '객관식 투표', defaultQ: '오늘 수업 내용의 이해도는 어느 정도인가요?' },
    scale: { label: '1~5 척도 평가', defaultQ: '오늘 수업의 난이도와 참여 만족도를 평가해 주세요.' },
    ranking: { label: '순위 매기기', defaultQ: '다음 시간에 가장 먼저 다루고 싶은 활동 순위를 정해 주세요.' },
    points100: { label: '100점 배분', defaultQ: '학급 프로젝트 평가 기준 100점을 항목별로 배분해 보세요.' },
    matrix2x2: { label: '2×2 사분면 매트릭스', defaultQ: '이 주제의 중요도(X)와 시급성(Y)을 1~10점으로 평가해 주세요.' },
    quiz: { label: '실시간 퀴즈 대결', defaultQ: '다음 중 조건부 확률 P(B|A)의 올바른 계산식은 무엇인가요?' },
    open: { label: '자유 의견 · Q&A', defaultQ: '수업 중 궁금한 점이나 자유로운 생각을 남겨 주세요.' }
  };

  function el(id) { return document.getElementById(id); }
  function uid() { return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function showToast(msg) {
    var t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function createSlide(type) {
    type = TYPE_META[type] ? type : 'wordcloud';
    var defaultOpts = {
      poll: ['매우 잘 이해되었다', '대체로 이해되었다', '예제를 한 번 더 보고 싶다', '추가 설명이 필요하다'],
      ranking: ['모둠 토론 활동', '실생활 데이터 탐구', '문제 풀이 연습', '퀴즈 대결'],
      points100: ['창의성', '협업 태도', '발표 전달력', '자료 완성도'],
      quiz: ['P(A∩B) / P(A)', 'P(A∪B) / P(B)', 'P(A) × P(B)', 'P(A) + P(B)']
    };
    return {
      id: uid(),
      type: type,
      question: TYPE_META[type].defaultQ,
      wcMaxWords: 3,
      options: (defaultOpts[type] || ['항목 1', '항목 2', '항목 3', '항목 4']).slice(),
      correctIndex: 0,
      scaleMin: '전혀 그렇지 않다 (1)',
      scaleMax: '매우 그렇다 (5)',
      matrixX: '중요도',
      matrixY: '시급성',
      vizMode: 'default', // 'default' | 'hbar' | 'vbar' | 'donut' | 'table'
      locked: false,
      hideResults: false,
      submittedClients: {}, // { clientId: true }
      // 응답 데이터
      words: {},            // wordcloud: { word: count }
      votes: [0, 0, 0, 0],  // poll / quiz: counts per option
      scales: [],           // scale: [1..5]
      rankings: [],         // ranking: [[idx0, idx1, ...], ...]
      pointsList: [],       // points100: [[p0, p1, ...], ...]
      matrixPoints: [],     // matrix2x2: [{ x, y, author }]
      quizScores: {},       // quiz: { author: score }
      opens: []             // open: [{ id, author, text, likes, ts }]
    };
  }

  var params = new URLSearchParams(location.search);
  if (params.get('join') === '1') initStudentMode();
  else initTeacherMode();

  // =========================================================================
  // 1. 학생용 실시간 QR 참여 모드 (8종 활동 지원 + 자동 슬라이드 전환 + 재연결)
  // =========================================================================
  function initStudentMode() {
    el('teacherView').style.display = 'none';
    el('studentView').style.display = 'flex';

    var roomCode = (params.get('room') || '').trim();
    var clientId = '';
    try {
      clientId = localStorage.getItem(CLIENT_ID_KEY) || '';
      if (!clientId) {
        clientId = 'c_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(CLIENT_ID_KEY, clientId);
      }
    } catch (e) { clientId = 'c_' + Math.random().toString(36).slice(2, 10); }

    var peerConn = null;
    var curCfg = null;
    var lastSlideId = '';
    var submittedSlides = {};

    function showFeedback(msg, ok) {
      var fb = el('stuFeedback');
      fb.textContent = msg;
      fb.className = 'tm-feedback ' + (ok ? 'ok' : 'err');
      fb.style.display = 'block';
    }

    function sendSubmit(payload) {
      if (!peerConn || !peerConn.open) {
        showFeedback('선생님 화면과 연결이 끊어졌습니다. 잠시 후 다시 눌러 주세요.', false);
        return false;
      }
      if (!curCfg) return false;
      if (curCfg.locked) {
        showFeedback('현재 응답이 마감되었습니다.', false);
        return false;
      }
      if (curCfg.limitOnce && submittedSlides[curCfg.slideId]) {
        showFeedback('이미 이 질문에 제출했습니다. (1인 1회 제한)', false);
        return false;
      }
      peerConn.send({
        type: 'submit',
        slideId: curCfg.slideId,
        clientId: clientId,
        payload: payload
      });
      submittedSlides[curCfg.slideId] = true;
      showFeedback('응답이 실시간 화면에 반영되었습니다!', true);
      return true;
    }

    function renderStudentUI(cfg) {
      var slideChanged = cfg.slideId !== lastSlideId;
      curCfg = cfg;
      lastSlideId = cfg.slideId;

      el('stuTypeKicker').textContent = (TYPE_META[cfg.type] && TYPE_META[cfg.type].label) || '실시간 참여';
      el('stuSlidePill').textContent = '질문 ' + (cfg.slideIndex + 1) + ' / ' + cfg.totalSlides;
      el('stuQuestion').textContent = cfg.question || '질문';
      el('stuConnSub').textContent = '실시간 교실 방(' + roomCode + ') 연결됨 · 선생님 화면과 자동 동기화';
      el('stuLockedNotice').style.display = cfg.locked ? 'block' : 'none';
      if (slideChanged) el('stuFeedback').style.display = 'none';

      var box = el('stuDynamicForm');
      if (cfg.locked) { box.innerHTML = ''; return; }
      if (!slideChanged && box.dataset.renderedSlide === cfg.slideId && box.dataset.renderedType === cfg.type) return;
      box.dataset.renderedSlide = cfg.slideId;
      box.dataset.renderedType = cfg.type;
      box.innerHTML = '';

      if (cfg.type === 'wordcloud') {
        var maxW = Math.max(1, Math.min(3, cfg.wcMaxWords || 3));
        var p = document.createElement('p');
        p.className = 'tm-stu-sub';
        p.textContent = '핵심 단어를 최대 ' + maxW + '개까지 입력해 주세요.';
        box.appendChild(p);
        for (var i = 1; i <= maxW; i++) {
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'tm-input stu-wc-inp';
          inp.maxLength = 24;
          inp.placeholder = i + '번째 단어' + (i > 1 ? ' (선택)' : '');
          box.appendChild(inp);
        }
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tm-btn tm-btn-primary tm-btn-full';
        btn.textContent = '단어 제출하기';
        btn.addEventListener('click', function () {
          var words = [];
          box.querySelectorAll('.stu-wc-inp').forEach(function (x) {
            var v = (x.value || '').trim();
            if (v) words.push(v);
          });
          if (!words.length) { showFeedback('단어를 1개 이상 입력해 주세요.', false); return; }
          if (sendSubmit({ kind: 'wordcloud', words: words })) {
            box.querySelectorAll('.stu-wc-inp').forEach(function (x) { x.value = ''; });
          }
        });
        box.appendChild(btn);
      } else if (cfg.type === 'poll' || cfg.type === 'quiz') {
        var selectedIdx = -1;
        var nameInp = null;
        if (cfg.type === 'quiz') {
          nameInp = document.createElement('input');
          nameInp.type = 'text';
          nameInp.className = 'tm-input';
          nameInp.placeholder = '닉네임 / 이름 입력 (리더보드 표시용)';
          nameInp.maxLength = 20;
          box.appendChild(nameInp);
        }
        var startTs = Date.now();
        (cfg.options || []).forEach(function (opt, idx) {
          var cb = document.createElement('button');
          cb.type = 'button';
          cb.className = 'tm-choice-btn';
          cb.textContent = (idx + 1) + '. ' + opt;
          cb.addEventListener('click', function () {
            selectedIdx = idx;
            box.querySelectorAll('.tm-choice-btn').forEach(function (x) { x.classList.remove('active'); });
            cb.classList.add('active');
          });
          box.appendChild(cb);
        });
        var subBtn = document.createElement('button');
        subBtn.type = 'button';
        subBtn.className = 'tm-btn tm-btn-primary tm-btn-full';
        subBtn.textContent = cfg.type === 'quiz' ? '정답 제출하기' : '투표 제출하기';
        subBtn.addEventListener('click', function () {
          if (selectedIdx < 0) { showFeedback('항목을 선택해 주세요.', false); return; }
          if (cfg.type === 'quiz') {
            var author = (nameInp && nameInp.value || '').trim() || ('학생' + clientId.slice(-3));
            var elapsed = Math.max(1, Math.round((Date.now() - startTs) / 1000));
            sendSubmit({ kind: 'quiz', choiceIndex: selectedIdx, author: author, elapsedSec: elapsed });
          } else {
            sendSubmit({ kind: 'poll', choiceIndex: selectedIdx });
          }
        });
        box.appendChild(subBtn);
      } else if (cfg.type === 'scale') {
        var selVal = 0;
        var row = document.createElement('div');
        row.className = 'tm-scale-row';
        for (var v = 1; v <= 5; v++) {
          (function (val) {
            var sb = document.createElement('button');
            sb.type = 'button';
            sb.className = 'tm-scale-pick';
            sb.textContent = String(val);
            sb.addEventListener('click', function () {
              selVal = val;
              row.querySelectorAll('.tm-scale-pick').forEach(function (x) { x.classList.remove('active'); });
              sb.classList.add('active');
            });
            row.appendChild(sb);
          })(v);
        }
        box.appendChild(row);
        var ends = document.createElement('div');
        ends.style.cssText = 'display:flex;justify-content:space-between;font-size:0.78rem;color:#64748b;';
        ends.innerHTML = '<span>' + esc(cfg.scaleMin) + '</span><span>' + esc(cfg.scaleMax) + '</span>';
        box.appendChild(ends);
        var sBtn = document.createElement('button');
        sBtn.type = 'button';
        sBtn.className = 'tm-btn tm-btn-primary tm-btn-full';
        sBtn.textContent = '점수 제출하기';
        sBtn.addEventListener('click', function () {
          if (!selVal) { showFeedback('1~5점 중 하나를 선택해 주세요.', false); return; }
          sendSubmit({ kind: 'scale', value: selVal });
        });
        box.appendChild(sBtn);
      } else if (cfg.type === 'ranking') {
        var order = (cfg.options || []).map(function (_, i) { return i; });
        var listDiv = document.createElement('div');
        listDiv.style.cssText = 'display:flex;flex-direction:column;gap:7px;';
        function drawRankList() {
          listDiv.innerHTML = '';
          order.forEach(function (optIdx, pos) {
            var r = document.createElement('div');
            r.className = 'tm-rank-row';
            r.innerHTML = '<span><b>' + (pos + 1) + '위</b> · ' + esc(cfg.options[optIdx]) + '</span>';
            var btns = document.createElement('div');
            btns.className = 'tm-rank-btns';
            var up = document.createElement('button'); up.type = 'button'; up.textContent = '▲'; up.disabled = pos === 0;
            var dn = document.createElement('button'); dn.type = 'button'; dn.textContent = '▼'; dn.disabled = pos === order.length - 1;
            up.addEventListener('click', function () { var t = order[pos - 1]; order[pos - 1] = order[pos]; order[pos] = t; drawRankList(); });
            dn.addEventListener('click', function () { var t = order[pos + 1]; order[pos + 1] = order[pos]; order[pos] = t; drawRankList(); });
            btns.appendChild(up); btns.appendChild(dn);
            r.appendChild(btns);
            listDiv.appendChild(r);
          });
        }
        drawRankList();
        box.appendChild(listDiv);
        var rBtn = document.createElement('button');
        rBtn.type = 'button';
        rBtn.className = 'tm-btn tm-btn-primary tm-btn-full';
        rBtn.textContent = '순위 제출하기';
        rBtn.addEventListener('click', function () { sendSubmit({ kind: 'ranking', order: order.slice() }); });
        box.appendChild(rBtn);
      } else if (cfg.type === 'points100') {
        var opts = cfg.options || [];
        var vals = opts.map(function () { return Math.floor(100 / Math.max(1, opts.length)); });
        vals[0] += 100 - vals.reduce(function (a, b) { return a + b; }, 0);
        var remEl = document.createElement('div');
        remEl.className = 'tm-pts-remain';
        function updateRem() {
          var sum = vals.reduce(function (a, b) { return a + b; }, 0);
          var rem = 100 - sum;
          remEl.textContent = '현재 합계: ' + sum + '점 (남은 점수: ' + rem + '점)';
          remEl.style.color = rem === 0 ? '#15803d' : '#dc2626';
        }
        opts.forEach(function (opt, idx) {
          var row = document.createElement('div');
          row.className = 'tm-pts-row';
          row.innerHTML = '<span>' + esc(opt) + '</span>';
          var inp = document.createElement('input');
          inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = '5';
          inp.className = 'tm-input tm-pts-input';
          inp.value = String(vals[idx]);
          inp.addEventListener('input', function () {
            vals[idx] = Math.max(0, Math.min(100, parseInt(inp.value, 10) || 0));
            updateRem();
          });
          row.appendChild(inp);
          box.appendChild(row);
        });
        updateRem();
        box.appendChild(remEl);
        var pBtn = document.createElement('button');
        pBtn.type = 'button';
        pBtn.className = 'tm-btn tm-btn-primary tm-btn-full';
        pBtn.textContent = '100점 배분 제출하기';
        pBtn.addEventListener('click', function () {
          var sum = vals.reduce(function (a, b) { return a + b; }, 0);
          if (sum !== 100) { showFeedback('합계가 정확히 100점이 되도록 맞춰 주세요. (현재 ' + sum + '점)', false); return; }
          sendSubmit({ kind: 'points100', points: vals.slice() });
        });
        box.appendChild(pBtn);
      } else if (cfg.type === 'matrix2x2') {
        var xVal = 5, yVal = 5;
        var xBox = document.createElement('div');
        xBox.className = 'tm-matrix-slider-box';
        xBox.innerHTML = '<label><span>가로축: ' + esc(cfg.matrixX || 'X') + '</span><b id="stuMxVal">5점</b></label>' +
          '<input type="range" id="stuMxInp" min="1" max="10" value="5">';
        var yBox = document.createElement('div');
        yBox.className = 'tm-matrix-slider-box';
        yBox.innerHTML = '<label><span>세로축: ' + esc(cfg.matrixY || 'Y') + '</span><b id="stuMyVal">5점</b></label>' +
          '<input type="range" id="stuMyInp" min="1" max="10" value="5">';
        box.appendChild(xBox);
        box.appendChild(yBox);
        xBox.querySelector('#stuMxInp').addEventListener('input', function () { xVal = parseInt(this.value, 10); xBox.querySelector('#stuMxVal').textContent = xVal + '점'; });
        yBox.querySelector('#stuMyInp').addEventListener('input', function () { yVal = parseInt(this.value, 10); yBox.querySelector('#stuMyVal').textContent = yVal + '점'; });
        var mBtn = document.createElement('button');
        mBtn.type = 'button';
        mBtn.className = 'tm-btn tm-btn-primary tm-btn-full';
        mBtn.textContent = '좌표 제출하기';
        mBtn.addEventListener('click', function () { sendSubmit({ kind: 'matrix2x2', x: xVal, y: yVal }); });
        box.appendChild(mBtn);
      } else {
        var aInp = document.createElement('input');
        aInp.type = 'text'; aInp.className = 'tm-input'; aInp.placeholder = '이름/별명 (비우면 익명)'; aInp.maxLength = 24;
        var tInp = document.createElement('textarea');
        tInp.className = 'tm-input tm-textarea'; tInp.rows = 4; tInp.placeholder = '질문이나 자유로운 의견을 적어 주세요.';
        var oBtn = document.createElement('button');
        oBtn.type = 'button'; oBtn.className = 'tm-btn tm-btn-primary tm-btn-full'; oBtn.textContent = '의견 제출하기';
        oBtn.addEventListener('click', function () {
          var txt = (tInp.value || '').trim();
          if (!txt) { showFeedback('내용을 입력해 주세요.', false); return; }
          if (sendSubmit({ kind: 'open', author: (aInp.value || '').trim() || '익명', text: txt })) tInp.value = '';
        });
        box.appendChild(aInp); box.appendChild(tInp); box.appendChild(oBtn);
      }
    }

    function connectWithRetry() {
      if (!roomCode) { el('stuConnSub').textContent = '방 코드가 없습니다. 선생님 QR 코드를 다시 스캔하세요.'; return; }
      if (typeof window.Peer !== 'function') { setTimeout(connectWithRetry, 350); return; }
      var peer = new window.Peer();
      peer.on('open', function () {
        var conn = peer.connect('tong-menti-' + roomCode, { reliable: true });
        conn.on('open', function () {
          peerConn = conn;
          conn.send({ type: 'hello', clientId: clientId });
        });
        conn.on('data', function (msg) {
          if (msg && msg.type === 'config' && msg.config) renderStudentUI(msg.config);
        });
        conn.on('close', function () {
          el('stuConnSub').textContent = '연결 재시도 중...';
          setTimeout(connectWithRetry, 700 + Math.floor(Math.random() * 1100));
        });
      });
      peer.on('error', function () {
        el('stuConnSub').textContent = '방 연결을 다시 시도하고 있습니다...';
        setTimeout(connectWithRetry, 1200 + Math.floor(Math.random() * 1000));
      });
    }
    connectWithRetry();
  }

  // =========================================================================
  // 2. 교사용 통합 멘티미터 대시보드 (멀티 슬라이드 + 8종 활동 + 그래프 전환 + 구조화 요약)
  // =========================================================================
  function initTeacherMode() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) {}

    var state = (saved && Array.isArray(saved.slides) && saved.slides.length) ? saved : {
      roomCode: String(Math.floor(100000 + Math.random() * 900000)),
      limitOnce: true,
      activeIndex: 0,
      slides: [createSlide('wordcloud'), createSlide('poll')]
    };
    if (typeof state.activeIndex !== 'number' || state.activeIndex >= state.slides.length) state.activeIndex = 0;

    var activeConns = {}; // peerId -> conn
    var redrawTimer = null;

    function curSlide() { return state.slides[state.activeIndex] || state.slides[0]; }
    function persist() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {} }

    function updateLiveUsersUI() {
      var cnt = Object.keys(activeConns).filter(function (k) { return activeConns[k] && activeConns[k].open; }).length;
      var pill = el('liveUsersPill');
      var stateText = cnt <= 40 ? '쾌적 · 권장 ≤60명' : (cnt <= 65 ? '원활 · 합반 수준' : '혼잡 주의 · 방 분리 권장');
      pill.textContent = '접속 중 ' + cnt + '명 (' + stateText + ')';
      pill.classList.toggle('is-busy', cnt > 40 && cnt <= 65);
      pill.classList.toggle('is-high', cnt > 65);
      el('stageLiveUsers').textContent = String(cnt);
    }

    function getPublicConfig() {
      var s = curSlide();
      return {
        slideId: s.id,
        slideIndex: state.activeIndex,
        totalSlides: state.slides.length,
        type: s.type,
        question: s.question,
        wcMaxWords: s.wcMaxWords,
        options: s.options,
        scaleMin: s.scaleMin,
        scaleMax: s.scaleMax,
        matrixX: s.matrixX,
        matrixY: s.matrixY,
        locked: Boolean(s.locked),
        limitOnce: Boolean(state.limitOnce)
      };
    }

    function broadcastConfig() {
      var cfg = getPublicConfig();
      Object.keys(activeConns).forEach(function (pid) {
        var c = activeConns[pid];
        if (c && c.open) {
          try { c.send({ type: 'config', config: cfg }); } catch (e) {}
        }
      });
    }

    function getJoinUrl() {
      return location.origin + location.pathname + '?join=1&room=' + encodeURIComponent(state.roomCode);
    }

    function renderQrCodes() {
      var url = getJoinUrl();
      el('miniRoomCode').textContent = state.roomCode;
      el('stageRoomCode').textContent = state.roomCode;
      el('bigRoomCode').textContent = state.roomCode;
      el('joinUrlInput').value = url;
      if (typeof window.qrcode === 'function') {
        var qr1 = window.qrcode(0, 'M'); qr1.addData(url); qr1.make();
        el('miniQrBox').innerHTML = qr1.createSvgTag({ cellSize: 4, margin: 1 });
        el('bigQrBox').innerHTML = qr1.createSvgTag({ cellSize: 6, margin: 2 });
      }
    }

    // ==================== 구조화 데이터 계산기 ====================
    function computeStructuredData(s) {
      var rows = []; // [{ label, value, pct, extra, isCorrect }]
      var total = 0;
      var kpis = [];

      if (s.type === 'wordcloud') {
        var entries = Object.keys(s.words || {}).map(function (w) { return { w: w, c: s.words[w] }; })
          .filter(function (x) { return x.c > 0; }).sort(function (a, b) { return b.c - a.c; });
        total = entries.reduce(function (a, b) { return a + b.c; }, 0);
        rows = entries.map(function (it, i) {
          return { rank: i + 1, label: it.w, value: it.c, unit: '회', pct: total ? Math.round((it.c / total) * 100) : 0 };
        });
        kpis = [
          { k: '총 단어 제출', v: total + '회' },
          { k: '고유 키워드 수', v: entries.length + '종' },
          { k: '최다 빈도 1위', v: entries[0] ? (entries[0].w + ' (' + entries[0].c + '회)') : '-' },
          { k: '상위 3개 집중도', v: total ? (Math.round(entries.slice(0, 3).reduce(function (a, b) { return a + b.c; }, 0) / total * 100) + '%') : '0%' }
        ];
      } else if (s.type === 'poll' || s.type === 'quiz') {
        while (s.votes.length < s.options.length) s.votes.push(0);
        total = s.votes.slice(0, s.options.length).reduce(function (a, b) { return a + b; }, 0);
        rows = s.options.map(function (opt, i) {
          var c = s.votes[i] || 0;
          return {
            rank: i + 1, label: opt, value: c, unit: '표',
            pct: total ? Math.round((c / total) * 100) : 0,
            isCorrect: s.type === 'quiz' && i === (s.correctIndex || 0)
          };
        });
        var sorted = rows.slice().sort(function (a, b) { return b.value - a.value; });
        if (s.type === 'quiz') {
          var corCnt = s.votes[s.correctIndex || 0] || 0;
          var corRate = total ? Math.round((corCnt / total) * 100) : 0;
          kpis = [
            { k: '총 참여 인원', v: total + '명' },
            { k: '정답률', v: corRate + '% (' + corCnt + '명)' },
            { k: '정답 항목', v: s.options[s.correctIndex || 0] || '-' },
            { k: '최다 선택', v: sorted[0] && sorted[0].value ? sorted[0].label : '-' }
          ];
        } else {
          kpis = [
            { k: '총 투표 수', v: total + '표' },
            { k: '최다 득표 1위', v: sorted[0] && sorted[0].value ? (sorted[0].label + ' (' + sorted[0].pct + '%)') : '-' },
            { k: '2위 항목', v: sorted[1] && sorted[1].value ? (sorted[1].label + ' (' + sorted[1].pct + '%)') : '-' },
            { k: '선택지 수', v: s.options.length + '개' }
          ];
        }
      } else if (s.type === 'scale') {
        var counts = [0, 0, 0, 0, 0];
        var vals = (s.scales || []).filter(function (v) { return v >= 1 && v <= 5; });
        total = vals.length;
        vals.forEach(function (v) { counts[v - 1]++; });
        var avg = total ? (vals.reduce(function (a, b) { return a + b; }, 0) / total) : 0;
        var variance = total ? vals.reduce(function (a, b) { return a + Math.pow(b - avg, 2); }, 0) / total : 0;
        var std = Math.sqrt(variance);
        var sortedV = vals.slice().sort(function (a, b) { return a - b; });
        var med = total ? (total % 2 ? sortedV[(total - 1) / 2] : (sortedV[total / 2 - 1] + sortedV[total / 2]) / 2) : 0;
        rows = counts.map(function (c, i) {
          return { rank: i + 1, label: (i + 1) + '점', value: c, unit: '명', pct: total ? Math.round((c / total) * 100) : 0 };
        });
        kpis = [
          { k: '총 응답자', v: total + '명' },
          { k: '평균 점수', v: avg.toFixed(2) + ' / 5.0' },
          { k: '중앙값', v: med.toFixed(1) + '점' },
          { k: '표준편차 (분산도)', v: '±' + std.toFixed(2) }
        ];
      } else if (s.type === 'ranking') {
        total = (s.rankings || []).length;
        var n = s.options.length;
        var scores = s.options.map(function () { return 0; });
        (s.rankings || []).forEach(function (ord) {
          ord.forEach(function (optIdx, pos) {
            if (optIdx >= 0 && optIdx < n) scores[optIdx] += (n - pos);
          });
        });
        var totalScore = scores.reduce(function (a, b) { return a + b; }, 0);
        rows = s.options.map(function (opt, i) {
          return { label: opt, value: scores[i], unit: '점', pct: totalScore ? Math.round((scores[i] / totalScore) * 100) : 0 };
        }).sort(function (a, b) { return b.value - a.value; }).map(function (r, idx) { r.rank = idx + 1; return r; });
        kpis = [
          { k: '총 참여자', v: total + '명' },
          { k: '종합 1위', v: rows[0] && rows[0].value ? rows[0].label : '-' },
          { k: '종합 2위', v: rows[1] && rows[1].value ? rows[1].label : '-' },
          { k: '집계 방식', v: 'Borda 가중 순위' }
        ];
      } else if (s.type === 'points100') {
        total = (s.pointsList || []).length;
        var sums = s.options.map(function () { return 0; });
        (s.pointsList || []).forEach(function (arr) {
          arr.forEach(function (v, i) { if (i < sums.length) sums[i] += Number(v) || 0; });
        });
        rows = s.options.map(function (opt, i) {
          var avgP = total ? Math.round((sums[i] / total) * 10) / 10 : 0;
          return { rank: i + 1, label: opt, value: avgP, unit: '점', pct: Math.round(avgP) };
        }).sort(function (a, b) { return b.value - a.value; });
        kpis = [
          { k: '총 배분 참여', v: total + '명' },
          { k: '최고 비중 항목', v: rows[0] && total ? (rows[0].label + ' (' + rows[0].value + '점)') : '-' },
          { k: '최저 비중 항목', v: rows[rows.length - 1] && total ? (rows[rows.length - 1].label + ' (' + rows[rows.length - 1].value + '점)') : '-' },
          { k: '기준 총점', v: '100점 배분' }
        ];
      } else if (s.type === 'matrix2x2') {
        var pts = s.matrixPoints || [];
        total = pts.length;
        var avgX = total ? pts.reduce(function (a, p) { return a + p.x; }, 0) / total : 0;
        var avgY = total ? pts.reduce(function (a, p) { return a + p.y; }, 0) / total : 0;
        var q1 = 0, q2 = 0, q3 = 0, q4 = 0;
        pts.forEach(function (p) {
          if (p.x >= 5.5 && p.y >= 5.5) q1++;
          else if (p.x < 5.5 && p.y >= 5.5) q2++;
          else if (p.x < 5.5 && p.y < 5.5) q3++;
          else q4++;
        });
        rows = [
          { rank: 1, label: '1사분면 (X높음 · Y높음)', value: q1, unit: '명', pct: total ? Math.round((q1 / total) * 100) : 0 },
          { rank: 2, label: '2사분면 (X낮음 · Y높음)', value: q2, unit: '명', pct: total ? Math.round((q2 / total) * 100) : 0 },
          { rank: 3, label: '3사분면 (X낮음 · Y낮음)', value: q3, unit: '명', pct: total ? Math.round((q3 / total) * 100) : 0 },
          { rank: 4, label: '4사분면 (X높음 · Y낮음)', value: q4, unit: '명', pct: total ? Math.round((q4 / total) * 100) : 0 }
        ];
        kpis = [
          { k: '총 응답 좌표', v: total + '개' },
          { k: (s.matrixX || 'X') + ' 평균', v: avgX.toFixed(1) + ' / 10' },
          { k: (s.matrixY || 'Y') + ' 평균', v: avgY.toFixed(1) + ' / 10' },
          { k: '최다 분포 구역', v: rows.slice().sort(function (a, b) { return b.value - a.value; })[0].label.split(' ')[0] }
        ];
      } else {
        var opens = s.opens || [];
        total = opens.length;
        rows = opens.map(function (o, i) {
          return { rank: i + 1, label: o.author || '익명', value: o.likes || 0, unit: '공감', extra: o.text };
        });
        kpis = [
          { k: '총 의견/질문', v: total + '건' },
          { k: '최다 공감', v: opens.length ? (Math.max.apply(null, opens.map(function (x) { return x.likes || 0; })) + '회') : '0회' },
          { k: '최근 작성자', v: opens[0] ? opens[0].author : '-' },
          { k: '표시 방식', v: '실시간 카드' }
        ];
      }
      return { rows: rows, total: total, kpis: kpis };
    }

    // ==================== Canvas 렌더러 3종 (워드클라우드, 도넛, 2×2 산점도) ====================
    function prepareCanvas() {
      var canvas = el('mainCanvas');
      var wrap = el('canvasStageWrap');
      var W = Math.max(460, wrap.clientWidth || 720);
      var H = Math.max(340, wrap.clientHeight || 380);
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      return { canvas: canvas, ctx: ctx, W: W, H: H };
    }

    function drawWordCloudCanvas(s, data) {
      var c = prepareCanvas();
      var ctx = c.ctx, W = c.W, H = c.H;
      var rows = data.rows.slice(0, 60);
      el('canvasEmptyHint').style.display = rows.length ? 'none' : 'flex';
      if (!rows.length) return;
      var maxC = rows[0].value, minC = rows[rows.length - 1].value;
      var placed = [];
      function hit(a, b) { return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y); }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      rows.forEach(function (it, idx) {
        var ratio = maxC === minC ? 0.72 : (it.value - minC) / (maxC - minC);
        var fs = Math.round(18 + ratio * 46);
        ctx.font = '900 ' + fs + 'px Pretendard, "Noto Sans KR", sans-serif';
        var tw = ctx.measureText(it.label).width + 14;
        var th = fs * 1.14;
        var found = null;
        for (var st = 0; st < 320; st++) {
          var ang = st * 0.38, rad = st * 1.45;
          var x = W / 2 + Math.cos(ang) * rad * 1.35;
          var y = H / 2 + Math.sin(ang) * rad * 0.88;
          var box = { x: x - tw / 2, y: y - th / 2, w: tw, h: th };
          if (box.x < 8 || box.y < 8 || box.x + box.w > W - 8 || box.y + box.h > H - 8) continue;
          if (!placed.some(function (p) { return hit(box, p); })) { found = { x: x, y: y, box: box }; break; }
        }
        if (found) {
          placed.push(found.box);
          ctx.fillStyle = COLORS[idx % COLORS.length];
          ctx.fillText(it.label, found.x, found.y);
        }
      });
    }

    function drawDonutCanvas(data) {
      var c = prepareCanvas();
      var ctx = c.ctx, W = c.W, H = c.H;
      var items = data.rows.filter(function (r) { return r.value > 0; }).slice(0, 8);
      el('canvasEmptyHint').style.display = items.length ? 'none' : 'flex';
      if (!items.length) return;
      var sum = items.reduce(function (a, b) { return a + b.value; }, 0);
      var cx = W * 0.34, cy = H / 2, r = Math.min(W * 0.24, H * 0.38);
      var start = -Math.PI / 2;
      items.forEach(function (it, i) {
        var ang = (it.value / sum) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, start, start + ang);
        ctx.closePath();
        ctx.fillStyle = COLORS[i % COLORS.length];
        ctx.fill();
        start += ang;
      });
      // 도넛 홀
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.54, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.textAlign = 'center';
      ctx.font = '900 22px Pretendard, sans-serif';
      ctx.fillText(String(data.total), cx, cy - 4);
      ctx.font = '700 12px Pretendard, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText('총 응답', cx, cy + 16);

      // 오른쪽 범례
      var lx = W * 0.60, ly = Math.max(36, H / 2 - (items.length * 28) / 2);
      ctx.textAlign = 'left';
      items.forEach(function (it, i) {
        var y = ly + i * 28;
        ctx.fillStyle = COLORS[i % COLORS.length];
        ctx.fillRect(lx, y - 8, 14, 14);
        ctx.fillStyle = '#0f172a';
        ctx.font = '800 13px Pretendard, "Noto Sans KR", sans-serif';
        var pct = Math.round((it.value / sum) * 100);
        ctx.fillText(it.label.slice(0, 16) + ' · ' + it.value + (it.unit || '') + ' (' + pct + '%)', lx + 22, y + 4);
      });
    }

    function drawMatrixCanvas(s) {
      var c = prepareCanvas();
      var ctx = c.ctx, W = c.W, H = c.H;
      var pad = 48;
      var gw = W - pad * 2, gh = H - pad * 2;
      el('canvasEmptyHint').style.display = 'none';

      // 사분면 배경
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(pad, pad, gw, gh);
      ctx.fillStyle = 'rgba(79,70,229,0.06)';
      ctx.fillRect(pad + gw / 2, pad, gw / 2, gh / 2);

      // 격자 및 중심선
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.strokeRect(pad, pad, gw, gh);
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(pad + gw / 2, pad); ctx.lineTo(pad + gw / 2, pad + gh);
      ctx.moveTo(pad, pad + gh / 2); ctx.lineTo(pad + gw, pad + gh / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // 축 라벨
      ctx.fillStyle = '#1e293b';
      ctx.font = '800 13px Pretendard, "Noto Sans KR", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText((s.matrixX || '중요도') + ' (1 → 10)', pad + gw / 2, H - 14);
      ctx.save();
      ctx.translate(18, pad + gh / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText((s.matrixY || '시급성') + ' (1 → 10)', 0, 0);
      ctx.restore();

      var pts = s.matrixPoints || [];
      if (!pts.length) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '700 14px Pretendard, sans-serif';
        ctx.fillText('학생들이 좌표를 제출하면 점과 학급 평균 중심점이 표시됩니다.', pad + gw / 2, pad + gh / 2);
        return;
      }

      var sumX = 0, sumY = 0;
      pts.forEach(function (p) {
        sumX += p.x; sumY += p.y;
        var px = pad + ((p.x - 1) / 9) * gw;
        var py = pad + gh - ((p.y - 1) / 9) * gh;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(79, 70, 229, 0.55)';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });

      // 학급 평균 중심점
      var ax = sumX / pts.length, ay = sumY / pts.length;
      var cpx = pad + ((ax - 1) / 9) * gw;
      var cpy = pad + gh - ((ay - 1) / 9) * gh;
      ctx.beginPath();
      ctx.arc(cpx, cpy, 13, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#b91c1c';
      ctx.font = '900 12px Pretendard, sans-serif';
      ctx.fillText('학급 평균 (' + ax.toFixed(1) + ', ' + ay.toFixed(1) + ')', cpx, cpy - 19);
    }

    // ==================== HTML 차트 & 구조화 표 렌더러 ====================
    function renderHbarHtml(data, s) {
      var maxV = Math.max.apply(null, data.rows.map(function (r) { return r.value; }).concat([1]));
      var html = '<div class="tm-hbar-list">' + data.rows.slice(0, 12).map(function (r, idx) {
        var wPct = Math.round((r.value / maxV) * 100);
        return (
          '<div class="tm-hbar-item">' +
            '<div class="tm-hbar-head"><span>' + (r.rank || (idx + 1)) + '. ' + esc(r.label) +
              (r.isCorrect ? '<span class="is-ans">정답</span>' : '') + '</span>' +
              '<span>' + r.value + (r.unit || '') + ' (' + r.pct + '%)</span></div>' +
            '<div class="tm-hbar-track"><div class="tm-hbar-fill" style="width:' + Math.max(wPct, r.value > 0 ? 5 : 0) + '%;background:' + COLORS[idx % COLORS.length] + '">' +
              (wPct >= 14 ? r.pct + '%' : '') + '</div></div>' +
          '</div>'
        );
      }).join('') + '</div>';

      if (s && s.type === 'quiz') {
        var board = Object.keys(s.quizScores || {}).map(function (name) {
          return { name: name, score: s.quizScores[name] };
        }).sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
        if (board.length) {
          html += '<div class="tm-leader-box"><div class="tm-leader-title">실시간 퀴즈 리더보드 (Top ' + board.length + ')</div><div class="tm-leader-grid">' +
            board.map(function (b, i) {
              return '<div class="tm-leader-item ' + (i === 0 ? 'top1' : '') + '"><span>' + (i + 1) + '위 · ' + esc(b.name) + '</span><b>' + b.score + '점</b></div>';
            }).join('') + '</div></div>';
        }
      }
      return html;
    }

    function renderVbarHtml(data, s) {
      var rows = data.rows.slice(0, 8);
      var maxV = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
      var topBanner = '';
      if (s && s.type === 'scale') {
        var vals = (s.scales || []).filter(function (v) { return v >= 1 && v <= 5; });
        var avg = vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length).toFixed(1) : '0.0';
        topBanner = '<div class="tm-scale-banner"><span>실시간 평균</span><strong>' + avg + '</strong><span>/ 5.0점</span></div>';
      }
      var bars = '<div class="tm-vbar-grid">' + rows.map(function (r, idx) {
        var hPct = Math.round((r.value / maxV) * 78);
        return (
          '<div class="tm-vbar-col">' +
            '<span class="tm-vbar-val">' + r.value + (r.unit || '') + '</span>' +
            '<div class="tm-vbar-bar" style="height:' + Math.max(4, hPct) + '%;background:' + COLORS[idx % COLORS.length] + '"></div>' +
            '<span class="tm-vbar-lbl">' + esc(r.label) + '</span>' +
          '</div>'
        );
      }).join('') + '</div>';
      var ends = (s && s.type === 'scale')
        ? '<div class="tm-scale-ends"><span>' + esc(s.scaleMin) + '</span><span>' + esc(s.scaleMax) + '</span></div>' : '';
      return topBanner + bars + ends;
    }

    function renderTableHtml(data, s) {
      if (s.type === 'open') {
        return '<table class="tm-data-table"><thead><tr><th>순번</th><th>작성자</th><th>의견 내용</th><th>공감</th></tr></thead><tbody>' +
          (data.rows.length ? data.rows.map(function (r) {
            return '<tr><td>' + r.rank + '</td><td>' + esc(r.label) + '</td><td>' + esc(r.extra) + '</td><td>♥ ' + r.value + '</td></tr>';
          }).join('') : '<tr><td colspan="4" style="text-align:center;color:#64748b;">응답 데이터가 없습니다.</td></tr>') +
          '</tbody></table>';
      }
      return '<table class="tm-data-table"><thead><tr><th>순위/번호</th><th>항목</th><th>집계 수치</th><th>비율 (%)</th></tr></thead><tbody>' +
        (data.rows.length ? data.rows.map(function (r) {
          return '<tr><td>' + (r.rank || '-') + '</td><td><b>' + esc(r.label) + '</b>' + (r.isCorrect ? ' <span style="color:#15803d;font-weight:800;">[정답]</span>' : '') + '</td><td>' + r.value + (r.unit || '') + '</td><td>' + (r.pct || 0) + '%</td></tr>';
        }).join('') : '<tr><td colspan="4" style="text-align:center;color:#64748b;">응답 데이터가 없습니다.</td></tr>') +
        '</tbody></table>';
    }

    function renderOpenCardsHtml(s) {
      var list = s.opens || [];
      if (!list.length) {
        return '<div style="text-align:center;color:#64748b;padding:48px 16px;">아직 도착한 의견이 없습니다. QR 참여 또는 [모의 학생 18명 응답 체험]을 눌러 보세요.</div>';
      }
      return '<div class="tm-open-grid">' + list.map(function (it, idx) {
        return (
          '<article class="tm-open-card">' +
            '<div class="tm-open-head"><span>' + esc(it.author || '익명') + '</span><button type="button" class="tm-open-del" data-del-open="' + idx + '">×</button></div>' +
            '<div class="tm-open-body">' + esc(it.text) + '</div>' +
            '<div class="tm-open-foot"><button type="button" class="tm-open-like" data-like-open="' + idx + '">♥ ' + (it.likes || 0) + '</button></div>' +
          '</article>'
        );
      }).join('') + '</div>';
    }

    // ==================== 메인 스테이지 & 사이드바 전체 렌더링 ====================
    function renderSlideList() {
      var wrap = el('slideListWrap');
      wrap.innerHTML = '';
      state.slides.forEach(function (sl, idx) {
        var div = document.createElement('div');
        div.className = 'tm-slide-item' + (idx === state.activeIndex ? ' active' : '');
        div.innerHTML =
          '<div class="tm-slide-item-txt">' +
            '<b>' + (idx + 1) + '. [' + esc(TYPE_META[sl.type].label) + ']</b>' +
            '<small>' + esc(sl.question.slice(0, 26)) + '</small>' +
          '</div>';
        div.addEventListener('click', function () {
          state.activeIndex = idx;
          persist();
          renderAll();
          broadcastConfig();
        });
        if (state.slides.length > 1) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'tm-slide-del';
          del.textContent = '×';
          del.title = '슬라이드 삭제';
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            state.slides.splice(idx, 1);
            if (state.activeIndex >= state.slides.length) state.activeIndex = state.slides.length - 1;
            persist();
            renderAll();
            broadcastConfig();
          });
          div.appendChild(del);
        }
        wrap.appendChild(div);
      });
      var ctr = (state.activeIndex + 1) + ' / ' + state.slides.length;
      el('slideCounterText').textContent = ctr;
      el('presSlideText').textContent = ctr;
    }

    function renderSidebarControls() {
      var s = curSlide();
      el('slideTypeSelect').value = s.type;
      el('questionInput').value = s.question;
      el('wcMaxWordsSelect').value = String(s.wcMaxWords || 3);
      el('scaleMinInput').value = s.scaleMin || '';
      el('scaleMaxInput').value = s.scaleMax || '';
      el('matrixXInput').value = s.matrixX || '중요도';
      el('matrixYInput').value = s.matrixY || '시급성';

      el('wcConfigSec').style.display = s.type === 'wordcloud' ? 'flex' : 'none';
      var hasOpts = ['poll', 'ranking', 'points100', 'quiz'].indexOf(s.type) >= 0;
      el('optionsConfigSec').style.display = hasOpts ? 'flex' : 'none';
      el('quizCorrectHint').style.display = s.type === 'quiz' ? 'block' : 'none';
      el('scaleConfigSec').style.display = s.type === 'scale' ? 'flex' : 'none';
      el('matrixConfigSec').style.display = s.type === 'matrix2x2' ? 'flex' : 'none';

      if (hasOpts) {
        var wrap = el('optionsList');
        wrap.innerHTML = '';
        s.options.forEach(function (opt, idx) {
          var row = document.createElement('div');
          row.className = 'tm-opt-row';
          if (s.type === 'quiz') {
            var rad = document.createElement('input');
            rad.type = 'radio'; rad.name = 'quizCorrect'; rad.className = 'tm-opt-radio';
            rad.checked = idx === (s.correctIndex || 0);
            rad.title = '정답 선택';
            rad.addEventListener('change', function () { s.correctIndex = idx; persist(); renderStage(); });
            row.appendChild(rad);
          }
          var inp = document.createElement('input');
          inp.type = 'text'; inp.className = 'tm-input'; inp.value = opt;
          inp.addEventListener('input', function () { s.options[idx] = inp.value; persist(); renderStage(); broadcastConfig(); });
          row.appendChild(inp);
          if (s.options.length > 2) {
            var del = document.createElement('button');
            del.type = 'button'; del.className = 'tm-opt-del'; del.textContent = '×';
            del.addEventListener('click', function () {
              s.options.splice(idx, 1);
              if (s.votes) s.votes.splice(idx, 1);
              if (s.correctIndex >= s.options.length) s.correctIndex = 0;
              persist(); renderSidebarControls(); renderStage(); broadcastConfig();
            });
            row.appendChild(del);
          }
          wrap.appendChild(row);
        });
      }

      // 토글 버튼 상태
      var lk = el('toggleLockBtn');
      lk.textContent = s.locked ? '응답 마감됨' : '응답 열림';
      lk.className = 'tm-toggle-btn' + (s.locked ? ' is-warn' : ' active');

      var hd = el('toggleHideResBtn');
      hd.textContent = s.hideResults ? '결과 숨김중' : '결과 공개중';
      hd.className = 'tm-toggle-btn' + (s.hideResults ? ' is-warn' : ' active');
      el('presHideBtn').textContent = s.hideResults ? '결과 공개' : '결과 가리기';

      var lm = el('toggleLimitOnceBtn');
      lm.textContent = '1인 1회: ' + (state.limitOnce ? 'ON' : 'OFF');
      lm.className = 'tm-toggle-btn' + (state.limitOnce ? ' active' : '');
    }

    function renderStage() {
      var s = curSlide();
      var data = computeStructuredData(s);
      el('stageTypeBadge').textContent = TYPE_META[s.type].label;
      el('stageLockBadge').style.display = s.locked ? 'inline-block' : 'none';
      el('stageQuestionText').textContent = s.question || '질문을 입력하세요';
      el('stageRespCount').textContent = String(data.total);
      el('hiddenRespCnt').textContent = String(data.total);

      // 시각화 모드 버튼 강조
      document.querySelectorAll('.tm-viz-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-viz') === (s.vizMode || 'default'));
      });

      // 결과 가리기 처리
      el('hiddenCover').style.display = s.hideResults ? 'flex' : 'none';
      el('mainVizCard').style.display = s.hideResults ? 'none' : 'flex';

      if (!s.hideResults) {
        var viz = s.vizMode || 'default';
        var useCanvas = (viz === 'donut') || (viz === 'default' && (s.type === 'wordcloud' || s.type === 'matrix2x2'));
        el('canvasStageWrap').style.display = useCanvas ? 'block' : 'none';
        el('htmlStageWrap').style.display = useCanvas ? 'none' : 'flex';
        el('wcTopBar').style.display = (s.type === 'wordcloud') ? 'flex' : 'none';

        if (s.type === 'wordcloud') {
          var chips = el('wcTopChips');
          chips.innerHTML = data.rows.slice(0, 12).map(function (it) {
            return '<button type="button" class="tm-wc-chip" data-rm-word="' + esc(it.label) + '">' + esc(it.label) + ' (' + it.value + ') ×</button>';
          }).join('');
          chips.querySelectorAll('[data-rm-word]').forEach(function (b) {
            b.addEventListener('click', function () {
              delete s.words[b.getAttribute('data-rm-word')];
              persist(); renderStage();
            });
          });
        }

        if (useCanvas) {
          if (viz === 'donut') drawDonutCanvas(data);
          else if (s.type === 'wordcloud') drawWordCloudCanvas(s, data);
          else drawMatrixCanvas(s);
        } else {
          var hw = el('htmlStageWrap');
          if (viz === 'table') hw.innerHTML = renderTableHtml(data, s);
          else if (viz === 'vbar' || (viz === 'default' && s.type === 'scale')) hw.innerHTML = renderVbarHtml(data, s);
          else if (s.type === 'open' && viz === 'default') {
            hw.innerHTML = renderOpenCardsHtml(s);
            hw.querySelectorAll('[data-del-open]').forEach(function (b) {
              b.addEventListener('click', function () { s.opens.splice(parseInt(b.getAttribute('data-del-open'), 10), 1); persist(); renderStage(); });
            });
            hw.querySelectorAll('[data-like-open]').forEach(function (b) {
              b.addEventListener('click', function () {
                var o = s.opens[parseInt(b.getAttribute('data-like-open'), 10)];
                if (o) { o.likes = (o.likes || 0) + 1; persist(); renderStage(); }
              });
            });
          } else {
            hw.innerHTML = renderHbarHtml(data, s);
          }
        }
      }

      // 하단 한국어 구조화 데이터 요약 바
      el('summaryStrip').innerHTML = data.kpis.map(function (item) {
        return '<div class="tm-sum-card"><span>' + esc(item.k) + '</span><strong>' + esc(item.v) + '</strong></div>';
      }).join('');
    }

    function scheduleRedraw() {
      clearTimeout(redrawTimer);
      redrawTimer = setTimeout(function () { persist(); renderStage(); }, 120);
    }

    function renderAll() {
      renderSlideList();
      renderSidebarControls();
      renderStage();
    }

    // ==================== 학생 제출 처리 (1인 1회 중복방지 + 배치 리드로우) ====================
    function handleStudentSubmit(msg) {
      var s = state.slides.find(function (x) { return x.id === msg.slideId; }) || curSlide();
      if (!s || s.locked) return;
      if (state.limitOnce && msg.clientId) {
        s.submittedClients = s.submittedClients || {};
        if (s.submittedClients[msg.clientId]) return;
        s.submittedClients[msg.clientId] = true;
      }
      var p = msg.payload || {};
      if (p.kind === 'wordcloud' && Array.isArray(p.words)) {
        p.words.forEach(function (w) {
          var clean = String(w || '').trim().slice(0, 24);
          if (clean) s.words[clean] = (s.words[clean] || 0) + 1;
        });
      } else if (p.kind === 'poll' && typeof p.choiceIndex === 'number') {
        s.votes[p.choiceIndex] = (s.votes[p.choiceIndex] || 0) + 1;
      } else if (p.kind === 'quiz' && typeof p.choiceIndex === 'number') {
        s.votes[p.choiceIndex] = (s.votes[p.choiceIndex] || 0) + 1;
        var isCor = p.choiceIndex === (s.correctIndex || 0);
        var pts = isCor ? Math.max(500, 1000 - (p.elapsedSec || 3) * 25) : 0;
        var who = String(p.author || '익명').slice(0, 20);
        s.quizScores = s.quizScores || {};
        s.quizScores[who] = (s.quizScores[who] || 0) + pts;
      } else if (p.kind === 'scale' && p.value >= 1 && p.value <= 5) {
        s.scales.push(p.value);
      } else if (p.kind === 'ranking' && Array.isArray(p.order)) {
        s.rankings.push(p.order);
      } else if (p.kind === 'points100' && Array.isArray(p.points)) {
        s.pointsList.push(p.points);
      } else if (p.kind === 'matrix2x2' && typeof p.x === 'number' && typeof p.y === 'number') {
        s.matrixPoints.push({ x: p.x, y: p.y });
      } else if (p.kind === 'open' && p.text) {
        s.opens.unshift({ id: uid(), author: p.author || '익명', text: String(p.text).trim(), likes: 0, ts: Date.now() });
      }
      scheduleRedraw();
    }

    // ==================== PeerJS 실시간 호스트 ====================
    function startPeerHost() {
      var badge = el('connBadge');
      if (typeof window.Peer !== 'function') { setTimeout(startPeerHost, 350); return; }
      var peer = new window.Peer('tong-menti-' + state.roomCode);
      peer.on('open', function () {
        badge.textContent = '실시간 방 ' + state.roomCode + ' 활성';
        badge.classList.add('is-live');
        renderQrCodes();
      });
      peer.on('connection', function (conn) {
        activeConns[conn.peer] = conn;
        conn.on('open', function () {
          updateLiveUsersUI();
          conn.send({ type: 'config', config: getPublicConfig() });
        });
        conn.on('data', function (msg) {
          if (!msg) return;
          if (msg.type === 'hello') conn.send({ type: 'config', config: getPublicConfig() });
          else if (msg.type === 'submit') handleStudentSubmit(msg);
        });
        conn.on('close', function () { delete activeConns[conn.peer]; updateLiveUsersUI(); });
        conn.on('error', function () { delete activeConns[conn.peer]; updateLiveUsersUI(); });
      });
      peer.on('error', function (err) {
        if (err && err.type === 'unavailable-id') {
          state.roomCode = String(Math.floor(100000 + Math.random() * 900000));
          persist();
          startPeerHost();
        }
      });
    }

    // ==================== 이벤트 바인딩 ====================
    function goSlide(idx) {
      if (idx < 0 || idx >= state.slides.length) return;
      state.activeIndex = idx;
      persist();
      renderAll();
      broadcastConfig();
      showToast('질문 ' + (idx + 1) + ' 화면으로 전환했습니다. (학생 폰 자동 전환)');
    }

    el('prevSlideBtn').addEventListener('click', function () { goSlide(state.activeIndex - 1); });
    el('nextSlideBtn').addEventListener('click', function () { goSlide(state.activeIndex + 1); });
    el('presPrevBtn').addEventListener('click', function () { goSlide(state.activeIndex - 1); });
    el('presNextBtn').addEventListener('click', function () { goSlide(state.activeIndex + 1); });

    el('addSlideBtn').addEventListener('click', function () {
      var order = ['wordcloud', 'poll', 'scale', 'ranking', 'points100', 'matrix2x2', 'quiz', 'open'];
      var nextType = order[state.slides.length % order.length];
      state.slides.push(createSlide(nextType));
      state.activeIndex = state.slides.length - 1;
      persist(); renderAll(); broadcastConfig();
      showToast('새 질문 슬라이드(' + TYPE_META[nextType].label + ')를 추가했습니다.');
    });

    el('dupSlideBtn').addEventListener('click', function () {
      var copy = JSON.parse(JSON.stringify(curSlide()));
      copy.id = uid();
      state.slides.splice(state.activeIndex + 1, 0, copy);
      state.activeIndex++;
      persist(); renderAll(); broadcastConfig();
    });

    el('slideTypeSelect').addEventListener('change', function () {
      var s = curSlide();
      var nt = this.value;
      var fresh = createSlide(nt);
      s.type = nt;
      s.question = fresh.question;
      s.options = fresh.options;
      s.votes = fresh.votes;
      s.vizMode = 'default';
      persist(); renderAll(); broadcastConfig();
    });

    el('questionInput').addEventListener('input', function () {
      curSlide().question = this.value;
      persist(); renderSlideList();
      el('stageQuestionText').textContent = this.value || '질문을 입력하세요';
      broadcastConfig();
    });
    el('wcMaxWordsSelect').addEventListener('change', function () { curSlide().wcMaxWords = parseInt(this.value, 10) || 3; persist(); broadcastConfig(); });
    el('scaleMinInput').addEventListener('input', function () { curSlide().scaleMin = this.value; persist(); renderStage(); broadcastConfig(); });
    el('scaleMaxInput').addEventListener('input', function () { curSlide().scaleMax = this.value; persist(); renderStage(); broadcastConfig(); });
    el('matrixXInput').addEventListener('input', function () { curSlide().matrixX = this.value; persist(); renderStage(); broadcastConfig(); });
    el('matrixYInput').addEventListener('input', function () { curSlide().matrixY = this.value; persist(); renderStage(); broadcastConfig(); });

    el('addOptionBtn').addEventListener('click', function () {
      var s = curSlide();
      if (s.options.length >= 6) { showToast('선택지는 최대 6개까지 가능합니다.'); return; }
      s.options.push('새 항목 ' + (s.options.length + 1));
      s.votes.push(0);
      persist(); renderSidebarControls(); renderStage(); broadcastConfig();
    });

    document.querySelectorAll('.tm-viz-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        curSlide().vizMode = b.getAttribute('data-viz') || 'default';
        persist(); renderStage();
      });
    });

    el('toggleLockBtn').addEventListener('click', function () {
      var s = curSlide(); s.locked = !s.locked;
      persist(); renderSidebarControls(); renderStage(); broadcastConfig();
      showToast(s.locked ? '응답을 마감했습니다.' : '응답을 다시 열었습니다.');
    });
    function toggleHideResults() {
      var s = curSlide(); s.hideResults = !s.hideResults;
      persist(); renderSidebarControls(); renderStage();
    }
    el('toggleHideResBtn').addEventListener('click', toggleHideResults);
    el('presHideBtn').addEventListener('click', toggleHideResults);
    el('revealNowBtn').addEventListener('click', function () { curSlide().hideResults = false; persist(); renderSidebarControls(); renderStage(); });

    el('toggleLimitOnceBtn').addEventListener('click', function () {
      state.limitOnce = !state.limitOnce;
      persist(); renderSidebarControls(); broadcastConfig();
      showToast(state.limitOnce ? '학생 기기당 1회 제출 제한을 켰습니다.' : '중복 제출을 허용했습니다.');
    });

    // 모의 학생 18명 응답 체험 (8종 전체 대응)
    el('simulateBtn').addEventListener('click', function () {
      var s = curSlide();
      if (s.type === 'wordcloud') {
        var pool = ['조건부확률', '데이터', '그래프', '협업', 'AI', '함수', '통계', '문제해결', '증명', '조건부확률', '데이터', 'AI', '그래프', '협업', '조건부확률', '통계', '함수', '문제해결'];
        pool.forEach(function (w) { s.words[w] = (s.words[w] || 0) + 1; });
      } else if (s.type === 'poll') {
        for (var i = 0; i < 18; i++) {
          var idx = Math.floor(Math.random() * s.options.length);
          s.votes[idx] = (s.votes[idx] || 0) + 1;
        }
      } else if (s.type === 'quiz') {
        var names = ['김민수', '이서연', '박지훈', '최유진', '정하준', '강서윤', '조민재', '윤지우', '임도윤', '한수아'];
        for (var q = 0; q < 18; q++) {
          var ci = Math.random() < 0.62 ? (s.correctIndex || 0) : Math.floor(Math.random() * s.options.length);
          s.votes[ci] = (s.votes[ci] || 0) + 1;
          var nm = names[q % names.length];
          s.quizScores[nm] = (s.quizScores[nm] || 0) + (ci === (s.correctIndex || 0) ? (650 + Math.floor(Math.random() * 320)) : 0);
        }
      } else if (s.type === 'scale') {
        [3, 4, 4, 5, 5, 4, 5, 3, 4, 5, 5, 4, 2, 4, 5, 4, 5, 4].forEach(function (v) { s.scales.push(v); });
      } else if (s.type === 'ranking') {
        for (var r = 0; r < 18; r++) {
          var ord = s.options.map(function (_, idx) { return idx; }).sort(function () { return Math.random() - 0.5; });
          s.rankings.push(ord);
        }
      } else if (s.type === 'points100') {
        for (var p = 0; p < 18; p++) {
          var raw = s.options.map(function () { return 10 + Math.floor(Math.random() * 40); });
          var sm = raw.reduce(function (a, b) { return a + b; }, 0);
          var norm = raw.map(function (v) { return Math.round((v / sm) * 100); });
          norm[0] += 100 - norm.reduce(function (a, b) { return a + b; }, 0);
          s.pointsList.push(norm);
        }
      } else if (s.type === 'matrix2x2') {
        for (var m = 0; m < 18; m++) {
          s.matrixPoints.push({ x: Math.min(10, Math.max(1, Math.round(4 + Math.random() * 6))), y: Math.min(10, Math.max(1, Math.round(3 + Math.random() * 7))) });
        }
      } else {
        [
          { author: '김민수', text: '실생활 데이터로 그래프를 바로 비교해 보니 이해가 훨씬 빨랐습니다.', likes: 6 },
          { author: '이서연', text: '다음 시간에는 모둠별로 직접 설문 문항을 설계해 보고 싶어요!', likes: 9 },
          { author: '박지훈', text: '2×2 사분면으로 중요도와 시급성을 나눠보니 우선순위가 한눈에 들어옵니다.', likes: 5 },
          { author: '익명', text: '3번 예제 풀이 과정을 한 번 더 정리해 주실 수 있나요?', likes: 4 }
        ].forEach(function (o) { s.opens.unshift({ id: uid(), author: o.author, text: o.text, likes: o.likes, ts: Date.now() }); });
      }
      persist(); renderStage();
      showToast('모의 학생 18명 응답을 반영했습니다.');
    });

    el('resetRespBtn').addEventListener('click', function () {
      if (!confirm('현재 질문의 응답을 초기화할까요?')) return;
      var s = curSlide();
      s.words = {}; s.votes = s.options.map(function () { return 0; });
      s.scales = []; s.rankings = []; s.pointsList = []; s.matrixPoints = [];
      s.quizScores = {}; s.opens = []; s.submittedClients = {};
      persist(); renderStage(); showToast('현재 질문 응답을 초기화했습니다.');
    });

    // 엑셀(CSV) 저장 (UTF-8 BOM 한글 완벽 호환)
    el('exportCsvBtn').addEventListener('click', function () {
      var s = curSlide();
      var data = computeStructuredData(s);
      var rows = [['질문', s.question], ['유형', TYPE_META[s.type].label], ['총응답', String(data.total)], []];
      if (s.type === 'open') {
        rows.push(['순번', '작성자', '내용', '공감']);
        data.rows.forEach(function (r) { rows.push([String(r.rank), r.label, r.extra, String(r.value)]); });
      } else {
        rows.push(['순위/번호', '항목', '수치', '비율(%)']);
        data.rows.forEach(function (r) { rows.push([String(r.rank), r.label, String(r.value), String(r.pct)]); });
      }
      var csv = '\uFEFF' + rows.map(function (r) {
        return r.map(function (c) { return '"' + String(c || '').replace(/"/g, '""') + '"'; }).join(',');
      }).join('\r\n');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      a.download = 'tong-menti-Q' + (state.activeIndex + 1) + '.csv';
      a.click();
    });

    // 전체 슬라이드 통합 엑셀(CSV) 다운로드
    el('exportAllCsvBtn').addEventListener('click', function () {
      var rows = [['슬라이드번호', '활동유형', '질문', '순위/번호', '항목/작성자', '수치/공감', '비율(%)', '상세내용']];
      state.slides.forEach(function (sl, sIdx) {
        var d = computeStructuredData(sl);
        if (!d.rows.length) {
          rows.push([String(sIdx + 1), TYPE_META[sl.type].label, sl.question, '-', '(응답 없음)', '0', '0', '']);
        } else {
          d.rows.forEach(function (r) {
            rows.push([
              String(sIdx + 1), TYPE_META[sl.type].label, sl.question,
              String(r.rank || '-'), r.label, String(r.value), String(r.pct || 0), r.extra || ''
            ]);
          });
        }
      });
      var csv = '\uFEFF' + rows.map(function (r) {
        return r.map(function (c) { return '"' + String(c || '').replace(/"/g, '""') + '"'; }).join(',');
      }).join('\r\n');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      a.download = 'tong-menti-전체결과-' + state.roomCode + '.csv';
      a.click();
      showToast('전체 ' + state.slides.length + '개 질문 결과를 통합 엑셀(CSV)로 다운로드했습니다.');
    });

    // 수업 세션 백업(.json) 다운로드 & 불러오기
    el('exportJsonBtn').addEventListener('click', function () {
      var payload = JSON.stringify({
        exportedAt: new Date().toISOString(),
        app: 'tong-menti-pro',
        slides: state.slides
      }, null, 2);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json;charset=utf-8;' }));
      a.download = 'tong-menti-수업백업-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      showToast('수업 질문·응답 전체를 백업(.json) 파일로 저장했습니다.');
    });

    el('importJsonInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var parsed = JSON.parse(fr.result);
          var slides = Array.isArray(parsed.slides) ? parsed.slides : (Array.isArray(parsed) ? parsed : null);
          if (!slides || !slides.length) throw new Error('invalid');
          state.slides = slides;
          state.activeIndex = 0;
          persist(); renderAll(); broadcastConfig();
          showToast('백업 파일에서 ' + slides.length + '개 질문 슬라이드를 불러왔습니다.');
        } catch (e) {
          showToast('올바른 T-ong 멘티미터 백업(.json) 파일이 아닙니다.');
        }
      };
      fr.readAsText(f);
      this.value = '';
    });

    // 접속 중 배지 클릭 시 동시 접속 안내(사용설명서) 열기
    el('liveUsersPill').addEventListener('click', function () { openModal('manualModal'); });

    el('exportPngBtn').addEventListener('click', function () {
      if (el('canvasStageWrap').style.display === 'none') {
        showToast('워드클라우드·도넛·2×2 사분면 차트에서 PNG 저장을 지원합니다. 전체 출력은 [PDF 보고서]를 이용해 주세요.');
        return;
      }
      var a = document.createElement('a');
      a.href = el('mainCanvas').toDataURL('image/png');
      a.download = 'tong-menti-chart-Q' + (state.activeIndex + 1) + '.png';
      a.click();
    });

    // 전체 슬라이드 통합 A4 PDF 보고서
    el('exportPdfBtn').addEventListener('click', function () {
      var now = new Date().toLocaleString('ko-KR');
      var curImg = (el('canvasStageWrap').style.display !== 'none') ? el('mainCanvas').toDataURL('image/png') : '';
      el('printReport').innerHTML = state.slides.map(function (sl, idx) {
        var d = computeStructuredData(sl);
        var imgTag = (idx === state.activeIndex && curImg) ? '<img class="tm-rep-img" src="' + curImg + '" alt="차트">' : '';
        var tbl = renderTableHtml(d, sl).replace('tm-data-table', 'tm-rep-table');
        return (
          '<div class="tm-rep-slide">' +
            '<div class="tm-rep-head">' +
              '<h1>질문 ' + (idx + 1) + '. ' + esc(sl.question) + '</h1>' +
              '<div class="tm-rep-meta">' +
                '<span>유형: ' + esc(TYPE_META[sl.type].label) + '</span>' +
                '<span>총 응답: ' + d.total + '건</span>' +
                '<span>출력 일시: ' + esc(now) + '</span>' +
              '</div>' +
            '</div>' + imgTag + tbl +
          '</div>'
        );
      }).join('');
      window.print();
    });

    // 전체화면 송출 토글 & 키보드 단축키
    function togglePresent() {
      document.body.classList.toggle('is-present');
      var on = document.body.classList.contains('is-present');
      el('fullscreenBtn').textContent = on ? '편집 화면 복귀' : '전체화면 송출';
      setTimeout(renderStage, 80);
    }
    el('fullscreenBtn').addEventListener('click', togglePresent);
    el('presExitBtn').addEventListener('click', togglePresent);

    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight') goSlide(state.activeIndex + 1);
      else if (e.key === 'ArrowLeft') goSlide(state.activeIndex - 1);
      else if (e.key === 'Escape' && document.body.classList.contains('is-present')) togglePresent();
    });

    // 모달 제어
    function openModal(id) { el(id).classList.add('show'); }
    el('openQrBtn').addEventListener('click', function () { renderQrCodes(); openModal('qrModal'); });
    el('presQrBtn').addEventListener('click', function () { renderQrCodes(); openModal('qrModal'); });
    el('openManualBtn').addEventListener('click', function () { openModal('manualModal'); });
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { el(b.getAttribute('data-close')).classList.remove('show'); });
    });
    document.querySelectorAll('.tm-modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) m.classList.remove('show'); });
    });

    function copyJoin() {
      navigator.clipboard.writeText(getJoinUrl()).then(function () { showToast('학생 참여 링크를 복사했습니다.'); });
    }
    el('copyJoinBtn').addEventListener('click', copyJoin);
    el('copyLinkMiniBtn').addEventListener('click', copyJoin);
    window.addEventListener('resize', function () { renderStage(); });

    renderQrCodes();
    renderAll();
    startPeerHost();
  }
})();
