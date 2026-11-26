/* ============================================================
   ミニバス スコアシート アプリ本体
   - 入力 UI（試合情報 / 選手登録 / 記録 / 修正）
   - 公式シートは JBA 公式様式画像の上に canvas で記入を重ね描き
   - 音声入力・メンバー表 OCR・バックアップ・スリープ防止は
     MainActivity 側のブリッジ（AndroidVoice / AndroidOcr /
     AndroidSave / AndroidBackup / AndroidScreen）と連携する
   - データは localStorage に自動保存
   ============================================================ */
'use strict';

var STORE_KEY = 'minibas-scoresheet-v1';
var PRACTICE_KEY = 'minibas-scoresheet-practice-v1';
var ARCHIVE_KEY = 'minibas-scoresheet-archive-v1';
var PRACTICE_ARCHIVE_KEY = 'minibas-scoresheet-practice-archive-v1';
var MODE_KEY = 'minibas-scoresheet-mode-v1';
function isPractice() {
  try { return localStorage.getItem(MODE_KEY) === 'practice'; } catch (e) { return false; }
}
function storeKey() { return isPractice() ? PRACTICE_KEY : STORE_KEY; }
function archiveKey() { return isPractice() ? PRACTICE_ARCHIVE_KEY : ARCHIVE_KEY; }

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
    teams: { A: emptyTeam('白'), B: emptyTeam('青') },
    quarter: '1',
    events: [],        // {team, idx, no, pts, q} 得点イベント（時系列）
    fouls: [],         // {team, who: 選手index | 'coach' | 'acoach', type, q}
    participation: { A: {}, B: {} }, // idx -> { q: 's'(先発/) | 'i'(途中\) }
    timeouts: { A: {}, B: {} },      // q -> [1]（取得済みの印。各Qに1回まで）
    toSeq: { A: {}, B: {} },         // timeouts と同じ形で、入力順(seq)を並行保持
    seqNext: 1,                      // 次に割り当てる入力順(seq)
    history: []
  };
}
/* タイムアウトは「取得済みかどうか」だけを持つ（各Qに1回まで）。
   旧データ（経過分の配列）は、入っていれば取得済み1件に丸める。 */
function normalizeTimeouts(s) {
  if (!s || !s.timeouts) return s;
  ['A', 'B'].forEach(function (t) {
    var tos = s.timeouts[t];
    if (!tos) return;
    Object.keys(tos).forEach(function (q) {
      if (Array.isArray(tos[q])) tos[q] = tos[q].length ? [1] : [];
    });
  });
  return s;
}
function loadFrom(key) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return null;
    var s = JSON.parse(raw);
    if (!s || !s.teams || !s.game) return null;
    // 旧データ移行: Bチームの色が空なら初期値の「青」を補う（A=白と対の扱い）
    if (s.teams.B && !s.teams.B.color) s.teams.B.color = '青';
    normalizeTimeouts(s);
    return s;
  } catch (e) { return null; }
}
function load() { return loadFrom(storeKey()); }
var S = load() || defaultState();
function save() {
  try { localStorage.setItem(storeKey(), JSON.stringify(S)); } catch (e) {}
}
function snapshot() {
  S.history.push(JSON.stringify({
    events: S.events, fouls: S.fouls,
    participation: S.participation, timeouts: S.timeouts, toSeq: S.toSeq
  }));
  if (S.history.length > 100) S.history.shift();
}
function undo() {
  var h = S.history.pop();
  if (!h) { alert('これ以上戻れません。'); return; }
  var d = JSON.parse(h);
  S.events = d.events; S.fouls = d.fouls;
  S.participation = d.participation; S.timeouts = d.timeouts;
  S.toSeq = d.toSeq || { A: {}, B: {} };
  save(); renderRecord(); renderSheet(); renderFix();
}

/* ---------- ユーティリティ ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function totalScore(team) {
  return S.events.filter(function (e) { return e.team === team; })
    .reduce(function (a, e) { return a + e.pts; }, 0);
}
function playerFouls(team, idx) {
  return S.fouls.filter(function (f) { return f.team === team && f.who === idx; });
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
    if (b.dataset.tab === 'fix') renderFix();
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
  cf.onchange = function () {
    /* 同点のままの試合終了はあり得ない（延長が必要）ので確認する（警告のみ） */
    if (cf.checked && totalScore('A') === totalScore('B')) {
      if (!confirm('同点です。ミニバスでは延長が必要です。\nこのまま試合終了にしますか？')) { cf.checked = false; return; }
    }
    S.game.finished = cf.checked; save(); renderSheet();
  };
}

/* ---------- 選手登録 ---------- */
function renderRoster() {
  var root = document.getElementById('rosterEditors');
  root.innerHTML = ['A', 'B'].map(function (t) {
    var team = S.teams[t];
    var rows = team.players.map(function (p, i) {
      return '<tr><td>' + (i + 1) + '</td>' +
        '<td><input class="no" data-team="' + t + '" data-idx="' + i + '" data-field="no" value="' + esc(p.no) + '" inputmode="numeric" placeholder="No."></td>' +
        '<td><span class="input-row"><input data-team="' + t + '" data-idx="' + i + '" data-field="name" value="' + esc(p.name) + '" placeholder="選手氏名"><button type="button" class="mic-btn" title="音声入力">🎤</button></span></td>' +
        '<td><input class="lic" data-team="' + t + '" data-idx="' + i + '" data-field="license" value="' + esc(p.license) + '" maxlength="3" inputmode="numeric" placeholder="3桁"></td></tr>';
    }).join('');
    return '<div class="team-editor">' +
      '<h3>チーム' + t + '</h3>' +
      '<div class="row">' +
      '<input class="tname" data-team="' + t + '" data-field="name" value="' + esc(team.name) + '" placeholder="チーム名">' +
      '<button type="button" class="mic-btn" title="音声入力">🎤</button>' +
      '<input class="tcolor" data-team="' + t + '" data-field="color" value="' + esc(team.color) + '" placeholder="ユニフォーム色（例：白）">' +
      '</div>' +
      '<div class="row"><button type="button" class="ocr-open" data-ocr-team="' + t + '">📷 メンバー表を取り込む</button></div>' +
      '<table class="roster"><thead><tr><th style="width:8%">#</th><th style="width:16%">背番号</th><th>選手氏名</th><th style="width:22%">ライセンスNo.<br>下3桁</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="coach-rows">' +
      '<div class="row"><label>コーチ 氏名 <input data-team="' + t + '" data-who="coach" data-field="name" value="' + esc(team.coach.name) + '"> <button type="button" class="mic-btn" title="音声入力">🎤</button> ライセンス下3桁 <input data-team="' + t + '" data-who="coach" data-field="license" value="' + esc(team.coach.license) + '" maxlength="3" inputmode="numeric" style="width:70px"></label></div>' +
      '<div class="row"><label>Aコーチ 氏名 <input data-team="' + t + '" data-who="acoach" data-field="name" value="' + esc(team.acoach.name) + '"> <button type="button" class="mic-btn" title="音声入力">🎤</button> ライセンス下3桁 <input data-team="' + t + '" data-who="acoach" data-field="license" value="' + esc(team.acoach.license) + '" maxlength="3" inputmode="numeric" style="width:70px"></label></div>' +
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
  setVoiceTeam(voiceTeam);
});
document.getElementById('rosterEditors').addEventListener('click', function (e) {
  var b = e.target.closest('[data-ocr-team]');
  if (!b) return;
  openOcrSource(b.dataset.ocrTeam);
});

/* ---------- 記録 ---------- */
document.getElementById('quarterBtns').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-q]');
  if (!b) return;
  var changed = S.quarter !== b.dataset.q;
  if (changed) {
    /* 前のQに得点が入っている状態で先のQへ進むときだけ、スコア確認を出す */
    var ORDER = { '1': 1, '2': 2, '3': 3, '4': 4, 'OT': 5 };
    var cur = S.quarter;
    /* Q3→Q4: ミニバスでは Q3 が終わるまでに登録10人以上のチームは
       10人以上の出場が必要。満たしていないチームがあれば警告する（警告のみ） */
    if (cur === '3' && b.dataset.q === '4') {
      var short = [];
      ['A', 'B'].forEach(function (t) {
        var reg = registeredList(t);
        if (reg.length < 10) return;
        var played = 0;
        reg.forEach(function (x) {
          var pp = S.participation[t][x.i] || {};
          if (pp['1'] || pp['2'] || pp['3']) played++;
        });
        if (played < 10) short.push('チーム' + t + '（' + (S.teams[t].name || '未入力') + '）：出場 ' + played + '人');
      });
      if (short.length && !confirm('ミニバスでは、Q3が終わるまでに10人以上の出場が必要です。\n' + short.join('\n') + '\nこのままQ4に進みますか？')) return;
    }
    /* Q2→Q3: Q3に入る時点で、Q3終了までの出場条件（登録10人以上なら10人、
       それ未満なら全員）をまだ満たしていないチームがあれば早めに警告する（警告のみ）。
       Q3の先発選択で未出場の選手を入れてもらうための知らせ */
    if (cur === '2' && b.dataset.q === '3') {
      var short3 = [];
      ['A', 'B'].forEach(function (t) {
        var reg = registeredList(t);
        if (!reg.length) return;
        var target = Math.min(10, reg.length);
        var played = 0;
        reg.forEach(function (x) {
          var pp = S.participation[t][x.i] || {};
          if (pp['1'] || pp['2']) played++;
        });
        if (played < target) short3.push('チーム' + t + '（' + (S.teams[t].name || '未入力') + '）：出場 ' + played + '人／あと' + (target - played) + '人');
      });
      if (short3.length && !confirm('ミニバスでは、Q3が終わるまでに' + '全員（登録10人以上のチームは10人以上）の出場が必要です。\n' + short3.join('\n') + '\n3Qで未出場の選手を出場させてください。\nこのままQ3に進みますか？')) return;
    }
    var curHasEvents = S.events.some(function (ev) { return ev.q === cur; });
    if (ORDER[b.dataset.q] > ORDER[cur] && curHasEvents) {
      var msg = qLabel(cur) + 'を終了しますか？\n現在のスコア\n' +
        (S.teams.A.name || 'チームA') + ' ' + totalScore('A') + ' - ' + totalScore('B') + ' ' + (S.teams.B.name || 'チームB');
      if (!confirm(msg)) return;
    }
  }
  S.quarter = b.dataset.q;
  document.querySelectorAll('#quarterBtns button').forEach(function (x) {
    x.classList.toggle('active', x.dataset.q === S.quarter);
  });
  save(); renderRecord();
  /* 新しいQに切り替えたとき、そのQの出場が両チームとも未設定なら
     先発メンバー選択画面を自動で開く */
  if (changed) maybeOpenLineup(S.quarter);
});

/* ---------- 出場（participation）まわりの共通処理 ---------- */
/* 登録済み選手（背番号か氏名がある行）の一覧 [{p, i}] */
function registeredList(t) {
  return S.teams[t].players.map(function (p, i) { return { p: p, i: i }; })
    .filter(function (x) { return x.p.no !== '' || x.p.name !== ''; });
}
/* その選手がこの試合で1つでも出場マークを持っているか */
function playerHasPlayed(t, idx) {
  var m = S.participation[t][idx];
  return !!(m && Object.keys(m).length > 0);
}
/* そのQにそのチームの出場マークが1つでもあるか */
function quarterHasMarks(t, q) {
  var part = S.participation[t] || {};
  return Object.keys(part).some(function (idx) { return !!(part[idx] && part[idx][q]); });
}
/* ミニバスの出場ルールの進捗表示（表示のみ。記録はブロックしない）
   登録10人以上なら「Q3終了時点で10人の出場が必要」として残り人数を出す */
function participationStatusText(t) {
  var reg = registeredList(t);
  if (!reg.length) return '';
  var played = 0;
  reg.forEach(function (x) { if (playerHasPlayed(t, x.i)) played++; });
  var target = Math.min(10, reg.length);
  var rest = Math.max(0, target - played);
  if (reg.length >= 10) return '出場済み ' + played + '人／あと' + rest + '人（Q3まで）';
  return '出場済み ' + played + '人／全員出場まで あと' + rest + '人';
}

/* ---------- Q開始時：出場メンバー（先発5人）選択 ----------
   クォーター開始時に先発5人をタップで選ぶ画面。確定すると選んだ選手に
   そのQの出場マーク「／」（'s'）が記録される（公式シート描画と同形式）。
   Q途中の交代は従来どおり記録タブの出場ボタンで行う想定で、この画面は
   先発（'s'）だけを編集する。途中出場（'i'）の記録は確定時も消さない。 */
var lineupCtx = null;   // { q, team, sel: { A: [idx...], B: [idx...] } }

function prevQuarterOf(q) {
  return { '2': '1', '3': '2', '4': '3', 'OT': '4' }[q] || null;
}
/* そのチーム・そのQで先発に必要な人数（登録が5人未満なら登録全員） */
function lineupRequired(t) {
  return Math.min(5, registeredList(t).length);
}
/* そのQの先発（'s'）の idx 一覧。先発記録が無い場合は出場マーク全体で代用 */
function starterIdxList(t, q) {
  var reg = registeredList(t);
  var s = reg.filter(function (x) { return (S.participation[t][x.i] || {})[q] === 's'; })
    .map(function (x) { return x.i; });
  if (!s.length) {
    s = reg.filter(function (x) { return !!(S.participation[t][x.i] || {})[q]; })
      .map(function (x) { return x.i; });
  }
  return s;
}
function openLineup(q) {
  lineupCtx = { q: q, team: 'A', sel: { A: starterIdxList('A', q), B: starterIdxList('B', q) } };
  /* 退場（5ファウル）の選手は先発に選べないので初期選択から外す */
  ['A', 'B'].forEach(function (t) {
    lineupCtx.sel[t] = lineupCtx.sel[t].filter(function (idx) {
      return playerFouls(t, idx).length < 5;
    });
  });
  document.getElementById('lineupTitle').textContent =
    qLabel(q) + ' 出場メンバー（先発5人）';
  renderLineup();
  document.getElementById('lineupModal').classList.remove('hidden');
}
/* Q切替時の自動オープン：両チームともそのQの出場が未設定で、
   どちらかのチームに登録選手がいる場合だけ開く */
function maybeOpenLineup(q) {
  var modal = document.getElementById('lineupModal');
  if (modal && !modal.classList.contains('hidden')) return;
  if (quarterHasMarks('A', q) || quarterHasMarks('B', q)) return;
  if (!registeredList('A').length && !registeredList('B').length) return;
  openLineup(q);
}
function renderLineup() {
  if (!lineupCtx) return;
  var t = lineupCtx.team, q = lineupCtx.q;
  var btnA = document.getElementById('lineupTeamA');
  var btnB = document.getElementById('lineupTeamB');
  btnA.classList.toggle('active', t === 'A');
  btnB.classList.toggle('active', t === 'B');
  btnA.textContent = 'チームA（' + lineupCtx.sel.A.length + '/' + lineupRequired('A') + '）';
  btnB.textContent = 'チームB（' + lineupCtx.sel.B.length + '/' + lineupRequired('B') + '）';
  var nm = S.teams[t].name;
  document.getElementById('lineupTeamName').textContent = nm ? '（' + nm + '）' : '';
  document.getElementById('lineupInfo').textContent = participationStatusText(t);
  var reg = registeredList(t);
  var root = document.getElementById('lineupPlayers');
  if (!reg.length) {
    root.innerHTML = '<p class="hint">登録されている選手がいません。「選手登録」タブで登録してください。</p>';
  } else {
    root.innerHTML = reg.map(function (x) {
      var idx = x.i, p = x.p;
      var sel = lineupCtx.sel[t].indexOf(idx) >= 0;
      var fc = playerFouls(t, idx).length;
      var out = fc >= 5;
      var mark = (S.participation[t][idx] || {})[q];
      var badges = '';
      if (out) badges += '<span class="lp-badge b-out">退場</span>';
      else if (!playerHasPlayed(t, idx)) badges += '<span class="lp-badge b-new">未出場</span>';
      if (mark === 'i') badges += '<span class="lp-badge b-sub">途中出場で記録あり</span>';
      return '<button type="button" class="lpick' + (sel ? ' sel' : '') + (out ? ' disabled' : '') +
        '" data-idx="' + idx + '"' + (out ? ' disabled' : '') + '>' +
        '<span class="lp-no">' + esc(p.no || '―') + '</span>' +
        '<span class="lp-name">' + esc(p.name || '（無名）') + '</span>' +
        badges +
        '<span class="lp-check">' + (sel ? '✓' : '') + '</span></button>';
    }).join('');
  }
  var pq = prevQuarterOf(q);
  var sameBtn = document.getElementById('lineupSame');
  if (pq) {
    sameBtn.classList.remove('hidden');
    sameBtn.textContent = '前のQ（' + qLabel(pq) + '）と同じメンバーにする';
  } else {
    sameBtn.classList.add('hidden');
  }
  var okA = lineupCtx.sel.A.length === lineupRequired('A');
  var okB = lineupCtx.sel.B.length === lineupRequired('B');
  var okBtn = document.getElementById('lineupOk');
  okBtn.disabled = !(okA && okB);
  okBtn.classList.toggle('disabled', okBtn.disabled);
  document.getElementById('lineupCount').textContent =
    'チームA ' + lineupCtx.sel.A.length + '/' + lineupRequired('A') + '人、チームB ' +
    lineupCtx.sel.B.length + '/' + lineupRequired('B') + '人' +
    ((okA && okB) ? '：確定できます' : '：両チームとも人数を合わせてください');
}
document.getElementById('lineupPlayers').addEventListener('click', function (e) {
  var b = e.target.closest('.lpick');
  if (!b || b.disabled || !lineupCtx) return;
  var idx = Number(b.dataset.idx);
  var sel = lineupCtx.sel[lineupCtx.team];
  var pos = sel.indexOf(idx);
  if (pos >= 0) sel.splice(pos, 1);
  else {
    if (sel.length >= 5) { voiceStatus('先発は5人までです'); return; }
    sel.push(idx);
  }
  renderLineup();
});
document.getElementById('lineupTeamA').addEventListener('click', function () {
  if (!lineupCtx) return;
  lineupCtx.team = 'A'; renderLineup();
});
document.getElementById('lineupTeamB').addEventListener('click', function () {
  if (!lineupCtx) return;
  lineupCtx.team = 'B'; renderLineup();
});
document.getElementById('lineupSame').addEventListener('click', function () {
  if (!lineupCtx) return;
  var pq = prevQuarterOf(lineupCtx.q);
  if (!pq) return;
  var t = lineupCtx.team;
  var list = starterIdxList(t, pq).filter(function (idx) {
    return playerFouls(t, idx).length < 5;
  });
  if (!list.length) {
    voiceStatus('前のQ（' + qLabel(pq) + '）の出場メンバーが記録されていません');
    return;
  }
  lineupCtx.sel[t] = list.slice(0, 5);
  renderLineup();
});
document.getElementById('lineupOk').addEventListener('click', function () {
  if (!lineupCtx) return;
  if (lineupCtx.sel.A.length !== lineupRequired('A') ||
      lineupCtx.sel.B.length !== lineupRequired('B')) return;
  var q = lineupCtx.q;
  snapshot();
  ['A', 'B'].forEach(function (t) {
    var sel = lineupCtx.sel[t];
    registeredList(t).forEach(function (x) {
      var part = S.participation[t][x.i];
      if (sel.indexOf(x.i) >= 0) {
        if (!part) part = S.participation[t][x.i] = {};
        part[q] = 's';
      } else if (part && part[q] === 's') {
        delete part[q];
      }
      /* 途中出場（'i'）の記録はこの画面では変更しない */
    });
  });
  lineupCtx = null;
  document.getElementById('lineupModal').classList.add('hidden');
  save(); renderRecord(); renderSheet();
});
document.getElementById('lineupCancel').addEventListener('click', function () {
  lineupCtx = null;
  document.getElementById('lineupModal').classList.add('hidden');
});
document.getElementById('btnLineup').addEventListener('click', function () {
  openLineup(S.quarter);
});

/* 記録タブで表示中のチーム（A/B切替式。両チーム分を縦に並べると長すぎるため、
   選択中のチームだけ大きく表示する。切替ボタンには両チームのスコアを出す） */
var recordTeam = 'A';
function recSwitchLabel(t) {
  var team = S.teams[t];
  return 'チーム' + t + '：' + esc(team.name || '（未入力）') + (team.color ? '（' + esc(team.color) + '）' : '') +
    ' <span class="rec-switch-score">' + totalScore(t) + '</span>';
}
function applyRecordTeam() {
  var a = document.getElementById('recTeamA');
  var b = document.getElementById('recTeamB');
  if (a) { a.innerHTML = recSwitchLabel('A'); a.classList.toggle('active', recordTeam === 'A'); }
  if (b) { b.innerHTML = recSwitchLabel('B'); b.classList.toggle('active', recordTeam === 'B'); }
  var pa = document.querySelector('#recordPanels .panel-a');
  var pb = document.querySelector('#recordPanels .panel-b');
  if (pa) pa.classList.toggle('panel-hidden', recordTeam !== 'A');
  if (pb) pb.classList.toggle('panel-hidden', recordTeam !== 'B');
}
function setRecordTeam(t) {
  recordTeam = t;
  setVoiceTeam(t);
  applyRecordTeam();
}
document.getElementById('recTeamA').addEventListener('click', function () { setRecordTeam('A'); });
document.getElementById('recTeamB').addEventListener('click', function () { setRecordTeam('B'); });

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
      return '<span class="chip">' + q + ' 済<b data-act="delto" data-team="' + t + '" data-i="' + i + '">×</b></span>';
    }).join('');
    var registered = registeredList(t);
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
          return '<tr' + (fc >= 5 ? ' class="out"' : (fc === 4 ? ' class="warn4"' : '')) + '>' +
            '<td><button type="button" class="play' + (part ? ' on' : '') + '" data-act="play" data-team="' + t + '" data-idx="' + i + '">' + playLabel + '</button></td>' +
            '<td class="pname"><span class="pno">' + esc(p.no || '―') + '</span> ' + esc(p.name) +
            (playerHasPlayed(t, i) ? '' : ' <span class="notyet">未出場</span>') +
            (fc ? ' <span class="foulcount">F' + fc + (fc >= 5 ? '（退場）' : '') + '</span>' : '') +
            (fc === 4 ? ' <span class="foulwarn">あと1回</span>' : '') + '</td>' +
            '<td>' + ptsBtns + '</td>' +
            '<td><button type="button" class="foul" data-act="foul" data-team="' + t + '" data-idx="' + i + '">F</button></td></tr>';
        }).join('') + '</tbody></table>';
    }
    return '<div class="team-panel panel-' + (t === 'A' ? 'a' : 'b') + '">' +
      '<header><h3>チーム' + t + '：' + esc(team.name || '（未入力）') + (team.color ? '（' + esc(team.color) + '）' : '') + '</h3>' +
      '<span class="score-now">' + totalScore(t) + '</span>' +
      '<span class="panel-btns">' +
      (timeoutTaken(t, q)
        ? '<button type="button" disabled title="このクォーターはすでに取っています">タイムアウト済み</button>'
        : '<button type="button" data-act="to" data-team="' + t + '">タイムアウト</button>') +
      '<button type="button" data-act="foul" data-team="' + t + '" data-who="coach">コーチF</button>' +
      '<button type="button" data-act="foul" data-team="' + t + '" data-who="acoach">AコーチF</button>' +
      '</span></header>' +
      '<div class="to-chips">' + (chips ? 'TO（' + q + '）: ' + chips : '') + '</div>' +
      (participationStatusText(t) ? '<div class="part-status">' + esc(participationStatusText(t)) + '</div>' : '') +
      rows + '</div>';
  }).join('');
  applyRecordTeam();
}

/* ---------- 得点・ファウルの追加（ボタン操作と音声入力で共用） ---------- */
function nextSeq() {
  if (typeof S.seqNext !== 'number' || S.seqNext < 1) S.seqNext = 1;
  return S.seqNext++;
}
/* 5ファウルで退場した選手への記録は公式ルールではあり得ないので確認する
   （警告のみ。訂正などの事情があれば「OK」でそのまま記録できる） */
function confirmOutPlayer(team, idx) {
  if (typeof idx !== 'number') return true;
  if (playerFouls(team, idx).length < 5) return true;
  var p = S.teams[team].players[idx] || {};
  return confirm((p.no ? p.no + '番 ' : '') + (p.name || 'この選手') +
    ' は5ファウルで退場しています。\nこのまま記録しますか？');
}
function addScore(team, idx, pts) {
  if (!confirmOutPlayer(team, idx)) return false;
  snapshot();
  S.events.push({ team: team, idx: idx, no: S.teams[team].players[idx].no, pts: pts, q: S.quarter, seq: nextSeq() });
  // 得点した選手は出場扱い（未設定なら途中出場の ＼）
  var part = S.participation[team][idx] || (S.participation[team][idx] = {});
  if (!part[S.quarter]) part[S.quarter] = 'i';
  save(); renderRecord(); renderSheet();
  return true;
}
function addFoul(team, who, type) {
  if (typeof who === 'number' && !confirmOutPlayer(team, who)) return false;
  snapshot();
  S.fouls.push({ team: team, who: who, type: type, q: S.quarter, seq: nextSeq() });
  if (typeof who === 'number') {
    var part = S.participation[team][who] || (S.participation[team][who] = {});
    if (!part[S.quarter]) part[S.quarter] = 'i';
  }
  save(); renderRecord(); renderSheet();
  return true;
}

document.getElementById('recordPanels').addEventListener('click', function (e) {
  var b = e.target.closest('[data-act]');
  if (!b) return;
  var act = b.dataset.act, t = b.dataset.team, q = S.quarter;
  if (act === 'score') {
    addScore(t, Number(b.dataset.idx), Number(b.dataset.pts));
  } else if (act === 'play') {
    var i2 = Number(b.dataset.idx);
    var curMark = (S.participation[t][i2] || {})[q];
    if (!curMark && !confirmOutPlayer(t, i2)) return;
    snapshot();
    var pr = S.participation[t][i2] || (S.participation[t][i2] = {});
    pr[q] = !pr[q] ? 's' : (pr[q] === 's' ? 'i' : undefined);
    if (!pr[q]) delete pr[q];
    save(); renderRecord(); renderSheet();
  } else if (act === 'foul') {
    foulTarget = { team: t, who: b.dataset.who !== undefined ? b.dataset.who : Number(b.dataset.idx) };
    openFoulModal();
  } else if (act === 'to') {
    addTimeout(t);
  } else if (act === 'delto') {
    snapshot();
    S.timeouts[t][q].splice(Number(b.dataset.i), 1);
    if (S.toSeq && S.toSeq[t] && S.toSeq[t][q]) S.toSeq[t][q].splice(Number(b.dataset.i), 1);
    save(); renderRecord(); renderSheet();
  }
});

/* ---------- ファウルピッカー ---------- */
var foulTarget = null;
var FOUL_TYPES_PLAYER = ['P', 'P1', 'P2', 'P3', 'U', 'U1', 'U2', 'T', 'T1', 'D'];
var FOUL_TYPES_COACH = ['C', 'C1', 'C2', 'B', 'B1', 'B2', 'M', 'M1'];
var FOUL_DESC_PLAYER = 'P＝パーソナル（通常のファウル）／U＝アンスポーツマンライク／T＝テクニカル／D＝ディスクォリファイイング（即退場）です。後ろの数字は、相手チームに与えるフリースローの本数です（数字なしはフリースローなし）。';
var FOUL_DESC_COACH = 'C＝コーチ自身のテクニカルファウル／B＝ベンチメンバーのテクニカルファウル／M＝マンツーマンペナルティ（U12・U15のみ）です。後ろの数字は、相手チームに与えるフリースローの本数です（数字なしはフリースローなし）。';
function openFoulModal() {
  var isCoach = typeof foulTarget.who === 'string';
  document.getElementById('foulModalTitle').textContent =
    'ファウルの種別（チーム' + foulTarget.team + ' / ' + S.quarter + '）';
  document.getElementById('foulDesc').textContent = isCoach ? FOUL_DESC_COACH : FOUL_DESC_PLAYER;
  var types = isCoach ? FOUL_TYPES_COACH : FOUL_TYPES_PLAYER;
  document.getElementById('foulTypeBtns').innerHTML = types.map(function (ty) {
    return '<button type="button" data-type="' + ty + '">' + ty + '</button>';
  }).join('');
  document.getElementById('foulModal').classList.remove('hidden');
}
document.getElementById('foulTypeBtns').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-type]');
  if (!b || !foulTarget) return;
  var target = foulTarget;
  foulTarget = null;
  document.getElementById('foulModal').classList.add('hidden');
  addFoul(target.team, target.who, b.dataset.type);
});
document.getElementById('foulCancel').addEventListener('click', function () {
  foulTarget = null;
  document.getElementById('foulModal').classList.add('hidden');
});

/* ---------- タイムアウト ----------
   ミニバスでは各クォーターに1回まで。時間（経過分）は記録せず、
   取ったかどうかだけを記録する。取ったクォーターではボタンが
   「タイムアウト済み」になって、もう取れない。 */
function timeoutTaken(team, q) {
  return ((S.timeouts[team] || {})[q] || []).length > 0;
}
function addTimeout(team) {
  if (timeoutTaken(team, S.quarter)) return false;
  snapshot();
  var arr = S.timeouts[team][S.quarter] || (S.timeouts[team][S.quarter] = []);
  arr.push(1);
  if (!S.toSeq) S.toSeq = { A: {}, B: {} };
  if (!S.toSeq[team]) S.toSeq[team] = {};
  var sarr = S.toSeq[team][S.quarter] || (S.toSeq[team][S.quarter] = []);
  sarr.push(nextSeq());
  save(); renderRecord(); renderSheet();
  return true;
}

/* ---------- 記録の修正 ----------
   得点・ファウル・タイムアウトを入力順（seq）に1つの一覧で表示し、
   行タップでその記録そのものを直接書き換える画面。
   seq は記録の入力順を示す通し番号で、得点/ファウルは各オブジェクトに、
   タイムアウトは S.toSeq（timeouts と同じ形の並行配列）に保持する。
   旧データ（seq 無し）は ensureSeq() が読み込み時に補完する。 */
function ensureSeq() {
  var changed = false;
  if (!S.toSeq) { S.toSeq = { A: {}, B: {} }; changed = true; }
  ['A', 'B'].forEach(function (t) {
    if (!S.toSeq[t]) { S.toSeq[t] = {}; changed = true; }
    Object.keys(S.timeouts[t] || {}).forEach(function (q) {
      var arr = S.timeouts[t][q] || [];
      var sarr = S.toSeq[t][q] || (S.toSeq[t][q] = []);
      while (sarr.length < arr.length) { sarr.push(null); changed = true; }
      if (sarr.length > arr.length) { sarr.length = arr.length; changed = true; }
    });
  });
  var max = 0;
  function see(v) { if (typeof v === 'number' && v > max) max = v; }
  S.events.forEach(function (e) { see(e.seq); });
  S.fouls.forEach(function (f) { see(f.seq); });
  ['A', 'B'].forEach(function (t) {
    Object.keys(S.toSeq[t]).forEach(function (q) { S.toSeq[t][q].forEach(see); });
  });
  var next = max + 1;
  /* 欠けている seq は、クォーター順 → 得点・ファウル・タイムアウトの順で補完する */
  ['1', '2', '3', '4', 'OT'].forEach(function (q) {
    S.events.forEach(function (e) { if (e.q === q && typeof e.seq !== 'number') { e.seq = next++; changed = true; } });
    S.fouls.forEach(function (f) { if (f.q === q && typeof f.seq !== 'number') { f.seq = next++; changed = true; } });
    ['A', 'B'].forEach(function (t) {
      var sarr = (S.toSeq[t] || {})[q] || [];
      for (var j = 0; j < sarr.length; j++) {
        if (typeof sarr[j] !== 'number') { sarr[j] = next++; changed = true; }
      }
    });
  });
  S.events.forEach(function (e) { if (typeof e.seq !== 'number') { e.seq = next++; changed = true; } });
  S.fouls.forEach(function (f) { if (typeof f.seq !== 'number') { f.seq = next++; changed = true; } });
  if (typeof S.seqNext !== 'number' || S.seqNext < next) { S.seqNext = next; changed = true; }
  if (changed) save();
}

function qLabel(q) { return q === 'OT' ? 'OT' : 'Q' + q; }
function playerLabel(team, idx) {
  var p = S.teams[team].players[idx];
  if (!p) return '#―';
  return '#' + (p.no || '―') + (p.name ? ' ' + p.name : '');
}
/* 修正画面の1行分の説明文（クォーター表記は含まない。行のバッジと削除確認で別途付ける） */
function fixItemText(it) {
  if (it.kind === 'score') {
    var e = S.events[it.i];
    if (!e) return '';
    return teamLabel(e.team) + ' ' + playerLabel(e.team, e.idx) + ' ' + e.pts + '点';
  }
  if (it.kind === 'foul') {
    var f = S.fouls[it.i];
    if (!f) return '';
    var who = typeof f.who === 'number' ? playerLabel(f.team, f.who)
      : (f.who === 'coach' ? 'コーチ' : 'Aコーチ');
    return teamLabel(f.team) + ' ' + who + ' ファウル ' + f.type;
  }
  return teamLabel(it.team) + ' タイムアウト';
}
/* 得点・ファウル・タイムアウトを横断した統合リスト（入力順） */
function fixItems() {
  var items = [];
  S.events.forEach(function (e, i) {
    items.push({ kind: 'score', i: i, team: e.team, q: e.q, ai: -1, seq: e.seq });
  });
  S.fouls.forEach(function (f, i) {
    items.push({ kind: 'foul', i: i, team: f.team, q: f.q, ai: -1, seq: f.seq });
  });
  ['A', 'B'].forEach(function (t) {
    Object.keys(S.timeouts[t] || {}).forEach(function (q) {
      (S.timeouts[t][q] || []).forEach(function (m, j) {
        var s = (S.toSeq && S.toSeq[t] && S.toSeq[t][q]) ? S.toSeq[t][q][j] : null;
        items.push({ kind: 'to', i: -1, team: t, q: q, ai: j, seq: s });
      });
    });
  });
  items.sort(function (a, b) {
    var sa = typeof a.seq === 'number' ? a.seq : Number.MAX_SAFE_INTEGER;
    var sb = typeof b.seq === 'number' ? b.seq : Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });
  return items;
}
function renderFix() {
  var root = document.getElementById('fixList');
  if (!root) return;
  var items = fixItems();
  if (!items.length) {
    root.innerHTML = '<p class="hint">まだ記録がありません。「記録」タブで得点やファウルを入力すると、ここに一覧が出て修正できるようになります。</p>';
    return;
  }
  root.innerHTML = items.map(function (it) {
    var k = qKey(it.q);
    var cls = (k === '1' || k === '3') ? 'qred' : 'qblue';
    return '<button type="button" class="fix-item" data-kind="' + it.kind + '" data-i="' + it.i +
      '" data-team="' + it.team + '" data-q="' + esc(it.q) + '" data-ai="' + it.ai + '">' +
      '<span class="fix-q ' + cls + '">' + qLabel(it.q) + '</span>' +
      '<span class="fix-text">' + esc(fixItemText(it)) + '</span>' +
      '<span class="fix-arrow">›</span></button>';
  }).join('');
}
document.getElementById('fixList').addEventListener('click', function (e) {
  var b = e.target.closest('.fix-item');
  if (!b) return;
  openEdit({
    kind: b.dataset.kind,
    i: Number(b.dataset.i),
    team: b.dataset.team,
    q: b.dataset.q,
    ai: Number(b.dataset.ai)
  });
});

/* ---------- 修正モーダル ---------- */
var editTarget = null;
function quarterOptions(cur) {
  return ['1', '2', '3', '4', 'OT'].map(function (q) {
    return '<option value="' + q + '"' + (String(cur) === q ? ' selected' : '') + '>' + qLabel(q) + '</option>';
  }).join('');
}
function playerOptions(team, curIdx) {
  return S.teams[team].players.map(function (p, i) {
    var label = '#' + (p.no || '―') + ' ' + (p.name || '（未登録）');
    return '<option value="' + i + '"' + (i === curIdx ? ' selected' : '') + '>' + esc(label) + '</option>';
  }).join('');
}
function fillEditFoulTypes(preferred) {
  var whoRaw = document.getElementById('efWho').value;
  var isCoach = (whoRaw === 'coach' || whoRaw === 'acoach');
  var types = isCoach ? FOUL_TYPES_COACH : FOUL_TYPES_PLAYER;
  var sel = document.getElementById('efType');
  var cur = preferred || sel.value;
  /* 選手⇔コーチの切替で種別がその区分に無い場合は、先頭の種別に合わせる */
  if (types.indexOf(cur) < 0) cur = types[0];
  sel.innerHTML = types.map(function (ty) {
    return '<option value="' + ty + '"' + (ty === cur ? ' selected' : '') + '>' + ty + '</option>';
  }).join('');
}
function openEdit(it) {
  /* 対象データが存在しない場合は何もしない */
  if (it.kind === 'score' && !S.events[it.i]) return;
  if (it.kind === 'foul' && !S.fouls[it.i]) return;
  if (it.kind === 'to' && ((S.timeouts[it.team] || {})[it.q] || [])[it.ai] === undefined) return;
  editTarget = it;
  document.getElementById('editDesc').textContent = qLabel(it.q) + ' ' + fixItemText(it);
  var fields = '';
  if (it.kind === 'score') {
    var e = S.events[it.i];
    var ptsOpts = [1, 2, 3].map(function (p) {
      var dis = (p === 3 && !S.game.use3pt && e.pts !== 3) ? ' disabled' : '';
      return '<option value="' + p + '"' + (p === e.pts ? ' selected' : '') + dis + '>' + p + '点</option>';
    }).join('');
    fields =
      '<label class="flabel">選手<select id="efPlayer">' + playerOptions(e.team, e.idx) + '</select></label>' +
      '<label class="flabel">点数<select id="efPts">' + ptsOpts + '</select></label>' +
      '<label class="flabel">クォーター<select id="efQ">' + quarterOptions(e.q) + '</select></label>';
  } else if (it.kind === 'foul') {
    var f = S.fouls[it.i];
    var whoOpts = S.teams[f.team].players.map(function (p, i) {
      var label = '#' + (p.no || '―') + ' ' + (p.name || '（未登録）');
      return '<option value="' + i + '"' + (f.who === i ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('') +
      '<option value="coach"' + (f.who === 'coach' ? ' selected' : '') + '>コーチ</option>' +
      '<option value="acoach"' + (f.who === 'acoach' ? ' selected' : '') + '>Aコーチ</option>';
    fields =
      '<label class="flabel">選手・コーチ<select id="efWho">' + whoOpts + '</select></label>' +
      '<label class="flabel">ファウルの種別<select id="efType"></select></label>' +
      '<label class="flabel">クォーター<select id="efQ">' + quarterOptions(f.q) + '</select></label>';
  } else {
    fields =
      '<p class="hint">タイムアウトは「取ったかどうか」の記録です。ここではクォーターの変更と削除ができます。</p>' +
      '<label class="flabel">クォーター<select id="efQ">' + quarterOptions(it.q) + '</select></label>';
  }
  document.getElementById('editFields').innerHTML = fields;
  if (it.kind === 'foul') {
    fillEditFoulTypes(S.fouls[it.i].type);
    document.getElementById('efWho').addEventListener('change', function () { fillEditFoulTypes(null); });
  }
  document.getElementById('editModal').classList.remove('hidden');
}
function closeEdit() {
  editTarget = null;
  document.getElementById('editModal').classList.add('hidden');
}
function afterEdit() {
  closeEdit();
  save(); renderFix(); renderRecord(); renderSheet();
}
document.getElementById('editSave').addEventListener('click', function () {
  if (!editTarget) return;
  var t = editTarget;
  if (t.kind === 'score') {
    var e = S.events[t.i];
    if (!e) { closeEdit(); return; }
    var idx = Number(document.getElementById('efPlayer').value);
    snapshot();
    e.idx = idx;
    e.no = S.teams[e.team].players[idx].no;
    e.pts = Number(document.getElementById('efPts').value);
    e.q = document.getElementById('efQ').value;
  } else if (t.kind === 'foul') {
    var f = S.fouls[t.i];
    if (!f) { closeEdit(); return; }
    var whoRaw = document.getElementById('efWho').value;
    snapshot();
    f.who = (whoRaw === 'coach' || whoRaw === 'acoach') ? whoRaw : Number(whoRaw);
    f.type = document.getElementById('efType').value;
    f.q = document.getElementById('efQ').value;
  } else {
    var nq = document.getElementById('efQ').value;
    if (nq !== t.q && timeoutTaken(t.team, nq)) {
      alert('そのクォーターは、すでにタイムアウトを取っています。');
      return;
    }
    snapshot();
    if (nq !== t.q) {
      var seq = (S.toSeq[t.team][t.q] || [])[t.ai];
      S.timeouts[t.team][t.q].splice(t.ai, 1);
      if (S.toSeq[t.team][t.q]) S.toSeq[t.team][t.q].splice(t.ai, 1);
      var arr = S.timeouts[t.team][nq] || (S.timeouts[t.team][nq] = []);
      arr.push(1);
      var sarr = S.toSeq[t.team][nq] || (S.toSeq[t.team][nq] = []);
      sarr.push(typeof seq === 'number' ? seq : nextSeq());
    }
  }
  afterEdit();
});
document.getElementById('editDelete').addEventListener('click', function () {
  if (!editTarget) return;
  var t = editTarget;
  var text = qLabel(t.q) + ' ' + fixItemText(t);
  if (!confirm(text + ' を削除しますか？')) return;
  snapshot();
  if (t.kind === 'score') {
    S.events.splice(t.i, 1);
  } else if (t.kind === 'foul') {
    S.fouls.splice(t.i, 1);
  } else {
    S.timeouts[t.team][t.q].splice(t.ai, 1);
    if (S.toSeq[t.team] && S.toSeq[t.team][t.q]) S.toSeq[t.team][t.q].splice(t.ai, 1);
  }
  afterEdit();
});
document.getElementById('editCancel').addEventListener('click', closeEdit);

/* ---------- 公式シート描画（canvas方式） ----------
   JBA公式様式そのものの画像（form_image.js の base64）を全面に描き、
   その上に記録データを「ペイント」するように重ね描きする。
   座標は scoresheet-ref/OVERLAY_SPEC.md の実測値（基準キャンバス 2481x3509 px）。
   検証済み Python レンダラー render_overlay.py の描画挙動を移植したもの。 */
var SHEET_W = 2481, SHEET_H = 3509;
var COL_RED = 'rgb(198,30,30)';    // 第1・第3クォーター
var COL_BLUE = 'rgb(28,38,140)';   // 第2・第4クォーター・延長
var COL_BLACK = 'rgb(20,20,20)';

/* アプリ内のクォーター表記（'OT'）をスペック側（'5'）へ正規化 */
function qKey(q) { return q === 'OT' ? '5' : String(q); }
function qColorCanvas(q) {
  var k = qKey(q);
  return (k === '1' || k === '3') ? COL_RED : COL_BLUE;
}

/* 公式様式画像の読み込み（非同期。読み込み完了後に再描画する） */
var formImg = null, formImgLoaded = false;
(function initFormImage() {
  if (typeof window.FORM_IMAGE_B64 === 'string' && window.FORM_IMAGE_B64) {
    formImg = new Image();
    formImg.onload = function () { formImgLoaded = true; drawSheetCanvas(); };
    formImg.onerror = function () { formImgLoaded = false; drawSheetCanvas(); };
    formImg.src = 'data:image/jpeg;base64,' + window.FORM_IMAGE_B64;
  }
})();

function setFont(ctx, size, bold) {
  ctx.font = (bold ? 'bold ' : '') + size + 'px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
}
function fitSize(ctx, s, baseSize, maxW, bold) {
  var size = baseSize;
  s = String(s);
  while (size > 16) {
    setFont(ctx, size, bold);
    if (ctx.measureText(s).width <= maxW) return size;
    size -= 2;
  }
  return size;
}
function textC(ctx, cx, cy, s, size, color, bold) {
  ctx.fillStyle = color || COL_BLACK;
  setFont(ctx, size, !!bold);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(s), cx, cy);
}
function textL(ctx, x, cy, s, size, color, bold) {
  ctx.fillStyle = color || COL_BLACK;
  setFont(ctx, size, !!bold);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(String(s), x, cy);
}
function textR(ctx, x, cy, s, size, color, bold) {
  ctx.fillStyle = color || COL_BLACK;
  setFont(ctx, size, !!bold);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(String(s), x, cy);
}
function drawLine(ctx, x0, y0, x1, y1, color, w) {
  ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
}
function ellipseOutline(ctx, cx, cy, rx, ry, color, w) {
  ctx.strokeStyle = color; ctx.lineWidth = w;
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
}
function ellipseFill(ctx, cx, cy, rx, ry, color) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
}
/* ライセンス下3桁を1桁ずつ描く（Python版と同じくゼロ埋めして末尾3文字） */
function drawLicense(ctx, license, centersX, cy) {
  var s = String(license == null ? '' : license).replace(/^\s+|\s+$/g, '');
  if (!s) return;
  var digits = ('000' + s).slice(-3);
  for (var k = 0; k < 3; k++) textC(ctx, centersX[k], cy, digits.charAt(k), 30, COL_BLACK);
}

function drawSheetCanvas() {
  var canvas = document.getElementById('sheetCanvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  var scale = canvas.width / SHEET_W;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  /* 以後の座標はすべて 2481x3509 基準で指定する */
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (formImg && formImgLoaded) {
    ctx.drawImage(formImg, 0, 0, SHEET_W, SHEET_H);
  }

  var game = S.game, teams = S.teams, events = S.events;
  var i, t, q, k;

  /* ---------- ヘッダー ---------- */
  if (game.tournament) {
    textL(ctx, 270, 287, game.tournament, fitSize(ctx, game.tournament, 46, 950, true), COL_BLACK, true);
  }
  if (game.date) {
    var dp = String(game.date).split('-');
    if (dp.length === 3) {
      textR(ctx, 1575, 254, String(Number(dp[0])), 38, COL_BLACK);
      textR(ctx, 1692, 254, String(Number(dp[1])), 38, COL_BLACK);
      textR(ctx, 1811, 254, String(Number(dp[2])), 38, COL_BLACK);
    }
  }
  if (game.time) {
    var tp = String(game.time).split(':');
    if (tp.length >= 2) {
      textR(ctx, 2235, 254, tp[0], 38, COL_BLACK);
      textL(ctx, 2271, 254, tp[1], 38, COL_BLACK);
    }
  }
  if (game.venue) {
    textL(ctx, 1420, 320, game.venue, fitSize(ctx, game.venue, 38, 520, false), COL_BLACK);
  }
  if (game.gameNo) {
    textC(ctx, 2252, 320, game.gameNo, 44, COL_BLACK, true);
  }
  var officials = [
    [game.crewChief, 1548, 414], [game.umpire, 2124, 414],
    [game.scorer, 1548, 518], [game.timer, 2124, 518],
    [game.aScorer, 1548, 622], [game.shotClock, 2124, 622]
  ];
  officials.forEach(function (o) {
    if (o[0]) textC(ctx, o[1], o[2], o[0], fitSize(ctx, o[0], 40, 480, false), COL_BLACK);
  });

  /* ---------- スコア（ヘッダー部） ---------- */
  var totals = { A: 0, B: 0 };
  var qpts = {};
  events.forEach(function (e) {
    totals[e.team] += e.pts;
    var key = e.team + '|' + qKey(e.q);
    qpts[key] = (qpts[key] || 0) + e.pts;
  });
  var dashY = { '1': 429, '2': 481, '3': 533, '4': 585, '5': 637 };
  ['1', '2', '3', '4', '5'].forEach(function (qq) {
    var a = qpts['A|' + qq] || 0;
    var b = qpts['B|' + qq] || 0;
    if (a === 0 && b === 0 && qq === '5') return;
    if (a) textR(ctx, 722, dashY[qq], String(a), 44, qColorCanvas(qq), true);
    if (b) textL(ctx, 774, dashY[qq], String(b), 44, qColorCanvas(qq), true);
  });
  textC(ctx, 377, 534, String(totals.A), 96, COL_BLACK, true);
  textC(ctx, 1119, 534, String(totals.B), 96, COL_BLACK, true);

  /* ---------- チームブロック ---------- */
  var headCY = { A: 838, B: 2193 };
  var rowTop0 = { A: 1024, B: 2379 };
  var coachTop = { A: 1907, B: 3262 };
  var acoachTop = { A: 1966, B: 3321 };
  var partX = [747, 804, 861, 918, 975];
  var foulX = [975, 1032, 1089, 1146, 1203, 1260];
  var licCX = [148, 205, 262];
  var toCols = [946, 1003, 1060, 1117, 1174];
  var toColIdx = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 };

  ['A', 'B'].forEach(function (tt) {
    var team = teams[tt];
    if (team.name) {
      textL(ctx, 235, headCY[tt], team.name, fitSize(ctx, team.name, 46, 540, true), COL_BLACK, true);
    }
    /* タイムアウト（取得済みなら○印） */
    var tos = S.timeouts[tt] || {};
    Object.keys(tos).forEach(function (qq0) {
      var col = toColIdx[qKey(qq0)];
      if (col === undefined) return;
      if (!(tos[qq0] || []).length) return;
      ellipseOutline(ctx, toCols[col], headCY[tt] + 38, 21, 21, COL_BLACK, 5);
    });
    /* 選手別ファウル（時系列順） */
    var pfouls = {};
    S.fouls.forEach(function (f) {
      if (f.team === tt) {
        (pfouls[f.who] || (pfouls[f.who] = [])).push(f);
      }
    });
    var part = S.participation[tt] || {};
    team.players.forEach(function (p, idx) {
      var top = rowTop0[tt] + idx * 59;
      var cy = top + 29;
      drawLicense(ctx, p.license, licCX, cy);
      if (p.name) {
        textL(ctx, 302, cy, p.name, fitSize(ctx, p.name, 34, 378, false), COL_BLACK);
      }
      if (p.no) {
        textC(ctx, 718, cy, p.no, 38, COL_BLACK, true);
      }
      var marks = part[idx] || part[String(idx)] || {};
      Object.keys(marks).forEach(function (qq0) {
        var kk = qKey(qq0);
        if (['1', '2', '3', '4'].indexOf(kk) < 0) return;
        var x0 = partX[Number(kk) - 1];
        var x1 = x0 + 57;
        var col = qColorCanvas(qq0);
        if (marks[qq0] === 's') {
          drawLine(ctx, x0 + 9, top + 50, x1 - 9, top + 9, col, 5);
        } else {
          drawLine(ctx, x0 + 9, top + 9, x1 - 9, top + 50, col, 5);
        }
      });
      var flist = (pfouls[idx] || []).slice(0, 5);
      flist.forEach(function (f, j) {
        var cx = Math.floor((foulX[j] + foulX[j + 1]) / 2);
        textC(ctx, cx, cy, f.type, fitSize(ctx, f.type, 28, 50, true), qColorCanvas(f.q), true);
      });
    });
    /* コーチ・Aコーチ（ライセンス欄は氏名欄の左 291-462、氏名は x=472 から） */
    [[team.coach, coachTop[tt]], [team.acoach, acoachTop[tt]]].forEach(function (ct) {
      var person = ct[0];
      var cy2 = ct[1] + 29;
      drawLicense(ctx, person.license, [320, 377, 434], cy2);
      if (person.name) {
        textL(ctx, 472, cy2, person.name, fitSize(ctx, person.name, 34, 208, false), COL_BLACK);
      }
    });
  });
  /* Bチームのユニフォーム色（Aの「（白）」は印刷済み。Bは括弧内が空白のため描く） */
  if (teams.B.color) {
    textC(ctx, 881, 2172, teams.B.color, 44, COL_BLACK);
  }

  /* ---------- チームファウル（×印） ---------- */
  var tfBoxes = {
    A: { '1': [1356, 1141], '2': [1420, 1141], '3': [1356, 1494], '4': [1420, 1494] },
    B: { '1': [1356, 2496], '2': [1420, 2496], '3': [1356, 2849], '4': [1420, 2849] }
  };
  ['A', 'B'].forEach(function (tt) {
    var counts = {};
    S.fouls.forEach(function (f) {
      if (f.team === tt) {
        var kk = qKey(f.q);
        counts[kk] = (counts[kk] || 0) + 1;
      }
    });
    Object.keys(counts).forEach(function (qq) {
      var box = tfBoxes[tt][qq];
      if (!box) return;
      var cx = box[0], top0 = box[1];
      var n = Math.min(counts[qq], 4);
      for (var kk2 = 0; kk2 < n; kk2++) {
        var top = top0 + kk2 * 59;
        var col = qColorCanvas(qq);
        drawLine(ctx, cx - 16, top + 10, cx + 16, top + 49, col, 5);
        drawLine(ctx, cx - 16, top + 49, cx + 16, top + 10, col, 5);
      }
    });
  });

  /* ---------- ランニングスコア ---------- */
  var lastOfQuarter = {};
  var lastEventIdx = {};
  events.forEach(function (e, idx) {
    lastOfQuarter[e.team + '|' + qKey(e.q)] = idx;
    lastEventIdx[e.team] = idx;
  });
  var runTot = { A: 0, B: 0 };
  var groupBase = [1516, 1836, 2156];
  events.forEach(function (e, idx) {
    var tt = e.team;
    runTot[tt] += e.pts;
    var tot = runTot[tt];
    var g = Math.floor((tot - 1) / 40);
    var r = (tot - 1) % 40;
    var base = groupBase[g];
    if (base === undefined) return; /* 120点超は様式に欄なし */
    var top = 847 + r * 59;
    var cy = top + 29;
    var sx, nx;
    if (tt === 'A') { sx = base; nx = base + 64; }
    else { nx = base + 128; sx = base + 192; }
    var col = qColorCanvas(e.q);
    if (e.no) {
      textC(ctx, sx + 32, cy, e.no, 28, col, true);
    }
    if (e.pts === 3 && game.use3pt) {
      ellipseOutline(ctx, sx + 32, top + 29.5, 28, 25.5, col, 4);
    }
    if (e.pts === 1) {
      ellipseFill(ctx, nx + 32, cy, 16, 16, col);
    } else {
      drawLine(ctx, nx + 5, top + 54, nx + 59, top + 5, col, 6);
    }
    var isQEnd = lastOfQuarter[tt + '|' + qKey(e.q)] === idx;
    var isFinal = !!game.finished && lastEventIdx[tt] === idx;
    if (isQEnd || isFinal) {
      ellipseOutline(ctx, nx + 32, top + 29.5, 30, 27.5, col, isFinal ? 8 : 5);
      var xLo = Math.min(sx, nx), xHi = Math.max(sx, nx) + 64;
      drawLine(ctx, xLo, top + 56, xHi, top + 56, col, 7);
      if (isFinal) {
        drawLine(ctx, xLo, top + 48, xHi, top + 48, col, 6);
      }
    }
  });

  /* ---------- 締めの線（試合終了時のみ。公式記入例の conventions） ---------- */
  if (game.finished) {
    ['A', 'B'].forEach(function (tt) {
      var team = teams[tt];
      var rosterSize = team.players.length;
      /* 登録済み選手数 = 名前か背番号のある最後の行 + 1（データ上は15枠ある） */
      var nReg = 0;
      team.players.forEach(function (p, idx) {
        var hasName = String(p.name || '').replace(/^\s+|\s+$/g, '') !== '';
        var hasNo = String(p.no == null ? '' : p.no).replace(/^\s+|\s+$/g, '') !== '';
        if (hasName || hasNo) nReg = idx + 1;
      });
      var pfoulsC = {};
      S.fouls.forEach(function (f) {
        if (f.team === tt) {
          (pfoulsC[f.who] || (pfoulsC[f.who] = [])).push(f);
        }
      });
      /* 1. 名簿の締め: 最終登録選手行の直下に太い横線（表の全幅） */
      if (nReg > 0 && nReg < rosterSize) {
        var yReg = rowTop0[tt] + nReg * 59;
        drawLine(ctx, 119, yReg, 1260, yReg, COL_BLACK, 6);
      }
      /* 2. 選手ファウル欄: 記録済みファウルの次のセルから右端まで横線 */
      for (var ii = 0; ii < nReg; ii++) {
        var cntF = Math.min((pfoulsC[ii] || []).length, 5);
        if (cntF < 5) {
          var cyF = rowTop0[tt] + ii * 59 + 29;
          drawLine(ctx, foulX[cntF] + 4, cyF, 1256, cyF, COL_BLACK, 5);
        }
      }
      /* 3. 未登録行のファウル欄: 全体に斜線1本 */
      if (nReg > 0 && nReg < rosterSize) {
        var uy0 = rowTop0[tt] + nReg * 59;
        var uy1 = rowTop0[tt] + rosterSize * 59;
        drawLine(ctx, foulX[0] + 4, uy1 - 4, foulX[5] - 4, uy0 + 4, COL_BLACK, 5);
      }
      /* 8. 未出場の選手の斜線: 登録済みで出場記録が1つもない選手が表の下端に
         2人以上続く場合、その範囲のファウル欄に斜線1本（実物の締め方）。
         1人だけの場合は引かない（項目2の横線のみ） */
      var partBlk = S.participation[tt] || {};
      var bBlk = nReg - 1;
      while (bBlk >= 0) {
        var ppBlk = partBlk[bBlk];
        if (ppBlk && Object.keys(ppBlk).length > 0) break;
        bBlk--;
      }
      if (nReg - 1 - bBlk >= 2) {
        var y0Blk = rowTop0[tt] + (bBlk + 1) * 59;
        var y1Blk = rowTop0[tt] + nReg * 59;
        drawLine(ctx, 947, y0Blk + 2, 1260, y1Blk - 2, COL_BLACK, 5);
        /* あわせてブロック先頭行の出場時限セル（①〜④）の中央に横線1本。
           2行目以降には引かない（実物の締め方、写真2枚目で確認） */
        drawLine(ctx, 749, y0Blk + 29, 973, y0Blk + 29, COL_BLACK, 5);
      }
      /* 4. コーチ・Aコーチ行のファウル欄: 全セルに横線 */
      [coachTop[tt], acoachTop[tt]].forEach(function (topC) {
        drawLine(ctx, foulX[0] + 4, topC + 29, 1256, topC + 29, COL_BLACK, 5);
      });
      /* 5. タイムアウト: 使わなかった枠に横線2本（そのQの色） */
      var tosC = S.timeouts[tt] || {};
      var usedTo = {};
      Object.keys(tosC).forEach(function (qq0) {
        if ((tosC[qq0] || []).length) usedTo[qKey(qq0)] = true;
      });
      ['1', '2', '3', '4', '5'].forEach(function (qq, qi) {
        if (usedTo[qq]) return;
        var cxT = toCols[qi];
        var cyT = headCY[tt] + 38;
        var colT = qColorCanvas(qq);
        drawLine(ctx, cxT - 22, cyT - 9, cxT + 22, cyT - 9, colT, 4);
        drawLine(ctx, cxT - 22, cyT + 9, cxT + 22, cyT + 9, colT, 4);
      });
      /* 6. チームファウル: 使わなかった数字の枠に縦線2本（そのQの色。コーチファウルも件数に含む） */
      var tfCounts = {};
      S.fouls.forEach(function (f) {
        if (f.team === tt) {
          var kk3 = qKey(f.q);
          tfCounts[kk3] = (tfCounts[kk3] || 0) + 1;
        }
      });
      ['1', '2', '3', '4'].forEach(function (qq) {
        var box = tfBoxes[tt][qq];
        var usedN = Math.min(tfCounts[qq] || 0, 4);
        for (var k3 = usedN; k3 < 4; k3++) {
          var topF = box[1] + k3 * 59;
          var colF = qColorCanvas(qq);
          drawLine(ctx, box[0] - 8, topF + 8, box[0] - 8, topF + 51, colF, 4);
          drawLine(ctx, box[0] + 8, topF + 8, box[0] + 8, topF + 51, colF, 4);
        }
      });
    });
    /* 7. ランニングスコア: チームごとに、最終得点のあるグループで、最終得点の直下から
       そのチームの2セル幅を通ってグループ下端まで斜線1本（実物の締め方） */
    ['A', 'B'].forEach(function (tt) {
      var tot = totals[tt];
      if (tot <= 0 || tot > 120) return;
      var gT = Math.floor((tot - 1) / 40);
      var rT = (tot - 1) % 40;
      if (rT >= 39) return;
      var baseT = groupBase[gT];
      var x0T = tt === 'A' ? baseT : baseT + 128;
      var x1T = tt === 'A' ? baseT + 128 : baseT + 256;
      var y0T = 847 + (rT + 1) * 59;
      drawLine(ctx, x0T + 2, y0T + 2, x1T - 2, 3205, COL_BLACK, 5);
    });
  }

  /* ---------- 勝利チーム・終了時間 ---------- */
  if (game.finished) {
    var winner = totals.A > totals.B ? teams.A.name : teams.B.name;
    if (winner) {
      textL(ctx, 1790, 3291, winner, fitSize(ctx, winner, 42, 600, true), COL_BLACK, true);
    }
  }
  if (game.endTime) {
    textL(ctx, 1790, 3350, game.endTime, 42, COL_BLACK);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);

  /* タブレット幅では記録タブの横に公式シートを同時表示する（プレビュー用canvasへ複写） */
  var pv = document.getElementById('sheetPreview');
  if (pv) {
    var pctx = pv.getContext('2d');
    if (pctx) { pctx.setTransform(1, 0, 0, 1, 0, 0); pctx.drawImage(canvas, 0, 0); }
  }
}

function renderSheet() {
  drawSheetCanvas();
}

/* ---------- 印刷 ----------
   印刷専用ビュー（#printRoot の img）に canvas の画像を A4 いっぱいに
   配置してから、既存の AndroidPrint ブリッジ（なければブラウザ印刷）を呼ぶ。 */
function doPrint() {
  drawSheetCanvas();
  var canvas = document.getElementById('sheetCanvas');
  var img = document.getElementById('printImg');
  function go() {
    if (window.AndroidPrint && typeof window.AndroidPrint.printSheet === 'function') {
      window.AndroidPrint.printSheet();
    } else {
      window.print();
    }
  }
  if (!canvas || !img) { go(); return; }
  var url;
  try { url = canvas.toDataURL('image/png'); } catch (e) { go(); return; }
  if (img.getAttribute('src') === url) { go(); return; }
  var called = false;
  var timer = setTimeout(function () {
    if (!called) { called = true; go(); }
  }, 800);
  img.onload = function () {
    if (!called) { called = true; clearTimeout(timer); go(); }
  };
  img.src = url;
}

/* ---------- ファイル保存の共通処理 ----------
   Android アプリ内では保存ブリッジ（window.AndroidSave.saveFile）に
   base64 で渡し、SAF（ACTION_CREATE_DOCUMENT）で端末へ保存する。
   ブリッジが無い環境（PC ブラウザ等）では Blob + ダウンロードリンク。 */
function androidSaveAvailable() {
  return !!(window.AndroidSave && typeof window.AndroidSave.saveFile === 'function');
}
function blobToBase64(blob, cb) {
  var reader = new FileReader();
  reader.onload = function () {
    var s = String(reader.result || '');
    var i = s.indexOf(',');
    cb(i >= 0 ? s.slice(i + 1) : s);
  };
  reader.onerror = function () { cb(null); };
  reader.readAsDataURL(blob);
}
/* blob をファイルとして保存する（ブリッジ優先、無ければダウンロード） */
function saveBlobAsFile(blob, fileName, mimeType, onError) {
  if (androidSaveAvailable()) {
    blobToBase64(blob, function (b64) {
      if (b64) {
        window.AndroidSave.saveFile(b64, fileName, mimeType);
      } else if (onError) {
        onError();
      }
    });
    return;
  }
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  if (a.parentNode) a.parentNode.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}
/* ファイル名に使えない文字を取り除く */
function sanitizeFileName(name) {
  return String(name).replace(/[\\\/:*?"<>|]/g, '').replace(/[\u0000-\u001f]/g, '').trim();
}

/* ---------- 画像として保存 ----------
   Android アプリ内では保存ブリッジ経由で端末に保存する。
   ブリッジが無い環境では canvas.toBlob → ダウンロードリンク方式。
   WebView 環境でダウンロードが効かない場合は印刷にフォールバックする。 */
function saveSheetImage() {
  drawSheetCanvas();
  var canvas = document.getElementById('sheetCanvas');
  if (!canvas) return;
  function download(href) {
    var a = document.createElement('a');
    a.href = href;
    a.download = 'scoresheet.png';
    document.body.appendChild(a);
    a.click();
    if (a.parentNode) a.parentNode.removeChild(a);
  }
  if (typeof canvas.toBlob === 'function') {
    canvas.toBlob(function (blob) {
      if (!blob) {
        try { download(canvas.toDataURL('image/png')); } catch (e) { doPrint(); }
        return;
      }
      if (androidSaveAvailable()) {
        saveBlobAsFile(blob, 'scoresheet.png', 'image/png', doPrint);
        return;
      }
      var url = URL.createObjectURL(blob);
      download(url);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }, 'image/png');
  } else {
    try { download(canvas.toDataURL('image/png')); } catch (e) { doPrint(); }
  }
}

/* ---------- PDFで保存 ----------
   シート canvas の JPEG を、外部ライブラリなしの最小構成 PDF
   （A4 1ページ、画像を全面配置）に包んで保存する。 */
function sheetPdfFileName() {
  var d = (S && S.game) ? String(S.game.date || '') : '';
  var name = d ? 'スコアシート_' + d + '.pdf' : 'スコアシート.pdf';
  return sanitizeFileName(name) || 'スコアシート.pdf';
}

/* JPEG バイト列から A4 1ページの PDF（Uint8Array）を組み立てる */
function buildSheetPdf(jpegBytes, imgW, imgH) {
  var PAGE_W = 595.28, PAGE_H = 841.89;
  var enc = new TextEncoder();
  var parts = [];
  var offsets = [];
  var pos = 0;
  function pushStr(s) { var b = enc.encode(s); parts.push(b); pos += b.length; }
  function pushBytes(b) { parts.push(b); pos += b.length; }
  function beginObj(n) { offsets[n] = pos; pushStr(n + ' 0 obj\n'); }

  pushStr('%PDF-1.4\n');
  beginObj(1);
  pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObj(2);
  pushStr('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  beginObj(3);
  pushStr('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] ' +
    '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n');
  var content = 'q\n' + PAGE_W + ' 0 0 ' + PAGE_H + ' 0 0 cm\n/Im0 Do\nQ\n';
  beginObj(4);
  pushStr('<< /Length ' + enc.encode(content).length + ' >>\nstream\n');
  pushStr(content);
  pushStr('endstream\nendobj\n');
  beginObj(5);
  pushStr('<< /Type /XObject /Subtype /Image /Width ' + imgW + ' /Height ' + imgH +
    ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
    jpegBytes.length + ' >>\nstream\n');
  pushBytes(jpegBytes);
  pushStr('\nendstream\nendobj\n');
  var xrefPos = pos;
  var size = 6;
  var xref = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
  for (var i = 1; i < size; i++) {
    var off = String(offsets[i]);
    while (off.length < 10) off = '0' + off;
    xref += off + ' 00000 n \n';
  }
  pushStr(xref);
  pushStr('trailer\n<< /Size ' + size + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');
  var total = 0, j;
  for (j = 0; j < parts.length; j++) total += parts[j].length;
  var out = new Uint8Array(total);
  var p = 0;
  for (j = 0; j < parts.length; j++) { out.set(parts[j], p); p += parts[j].length; }
  return out;
}

function saveSheetPdf() {
  drawSheetCanvas();
  var canvas = document.getElementById('sheetCanvas');
  if (!canvas) return;
  var fileName = sheetPdfFileName();
  function handleJpegBytes(bytes) {
    if (!bytes) { alert('PDFの作成に失敗しました。'); return; }
    var pdf = buildSheetPdf(bytes, canvas.width, canvas.height);
    var blob = new Blob([pdf], { type: 'application/pdf' });
    saveBlobAsFile(blob, fileName, 'application/pdf', function () {
      alert('PDFの保存に失敗しました。');
    });
  }
  function fallbackDataUrl() {
    try {
      var url = canvas.toDataURL('image/jpeg', 0.92);
      var b64 = url.slice(url.indexOf(',') + 1);
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      handleJpegBytes(bytes);
    } catch (e) {
      alert('PDFの作成に失敗しました。');
    }
  }
  if (typeof canvas.toBlob === 'function') {
    canvas.toBlob(function (blob) {
      if (!blob) { fallbackDataUrl(); return; }
      if (typeof blob.arrayBuffer === 'function') {
        blob.arrayBuffer().then(function (buf) {
          handleJpegBytes(new Uint8Array(buf));
        }, fallbackDataUrl);
      } else {
        var r = new FileReader();
        r.onload = function () { handleJpegBytes(new Uint8Array(r.result)); };
        r.onerror = fallbackDataUrl;
        r.readAsArrayBuffer(blob);
      }
    }, 'image/jpeg', 0.92);
  } else {
    fallbackDataUrl();
  }
}
document.getElementById('btnSaveImage').addEventListener('click', saveSheetImage);
document.getElementById('btnSavePdf').addEventListener('click', saveSheetPdf);

/* 公式シートプレビューの拡大・縮小（スマホでは全体表示だと文字が読めないため。
   表示だけの拡大で、保存される画像・PDFには影響しない）
   「全体を表示」は、シート全体が枠（.sheet-scroll）の中に一度に収まる大きさにする */
var sheetZoom = 1;
var sheetFit = false;
function applySheetZoom() {
  var c = document.getElementById('sheetCanvas');
  var l = document.getElementById('zoomLabel');
  if (sheetFit) {
    var sc = c ? c.parentElement : null;
    if (c && sc) {
      /* 枠の内側（パディング20pxを除く）に、縦横ともはみ出さない大きさにする。
         細長い枠では横幅が、横広い枠では高さが上限になる */
      var availW = Math.max(100, sc.clientWidth - 20);
      var availH = Math.max(100, sc.clientHeight - 20);
      var w = Math.min(availW, availH * (c.width / c.height));
      c.style.width = Math.floor(w) + 'px';
      c.style.height = 'auto';
      c.style.margin = '0 auto';
    }
    if (l) l.textContent = '全体';
    return;
  }
  if (c) {
    c.style.height = '';
    c.style.margin = '';
    c.style.width = (sheetZoom * 100) + '%';
  }
  if (l) l.textContent = Math.round(sheetZoom * 100) + '%';
}
document.getElementById('btnZoomIn').addEventListener('click', function () {
  if (sheetFit) { sheetFit = false; sheetZoom = 1; }
  sheetZoom = Math.min(3, sheetZoom + 0.5); applySheetZoom();
});
document.getElementById('btnZoomOut').addEventListener('click', function () {
  if (sheetFit) { sheetFit = false; sheetZoom = 1; }
  sheetZoom = Math.max(1, sheetZoom - 0.5); applySheetZoom();
});
document.getElementById('btnZoomFit').addEventListener('click', function () {
  sheetFit = true; applySheetZoom();
});
window.addEventListener('resize', function () { if (sheetFit) applySheetZoom(); });
document.getElementById('btnUndo').addEventListener('click', undo);
/* ---------- れんしゅうモード ----------
   本番データ（STORE_KEY）とは別の保存先を使い、架空のサンプル試合で
   自由に練習できる。子どもや初めてのTOが本番前に触るためのモード。 */
function practiceSeed() {
  var s = JSON.parse('{"game":{"tournament":"れんしゅうカップ","date":"","time":"","venue":"みどり小学校","gameNo":"","endTime":"","crewChief":"","umpire":"","scorer":"","timer":"","aScorer":"","shotClock":"","use3pt":false,"finished":false},"teams":{"A":{"name":"さくらミニバス","color":"白","coach":{"name":"佐々木 健","license":"047"},"acoach":{"name":"中村 翔","license":"059"},"players":[{"no":"4","name":"佐藤さくら","license":"101"},{"no":"5","name":"鈴木あおい","license":"102"},{"no":"6","name":"高橋ゆい","license":"103"},{"no":"7","name":"田中りん","license":"104"},{"no":"8","name":"伊藤めい","license":"105"},{"no":"9","name":"渡辺ほのか","license":"106"},{"no":"10","name":"山本ことね","license":"107"},{"no":"11","name":"中村すず","license":"108"},{"no":"12","name":"小林はな","license":"109"},{"no":"13","name":"加藤ゆず","license":"110"},{"no":"","name":"","license":""},{"no":"","name":"","license":""},{"no":"","name":"","license":""},{"no":"","name":"","license":""},{"no":"","name":"","license":""}]},"B":{"name":"ひまわりミニバス","color":"青","coach":{"name":"高田 修","license":"078"},"acoach":{"name":"青木 翔","license":"082"},"players":[{"no":"4","name":"山田みく","license":"201"},{"no":"5","name":"佐々木れな","license":"202"},{"no":"6","name":"井上かえで","license":"203"},{"no":"7","name":"山口つむぎ","license":"204"},{"no":"8","name":"松本しおり","license":"205"},{"no":"9","name":"木村のぞみ","license":"206"},{"no":"10","name":"林あかり","license":"207"},{"no":"11","name":"清水まお","license":"208"},{"no":"12","name":"森ことり","license":"209"},{"no":"13","name":"石川るな","license":"210"},{"no":"","name":"","license":""},{"no":"","name":"","license":""},{"no":"","name":"","license":""},{"no":"","name":"","license":""},{"no":"","name":"","license":""}]}},"quarter":"1","events":[],"fouls":[],"participation":{"A":{},"B":{}},"timeouts":{"A":{},"B":{}},"toSeq":{"A":{},"B":{}},"seqNext":1,"history":[]}');
  var d = new Date();
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  s.game.date = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  return s;
}
function refreshAll() {
  bindInfo(); renderRoster(); renderRecord(); renderSheet(); renderFix(); renderArchive(); updatePracticeUI();
}
function updatePracticeUI() {
  var p = isPractice();
  var banner = document.getElementById('practiceBanner');
  if (banner) banner.style.display = p ? 'flex' : 'none';
  var sec = document.getElementById('practiceSection');
  if (sec) sec.style.display = p ? 'none' : '';
}
function stateHasPlayers(st) {
  if (!st || !st.teams) return false;
  return ['A', 'B'].some(function (t) {
    return (st.teams[t].players || []).some(function (p) {
      return ((p.no || '') + '').trim() || ((p.name || '') + '').trim();
    });
  });
}
function enterPractice() {
  try { localStorage.setItem(MODE_KEY, 'practice'); } catch (e) {}
  var st = loadFrom(PRACTICE_KEY);
  /* 練習データが空（選手が一人もいない）ときは、見本の選手で入れ直す。
     「新しい試合」で空の状態が保存されてしまっても、入り直せば復活する */
  if (!st || (!stateHasPlayers(st) && !(st.events || []).length)) st = practiceSeed();
  S = st;
  save(); refreshAll();
  /* 練習モードの知らせは緑の帯（practiceBanner）で常時分かるので、
     黄色い音声ステータス欄には残さない（帯の二重表示を避ける） */
  voiceStatus('');
}
function exitPractice() {
  try { localStorage.removeItem(MODE_KEY); } catch (e) {}
  S = loadFrom(STORE_KEY) || defaultState();
  refreshAll();
  voiceStatus('');
}
document.getElementById('btnPractice').addEventListener('click', enterPractice);
document.getElementById('btnExitPractice').addEventListener('click', exitPractice);

/* ---------- 過去の試合（アーカイブ） ----------
   「新しい試合」を始めるとき、入力済みの試合を自動でここに残す。
   PDF保存を忘れても記録が消えないようにするため。最大20試合。 */
function gameHasContent(s) {
  return !!(s.events.length || s.fouls.length || s.teams.A.name || s.teams.B.name || s.game.tournament);
}
function loadArchive() {
  try {
    var a = JSON.parse(localStorage.getItem(archiveKey()) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function saveArchive(a) {
  try { localStorage.setItem(archiveKey(), JSON.stringify(a)); } catch (e) {}
}
function archiveCurrent() {
  if (!gameHasContent(S)) return;
  var a = loadArchive();
  a.unshift({ savedAt: new Date().toISOString(), state: JSON.parse(JSON.stringify(S)) });
  if (a.length > 20) a = a.slice(0, 20);
  saveArchive(a);
}
function scoreOfState(st, t) {
  return st.events.filter(function (ev) { return ev.team === t; })
    .reduce(function (sum, ev) { return sum + ev.pts; }, 0);
}
function renderArchive() {
  var root = document.getElementById('archiveList');
  if (!root) return;
  var a = loadArchive();
  if (!a.length) {
    root.innerHTML = '<p class="hint">保存された試合はまだありません。「新しい試合」を始めると、入力済みの試合は自動でここに保存されます。</p>';
    return;
  }
  root.innerHTML = a.map(function (item, i) {
    var st = item.state;
    var title = (st.game.date || '') + ' ' + (st.game.tournament || '（大会名なし）');
    var vs = (st.teams.A.name || 'チームA') + ' ' + scoreOfState(st, 'A') + ' - ' + scoreOfState(st, 'B') + ' ' + (st.teams.B.name || 'チームB');
    return '<div class="archive-item"><div class="archive-main">' + esc(title) + '<br>' + esc(vs) + '</div>' +
      '<div class="archive-btns"><button type="button" data-arch-open="' + i + '">開く</button>' +
      '<button type="button" data-arch-del="' + i + '">削除</button></div></div>';
  }).join('');
}
document.getElementById('archiveList').addEventListener('click', function (e) {
  var openBtn = e.target.closest('[data-arch-open]');
  var delBtn = e.target.closest('[data-arch-del]');
  var a = loadArchive();
  if (delBtn) {
    var di = Number(delBtn.dataset.archDel);
    if (!confirm('この保存済みの試合を削除しますか？')) return;
    a.splice(di, 1); saveArchive(a); renderArchive();
    return;
  }
  if (openBtn) {
    var oi = Number(openBtn.dataset.archOpen);
    if (!a[oi]) return;
    if (!confirm('この試合を開きますか？\n今入力中の試合は「過去の試合」に自動で保存されます。')) return;
    var target = a[oi].state;
    a.splice(oi, 1); saveArchive(a);
    archiveCurrent();
    S = normalizeTimeouts(target);
    save(); refreshAll();
    alert('保存した試合を開きました。');
  }
});

document.getElementById('btnNewGame').addEventListener('click', function () {
  if (!confirm('新しい試合を始めますか？\n入力済みの試合は「過去の試合」に自動で保存されます。')) return;
  archiveCurrent();
  /* 練習モードの「新しい試合」は、空ではなく見本の試合（選手入り）から始める */
  S = isPractice() ? practiceSeed() : defaultState();
  save(); bindInfo(); renderRoster(); renderRecord(); renderSheet(); renderFix(); renderArchive();
  alert('新しい試合の入力を始められます。');
});

/* ---------- データのバックアップ ----------
   進行中の試合・過去の試合・れんしゅうモードのデータを、localStorage の
   キーごと1つの JSON ファイルに書き出す。復元は AndroidBackup ブリッジ
   （ファイル選択）または file 入力から受け取り、検証してから書き戻す。 */
var BACKUP_KEYS = [STORE_KEY, PRACTICE_KEY, ARCHIVE_KEY, PRACTICE_ARCHIVE_KEY, MODE_KEY];
function backupStamp() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}
function exportBackup() {
  var data = {};
  BACKUP_KEYS.forEach(function (k) {
    try { var v = localStorage.getItem(k); if (v != null) data[k] = v; } catch (e) {}
  });
  var payload = {
    app: 'minibas-scoresheet', kind: 'backup', version: 1,
    exportedAt: new Date().toISOString(), data: data
  };
  var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  saveBlobAsFile(blob, 'minibas-scoresheet-backup-' + backupStamp() + '.json', 'application/json', function () {
    alert('バックアップの書き出しに失敗しました。');
  });
}
function backupSummary(payload) {
  var lines = [];
  try {
    var st = payload.data[STORE_KEY] ? JSON.parse(payload.data[STORE_KEY]) : null;
    if (st && st.teams) {
      lines.push('本番の試合：' + (st.teams.A.name || 'チームA') + ' 対 ' + (st.teams.B.name || 'チームB'));
    }
    var arc = payload.data[ARCHIVE_KEY] ? JSON.parse(payload.data[ARCHIVE_KEY]) : [];
    lines.push('過去の試合：' + (Array.isArray(arc) ? arc.length : 0) + '件');
    var d = new Date(payload.exportedAt);
    if (!isNaN(d.getTime())) lines.push('書き出した日時：' + d.toLocaleString('ja-JP'));
  } catch (e) {}
  return lines.join('\n');
}
function handleBackupText(text) {
  var payload = null;
  try { payload = JSON.parse(text); } catch (e) {}
  if (!payload || payload.app !== 'minibas-scoresheet' || payload.kind !== 'backup' || !payload.data) {
    alert('このファイルは、このアプリのバックアップではないようです。');
    return;
  }
  var msg = 'このバックアップで、今のデータを上書きして戻しますか？\n\n' +
    backupSummary(payload) + '\n\n※今のデータは上書きされます。';
  if (!confirm(msg)) return;
  BACKUP_KEYS.forEach(function (k) {
    try {
      if (typeof payload.data[k] === 'string') localStorage.setItem(k, payload.data[k]);
      else localStorage.removeItem(k);
    } catch (e) {}
  });
  alert('バックアップから戻しました。');
  location.reload();
}
window.onBackupFile = function (text) { handleBackupText(text); };
window.onBackupError = function (code) {
  if (code === 1) return; /* キャンセル時は何もしない */
  alert('バックアップファイルを開けませんでした。');
};
document.getElementById('btnBackupExport').addEventListener('click', exportBackup);
document.getElementById('btnBackupImport').addEventListener('click', function () {
  if (window.AndroidBackup && typeof window.AndroidBackup.pickBackup === 'function') {
    window.AndroidBackup.pickBackup();
  } else {
    document.getElementById('backupFileInput').click();
  }
});
document.getElementById('backupFileInput').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function () { handleBackupText(String(reader.result || '')); };
  reader.onerror = function () { alert('バックアップファイルを開けませんでした。'); };
  reader.readAsText(f);
});

/* ---------- 画面のスリープ防止 ----------
   試合中に画面が消えないようにする設定（初期値はオン）。
   Android では ScreenBridge が FLAG_KEEP_SCREEN_ON を切り替え、
   ブラウザでは Wake Lock API を使う。 */
var SCREEN_KEY = 'minibas-scoresheet-screen-v1';
var wakeLockObj = null;
function keepScreenOnEnabled() {
  try { return localStorage.getItem(SCREEN_KEY) !== 'off'; } catch (e) { return true; }
}
function applyKeepScreenOn() {
  var on = keepScreenOnEnabled();
  if (window.AndroidScreen && typeof window.AndroidScreen.setKeepScreenOn === 'function') {
    window.AndroidScreen.setKeepScreenOn(on);
    return;
  }
  if (!on) {
    if (wakeLockObj) { try { wakeLockObj.release(); } catch (e) {} wakeLockObj = null; }
    return;
  }
  if (navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
    navigator.wakeLock.request('screen').then(function (wl) { wakeLockObj = wl; }).catch(function () {});
  }
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && keepScreenOnEnabled()) applyKeepScreenOn();
});
var chkKeepScreenOnEl = document.getElementById('chkKeepScreenOn');
if (chkKeepScreenOnEl) {
  chkKeepScreenOnEl.checked = keepScreenOnEnabled();
  chkKeepScreenOnEl.addEventListener('change', function () {
    try { localStorage.setItem(SCREEN_KEY, chkKeepScreenOnEl.checked ? 'on' : 'off'); } catch (e) {}
    applyKeepScreenOn();
  });
}
applyKeepScreenOn();

/* ---------- 音声入力（AndroidVoice ブリッジ） ----------
   ネイティブ側（MainActivity の VoiceBridge）が SpeechRecognizer で
   取得したテキストを window.onVoiceResult / window.onVoiceError で受け取る。
   記録タブではコマンド解釈、各入力欄の横のマイクでは dictation を行う。 */
var voiceTeam = 'A';        // 音声コマンドの対象チーム
var voiceMode = 'command';  // 'command' | 'dictation'
var voiceFieldEl = null;    // dictation の入力先フィールド

var voiceToastTimer = null;
function voiceStatus(msg) {
  var el = document.getElementById('voiceStatus');
  if (el) el.textContent = msg || '';
  /* 記録が入った・チームが切り替わったときは、結果を大きく一瞬表示する（体育館でも見やすく） */
  if (msg && (msg.indexOf('追加しました') >= 0 || msg.indexOf('切り替えました') >= 0)) {
    showVoiceToast(msg.replace(/^音声:『[^』]*』→ /, ''));
  }
}
function showVoiceToast(text) {
  var t = document.getElementById('voiceToast');
  if (!t) return;
  t.textContent = text;
  t.style.display = 'block';
  if (voiceToastTimer) clearTimeout(voiceToastTimer);
  voiceToastTimer = setTimeout(function () { t.style.display = 'none'; }, 2600);
}
function voiceAvailable() {
  return !!(window.AndroidVoice && typeof window.AndroidVoice.startRecognition === 'function');
}
function teamLabel(t) {
  var team = S.teams[t];
  return team.color || team.name || ('チーム' + t);
}
function setVoiceTeam(t) {
  voiceTeam = t;
  /* 音声の対象チームと記録タブの表示チームは揃える（今どちらのチームを扱っているか迷わないように） */
  if (recordTeam !== t) { recordTeam = t; applyRecordTeam(); }
  var a = document.getElementById('voiceTeamA');
  var b = document.getElementById('voiceTeamB');
  if (a) a.classList.toggle('active', t === 'A');
  if (b) b.classList.toggle('active', t === 'B');
  var lbl = document.getElementById('voiceTeamLabel');
  if (lbl) lbl.textContent = 'チーム' + t + '（' + teamLabel(t) + '）';
}
function startVoice(mode) {
  if (!voiceAvailable()) {
    voiceStatus('音声入力はこの環境では使えません（Androidアプリで開いてください）');
    return;
  }
  voiceMode = mode;
  voiceStatus(mode === 'dictation'
    ? '音声入力中…話してください'
    : '音声入力中…「4番 2点」のように話してください');
  try {
    window.AndroidVoice.startRecognition();
  } catch (e) {
    voiceStatus('音声入力を開始できませんでした');
  }
}

/* 全角→半角、漢数字→数字に正規化し、空白と句読点を除く */
var KANJI_DIGITS = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
function kanjiNumberToInt(s) {
  if (!/^[〇零一二三四五六七八九十]+$/.test(s)) return null;
  var total = 0, current = 0, seen = false;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === '十') { total += (current === 0 ? 1 : current) * 10; current = 0; seen = true; }
    else if (Object.prototype.hasOwnProperty.call(KANJI_DIGITS, ch)) { current = KANJI_DIGITS[ch]; seen = true; }
  }
  return seen ? total + current : null;
}
function normalizeVoiceText(text) {
  var s = String(text == null ? '' : text);
  s = s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  s = s.replace(/[〇零一二三四五六七八九十]+/g, function (m) {
    var n = kanjiNumberToInt(m);
    return n === null ? m : String(n);
  });
  s = s.replace(/[\s、。]+/g, '');
  return s;
}

function findPlayerIdxByNo(team, no) {
  var players = S.teams[team].players;
  for (var i = 0; i < players.length; i++) {
    if (players[i].no !== '' && Number(players[i].no) === no) return i;
  }
  return -1;
}

function handleVoiceCommand(rawText) {
  var heard = '音声:『' + rawText + '』→ ';
  var s = normalizeVoiceText(rawText);
  var m;
  /* チーム切替：「Aチーム」「エーチーム」「チームB」など */
  m = s.match(/([ABエービー])チーム/) || s.match(/チーム([ABエービー])/);
  if (m) {
    var nt = (m[1] === 'A' || m[1] === 'エー') ? 'A' : 'B';
    setVoiceTeam(nt);
    voiceStatus(heard + '対象チームをチーム' + nt + '（' + teamLabel(nt) + '）に切り替えました');
    return;
  }
  /* タイムアウト：その場で記録する（各Qに1回まで） */
  if (s.indexOf('タイムアウト') !== -1) {
    if (addTimeout(voiceTeam)) {
      voiceStatus(heard + 'チーム' + voiceTeam + 'のタイムアウトを記録しました');
    } else {
      voiceStatus(heard + 'チーム' + voiceTeam + 'は、このクォーターのタイムアウトをすでに取っています');
    }
    return;
  }
  /* ファウル（種別は P） */
  m = s.match(/(\d+)番.*(ファウル|ファール)/);
  if (m) {
    var fi = findPlayerIdxByNo(voiceTeam, Number(m[1]));
    if (fi < 0) { voiceStatus(heard + m[1] + '番の選手が登録されていません'); return; }
    if (addFoul(voiceTeam, fi, 'P')) voiceStatus(heard + teamLabel(voiceTeam) + ' ' + m[1] + '番にファウル（P）を追加しました');
    else voiceStatus(heard + '記録しませんでした');
    return;
  }
  /* フリースロー（1点） */
  m = s.match(/(\d+)番.*フリースロー/);
  if (m) {
    var si = findPlayerIdxByNo(voiceTeam, Number(m[1]));
    if (si < 0) { voiceStatus(heard + m[1] + '番の選手が登録されていません'); return; }
    if (addScore(voiceTeam, si, 1)) voiceStatus(heard + teamLabel(voiceTeam) + ' ' + m[1] + '番にフリースローで1点を追加しました');
    else voiceStatus(heard + '記録しませんでした');
    return;
  }
  /* 得点：「4番 2点」 */
  m = s.match(/(\d+)番[^\d]*(\d+)点/);
  if (m) {
    var pts = Number(m[2]);
    if (pts < 1 || pts > 3) { voiceStatus(heard + '解釈できませんでした'); return; }
    if (pts === 3 && !S.game.use3pt) {
      voiceStatus(heard + '3ポイントは採用されていません（試合情報タブで有効にしてください）');
      return;
    }
    var pi = findPlayerIdxByNo(voiceTeam, Number(m[1]));
    if (pi < 0) { voiceStatus(heard + m[1] + '番の選手が登録されていません'); return; }
    if (addScore(voiceTeam, pi, pts)) voiceStatus(heard + teamLabel(voiceTeam) + ' ' + m[1] + '番に' + pts + '点を追加しました');
    else voiceStatus(heard + '記録しませんでした');
    return;
  }
  voiceStatus(heard + '解釈できませんでした');
}

window.onVoiceResult = function (text) {
  if (voiceMode === 'dictation') {
    var el = voiceFieldEl;
    voiceMode = 'command';
    voiceFieldEl = null;
    if (el && document.contains(el)) {
      el.value = text;
      // 既存の保存ハンドラ（oninput / 委譲リスナー）を発火させる
      el.dispatchEvent(new Event('input', { bubbles: true }));
      voiceStatus('音声入力：『' + text + '』を入力しました');
    } else {
      voiceStatus('入力先の欄が見つかりませんでした');
    }
    return;
  }
  handleVoiceCommand(text);
};
window.onVoiceError = function (code) {
  voiceMode = 'command';
  voiceFieldEl = null;
  var msg;
  if (code === -1 || code === 9) {
    msg = 'マイクの使用が許可されていません。端末の設定で許可してください';
  } else if (code === -2) {
    msg = '音声認識サービスが利用できません';
  } else {
    msg = '音声認識できませんでした';
  }
  voiceStatus(msg + '（エラー ' + code + '）');
};

document.getElementById('btnVoice').addEventListener('click', function () {
  voiceFieldEl = null;
  startVoice('command');
});
document.getElementById('voiceTeamA').addEventListener('click', function () { setVoiceTeam('A'); });
document.getElementById('voiceTeamB').addEventListener('click', function () { setVoiceTeam('B'); });
/* 各入力欄の横のマイクボタン（dictation）：同じ label / td / row 内の最初の input を入力先にする */
document.addEventListener('click', function (e) {
  var b = e.target.closest('.mic-btn');
  if (!b) return;
  e.preventDefault();
  var scope = b.closest('label, td, .row') || b.parentElement;
  var input = scope ? scope.querySelector('input') : null;
  if (!input) { voiceStatus('入力先の欄が見つかりませんでした'); return; }
  voiceFieldEl = input;
  startVoice('dictation');
});

/* ---------- メンバー表のOCR取り込み（AndroidOcr ブリッジ） ----------
   大会で渡されるメンバー表（紙）を撮影／写真選択し、ネイティブ側
   （MainActivity の OcrBridge）が ML Kit（日本語・モデル同梱版）で
   読み取った行テキスト＋座標を window.onOcrResult(json) で受け取る。
   行を y 座標で表の行にまとめ直し、背番号・氏名・ライセンス下3桁を抽出。
   登録前に必ず確認画面（モーダル）で編集でき、抽出できなかった生テキストは
   捨てずに「読み取れなかった行」として参考表示する。
   認識は端末内で完結し、写真や名前が外部に送信されることはない。 */
var ocrTeam = 'A';     // 取り込み先チーム（ボタンを押した側）
var ocrRawTexts = [];  // データ行にできなかった生テキスト

function ocrAvailable() {
  return !!(window.AndroidOcr &&
    typeof window.AndroidOcr.capture === 'function' &&
    typeof window.AndroidOcr.pick === 'function');
}

/* 全角の数字・英字を半角へ（氏名の漢字・かなはそのまま） */
function ocrNormalize(s) {
  return String(s == null ? '' : s).replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
}

/* ML Kit の行要素を、y 座標の重なりで「表の1行」にまとめ直す。
   戻り値は、行ごとに x 順に並んだセル文字列の配列。 */
function ocrGroupRows(lines) {
  var items = (lines || []).map(function (l) {
    return {
      text: String(l.text == null ? '' : l.text),
      left: Number(l.left) || 0, top: Number(l.top) || 0,
      right: Number(l.right) || 0, bottom: Number(l.bottom) || 0
    };
  }).filter(function (l) { return l.text.trim() !== ''; });
  items.sort(function (a, b) {
    var ca = (a.top + a.bottom) / 2, cb = (b.top + b.bottom) / 2;
    return ca - cb || a.left - b.left;
  });
  var groups = [];
  items.forEach(function (it) {
    var g = groups.length ? groups[groups.length - 1] : null;
    if (g) {
      var overlap = Math.min(g.bottom, it.bottom) - Math.max(g.top, it.top);
      var minH = Math.min(g.bottom - g.top, it.bottom - it.top);
      if (minH > 0 && overlap > minH * 0.3) {
        g.cells.push(it);
        g.top = Math.min(g.top, it.top);
        g.bottom = Math.max(g.bottom, it.bottom);
        return;
      }
    }
    groups.push({ top: it.top, bottom: it.bottom, cells: [it] });
  });
  return groups.map(function (g) {
    g.cells.sort(function (a, b) { return a.left - b.left; });
    return g.cells.map(function (c) { return c.text; });
  });
}

/* 表の1行（セル文字列の配列）から 背番号・氏名・ライセンス下3桁 を抽出する。
   背番号（1〜2桁の数）が取れない行はデータ行にせず null を返す。 */
function ocrParseRow(cells) {
  var text = ocrNormalize(cells.join(' '));
  var tokens = text.split(/[\s　]+/).filter(function (x) { return x !== ''; });
  var no = '', license = '', nameParts = [];
  tokens.forEach(function (tok) {
    var digits = tok.replace(/[^\d]/g, '');
    if (no === '' && /^\d{1,2}$/.test(tok)) {
      no = tok;
    } else if (license === '' && digits.length >= 3 && !/[ぁ-んァ-ヶ一-龠々]/.test(tok)) {
      // 数字列（区切りや接頭辞つきでも可）があればライセンス番号とみなし下3桁
      license = digits.slice(-3);
    } else if (!/^\d+$/.test(tok)) {
      nameParts.push(tok);
    }
  });
  if (no === '') return null;
  return { no: no, name: nameParts.join(''), license: license };
}

function openOcrSource(team) {
  ocrTeam = team;
  if (!ocrAvailable()) {
    voiceStatus('メンバー表の取り込みはAndroidアプリで使えます');
    return;
  }
  document.getElementById('ocrSourceTitle').textContent =
    'メンバー表を取り込む（チーム' + team + '）';
  document.getElementById('ocrSourceModal').classList.remove('hidden');
}
document.getElementById('ocrCapture').addEventListener('click', function () {
  document.getElementById('ocrSourceModal').classList.add('hidden');
  try {
    window.AndroidOcr.capture();
  } catch (e) {
    voiceStatus('カメラを起動できませんでした');
  }
});
document.getElementById('ocrPick').addEventListener('click', function () {
  document.getElementById('ocrSourceModal').classList.add('hidden');
  try {
    window.AndroidOcr.pick();
  } catch (e) {
    voiceStatus('写真の選択を開けませんでした');
  }
});
document.getElementById('ocrSourceCancel').addEventListener('click', function () {
  document.getElementById('ocrSourceModal').classList.add('hidden');
});

function ocrRowHtml(r) {
  return '<div class="ocr-row">' +
    '<input class="o-no" value="' + esc(r.no) + '" inputmode="numeric" placeholder="No.">' +
    '<input class="o-name" value="' + esc(r.name) + '" placeholder="選手氏名">' +
    '<input class="o-lic" value="' + esc(r.license) + '" inputmode="numeric" maxlength="3" placeholder="3桁">' +
    '<button type="button" class="o-del" title="この行を削除">×</button></div>';
}
function setOcrTeam(t) {
  ocrTeam = t;
  document.getElementById('ocrTeamA').classList.toggle('active', t === 'A');
  document.getElementById('ocrTeamB').classList.toggle('active', t === 'B');
  var nm = S.teams[t].name;
  document.getElementById('ocrTeamName').textContent = nm ? '（' + nm + '）' : '';
}
document.getElementById('ocrTeamA').addEventListener('click', function () { setOcrTeam('A'); });
document.getElementById('ocrTeamB').addEventListener('click', function () { setOcrTeam('B'); });

function openOcrModal(rows) {
  document.getElementById('ocrEdit').classList.remove('hidden');
  document.getElementById('ocrDone').classList.add('hidden');
  document.getElementById('ocrRows').innerHTML = rows.map(ocrRowHtml).join('');
  var rawWrap = document.getElementById('ocrRawWrap');
  if (ocrRawTexts.length) {
    rawWrap.classList.remove('hidden');
    document.getElementById('ocrRaw').textContent = ocrRawTexts.join('\n');
  } else {
    rawWrap.classList.add('hidden');
    document.getElementById('ocrRaw').textContent = '';
  }
  setOcrTeam(ocrTeam);
  document.getElementById('ocrModal').classList.remove('hidden');
}
document.getElementById('ocrRows').addEventListener('click', function (e) {
  var b = e.target.closest('.o-del');
  if (!b) return;
  var row = b.closest('.ocr-row');
  if (row) row.remove();
});
document.getElementById('ocrAddRow').addEventListener('click', function () {
  document.getElementById('ocrRows').insertAdjacentHTML(
    'beforeend', ocrRowHtml({ no: '', name: '', license: '' }));
});
document.getElementById('ocrCancel').addEventListener('click', function () {
  document.getElementById('ocrModal').classList.add('hidden');
});
document.getElementById('ocrApply').addEventListener('click', function () {
  var rows = [];
  document.querySelectorAll('#ocrRows .ocr-row').forEach(function (rowEl) {
    var no = rowEl.querySelector('.o-no').value.trim();
    var name = rowEl.querySelector('.o-name').value.trim();
    var lic = rowEl.querySelector('.o-lic').value.trim();
    if (no === '' && name === '' && lic === '') return;
    rows.push({ no: no, name: name, license: lic.slice(-3) });
  });
  if (rows.length === 0) { alert('登録する行がありません。'); return; }
  if (rows.length > 15) {
    alert('登録できるのは15人までです（' + rows.length + '行あります）。行を減らしてください。');
    return;
  }
  var team = S.teams[ocrTeam];
  var hasExisting = team.players.some(function (p) { return p.no !== '' || p.name !== ''; });
  if (hasExisting && !confirm(
    'チーム' + ocrTeam + 'には既に選手が登録されています。読み取った ' +
    rows.length + ' 人で置き換えますか？'
  )) return;
  for (var i = 0; i < 15; i++) {
    team.players[i] = rows[i]
      ? { no: rows[i].no, name: rows[i].name, license: rows[i].license }
      : emptyPlayer();
  }
  save(); renderRoster(); renderRecord(); renderSheet();
  voiceStatus('チーム' + ocrTeam + 'に ' + rows.length + ' 人を登録しました');
  showOcrDone(ocrTeam, rows.length);
});

/* OCR登録の完了表示：そのまま Q1 の先発メンバー選択へ進める導線を出す */
function showOcrDone(team, count) {
  document.getElementById('ocrEdit').classList.add('hidden');
  document.getElementById('ocrDone').classList.remove('hidden');
  document.getElementById('ocrDoneMsg').textContent =
    'チーム' + team + 'に ' + count + ' 人を登録しました。続けてQ1の先発メンバー（5人）を選べます。';
}
function closeOcrDone() {
  document.getElementById('ocrModal').classList.add('hidden');
  document.getElementById('ocrEdit').classList.remove('hidden');
  document.getElementById('ocrDone').classList.add('hidden');
}
document.getElementById('ocrDoneClose').addEventListener('click', closeOcrDone);
document.getElementById('ocrGoLineup').addEventListener('click', function () {
  closeOcrDone();
  var recBtn = document.querySelector('#tabs button[data-tab="record"]');
  if (recBtn) recBtn.click();
  if (S.quarter !== '1') { S.quarter = '1'; save(); }
  renderRecord();
  openLineup('1');
});

window.onOcrResult = function (json) {
  var data = null;
  try { data = JSON.parse(json); } catch (e) { data = null; }
  var lines = (data && data.lines) || [];
  if (!lines.length) {
    voiceStatus('メンバー表から文字を読み取れませんでした');
    return;
  }
  var rows = [], raw = [];
  ocrGroupRows(lines).forEach(function (cells) {
    var parsed = ocrParseRow(cells);
    if (parsed) rows.push(parsed);
    else raw.push(cells.join(' '));
  });
  ocrRawTexts = raw;
  openOcrModal(rows);
};
window.onOcrError = function (code) {
  if (code === 1) {
    voiceStatus('メンバー表の取り込みをキャンセルしました');
    return;
  }
  var msg;
  if (code === 2) msg = '画像を開けませんでした';
  else if (code === 4) msg = 'カメラ／写真のアプリが見つかりませんでした';
  else msg = '文字を読み取れませんでした。明るい場所で、表がまっすぐ写るように撮り直してください';
  voiceStatus(msg + '（エラー ' + code + '）');
};

/* ---------- 初期化 ---------- */
ensureSeq();
bindInfo();
renderRoster();
renderRecord();
renderFix();
renderSheet();
renderArchive();
updatePracticeUI();
setVoiceTeam('A');
