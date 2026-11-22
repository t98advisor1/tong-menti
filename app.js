(function () {
  'use strict';

  var STORAGE_KEY = 'tong_menti_state_v1';
  var BAR_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];
  var WC_PALETTE = ['#4f46e5', '#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0f766e', '#1d4ed8'];

  function el(id) { return document.getElementById(id); }
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

  var params = new URLSearchParams(location.search);
  var isJoin = params.get('join') === '1';

  if (isJoin) initStudentMode();
  else initTeacherMode();

  // ==================== 학생 QR 참여 모드 ====================
  function initStudentMode() {
    el('teacherView').style.display = 'none';
    el('studentView').style.display = 'flex';

    var roomCode = (params.get('room') || '').trim();
    var peerConn = null;
    var roomConfig = null;
    var selectedChoice = -1;
    var selectedScale = 0;

    function showFeedback(msg, ok) {
      var fb = el('stuFeedback');
      fb.textContent = msg;
      fb.className = 'tm-feedback ' + (ok ? 'ok' : 'err');
      fb.style.display = 'block';
    }

    function renderStudentForm(cfg) {
      roomConfig = cfg;
      var typeNames = { wordcloud: '워드 클라우드', poll: '객관식 실시간 투표', scale: '1~5 척도 평가', open: '자유 의견 · Q&A' };
      el('stuTypeKicker').textContent = typeNames[cfg.type] || '실시간 참여';
      el('stuQuestion').textContent = cfg.question || '질문';
      el('stuConnSub').textContent = '실시간 교실 방(' + roomCode + ') 연결 완료';

      el('stuWcForm').style.display = cfg.type === 'wordcloud' ? 'block' : 'none';
      el('stuPollForm').style.display = cfg.type === 'poll' ? 'block' : 'none';
      el('stuScaleForm').style.display = cfg.type === 'scale' ? 'block' : 'none';
      el('stuOpenForm').style.display = cfg.type === 'open' ? 'block' : 'none';

      if (cfg.type === 'wordcloud') {
        var maxW = Math.max(1, Math.min(3, cfg.wcMaxWords || 3));
        el('stuMaxWords').textContent = String(maxW);
        var wrap = el('stuWcInputs');
        wrap.innerHTML = '';
        for (var i = 1; i <= maxW; i++) {
          var inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'tm-input stu-wc-word';
          inp.maxLength = 24;
          inp.placeholder = i + '번째 단어 입력' + (i > 1 ? ' (선택)' : '');
          wrap.appendChild(inp);
        }
      } else if (cfg.type === 'poll') {
        selectedChoice = -1;
        var cWrap = el('stuPollChoices');
        cWrap.innerHTML = '';
        (cfg.options || []).forEach(function (opt, idx) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'tm-choice-btn';
          b.textContent = (idx + 1) + '. ' + opt;
          b.addEventListener('click', function () {
            selectedChoice = idx;
            cWrap.querySelectorAll('.tm-choice-btn').forEach(function (x) { x.classList.remove('active'); });
            b.classList.add('active');
          });
          cWrap.appendChild(b);
        });
      } else if (cfg.type === 'scale') {
        selectedScale = 0;
        el('stuScaleMinLbl').textContent = cfg.scaleMin || '1점';
        el('stuScaleMaxLbl').textContent = cfg.scaleMax || '5점';
        document.querySelectorAll('#stuScaleRow .tm-scale-pick').forEach(function (b) { b.classList.remove('active'); });
      }
    }

    document.querySelectorAll('#stuScaleRow .tm-scale-pick').forEach(function (b) {
      b.addEventListener('click', function () {
        selectedScale = parseInt(b.getAttribute('data-val'), 10) || 0;
        document.querySelectorAll('#stuScaleRow .tm-scale-pick').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
      });
    });

    function connectToTeacher() {
      if (!roomCode) {
        el('stuConnSub').textContent = '방 코드가 없습니다. 선생님 화면의 QR 코드를 다시 스캔해 주세요.';
        return;
      }
      if (typeof window.Peer !== 'function') {
        setTimeout(connectToTeacher, 350);
        return;
      }
      var peer = new window.Peer();
      peer.on('open', function () {
        var conn = peer.connect('tong-menti-' + roomCode, { reliable: true });
        conn.on('open', function () {
          peerConn = conn;
          conn.send({ type: 'hello' });
        });
        conn.on('data', function (msg) {
          if (msg && msg.type === 'config' && msg.config) {
            renderStudentForm(msg.config);
          }
        });
        conn.on('error', function () {
          el('stuConnSub').textContent = '선생님 방에 연결할 수 없습니다. 방이 열려 있는지 확인해 주세요.';
        });
      });
    }
    connectToTeacher();

    function sendPayload(payload) {
      if (!peerConn || !peerConn.open) {
        showFeedback('선생님 화면과 연결이 끊어졌습니다. 새로고침해 주세요.', false);
        return false;
      }
      peerConn.send({ type: 'submit', payload: payload });
      showFeedback('응답이 실시간 화면에 반영되었습니다!', true);
      return true;
    }

    el('stuWcSubmitBtn').addEventListener('click', function () {
      var words = [];
      document.querySelectorAll('.stu-wc-word').forEach(function (inp) {
        var v = (inp.value || '').trim();
        if (v) words.push(v);
      });
      if (!words.length) { showFeedback('단어를 1개 이상 입력해 주세요.', false); return; }
      if (sendPayload({ kind: 'wordcloud', words: words })) {
        document.querySelectorAll('.stu-wc-word').forEach(function (inp) { inp.value = ''; });
      }
    });

    el('stuPollSubmitBtn').addEventListener('click', function () {
      if (selectedChoice < 0) { showFeedback('항목을 선택해 주세요.', false); return; }
      sendPayload({ kind: 'poll', choiceIndex: selectedChoice });
    });

    el('stuScaleSubmitBtn').addEventListener('click', function () {
      if (!selectedScale) { showFeedback('1~5점 중 하나를 선택해 주세요.', false); return; }
      sendPayload({ kind: 'scale', value: selectedScale });
    });

    el('stuOpenSubmitBtn').addEventListener('click', function () {
      var text = (el('stuOpenText').value || '').trim();
      var author = (el('stuOpenAuthor').value || '').trim() || '익명';
      if (!text) { showFeedback('내용을 입력해 주세요.', false); return; }
      if (sendPayload({ kind: 'open', author: author, text: text })) {
        el('stuOpenText').value = '';
      }
    });
  }

  // ==================== 교사용 대시보드 모드 ====================
  function initTeacherMode() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (e) {}

    var state = {
      type: saved.type || 'wordcloud', // 'wordcloud' | 'poll' | 'scale' | 'open'
      question: saved.question || '오늘 수업에서 가장 기억에 남는 핵심 키워드는 무엇인가요?',
      roomCode: saved.roomCode || String(Math.floor(1000 + Math.random() * 9000)),
      wcMaxWords: saved.wcMaxWords || 3,
      options: Array.isArray(saved.options) && saved.options.length >= 2
        ? saved.options
        : ['매우 이해가 잘 되었다', '대체로 이해되었다', '예제를 한 번 더 보고 싶다', '질문이 있다'],
      scaleMin: saved.scaleMin || '전혀 그렇지 않다 (1)',
      scaleMax: saved.scaleMax || '매우 그렇다 (5)',
      // 응답 데이터
      words: saved.words || {},       // { word: count }
      votes: Array.isArray(saved.votes) ? saved.votes : [0, 0, 0, 0],
      scales: Array.isArray(saved.scales) ? saved.scales : [],
      opens: Array.isArray(saved.opens) ? saved.opens : []
    };

    var connectedPeers = [];

    function persist() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    }

    function getPublicConfig() {
      return {
        type: state.type,
        question: state.question,
        wcMaxWords: state.wcMaxWords,
        options: state.options,
        scaleMin: state.scaleMin,
        scaleMax: state.scaleMax
      };
    }

    function broadcastConfig() {
      var cfg = getPublicConfig();
      connectedPeers.forEach(function (conn) {
        if (conn && conn.open) {
          try { conn.send({ type: 'config', config: cfg }); } catch (e) {}
        }
      });
    }

    function getJoinUrl() {
      var base = location.origin + location.pathname;
      return base + '?join=1&room=' + encodeURIComponent(state.roomCode);
    }

    function renderQrCodes() {
      var url = getJoinUrl();
      el('miniRoomCode').textContent = state.roomCode;
      el('stageRoomCode').textContent = state.roomCode;
      el('bigRoomCode').textContent = state.roomCode;
      el('joinUrlInput').value = url;
      if (typeof window.qrcode === 'function') {
        var qr1 = window.qrcode(0, 'M');
        qr1.addData(url);
        qr1.make();
        el('miniQrBox').innerHTML = qr1.createSvgTag({ cellSize: 4, margin: 1 });
        el('bigQrBox').innerHTML = qr1.createSvgTag({ cellSize: 6, margin: 2 });
      }
    }

    // ==================== 워드 클라우드 HiDPI 캔버스 렌더링 ====================
    function renderWordCloud() {
      var canvas = el('wcCanvas');
      var wrap = canvas.parentElement;
      var W = Math.max(480, wrap.clientWidth || 720);
      var H = Math.max(360, wrap.clientHeight || 400);
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      var entries = Object.keys(state.words).map(function (w) {
        return { word: w, count: state.words[w] };
      }).filter(function (x) { return x.count > 0; })
        .sort(function (a, b) { return b.count - a.count; })
        .slice(0, 60);

      el('wcEmptyHint').style.display = entries.length ? 'none' : 'flex';

      // 상위 키워드 칩
      var chipsEl = el('wcTopChips');
      chipsEl.innerHTML = entries.slice(0, 12).map(function (it) {
        return '<button type="button" class="tm-wc-chip" data-rm-word="' + esc(it.word) + '" title="클릭하면 이 단어를 워드클라우드에서 제외합니다">' +
          esc(it.word) + ' (' + it.count + ') ×</button>';
      }).join('');
      chipsEl.querySelectorAll('[data-rm-word]').forEach(function (b) {
        b.addEventListener('click', function () {
          var w = b.getAttribute('data-rm-word');
          delete state.words[w];
          persist();
          renderStage();
          showToast('"' + w + '" 단어를 제외했습니다.');
        });
      });

      if (!entries.length) return;

      var maxC = entries[0].count;
      var minC = entries[entries.length - 1].count;
      var placed = [];

      function overlaps(a, b) {
        return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      entries.forEach(function (it, idx) {
        var ratio = maxC === minC ? 0.7 : (it.count - minC) / (maxC - minC);
        var fontSize = Math.round(18 + ratio * 48);
        ctx.font = '900 ' + fontSize + 'px Pretendard, "Noto Sans KR", sans-serif';
        var tw = ctx.measureText(it.word).width + 14;
        var th = fontSize * 1.15;

        var cx = W / 2;
        var cy = H / 2;
        var found = null;
        for (var step = 0; step < 320; step++) {
          var angle = step * 0.38;
          var radius = step * 1.45;
          var x = cx + Math.cos(angle) * radius * 1.35;
          var y = cy + Math.sin(angle) * radius * 0.88;
          var box = { x: x - tw / 2, y: y - th / 2, w: tw, h: th };
          if (box.x < 8 || box.y < 8 || box.x + box.w > W - 8 || box.y + box.h > H - 8) continue;
          var hit = false;
          for (var j = 0; j < placed.length; j++) {
            if (overlaps(box, placed[j])) { hit = true; break; }
          }
          if (!hit) { found = { x: x, y: y, box: box }; break; }
        }
        if (found) {
          placed.push(found.box);
          ctx.fillStyle = WC_PALETTE[idx % WC_PALETTE.length];
          ctx.fillText(it.word, found.x, found.y);
        }
      });
    }

    function renderPollChart() {
      while (state.votes.length < state.options.length) state.votes.push(0);
      var total = state.votes.slice(0, state.options.length).reduce(function (a, b) { return a + b; }, 0);
      el('pollBarsWrap').innerHTML = state.options.map(function (opt, idx) {
        var cnt = state.votes[idx] || 0;
        var pct = total ? Math.round((cnt / total) * 100) : 0;
        var color = BAR_COLORS[idx % BAR_COLORS.length];
        return (
          '<div class="tm-bar-item">' +
            '<div class="tm-bar-top"><span>' + (idx + 1) + '. ' + esc(opt) + '</span><span>' + cnt + '표 (' + pct + '%)</span></div>' +
            '<div class="tm-bar-track"><div class="tm-bar-fill" style="width:' + Math.max(pct, cnt > 0 ? 6 : 0) + '%;background:' + color + '">' + (pct >= 12 ? pct + '%' : '') + '</div></div>' +
          '</div>'
        );
      }).join('');
    }

    function renderScaleChart() {
      var counts = [0, 0, 0, 0, 0];
      var sum = 0;
      state.scales.forEach(function (v) {
        if (v >= 1 && v <= 5) { counts[v - 1]++; sum += v; }
      });
      var avg = state.scales.length ? (sum / state.scales.length).toFixed(1) : '0.0';
      el('scaleAvgNum').textContent = avg;
      el('scaleEndMin').textContent = state.scaleMin;
      el('scaleEndMax').textContent = state.scaleMax;
      var maxCnt = Math.max.apply(null, counts.concat([1]));
      el('scaleDistWrap').innerHTML = counts.map(function (c, i) {
        var hPct = Math.round((c / maxCnt) * 100);
        return (
          '<div class="tm-scale-col">' +
            '<span class="tm-scale-cnt">' + c + '명</span>' +
            '<div class="tm-scale-bar" style="height:' + Math.max(4, hPct * 0.72) + '%"></div>' +
            '<span class="tm-scale-num">' + (i + 1) + '점</span>' +
          '</div>'
        );
      }).join('');
    }

    function renderOpenCards() {
      var wrap = el('openCardsWrap');
      if (!state.opens.length) {
        wrap.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#64748b;padding:48px 16px;">아직 도착한 의견이 없습니다. 학생 QR 참여 또는 [모의 응답 15명 체험]을 이용해 보세요.</div>';
        return;
      }
      wrap.innerHTML = state.opens.map(function (it, idx) {
        return (
          '<article class="tm-open-card">' +
            '<div class="tm-open-head"><span>' + esc(it.author || '익명') + '</span><button type="button" class="tm-open-del" data-del-open="' + idx + '">×</button></div>' +
            '<div class="tm-open-body">' + esc(it.text) + '</div>' +
          '</article>'
        );
      }).join('');
      wrap.querySelectorAll('[data-del-open]').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = parseInt(b.getAttribute('data-del-open'), 10);
          state.opens.splice(i, 1);
          persist();
          renderStage();
        });
      });
    }

    function totalCount() {
      if (state.type === 'wordcloud') return Object.keys(state.words).reduce(function (a, k) { return a + (state.words[k] || 0); }, 0);
      if (state.type === 'poll') return state.votes.slice(0, state.options.length).reduce(function (a, b) { return a + b; }, 0);
      if (state.type === 'scale') return state.scales.length;
      return state.opens.length;
    }

    function renderPollOptionInputs() {
      var wrap = el('pollOptionsList');
      wrap.innerHTML = '';
      state.options.forEach(function (opt, idx) {
        var row = document.createElement('div');
        row.className = 'tm-opt-row';
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'tm-input';
        inp.value = opt;
        inp.placeholder = '선택지 ' + (idx + 1);
        inp.addEventListener('input', function () {
          state.options[idx] = inp.value;
          persist();
          renderPollChart();
          broadcastConfig();
        });
        row.appendChild(inp);
        if (state.options.length > 2) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'tm-opt-del';
          del.textContent = '×';
          del.addEventListener('click', function () {
            state.options.splice(idx, 1);
            state.votes.splice(idx, 1);
            persist();
            renderPollOptionInputs();
            renderStage();
            broadcastConfig();
          });
          row.appendChild(del);
        }
        wrap.appendChild(row);
      });
    }

    function renderStage() {
      var badges = { wordcloud: 'WORD CLOUD', poll: 'MULTIPLE CHOICE', scale: 'SCALE 1–5', open: 'OPEN Q&A' };
      el('stageTypeBadge').textContent = badges[state.type] || 'LIVE';
      el('stageQuestionText').textContent = state.question || '질문을 입력하세요';
      var cnt = totalCount();
      el('totalRespCount').textContent = cnt + '건';
      el('stageRespCount').textContent = String(cnt);

      document.querySelectorAll('.tm-type-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-type') === state.type);
      });
      el('wcConfigSec').style.display = state.type === 'wordcloud' ? 'flex' : 'none';
      el('pollOptionsSec').style.display = state.type === 'poll' ? 'flex' : 'none';
      el('scaleLabelsSec').style.display = state.type === 'scale' ? 'flex' : 'none';

      el('wcStage').style.display = state.type === 'wordcloud' ? 'flex' : 'none';
      el('pollStage').style.display = state.type === 'poll' ? 'flex' : 'none';
      el('scaleStage').style.display = state.type === 'scale' ? 'flex' : 'none';
      el('openStage').style.display = state.type === 'open' ? 'flex' : 'none';

      if (state.type === 'wordcloud') renderWordCloud();
      else if (state.type === 'poll') renderPollChart();
      else if (state.type === 'scale') renderScaleChart();
      else renderOpenCards();
    }

    // 학생 응답 반영
    function handleSubmission(payload) {
      if (!payload) return;
      if (payload.kind === 'wordcloud' && Array.isArray(payload.words)) {
        payload.words.forEach(function (w) {
          var clean = String(w || '').trim().slice(0, 24);
          if (clean) state.words[clean] = (state.words[clean] || 0) + 1;
        });
      } else if (payload.kind === 'poll' && typeof payload.choiceIndex === 'number') {
        if (payload.choiceIndex >= 0 && payload.choiceIndex < state.options.length) {
          state.votes[payload.choiceIndex] = (state.votes[payload.choiceIndex] || 0) + 1;
        }
      } else if (payload.kind === 'scale' && payload.value >= 1 && payload.value <= 5) {
        state.scales.push(payload.value);
      } else if (payload.kind === 'open' && payload.text) {
        state.opens.unshift({ author: payload.author || '익명', text: String(payload.text).trim(), ts: Date.now() });
      }
      persist();
      renderStage();
    }

    // PeerJS 교사용 실시간 호스트
    function startPeerHost() {
      var badge = el('connBadge');
      if (typeof window.Peer !== 'function') { setTimeout(startPeerHost, 350); return; }
      var peer = new window.Peer('tong-menti-' + state.roomCode);
      peer.on('open', function () {
        badge.textContent = '실시간 방 ' + state.roomCode + ' 활성 (QR 즉시 참여)';
        badge.classList.add('is-live');
        renderQrCodes();
      });
      peer.on('connection', function (conn) {
        connectedPeers.push(conn);
        conn.on('open', function () {
          conn.send({ type: 'config', config: getPublicConfig() });
        });
        conn.on('data', function (msg) {
          if (!msg) return;
          if (msg.type === 'hello') conn.send({ type: 'config', config: getPublicConfig() });
          else if (msg.type === 'submit' && msg.payload) handleSubmission(msg.payload);
        });
      });
      peer.on('error', function (err) {
        if (err && err.type === 'unavailable-id') {
          state.roomCode = String(Math.floor(1000 + Math.random() * 9000));
          persist();
          startPeerHost();
        }
      });
    }

    // 초기 UI 채우기
    el('questionInput').value = state.question;
    el('wcMaxWordsSelect').value = String(state.wcMaxWords);
    el('scaleMinInput').value = state.scaleMin;
    el('scaleMaxInput').value = state.scaleMax;
    renderPollOptionInputs();
    renderQrCodes();
    renderStage();
    startPeerHost();

    // 이벤트 바인딩
    document.querySelectorAll('.tm-type-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.type = b.getAttribute('data-type');
        persist();
        renderStage();
        broadcastConfig();
      });
    });

    el('questionInput').addEventListener('input', function () {
      state.question = this.value;
      persist();
      el('stageQuestionText').textContent = state.question || '질문을 입력하세요';
      broadcastConfig();
    });
    el('wcMaxWordsSelect').addEventListener('change', function () {
      state.wcMaxWords = parseInt(this.value, 10) || 3;
      persist();
      broadcastConfig();
    });
    el('scaleMinInput').addEventListener('input', function () {
      state.scaleMin = this.value;
      persist();
      renderScaleChart();
      broadcastConfig();
    });
    el('scaleMaxInput').addEventListener('input', function () {
      state.scaleMax = this.value;
      persist();
      renderScaleChart();
      broadcastConfig();
    });
    el('addOptionBtn').addEventListener('click', function () {
      if (state.options.length >= 6) { showToast('선택지는 최대 6개까지 추가할 수 있습니다.'); return; }
      state.options.push('새 선택지 ' + (state.options.length + 1));
      state.votes.push(0);
      persist();
      renderPollOptionInputs();
      renderStage();
      broadcastConfig();
    });

    // 모의 응답 15명 시뮬레이션
    el('simulateBtn').addEventListener('click', function () {
      if (state.type === 'wordcloud') {
        var pool = ['조건부확률', '함수', '그래프', '미분', '적분', '통계', '데이터', 'AI', '협업', '토론', '증명', '문제해결', '조건부확률', '그래프', '조건부확률', '데이터', 'AI', '함수', '협업', '미분'];
        for (var i = 0; i < 18; i++) {
          var w = pool[Math.floor(Math.random() * pool.length)];
          state.words[w] = (state.words[w] || 0) + 1;
        }
      } else if (state.type === 'poll') {
        for (var j = 0; j < 15; j++) {
          var idx = Math.floor(Math.random() * state.options.length);
          state.votes[idx] = (state.votes[idx] || 0) + 1;
        }
      } else if (state.type === 'scale') {
        var sPool = [3, 4, 4, 4, 5, 5, 5, 5, 4, 3, 5, 4, 2, 5, 4];
        sPool.forEach(function (v) { state.scales.push(v); });
      } else {
        var oPool = [
          { author: '김민수', text: '실생활 예시로 확률을 설명해 주셔서 이해가 훨씬 잘 되었어요!' },
          { author: '이서연', text: '다음 시간에는 모둠별로 직접 데이터를 모아 그래프를 그려보고 싶습니다.' },
          { author: '익명', text: '3번 문제의 두 번째 풀이 과정을 한 번만 더 짚어주실 수 있나요?' },
          { author: '박지훈', text: '워드클라우드로 친구들 생각을 한눈에 보니까 재미있어요.' }
        ];
        oPool.forEach(function (x) { state.opens.unshift({ author: x.author, text: x.text, ts: Date.now() }); });
      }
      persist();
      renderStage();
      showToast('모의 학생 응답을 반영했습니다.');
    });

    el('resetRespBtn').addEventListener('click', function () {
      if (!confirm('현재 활동의 응답을 모두 초기화할까요?')) return;
      if (state.type === 'wordcloud') state.words = {};
      else if (state.type === 'poll') state.votes = state.options.map(function () { return 0; });
      else if (state.type === 'scale') state.scales = [];
      else state.opens = [];
      persist();
      renderStage();
      showToast('응답을 초기화했습니다.');
    });

    // 전체화면 송출 토글
    el('fullscreenBtn').addEventListener('click', function () {
      document.body.classList.toggle('is-present');
      var on = document.body.classList.contains('is-present');
      this.textContent = on ? '편집 화면 보기' : '전체화면 송출';
      if (state.type === 'wordcloud') setTimeout(renderWordCloud, 80);
    });

    // 워드클라우드 PNG 저장
    el('exportPngBtn').addEventListener('click', function () {
      if (state.type !== 'wordcloud') {
        showToast('전체 결과 저장은 상단 [PDF 보고서] 버튼을 이용해 주세요.');
        return;
      }
      var a = document.createElement('a');
      a.href = el('wcCanvas').toDataURL('image/png');
      a.download = 'tong-wordcloud-' + state.roomCode + '.png';
      a.click();
    });

    // A4 PDF 결과 보고서 출력
    el('exportPdfBtn').addEventListener('click', function () {
      var rep = el('printReport');
      var now = new Date().toLocaleString('ko-KR');
      var typeNames = { wordcloud: '워드 클라우드', poll: '객관식 투표', scale: '1~5 척도 평가', open: '자유 의견 · Q&A' };
      var bodyHtml = '';

      if (state.type === 'wordcloud') {
        var imgData = el('wcCanvas').toDataURL('image/png');
        var entries = Object.keys(state.words).map(function (w) { return { w: w, c: state.words[w] }; })
          .filter(function (x) { return x.c > 0; }).sort(function (a, b) { return b.c - a.c; });
        bodyHtml =
          '<img class="tm-rep-img" src="' + imgData + '" alt="워드 클라우드">' +
          '<table class="tm-rep-table"><thead><tr><th>순위</th><th>키워드</th><th>빈도(회)</th></tr></thead><tbody>' +
          entries.map(function (it, i) { return '<tr><td>' + (i + 1) + '</td><td>' + esc(it.w) + '</td><td>' + it.c + '</td></tr>'; }).join('') +
          '</tbody></table>';
      } else if (state.type === 'poll') {
        var total = state.votes.slice(0, state.options.length).reduce(function (a, b) { return a + b; }, 0);
        bodyHtml =
          '<table class="tm-rep-table"><thead><tr><th>번호</th><th>선택지</th><th>득표수</th><th>비율</th></tr></thead><tbody>' +
          state.options.map(function (opt, i) {
            var c = state.votes[i] || 0;
            var p = total ? Math.round((c / total) * 100) : 0;
            return '<tr><td>' + (i + 1) + '</td><td>' + esc(opt) + '</td><td>' + c + '표</td><td>' + p + '%</td></tr>';
          }).join('') +
          '</tbody></table>';
      } else if (state.type === 'scale') {
        var counts = [0, 0, 0, 0, 0];
        var sum = 0;
        state.scales.forEach(function (v) { if (v >= 1 && v <= 5) { counts[v - 1]++; sum += v; } });
        var avg = state.scales.length ? (sum / state.scales.length).toFixed(2) : '0.00';
        bodyHtml =
          '<p><b>평균 점수: ' + avg + ' / 5.00점</b> (총 ' + state.scales.length + '명 응답)</p>' +
          '<table class="tm-rep-table"><thead><tr><th>점수</th><th>응답자 수</th></tr></thead><tbody>' +
          counts.map(function (c, i) { return '<tr><td>' + (i + 1) + '점</td><td>' + c + '명</td></tr>'; }).join('') +
          '</tbody></table>';
      } else {
        bodyHtml =
          '<table class="tm-rep-table"><thead><tr><th>작성자</th><th>의견 내용</th></tr></thead><tbody>' +
          state.opens.map(function (o) { return '<tr><td>' + esc(o.author) + '</td><td>' + esc(o.text) + '</td></tr>'; }).join('') +
          '</tbody></table>';
      }

      rep.innerHTML =
        '<div class="tm-rep-head">' +
          '<h1>' + esc(state.question) + '</h1>' +
          '<div class="tm-rep-meta">' +
            '<span>활동 유형: ' + esc(typeNames[state.type]) + '</span>' +
            '<span>총 응답: ' + totalCount() + '건</span>' +
            '<span>출력 일시: ' + esc(now) + '</span>' +
          '</div>' +
        '</div>' + bodyHtml;
      window.print();
    });

    // QR 모달 & 링크 복사
    el('openQrBtn').addEventListener('click', function () { renderQrCodes(); el('qrModal').classList.add('show'); });
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { el(b.getAttribute('data-close')).classList.remove('show'); });
    });
    el('qrModal').addEventListener('click', function (e) { if (e.target === el('qrModal')) el('qrModal').classList.remove('show'); });

    function copyJoin() {
      navigator.clipboard.writeText(getJoinUrl()).then(function () { showToast('학생 참여 링크를 복사했습니다.'); });
    }
    el('copyJoinBtn').addEventListener('click', copyJoin);
    el('copyLinkMiniBtn').addEventListener('click', copyJoin);

    window.addEventListener('resize', function () {
      if (state.type === 'wordcloud') renderWordCloud();
    });
  }
})();
