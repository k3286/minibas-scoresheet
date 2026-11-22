/* ============================================================
   ミニバス スコアシート アプリ本体
   - 入力 UI（試合情報 / 選手登録 / 記録）
   - JBA ミニバス公式スコアシート様式への転記・描画
   - データは localStorage に自動保存
   ============================================================ */
'use strict';

var QTRS = ['1', '2', '3', '4', 'OT'];
var STORE_KEY = 'minibas-scoresheet-v1';

/* ---------- 状態 ---------- */
function emptyPlayer() { return { no: '', name: '', license: '' }; }
function emptyTeam(color) {
  return {
    name: '', color: color,
    coach: { name: '', license: '' },
    acoach: { name: '', license: '' },
    players: Array.from({ length: 15 }, emptyPlayer)
  };
}
function defaultState() {
  return {
    game: {
      tournament: '', date: '', time: '', venue: '', gameNo: '', endTime: '',
      crewChief: '', umpire: '', scorer: '', timer: '', aScorer: '', shotClock: '',
      use3pt: false, finished: false
    },
    teams: { A: emptyTeam('白'), B: emptyTeam('') },
    quarter: '1',
    events: [],        // {team, idx, no, pts, q} 得点イベント（時系列）
    fouls: [],         // {team, who: 選手index | 'coach' | 'acoach', type, q}
    participation: { A: {}, B: {} }, // idx -> { q: 's'(先発/) | 'i'(途中\) }
    timeouts: { A: {}, B: {} },      // q -> [経過分, ...]
    history: []
  };
}
function load() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    var s = JSON.parse(raw);
    if (!s || !s.teams || !s.game) return null;
    return s;
  } catch (e) { return null; }
}
var S = load() || defaultState();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {}
}
function snapshot() {
  S.history.push(JSON.stringify({
    events: S.events, fouls: S.fouls,
    participation: S.participation, timeouts: S.timeouts
  }));
  if (S.history.length > 100) S.history.shift();
}
function undo() {
  var h = S.history.pop();
  if (!h) { alert('これ以上戻れません。'); return; }
  var d = JSON.parse(h);
  S.events = d.events; S.fouls = d.fouls;
  S.participation = d.participation; S.timeouts = d.timeouts;
  save(); renderRecord(); renderSheet();
}

/* ---------- ユーティリティ ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function qColorClass(q) { return (q === '1' || q === '3') ? 'qc-r' : 'qc-k'; }
function qColor(q) { return (q === '1' || q === '3') ? '#d32f2f' : '#1a237e'; }
function fmtDate(d) {
  if (!d) return '　　年　　月　　日';
  var p = d.split('-');
  if (p.length !== 3) return esc(d);
  return Number(p[0]) + ' 年 ' + Number(p[1]) + ' 月 ' + Number(p[2]) + ' 日';
}
function quarterPoints(team, q) {
  return S.events.filter(function (e) { return e.team === team && e.q === q; })
    .reduce(function (a, e) { return a + e.pts; }, 0);
}
function totalScore(team) {
  return S.events.filter(function (e) { return e.team === team; })
    .reduce(function (a, e) { return a + e.pts; }, 0);
}
function playerFouls(team, idx) {
  return S.fouls.filter(function (f) { return f.team === team && f.who === idx; });
}
function teamFoulCount(team, q) {
  var qq = (q === 'OT') ? '4' : q; // 延長は第4Qの続きとして数える
  return S.fouls.filter(function (f) {
    return f.team === team && typeof f.who === 'number' &&
      ((q === 'OT') ? (f.q === 'OT' || f.q === '4') : f.q === qq);
  }).length;
}

/* ---------- タブ切り替え ---------- */
document.querySelectorAll('#tabs button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    document.querySelectorAll('.tabpage').forEach(function (p) { p.classList.remove('active'); });
    document.getElementById('tab-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'sheet') renderSheet();
    if (b.dataset.tab === 'record') renderRecord();
  });
});

/* ---------- 試合情報 ---------- */
var INFO_FIELDS = [
  ['gTournament', 'tournament'], ['gDate', 'date'], ['gTime', 'time'],
  ['gVenue', 'venue'], ['gGameNo', 'gameNo'], ['gEndTime', 'endTime'],
  ['gCrewChief', 'crewChief'], ['gUmpire', 'umpire'], ['gScorer', 'scorer'],
  ['gTimer', 'timer'], ['gAScorer', 'aScorer'], ['gShotClock', 'shotClock']
];
function bindInfo() {
  INFO_FIELDS.forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    el.value = S.game[pair[1]] || '';
    el.oninput = function () { S.game[pair[1]] = el.value; save(); };
  });
  var c3 = document.getElementById('gUse3pt');
  c3.checked = !!S.game.use3pt;
  c3.onchange = function () { S.game.use3pt = c3.checked; save(); renderRecord(); };
  var cf = document.getElementById('gFinished');
  cf.checked = !!S.game.finished;
  cf.onchange = function () { S.game.finished = cf.checked; save(); renderSheet(); };
}

/* ---------- 選手登録 ---------- */
function renderRoster() {
  var root = document.getElementById('rosterEditors');
  root.innerHTML = ['A', 'B'].map(function (t) {
    var team = S.teams[t];
    var rows = team.players.map(function (p, i) {
      return '<tr><td>' + (i + 1) + '</td>' +
        '<td><input class="no" data-team="' + t + '" data-idx="' + i + '" data-field="no" value="' + esc(p.no) + '" inputmode="numeric" placeholder="No."></td>' +
        '<td><input data-team="' + t + '" data-idx="' + i + '" data-field="name" value="' + esc(p.name) + '" placeholder="選手氏名"></td>' +
        '<td><input class="lic" data-team="' + t + '" data-idx="' + i + '" data-field="license" value="' + esc(p.license) + '" maxlength="3" inputmode="numeric" placeholder="3桁"></td></tr>';
    }).join('');
    return '<div class="team-editor">' +
      '<h3>チーム' + t + '</h3>' +
      '<div class="row">' +
      '<input class="tname" data-team="' + t + '" data-field="name" value="' + esc(team.name) + '" placeholder="チーム名">' +
      '<input class="tcolor" data-team="' + t + '" data-field="color" value="' + esc(team.color) + '" placeholder="ユニフォーム色（例：白）">' +
      '</div>' +
      '<table class="roster"><thead><tr><th style="width:8%">#</th><th style="width:16%">背番号</th><th>選手氏名</th><th style="width:22%">ライセンスNo.<br>下3桁</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="coach-rows">' +
      '<div class="row"><label>コーチ 氏名 <input data-team="' + t + '" data-who="coach" data-field="name" value="' + esc(team.coach.name) + '"> ライセンス下3桁 <input data-team="' + t + '" data-who="coach" data-field="license" value="' + esc(team.coach.license) + '" maxlength="3" inputmode="numeric" style="width:70px"></label></div>' +
      '<div class="row"><label>Aコーチ 氏名 <input data-team="' + t + '" data-who="acoach" data-field="name" value="' + esc(team.acoach.name) + '"> ライセンス下3桁 <input data-team="' + t + '" data-who="acoach" data-field="license" value="' + esc(team.acoach.license) + '" maxlength="3" inputmode="numeric" style="width:70px"></label></div>' +
      '</div></div>';
  }).join('');
}
document.getElementById('rosterEditors').addEventListener('input', function (e) {
  var el = e.target;
  if (!el.dataset || !el.dataset.team) return;
  var team = S.teams[el.dataset.team];
  if (el.dataset.who) {
    team[el.dataset.who][el.dataset.field] = el.value;
  } else if (el.dataset.idx !== undefined && el.dataset.idx !== '') {
    team.players[Number(el.dataset.idx)][el.dataset.field] = el.value;
  } else {
    team[el.dataset.field] = el.value;
  }
  save();
});

/* ---------- 記録 ---------- */
document.getElementById('quarterBtns').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-q]');
  if (!b) return;
  S.quarter = b.dataset.q;
  document.querySelectorAll('#quarterBtns button').forEach(function (x) {
    x.classList.toggle('active', x.dataset.q === S.quarter);
  });
  save(); renderRecord();
});

function renderRecord() {
  document.querySelectorAll('#quarterBtns button').forEach(function (x) {
    x.classList.toggle('active', x.dataset.q === S.quarter);
  });
  var root = document.getElementById('recordPanels');
  root.innerHTML = ['A', 'B'].map(function (t) {
    var team = S.teams[t];
    var q = S.quarter;
    var tos = (S.timeouts[t][q] || []);
    var chips = tos.map(function (m, i) {
      return '<span class="chip">' + q + ' ' + m + '分<b data-act="delto" data-team="' + t + '" data-i="' + i + '">×</b></span>';
    }).join('');
    var registered = team.players.map(function (p, i) { return { p: p, i: i }; })
      .filter(function (x) { return x.p.no !== '' || x.p.name !== ''; });
    var rows;
    if (registered.length === 0) {
      rows = '<p class="hint">「選手登録」タブで選手を登録してください。</p>';
    } else {
      rows = '<table class="record"><thead><tr><th>出場</th><th>選手</th><th>得点</th><th>ファウル</th></tr></thead><tbody>' +
        registered.map(function (x) {
          var p = x.p, i = x.i;
          var part = (S.participation[t][i] || {})[q];
          var fc = playerFouls(t, i).length;
          var playLabel = part === 's' ? '／' : (part === 'i' ? '＼' : '出場');
          var ptsBtns = '<button type="button" class="pts" data-act="score" data-team="' + t + '" data-idx="' + i + '" data-pts="1">+1</button> ' +
            '<button type="button" class="pts" data-act="score" data-team="' + t + '" data-idx="' + i + '" data-pts="2">+2</button>' +
            (S.game.use3pt ? ' <button type="button" class="pts" data-act="score" data-team="' + t + '" data-idx="' + i + '" data-pts="3">+3</button>' : '');
          return '<tr' + (fc >= 5 ? ' class="out"' : '') + '>' +
            '<td><button type="button" class="play' + (part ? ' on' : '') + '" data-act="play" data-team="' + t + '" data-idx="' + i + '">' + playLabel + '</button></td>' +
            '<td class="pname"><span class="pno">' + esc(p.no || '―') + '</span> ' + esc(p.name) +
            (fc ? ' <span class="foulcount">F' + fc + (fc >= 5 ? '（退場）' : '') + '</span>' : '') + '</td>' +
            '<td>' + ptsBtns + '</td>' +
            '<td><button type="button" class="foul" data-act="foul" data-team="' + t + '" data-idx="' + i + '">F</button></td></tr>';
        }).join('') + '</tbody></table>';
    }
    return '<div class="team-panel">' +
      '<header><h3>チーム' + t + '：' + esc(team.name || '（未入力）') + '</h3>' +
      '<span class="score-now">' + totalScore(t) + '</span>' +
      '<span class="panel-btns">' +
      '<button type="button" data-act="to" data-team="' + t + '">タイムアウト</button>' +
      '<button type="button" data-act="foul" data-team="' + t + '" data-who="coach">コーチF</button>' +
      '<button type="button" data-act="foul" data-team="' + t + '" data-who="acoach">AコーチF</button>' +
      '</span></header>' +
      '<div class="to-chips">' + (chips ? 'TO（' + q + '）: ' + chips : '') + '</div>' +
      rows + '</div>';
  }).join('');
}

document.getElementById('recordPanels').addEventListener('click', function (e) {
  var b = e.target.closest('[data-act]');
  if (!b) return;
  var act = b.dataset.act, t = b.dataset.team, q = S.quarter;
  if (act === 'score') {
    var idx = Number(b.dataset.idx);
    snapshot();
    S.events.push({ team: t, idx: idx, no: S.teams[t].players[idx].no, pts: Number(b.dataset.pts), q: q });
    // 得点した選手は出場扱い（未設定なら途中出場の ＼）
    var part = S.participation[t][idx] || (S.participation[t][idx] = {});
    if (!part[q]) part[q] = 'i';
    save(); renderRecord();
  } else if (act === 'play') {
    var i2 = Number(b.dataset.idx);
    snapshot();
    var pr = S.participation[t][i2] || (S.participation[t][i2] = {});
    pr[q] = !pr[q] ? 's' : (pr[q] === 's' ? 'i' : undefined);
    if (!pr[q]) delete pr[q];
    save(); renderRecord();
  } else if (act === 'foul') {
    foulTarget = { team: t, who: b.dataset.who !== undefined ? b.dataset.who : Number(b.dataset.idx) };
    openFoulModal();
  } else if (act === 'to') {
    toTarget = { team: t };
    document.getElementById('toModalTitle').textContent =
      'タイムアウト（チーム' + t + ' / ' + q + '）';
    document.getElementById('toMinute').value = '';
    document.getElementById('toModal').classList.remove('hidden');
  } else if (act === 'delto') {
    snapshot();
    S.timeouts[t][q].splice(Number(b.dataset.i), 1);
    save(); renderRecord();
  }
});

/* ---------- ファウルピッカー ---------- */
var foulTarget = null;
var FOUL_TYPES_PLAYER = ['P', 'P1', 'P2', 'P3', 'U', 'U1', 'U2', 'T', 'T1', 'D'];
var FOUL_TYPES_COACH = ['C', 'C1', 'C2', 'B', 'B1', 'B2', 'M', 'M1'];
function openFoulModal() {
  var isCoach = typeof foulTarget.who === 'string';
  document.getElementById('foulModalTitle').textContent =
    'ファウルの種別（チーム' + foulTarget.team + ' / ' + S.quarter + '）';
  var types = isCoach ? FOUL_TYPES_COACH : FOUL_TYPES_PLAYER;
  document.getElementById('foulTypeBtns').innerHTML = types.map(function (ty) {
    return '<button type="button" data-type="' + ty + '">' + ty + '</button>';
  }).join('');
  document.getElementById('foulModal').classList.remove('hidden');
}
document.getElementById('foulTypeBtns').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-type]');
  if (!b || !foulTarget) return;
  snapshot();
  S.fouls.push({ team: foulTarget.team, who: foulTarget.who, type: b.dataset.type, q: S.quarter });
  if (typeof foulTarget.who === 'number') {
    var part = S.participation[foulTarget.team][foulTarget.who] ||
      (S.participation[foulTarget.team][foulTarget.who] = {});
    if (!part[S.quarter]) part[S.quarter] = 'i';
  }
  foulTarget = null;
  document.getElementById('foulModal').classList.add('hidden');
  save(); renderRecord();
});
document.getElementById('foulCancel').addEventListener('click', function () {
  foulTarget = null;
  document.getElementById('foulModal').classList.add('hidden');
});

/* ---------- タイムアウト ---------- */
var toTarget = null;
document.getElementById('toSave').addEventListener('click', function () {
  var v = document.getElementById('toMinute').value;
  if (!toTarget || v === '' || Number(v) < 1) { alert('経過時間（分）を入力してください。'); return; }
  snapshot();
  var arr = S.timeouts[toTarget.team][S.quarter] || (S.timeouts[toTarget.team][S.quarter] = []);
  arr.push(Number(v));
  toTarget = null;
  document.getElementById('toModal').classList.add('hidden');
  save(); renderRecord();
});
document.getElementById('toCancel').addEventListener('click', function () {
  toTarget = null;
  document.getElementById('toModal').classList.add('hidden');
});

/* ---------- 公式シート描画 ---------- */
function licCells(license) {
  var s = String(license || '');
  var out = '';
  for (var i = 0; i < 3; i++) out += '<td class="lic">' + esc(s.charAt(i) || '') + '</td>';
  return out;
}
function foulCells(team, who) {
  var fs = S.fouls.filter(function (f) { return f.team === team && f.who === who; });
  var out = '';
  for (var i = 0; i < 5; i++) {
    var f = fs[i];
    out += '<td class="foul' + (f ? ' ' + qColorClass(f.q) : '') + '">' + (f ? esc(f.type) : '') + '</td>';
  }
  return out;
}
function timeoutTable(team) {
  var head = QTRS.map(function (q) { return '<td class="to-q">' + (q === 'OT' ? 'OT' : q + 'Q') + '</td>'; }).join('');
  var rows = [0, 1].map(function (r) {
    return '<tr>' + QTRS.map(function (q) {
      var v = (S.timeouts[team][q] || [])[r];
      return '<td class="to-v">' + (v != null ? v : '') + '</td>';
    }).join('') + '</tr>';
  }).join('');
  return '<table class="timeout"><tr><td class="to-title" colspan="5">タイムアウト</td></tr><tr>' +
    head + '</tr>' + rows + '</table>';
}
function teamBlock(t) {
  var team = S.teams[t];
  var headCls = t === 'A' ? 'team-head-a' : 'team-head-b';
  var html = '<table class="team">' +
    '<colgroup><col style="width:20px">' +
    '<col style="width:12px"><col style="width:12px"><col style="width:12px">' +
    '<col><col style="width:24px">' +
    '<col style="width:15px"><col style="width:15px"><col style="width:15px"><col style="width:15px">' +
    '<col style="width:19px"><col style="width:19px"><col style="width:19px"><col style="width:19px"><col style="width:19px">' +
    '</colgroup>' +
    '<tr class="team-head ' + headCls + '">' +
    '<td colspan="10" class="team-name-cell"><div class="team-name-flex">' +
    '<span class="tlabel">チーム' + t + '：</span>' +
    '<span class="tname">' + esc(team.name) + '</span>' +
    '<span class="tcolor">（' + esc(team.color) + '）</span></div></td>' +
    '<td colspan="5" class="to-cell">' + timeoutTable(t) + '</td></tr>' +
    '<tr><th rowspan="2">No.</th><th colspan="3">ライセンスNo.</th><th rowspan="2">選手氏名</th><th rowspan="2">No.</th>' +
    '<th colspan="4">出場時限</th><th colspan="5">ファウル</th></tr>' +
    '<tr><th>①</th><th>②</th><th>③</th><th>④</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th></tr>';
  team.players.forEach(function (p, i) {
    var part = S.participation[t][i] || {};
    var playCells = ['1', '2', '3', '4'].map(function (q) {
      var m = part[q];
      return '<td class="play ' + qColorClass(q) + '">' + (m === 's' ? '／' : (m === 'i' ? '＼' : '')) + '</td>';
    }).join('');
    html += '<tr class="prow"><td>' + (i + 1) + '</td>' + licCells(p.license) +
      '<td class="pname">' + esc(p.name) + '</td><td>' + esc(p.no) + '</td>' +
      playCells + foulCells(t, i) + '</tr>';
  });
  [['coach', 'コーチ'], ['acoach', 'Aコーチ']].forEach(function (cw) {
    var c = team[cw[0]];
    html += '<tr><td class="coach-label">' + cw[1] + '</td>' + licCells(c.license) +
      '<td class="pname">' + esc(c.name) + '</td>' +
      '<td class="sign" colspan="5">（サイン）</td>' + foulCells(t, cw[0]) + '</tr>';
  });
  html += '</table>';
  return html;
}
function foulBox(t) {
  function box(q1, q2) {
    var c1 = teamFoulCount(t, q1), c2 = teamFoulCount(t, q2);
    var rows = '';
    for (var n = 1; n <= 4; n++) {
      rows += '<tr><td class="' + (n <= c1 ? 'x' : '') + '">' + n + '</td>' +
        '<td class="' + (n <= c2 ? 'x' : '') + '">' + n + '</td></tr>';
    }
    return '<table class="fb"><tr><th>' + q1 + 'Q</th><th>' + q2 + 'Q</th></tr>' + rows + '</table>';
  }
  return '<div class="foul-box"><div class="fb-title">チーム<br>ファウル</div>' +
    box('1', '2') + box('3', '4') + '</div>';
}
function runningScore() {
  // ランニングスコアのマークを計算
  var cum = { A: 0, B: 0 };
  var marks = { A: {}, B: {} };       // total -> {no, pts, q}
  var qLast = { A: {}, B: {} };       // q -> そのQ終了時点の累計
  S.events.forEach(function (ev) {
    cum[ev.team] += ev.pts;
    marks[ev.team][cum[ev.team]] = { no: ev.no, pts: ev.pts, q: ev.q };
    qLast[ev.team][ev.q] = cum[ev.team];
  });
  var final = { A: cum.A, B: cum.B };
  function cells(t, n) {
    var m = marks[t][n];
    var numCls = t === 'A' ? 'num-a' : 'num-b';
    if (!m) return '<td class="small"></td><td class="' + numCls + '">' + n + '</td>';
    var cc = qColorClass(m.q);
    var isFinal = S.game.finished && n === final[t] && final[t] > 0;
    var isQEnd = qLast[t][m.q] === n;
    var spanCls = 'rnum ' + (m.pts === 1 ? 'dot' : 'slash') +
      (isQEnd ? ' circle' + (isFinal ? ' strong' : '') : '');
    var tdCls = numCls + (isFinal ? ' fend' : (isQEnd ? ' qend' : ''));
    var smallCls = 'small ' + cc + (isFinal ? ' fend' : (isQEnd ? ' qend' : ''));
    var noHtml = m.pts === 3
      ? '<span class="pno3">' + esc(m.no) + '</span>' : esc(m.no);
    return '<td class="' + smallCls + '">' + noHtml + '</td>' +
      '<td class="' + tdCls + '"><span class="' + spanCls + ' ' + cc +
      '" style="--qcolor:' + qColor(m.q) + '">' + n + '</span></td>';
  }
  var html = '<table class="running"><tr><th colspan="12" class="run-title">ランニング スコア</th></tr>';
  html += '<tr>' + [0, 1, 2].map(function () {
    return '<th colspan="2" class="ab-a">A</th><th colspan="2" class="ab-b">B</th>';
  }).join('') + '</tr>';
  for (var r = 0; r < 40; r++) {
    html += '<tr>';
    for (var g = 0; g < 3; g++) {
      var n = g * 40 + r + 1;
      html += cells('A', n) + cells('B', n);
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}
function renderSheet() {
  var g = S.game;
  var finalA = totalScore('A'), finalB = totalScore('B');
  var lines = ['1', '2', '3', '4'].map(function (q) {
    return '<div class="score-line ' + qColorClass(q) + '">' + quarterPoints('A', q) +
      '<span class="dash">―</span>' + quarterPoints('B', q) + '</div>';
  }).join('');
  var hasOT = S.events.some(function (e) { return e.q === 'OT'; });
  var otLine = hasOT
    ? '<div class="score-line ot ' + qColorClass('OT') + '">' + quarterPoints('A', 'OT') +
      '<span class="dash">―</span>' + quarterPoints('B', 'OT') + '</div>'
    : '<div class="score-line ot"></div>';
  var winner = '';
  if (g.finished) {
    winner = finalA > finalB ? (S.teams.A.name || 'チームA')
      : (finalB > finalA ? (S.teams.B.name || 'チームB') : '');
  }
  var html =
    '<div class="sheet">' +
    '<div class="sheet-title">MINI-BASKETBALL OFFICIAL SCORESHEET</div>' +
    '<table class="hdr"><colgroup>' +
    '<col style="width:52px"><col><col style="width:64px"><col style="width:128px"><col style="width:46px"><col style="width:92px">' +
    '</colgroup>' +
    '<tr><td class="lb">大会名</td><td class="val tournament">' + esc(g.tournament) + '</td>' +
    '<td class="lb">日付</td><td class="val-c">' + fmtDate(g.date) + '</td>' +
    '<td class="lb">時間</td><td class="val-c">' + esc(g.time) + '</td></tr>' +
    '<tr><td class="hdr-score" colspan="2" rowspan="4"><div class="score-flex">' +
    '<div class="score-side"><span class="slabel">チームA</span>' +
    '<div class="score-box">' + (finalA || '') + '</div><span class="tname-v">チーム名</span></div>' +
    '<div class="score-mid"><span class="brace">{</span><div class="score-lines">' +
    lines + otLine + '<div class="score-line ot">（延長）</div></div><span class="brace">}</span></div>' +
    '<div class="score-side"><span class="slabel">チームB</span>' +
    '<div class="score-box">' + (finalB || '') + '</div><span class="tname-v">チーム名</span></div>' +
    '</div></td>' +
    '<td class="lb">会場</td><td class="val">' + esc(g.venue) + '</td>' +
    '<td class="lb-sm">Game<br>No.</td><td class="val-c">第 ' + esc(g.gameNo) + ' 試合</td></tr>' +
    '<tr><td class="lb">クルーチーフ</td><td class="val">' + esc(g.crewChief) + '</td>' +
    '<td class="lb">アンパイア</td><td class="val">' + esc(g.umpire) + '</td></tr>' +
    '<tr><td class="lb">スコアラー</td><td class="val">' + esc(g.scorer) + '</td>' +
    '<td class="lb">タイマー</td><td class="val">' + esc(g.timer) + '</td></tr>' +
    '<tr><td class="lb">A・スコアラー</td><td class="val">' + esc(g.aScorer) + '</td>' +
    '<td class="lb" style="font-size:8px">ショットクロック<br>オペレイター（24秒）</td><td class="val">' + esc(g.shotClock) + '</td></tr>' +
    '</table>' +
    '<div class="sheet-main"><div class="sheet-left">' +
    '<div class="team-row"><div class="team-block">' + teamBlock('A') + '</div>' + foulBox('A') + '</div>' +
    '<div class="team-row"><div class="team-block">' + teamBlock('B') + '</div>' + foulBox('B') + '</div>' +
    '</div><div class="sheet-right">' + runningScore() +
    '<table class="win"><tr><td class="win-label">勝利チーム</td><td class="win-name">' + esc(winner) + '</td></tr>' +
    '<tr><td class="win-label">試合終了時間</td><td>' + esc(g.endTime) + '</td></tr></table>' +
    '</div></div></div>';
  document.getElementById('sheetRoot').innerHTML = html;
}

/* ---------- 印刷 ---------- */
function doPrint() {
  renderSheet();
  if (window.AndroidPrint && typeof window.AndroidPrint.printSheet === 'function') {
    window.AndroidPrint.printSheet();
  } else {
    window.print();
  }
}
document.getElementById('btnPrint').addEventListener('click', doPrint);
document.getElementById('btnPrintTop').addEventListener('click', doPrint);
document.getElementById('btnUndo').addEventListener('click', undo);
document.getElementById('btnNewGame').addEventListener('click', function () {
  if (!confirm('全てのデータを消去して新しい試合を始めます。よろしいですか？')) return;
  S = defaultState();
  save(); bindInfo(); renderRoster(); renderRecord(); renderSheet();
  alert('新しい試合の入力を始められます。');
});

/* ---------- 初期化 ---------- */
bindInfo();
renderRoster();
renderRecord();
renderSheet();
