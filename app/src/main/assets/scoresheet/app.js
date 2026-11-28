/* ============================================================
   バスケ スコアシート アプリ本体
   - 入力 UI（試合情報 / 選手登録 / 記録 / 修正）
   - 公式シートは JBA 公式様式画像の上に canvas で記入を重ね描き
   - 音声入力・メンバー表 OCR・バックアップ・スリープ防止は
     MainActivity 側のブリッジ（AndroidVoice / AndroidOcr /
     AndroidSave / AndroidBackup / AndroidScreen）と連携する
   - データは localStorage に自動保存
   ============================================================ */
'use strict';

var APP_VERSION = '1.65';

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

/* ---------- localStorage の読み書き（共通ヘルパー） ----------
   JSON 値の読み書きはここに集約する。読めない・壊れている場合は
   fallback を返し、書き込みの失敗は黙って無視する（従来どおり）。
   生文字列の読み書きが要る場所（モードや画面設定のキー）は
   writeText / 直接の getItem を使う。 */
function readJson(key, fallback) {
  try {
    var v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}
function writeText(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}
/* 状態データ（JSON 化できるものだけ）のディープコピー */
function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

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
    timeouts: { A: {}, B: {} },      // q -> [経過分]（公式の書き方。各Qに1回まで）
    toSeq: { A: {}, B: {} },         // timeouts と同じ形で、入力順(seq)を並行保持
    seqNext: 1,                      // 次に割り当てる入力順(seq)
    history: []
  };
}
/* タイムアウトは各クォーターに1回までで、取った時点の「経過分」を持つ（公式の書き方）。
   旧データ（v23〜v25の取得済み印 [1]、複数件入ったもの）は先頭の1件に丸める。 */
function normalizeTimeouts(s) {
  if (!s || !s.timeouts) return s;
  ['A', 'B'].forEach(function (t) {
    var tos = s.timeouts[t];
    if (!tos) return;
    Object.keys(tos).forEach(function (q) {
      if (Array.isArray(tos[q])) {
        if (!tos[q].length) { tos[q] = []; return; }
        var m0 = Number(tos[q][0]);
        tos[q] = [isFinite(m0) && m0 >= 1 ? Math.floor(m0) : 1];
      }
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
function save() { writeJson(storeKey(), S); }
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
function trimStr(v) {
  return String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
}
/* 登録済み選手数 = 名前か背番号のある最後の行 + 1（データ上は枠が多めにある） */
function lastRegisteredCount(players) {
  var n = 0;
  players.forEach(function (p, idx) {
    if (trimStr(p.name) !== '' || trimStr(p.no) !== '') n = idx + 1;
  });
  return n;
}
/* そのチームのファウルを who（選手index / 'coach' / 'acoach'）ごとに時系列でまとめる */
function foulsByWho(teamKey) {
  var map = {};
  S.fouls.forEach(function (f) {
    if (f.team === teamKey) {
      (map[f.who] || (map[f.who] = [])).push(f);
    }
  });
  return map;
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
    /* 試合終了にしたら、その時点のデータを自動バックアップする（v29） */
    if (cf.checked && typeof runAutoBackup === 'function') runAutoBackup();
  };
  closeHistLists();
}

/* ---------- 履歴ドロップダウン（大会名・会場） ----------
   過去の試合（アーカイブ）に記録された大会名・会場を、入力欄にフォーカス
   したときに欄の下へドロップダウンで出す。アーカイブは新しい順に並んで
   いるので、その順のまま重複を取り除き、空のものと今入力されている値を
   除いて最大8件まで。項目を選ぶと、通常の手入力と同じ保存経路で値が入る。
   履歴が無い欄では何も出ない。欄の外をタップすると閉じる。 */
var HIST_FIELDS = [
  { input: 'gTournament', list: 'tournamentHist', field: 'tournament' },
  { input: 'gVenue', list: 'venueHist', field: 'venue' }
];
function historyValues(field) {
  var cur = trimStr(S.game[field]);
  var seen = {}, out = [];
  loadArchive().forEach(function (item) {
    var v = (item && item.state && item.state.game) ? trimStr(item.state.game[field]) : '';
    if (!v || v === cur || seen[v]) return;
    seen[v] = true;
    out.push(v);
  });
  return out.slice(0, 8);
}
function closeHistLists() {
  HIST_FIELDS.forEach(function (h) {
    var list = document.getElementById(h.list);
    if (list) { list.innerHTML = ''; list.style.display = 'none'; }
  });
}
function openHistList(h) {
  var list = document.getElementById(h.list);
  if (!list) return;
  var values = historyValues(h.field);
  closeHistLists();
  if (!values.length) return;
  list.innerHTML = values.map(function (v) {
    return '<button type="button" class="hist-item" data-hist-value="' + esc(v) + '">' + esc(v) + '</button>';
  }).join('');
  list.style.display = '';
}
HIST_FIELDS.forEach(function (h) {
  var el = document.getElementById(h.input);
  if (el) {
    el.onfocus = function () { openHistList(h); };
    el.onclick = function () { openHistList(h); };
  }
  var list = document.getElementById(h.list);
  if (list) {
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-hist-value]');
      if (!btn) return;
      var input = document.getElementById(h.input);
      input.value = btn.dataset.histValue;
      S.game[h.field] = input.value; save();
      closeHistLists();
    });
  }
});
document.querySelectorAll('[data-hist-btn]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var h = null;
    HIST_FIELDS.forEach(function (x) { if (x.field === btn.dataset.histBtn) h = x; });
    if (!h) return;
    var list = document.getElementById(h.list);
    if (list && list.style.display !== 'none') { closeHistLists(); return; }
    document.getElementById(h.input).focus();
    openHistList(h);
  });
});
document.addEventListener('pointerdown', function (e) {
  HIST_FIELDS.forEach(function (h) {
    var list = document.getElementById(h.list);
    if (!list || list.style.display === 'none') return;
    var label = list.closest('label');
    if (label && label.contains(e.target)) return;
    list.innerHTML = ''; list.style.display = 'none';
  });
});

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
    return '<div class="team-editor team-editor-' + t.toLowerCase() + '">' +
      '<h3>チーム' + t + '</h3>' +
      '<div class="row">' +
      '<input class="tname" data-team="' + t + '" data-field="name" value="' + esc(team.name) + '" placeholder="チーム名">' +
      '<button type="button" class="mic-btn" title="音声入力">🎤</button>' +
      '<input class="tcolor" data-team="' + t + '" data-field="color" value="' + esc(team.color) + '" placeholder="ユニフォーム色（例：白）">' +
      '</div>' +
      '<div class="row"><button type="button" class="ocr-open" data-ocr-team="' + t + '">📷 メンバー表を取り込む</button></div>' +
      '<div class="row"><button type="button" class="roster-save" data-roster-save="' + t + '">💾 この名簿を保存</button>' +
      '<button type="button" class="roster-load" data-roster-load="' + t + '">📂 名簿を呼び出す</button></div>' +
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
  if (b) { openOcrSource(b.dataset.ocrTeam); return; }
  var sv = e.target.closest('[data-roster-save]');
  if (sv) { saveRosterToLib(sv.dataset.rosterSave); return; }
  var ld = e.target.closest('[data-roster-load]');
  if (ld) { openRosterLoad(ld.dataset.rosterLoad); return; }
});

/* ---------- 名簿の保存・呼び出し ----------
   いつものチームの名簿をアプリ内に保存しておき、新しい試合で呼び出す。
   過去の試合の名簿からも呼び出せる。保存先は端末内（localStorage）のみ。 */
var ROSTER_LIB_KEY = 'minibas-scoresheet-rosters-v1';
function loadRosterLib() {
  var v = readJson(ROSTER_LIB_KEY, []);
  return Array.isArray(v) ? v : [];
}
function writeRosterLib(lib) { writeJson(ROSTER_LIB_KEY, lib); }
function copyTeam(team) { return deepCopy(team); }
function saveRosterToLib(t) {
  var team = S.teams[t];
  var label = team.name || ('チーム' + t);
  var lib = loadRosterLib();
  var idx = -1;
  lib.forEach(function (e, i) { if ((e.team.name || '') === (team.name || '')) idx = i; });
  if (idx >= 0) {
    if (!confirm('「' + label + '」の名簿はすでに保存されています。いまの内容で上書きしますか？')) return;
    lib[idx] = { savedAt: new Date().toISOString(), team: copyTeam(team) };
  } else {
    lib.unshift({ savedAt: new Date().toISOString(), team: copyTeam(team) });
  }
  writeRosterLib(lib.slice(0, 20));
  alert('名簿を保存しました：' + label);
}
var rosterLoadTarget = 'A';
function rosterEntryLabel(team) {
  var n = 0;
  team.players.forEach(function (p) { if (p.name || p.no) n++; });
  return (team.name || '（チーム名なし）') + '（選手' + n + '人）';
}
function openRosterLoad(t) {
  rosterLoadTarget = t;
  document.getElementById('rosterModalTitle').textContent =
    '名簿を呼び出す（チーム' + t + 'へ）';
  var list = document.getElementById('rosterModalList');
  var html = '';
  var lib = loadRosterLib();
  lib.forEach(function (e, i) {
    var d = new Date(e.savedAt);
    var when = isNaN(d.getTime()) ? '' : d.toLocaleDateString('ja-JP');
    html += '<button type="button" class="pick-item" data-lib="' + i + '">' +
      esc(rosterEntryLabel(e.team)) + '<span class="pick-sub">保存した名簿' +
      (when ? '・' + when : '') + '</span></button>';
  });
  var arc = [];
  try { arc = loadArchive() || []; } catch (e) {}
  arc.forEach(function (g, gi) {
    ['A', 'B'].forEach(function (side) {
      var tm = g.state && g.state.teams ? g.state.teams[side] : null;
      if (!tm || !(tm.name || tm.players.some(function (p) { return p.name || p.no; }))) return;
      var sub = '過去の試合';
      if (g.state.game) {
        if (g.state.game.date) sub += '・' + g.state.game.date;
        if (g.state.game.tournament) sub += '・' + g.state.game.tournament;
      }
      html += '<button type="button" class="pick-item" data-arc="' + gi + '" data-side="' + side + '">' +
        esc(rosterEntryLabel(tm)) + '<span class="pick-sub">' + esc(sub) + '</span></button>';
    });
  });
  list.innerHTML = html || '<p class="hint">呼び出せる名簿がまだありません。「この名簿を保存」で保存すると、次から呼び出せます。</p>';
  document.getElementById('rosterModal').classList.remove('hidden');
}
function applyRoster(team) {
  var t = rosterLoadTarget;
  var cur = S.teams[t];
  var has = cur.name || cur.players.some(function (p) { return p.name || p.no; });
  if (has && !confirm('チーム' + t + 'には入力済みの名簿があります。呼び出した名簿で上書きしますか？')) return;
  S.teams[t] = copyTeam(team);
  save();
  renderRoster();
  renderRecord();
  renderSheet();
  setVoiceTeam(voiceTeam);
  document.getElementById('rosterModal').classList.add('hidden');
  alert('名簿を呼び出しました：' + (team.name || ('チーム' + t)));
}
document.getElementById('rosterModalList').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-lib], button[data-arc]');
  if (!b) return;
  if (b.dataset.lib !== undefined) {
    var lib = loadRosterLib();
    var ent = lib[Number(b.dataset.lib)];
    if (ent) applyRoster(ent.team);
    return;
  }
  var arc = [];
  try { arc = loadArchive() || []; } catch (err) {}
  var g = arc[Number(b.dataset.arc)];
  var tm = g && g.state && g.state.teams ? g.state.teams[b.dataset.side] : null;
  if (tm) applyRoster(tm);
});
document.getElementById('rosterModalCancel').addEventListener('click', function () {
  document.getElementById('rosterModal').classList.add('hidden');
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
  /* 1行目にチーム記号と色、2行目にチーム名とスコアを置き、
     チーム名の途中では改行しない（長い名前は…で省略） */
  return '<span class="rt-head">チーム' + t + (team.color ? '（' + esc(team.color) + '）' : '') + '</span>' +
    '<span class="rt-main"><span class="rt-name">' + esc(team.name || '（未入力）') + '</span>' +
    '<span class="rec-switch-score">' + totalScore(t) + '</span></span>';
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

/* そのクォーターのチームファウル数（選手のファウルだけを数える。
   コーチ・ベンチのテクニカルとマンツーマンペナルティは数えない＝TOの決まり） */
function teamFoulCount(t, q) {
  var k = qKey(q);
  var n = 0;
  S.fouls.forEach(function (f) {
    if (f.team === t && f.who !== 'coach' && f.who !== 'acoach' && qKey(f.q) === k) n++;
  });
  return n;
}
/* 記録タブ上部に、今のクォーターのチームファウル数を大きく出す */
function updateTfBar() {
  var el = document.getElementById('tfBar');
  if (!el) return;
  var qText = S.quarter === 'OT' ? '延長' : ('Q' + S.quarter);
  el.innerHTML = ['A', 'B'].map(function (t) {
    var name = S.teams[t].name || ('チーム' + t);
    return '<span class="tf-chip"><span class="tf-team">' + esc(name) + '</span>' +
      '<span class="tf-label">' + qText + ' チームファウル</span>' +
      '<span class="tf-num">' + teamFoulCount(t, S.quarter) + '</span></span>';
  }).join('');
}

function renderRecord() {
  document.querySelectorAll('#quarterBtns button').forEach(function (x) {
    x.classList.toggle('active', x.dataset.q === S.quarter);
  });
  updateTfBar();
  var root = document.getElementById('recordPanels');
  root.innerHTML = ['A', 'B'].map(function (t) {
    var team = S.teams[t];
    var q = S.quarter;
    var tos = (S.timeouts[t][q] || []);
    var chips = tos.map(function (m, i) {
      return '<span class="chip">' + q + ' ' + m + '分<b data-act="delto" data-team="' + t + '" data-i="' + i + '">×</b></span>';
    }).join('');
    var registered = registeredList(t);
    var partStatus = participationStatusText(t);
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
      (partStatus ? '<div class="part-status">' + esc(partStatus) + '</div>' : '') +
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
    openToModal(t, false);
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
function setModalTeam(modalId, team) {
  var box = document.querySelector('#' + modalId + ' .modal-box');
  if (!box) return;
  box.classList.toggle('team-a', team === 'A');
  box.classList.toggle('team-b', team === 'B');
}
function openFoulModal() {
  var isCoach = typeof foulTarget.who === 'string';
  document.getElementById('foulModalTitle').textContent =
    'ファウルの種別（チーム' + foulTarget.team + ' / ' + S.quarter + '）';
  document.getElementById('foulDesc').textContent = isCoach ? FOUL_DESC_COACH : FOUL_DESC_PLAYER;
  var types = isCoach ? FOUL_TYPES_COACH : FOUL_TYPES_PLAYER;
  document.getElementById('foulTypeBtns').innerHTML = types.map(function (ty) {
    return '<button type="button" data-type="' + ty + '">' + ty + '</button>';
  }).join('');
  setModalTeam('foulModal', foulTarget.team);
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
   公式の書き方：ミニバスでは各クォーターに1回までで、取った時点の
   「経過分」を記録する（6分クォーターで残り2分35秒のときに取ったら、
   6−2で経過「4」分）。取ったクォーターではボタンが
   「タイムアウト済み」になって、もう取れない。 */
function timeoutTaken(team, q) {
  return ((S.timeouts[team] || {})[q] || []).length > 0;
}
function addTimeout(team, minute) {
  if (timeoutTaken(team, S.quarter)) return false;
  var mn = Math.floor(Number(minute));
  if (!isFinite(mn) || mn < 1) mn = 1;
  snapshot();
  var arr = S.timeouts[team][S.quarter] || (S.timeouts[team][S.quarter] = []);
  arr.push(mn);
  if (!S.toSeq) S.toSeq = { A: {}, B: {} };
  if (!S.toSeq[team]) S.toSeq[team] = {};
  var sarr = S.toSeq[team][S.quarter] || (S.toSeq[team][S.quarter] = []);
  sarr.push(nextSeq());
  save(); renderRecord(); renderSheet();
  return true;
}

/* 経過分ピッカー（ボタンと音声で共用）。延長のクォーターは3分なので 1〜3分、
   通常クォーターは6分なので 1〜6分から選ぶ。 */
var toTarget = null;
function openToModal(team, fromVoice) {
  if (timeoutTaken(team, S.quarter)) return;
  toTarget = { team: team, voice: !!fromVoice };
  document.getElementById('toModalTitle').textContent =
    teamLabel(team) + ' タイムアウト（' + qLabel(S.quarter) + '）';
  var maxMin = (S.quarter === 'OT') ? 3 : 6;
  var btns = '';
  for (var m = 1; m <= maxMin; m++) {
    btns += '<button type="button" data-min="' + m + '">' + m + '分</button>';
  }
  document.getElementById('toMinuteBtns').innerHTML = btns;
  setModalTeam('toModal', team);
  document.getElementById('toModal').classList.remove('hidden');
}
function closeToModal() {
  toTarget = null;
  document.getElementById('toModal').classList.add('hidden');
}
document.getElementById('toMinuteBtns').addEventListener('click', function (e) {
  var b = e.target.closest('[data-min]');
  if (!b || !toTarget) return;
  var team = toTarget.team, wasVoice = toTarget.voice;
  var mn = Number(b.dataset.min);
  closeToModal();
  if (addTimeout(team, mn) && wasVoice) {
    voiceStatus('チーム' + team + 'のタイムアウト（経過' + mn + '分）を記録しました');
  }
});
document.getElementById('toCancel').addEventListener('click', closeToModal);

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
  var tmin = ((S.timeouts[it.team] || {})[it.q] || [])[it.ai];
  return teamLabel(it.team) + ' タイムアウト' + (tmin ? ' ' + tmin + '分' : '');
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
  root.innerHTML = items.map(function (it, pos) {
    var k = qKey(it.q);
    var cls = (k === '1' || k === '3') ? 'qred' : 'qblue';
    return '<button type="button" class="fix-item fix-' + String(it.team).toLowerCase() + '" data-kind="' + it.kind + '" data-i="' + it.i +
      '" data-team="' + it.team + '" data-q="' + esc(it.q) + '" data-ai="' + it.ai + '" data-pos="' + pos + '">' +
      '<span class="fix-drag">≡</span>' +
      '<span class="fix-q ' + cls + '">' + qLabel(it.q) + '</span>' +
      '<span class="fix-text">' + esc(fixItemText(it)) + '</span>' +
      '<span class="fix-arrow">›</span></button>';
  }).join('');
}
document.getElementById('fixList').addEventListener('click', function (e) {
  if (suppressFixClick) { suppressFixClick = false; return; }
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

/* 修正画面のドラッグ並び替え：seq（入力順の通し番号）を新しい並びに振り直す。
   得点・ファウル・タイムアウトはすべて seq で一元的に並ぶので、これで全体の順番が変わる。 */
var suppressFixClick = false;
function moveFixItem(fromPos, toPos) {
  var items = fixItems();
  if (fromPos === toPos || fromPos < 0 || toPos < 0 || fromPos >= items.length || toPos >= items.length) return;
  var seqs = items.map(function (it) { return it.seq; });
  var moved = items.splice(fromPos, 1)[0];
  items.splice(toPos, 0, moved);
  items.forEach(function (it, k) {
    var s = seqs[k];
    if (it.kind === 'score') S.events[it.i].seq = s;
    else if (it.kind === 'foul') S.fouls[it.i].seq = s;
    else if (S.toSeq && S.toSeq[it.team] && S.toSeq[it.team][it.q]) S.toSeq[it.team][it.q][it.ai] = s;
  });
  save(); renderFix(); renderRecord(); renderSheet();
}
(function () {
  var list = document.getElementById('fixList');
  if (!list) return;
  var dragEl = null, startPos = -1, curPos = -1, startY = 0;
  function rows() { return Array.prototype.slice.call(list.querySelectorAll('.fix-item')); }
  function onMove(e) {
    if (!dragEl) return;
    var y = e.clientY;
    var rs = rows();
    var idx = rs.indexOf(dragEl);
    while (idx > 0) {
      var prev = rs[idx - 1];
      var pb = prev.getBoundingClientRect();
      if (y < pb.top + pb.height / 2) {
        list.insertBefore(dragEl, prev);
        startY -= prev.offsetHeight + 8;
        rs = rows(); idx = rs.indexOf(dragEl); curPos = idx;
      } else break;
    }
    rs = rows(); idx = rs.indexOf(dragEl);
    while (idx >= 0 && idx < rs.length - 1) {
      var next = rs[idx + 1];
      var nb = next.getBoundingClientRect();
      if (y > nb.top + nb.height / 2) {
        list.insertBefore(next, dragEl);
        startY += next.offsetHeight + 8;
        rs = rows(); idx = rs.indexOf(dragEl); curPos = idx;
      } else break;
    }
    dragEl.style.transform = 'translateY(' + (y - startY) + 'px)';
  }
  function cleanup() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    if (dragEl) { dragEl.classList.remove('dragging'); dragEl.style.transform = ''; }
  }
  function onUp() {
    var f = startPos, t = curPos, el = dragEl;
    cleanup();
    dragEl = null;
    setTimeout(function () { suppressFixClick = false; }, 350);
    if (el && t !== f) moveFixItem(f, t);
  }
  function onCancel() {
    cleanup();
    dragEl = null;
    suppressFixClick = false;
    renderFix();
  }
  list.addEventListener('pointerdown', function (e) {
    var h = e.target.closest('.fix-drag');
    if (!h) return;
    var item = h.closest('.fix-item');
    if (!item) return;
    e.preventDefault();
    suppressFixClick = true;
    dragEl = item;
    startPos = curPos = Number(item.dataset.pos);
    startY = e.clientY;
    dragEl.classList.add('dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  });
})();

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
    var curMin = ((S.timeouts[it.team] || {})[it.q] || [])[it.ai];
    var minOpts = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (mm) {
      return '<option value="' + mm + '"' + (mm === curMin ? ' selected' : '') + '>' + mm + '分</option>';
    }).join('');
    fields =
      '<p class="hint">タイムアウトの経過分とクォーターを変更できます。</p>' +
      '<label class="flabel">経過分<select id="efMinute">' + minOpts + '</select></label>' +
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
    var nmin = Number(document.getElementById('efMinute').value);
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
      arr.push(nmin);
      var sarr = S.toSeq[t.team][nq] || (S.toSeq[t.team][nq] = []);
      sarr.push(typeof seq === 'number' ? seq : nextSeq());
    } else {
      S.timeouts[t.team][t.q][t.ai] = nmin;
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

/* ---------- スコアシート描画（canvas方式） ----------
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
  var s = trimStr(license);
  if (!s) return;
  var digits = ('000' + s).slice(-3);
  for (var k = 0; k < 3; k++) textC(ctx, centersX[k], cy, digits.charAt(k), 30, COL_BLACK, true);
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
      textR(ctx, 1575, 254, String(Number(dp[0])), 38, COL_BLACK, true);
      textR(ctx, 1692, 254, String(Number(dp[1])), 38, COL_BLACK, true);
      textR(ctx, 1811, 254, String(Number(dp[2])), 38, COL_BLACK, true);
    }
  }
  if (game.time) {
    var tp = String(game.time).split(':');
    if (tp.length >= 2) {
      textR(ctx, 2235, 254, tp[0], 38, COL_BLACK, true);
      textL(ctx, 2271, 254, tp[1], 38, COL_BLACK, true);
    }
  }
  if (game.venue) {
    textL(ctx, 1420, 320, game.venue, fitSize(ctx, game.venue, 38, 520, true), COL_BLACK, true);
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
    if (o[0]) textC(ctx, o[1], o[2], o[0], fitSize(ctx, o[0], 40, 480, true), COL_BLACK, true);
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
  var toCols = [1004, 1060, 1118, 1175, 1231];
  var toColIdx = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 };

  ['A', 'B'].forEach(function (tt) {
    var team = teams[tt];
    if (team.name) {
      textL(ctx, 235, headCY[tt], team.name, fitSize(ctx, team.name, 46, 540, true), COL_BLACK, true);
    }
    /* タイムアウト（取得済みなら経過分をそのクォーターの色で記入。公式の書き方） */
    var tos = S.timeouts[tt] || {};
    Object.keys(tos).forEach(function (qq0) {
      var col = toColIdx[qKey(qq0)];
      if (col === undefined) return;
      var arrT = tos[qq0] || [];
      if (!arrT.length) return;
      textC(ctx, toCols[col], headCY[tt] + 42, String(arrT[0]), 40, qColorCanvas(qq0), true);
    });
    /* 選手別ファウル（時系列順） */
    var pfouls = foulsByWho(tt);
    var part = S.participation[tt] || {};
    team.players.forEach(function (p, idx) {
      var top = rowTop0[tt] + idx * 59;
      var cy = top + 29;
      drawLicense(ctx, p.license, licCX, cy);
      if (p.name) {
        textL(ctx, 302, cy, p.name, fitSize(ctx, p.name, 34, 378, true), COL_BLACK, true);
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
    /* コーチ・Aコーチ（ライセンス欄は氏名欄の左 291-462、氏名は x=472 から。
       ファウル（C/B/M）も選手と同じくファウル欄に時系列順で描く） */
    [[team.coach, coachTop[tt], 'coach'], [team.acoach, acoachTop[tt], 'acoach']].forEach(function (ct) {
      var person = ct[0];
      var cy2 = ct[1] + 29;
      drawLicense(ctx, person.license, [320, 377, 434], cy2);
      if (person.name) {
        textL(ctx, 472, cy2, person.name, fitSize(ctx, person.name, 34, 208, true), COL_BLACK, true);
      }
      var cflist = (pfouls[ct[2]] || []).slice(0, 5);
      cflist.forEach(function (f, j) {
        var cx = Math.floor((foulX[j] + foulX[j + 1]) / 2);
        textC(ctx, cx, cy2, f.type, fitSize(ctx, f.type, 28, 50, true), qColorCanvas(f.q), true);
      });
    });
  });
  /* Bチームのユニフォーム色（Aの「（白）」は印刷済み。Bは括弧内が空白のため描く）
     サイズは印刷済みの「白」の字の大きさ（インク高さ約50px）に合わせる（v28で44→52に拡大） */
  if (teams.B.color) {
    textC(ctx, 881, 2172, teams.B.color, 52, COL_BLACK);
  }

  /* ---------- チームファウル（×印） ---------- */
  var tfBoxes = {
    A: { '1': [1356, 1141], '2': [1420, 1141], '3': [1356, 1494], '4': [1420, 1494] },
    B: { '1': [1356, 2496], '2': [1420, 2496], '3': [1356, 2849], '4': [1420, 2849] }
  };
  ['A', 'B'].forEach(function (tt) {
    var counts = {};
    S.fouls.forEach(function (f) {
      /* コーチ・ベンチのテクニカル（C/B）とマンツーマンペナルティ（M）は
         チームファウルに数えない（TOの決まり）。数えるのは選手のファウルだけ */
      if (f.team === tt && f.who !== 'coach' && f.who !== 'acoach') {
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
      ellipseOutline(ctx, sx + 32, top + 29.5, 26, 23.5, col, 4);
    }
    if (e.pts === 1) {
      ellipseFill(ctx, nx + 32, cy, 16, 16, col);
    } else {
      drawLine(ctx, nx + 5, top + 54, nx + 59, top + 5, col, 6);
    }
    var isQEnd = lastOfQuarter[tt + '|' + qKey(e.q)] === idx;
    var isFinal = !!game.finished && lastEventIdx[tt] === idx;
    if (isQEnd || isFinal) {
      ellipseOutline(ctx, nx + 32, top + 29.5, isFinal ? 26 : 27, isFinal ? 23 : 24, col, isFinal ? 8 : 5);
      var xLo = Math.min(sx, nx), xHi = Math.max(sx, nx) + 64;
      drawLine(ctx, xLo, top + 52, xHi, top + 52, col, 6);
      if (isFinal) {
        drawLine(ctx, xLo, top + 43, xHi, top + 43, col, 5);
      }
    }
  });

  /* ---------- 締めの線（試合終了時のみ。公式記入例の conventions） ---------- */
  if (game.finished) {
    ['A', 'B'].forEach(function (tt) {
      var team = teams[tt];
      var rosterSize = team.players.length;
      /* 登録済み選手数 = 名前か背番号のある最後の行 + 1（データ上は15枠ある） */
      var nReg = lastRegisteredCount(team.players);
      var pfoulsC = foulsByWho(tt);
      /* 1. 名簿の締め: 最終登録選手行の直下に太い横線（表の全幅） */
      if (nReg > 0 && nReg < rosterSize) {
        var yReg = rowTop0[tt] + nReg * 59;
        drawLine(ctx, 119, yReg, 1260, yReg, COL_BLACK, 6);
      }
      /* 未出場ブロックの範囲を先に求める（項目2と8で使う）:
         登録済みで出場記録が1つもない選手が、表の下端に続く範囲 */
      var partBlk = S.participation[tt] || {};
      var bBlk = nReg - 1;
      while (bBlk >= 0) {
        var ppBlk = partBlk[bBlk];
        if (ppBlk && Object.keys(ppBlk).length > 0) break;
        bBlk--;
      }
      var blkStart = (nReg - 1 - bBlk >= 2) ? bBlk + 1 : -1;
      /* 2. 選手ファウル欄: 記録済みファウルの次のセルから右端まで横線。
         未出場ブロック（2人以上）の選手は斜線（項目8）だけにして、
         横線と斜線が交差しないようにする（実物の締め方、2026-11-26の写真で確認） */
      for (var ii = 0; ii < nReg; ii++) {
        if (blkStart >= 0 && ii >= blkStart) continue;
        var cntF = Math.min((pfoulsC[ii] || []).length, 5);
        if (cntF < 5) {
          var cyF = rowTop0[tt] + ii * 59 + 29;
          drawLine(ctx, foulX[cntF] + 4, cyF, 1256, cyF, COL_BLACK, 5);
        }
      }
      /* 3. 未登録行のファウル欄: 全体に斜線1本。
         向きは公式記入例どおり左上→右下（項目8の未出場ブロックと同じ向き。
         旧コードは右上がりで逆だった。2026-11-26 公式記入例で確認して修正） */
      if (nReg > 0 && nReg < rosterSize) {
        var uy0 = rowTop0[tt] + nReg * 59;
        var uy1 = rowTop0[tt] + rosterSize * 59;
        drawLine(ctx, foulX[0] + 4, uy0 + 4, foulX[5] - 4, uy1 - 4, COL_BLACK, 5);
      }
      /* 8. 未出場の選手の斜線: 登録済みで出場記録が1つもない選手が表の下端に
         2人以上続く場合、その範囲のファウル欄に斜線1本（実物の締め方）。
         斜線はファウル欄の左端（x=975）から引く。1人だけの場合は引かない
         （項目2の横線のみ） */
      if (blkStart >= 0) {
        var y0Blk = rowTop0[tt] + blkStart * 59;
        var y1Blk = rowTop0[tt] + nReg * 59;
        drawLine(ctx, foulX[0], y0Blk + 2, 1260, y1Blk - 2, COL_BLACK, 5);
        /* あわせてブロック先頭行の出場時限セル（①〜④）の中央に横線1本。
           2行目以降には引かない（実物の締め方、写真2枚目で確認） */
        drawLine(ctx, partX[0], y0Blk + 29, foulX[0], y0Blk + 29, COL_BLACK, 5);
      }
      /* 4. コーチ・Aコーチ行のファウル欄: 記録済みファウルの次のセルから右端まで横線（選手と同じ） */
      [[coachTop[tt], 'coach'], [acoachTop[tt], 'acoach']].forEach(function (ctC) {
        var cntC = Math.min((pfoulsC[ctC[1]] || []).length, 5);
        if (cntC < 5) {
          drawLine(ctx, foulX[cntC] + 4, ctC[0] + 29, 1256, ctC[0] + 29, COL_BLACK, 5);
        }
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
      /* 6. チームファウル: 使わなかった数字の枠に縦線2本（そのQの色。
         コーチ・ベンチのテクニカルとマンツーマンペナルティはチームファウルに数えない） */
      var tfCounts = {};
      S.fouls.forEach(function (f) {
        if (f.team === tt && f.who !== 'coach' && f.who !== 'acoach') {
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

  /* ---------- ファウルの太線（JBA公式記入例の決まり） ----------
     第2Qの終わりにだけ、使用した枠と未使用の枠の間に濃色（黒）で
     太線を引く（前半のファウルの右端に縦線＋前半の枠の下線）。
     ゲーム終了後に引くのは未使用欄への横線（締めの線の項目2）で、
     太線は引かない。公式記入例の注記「第2Qの終りに、使用した枠と
     未使用の枠の間に濃色（黒/青）で太線を引く／ゲーム終了後未使用の
     欄に横線を引く」と記入例の各行で確認（2026-11-26、河野さんの
     依頼で公式確認。旧実装は試合終了時にも太線を足していて誤り）。
     第3Q以降（または試合終了時）に表示する。 */
  var pastHalf = game.finished || ['3', '4', '5'].indexOf(qKey(S.quarter)) !== -1;
  if (pastHalf) {
    ['A', 'B'].forEach(function (tt) {
      var team = teams[tt];
      var nRegT = lastRegisteredCount(team.players);
      var pfoulsT = foulsByWho(tt);
      function thickMark(fl, top) {
        if (!fl || !fl.length) return;
        /* 区切りは前半（1・2Q）最後のファウルの右端の1か所だけ */
        var lastHalf = -1;
        fl.forEach(function (f, j) {
          var kk = qKey(f.q);
          if (kk === '1' || kk === '2') lastHalf = j;
        });
        if (lastHalf < 0) return;
        var bx = foulX[lastHalf + 1];
        drawLine(ctx, bx, top + 2, bx, top + 57, COL_BLACK, 8);
        drawLine(ctx, foulX[0], top + 57, bx, top + 57, COL_BLACK, 8);
      }
      for (var iiT = 0; iiT < nRegT; iiT++) {
        thickMark(pfoulsT[iiT], rowTop0[tt] + iiT * 59);
      }
      thickMark(pfoulsT.coach, coachTop[tt]);
      thickMark(pfoulsT.acoach, acoachTop[tt]);
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
    textL(ctx, 1790, 3350, game.endTime, 42, COL_BLACK, true);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);

  /* タブレット幅では記録タブの横にスコアシートを同時表示する（プレビュー用canvasへ複写） */
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
      /* ブリッジ保存・ダウンロードの振り分けは saveBlobAsFile が担う */
      saveBlobAsFile(blob, 'scoresheet.png', 'image/png', doPrint);
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

/* シート canvas の JPEG バイト列を取り出して cb(bytes) に渡す共通処理
   （PDF保存とPDF共有で共用）。取得できなければ cb(null)。
   toBlob → arrayBuffer / FileReader の順に試し、だめなら toDataURL 経由。 */
function sheetJpegBytes(canvas, cb) {
  function fallbackDataUrl() {
    try {
      var url = canvas.toDataURL('image/jpeg', 0.92);
      var b64 = url.slice(url.indexOf(',') + 1);
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      cb(bytes);
    } catch (e) {
      cb(null);
    }
  }
  if (typeof canvas.toBlob === 'function') {
    canvas.toBlob(function (blob) {
      if (!blob) { fallbackDataUrl(); return; }
      if (typeof blob.arrayBuffer === 'function') {
        blob.arrayBuffer().then(function (buf) {
          cb(new Uint8Array(buf));
        }, fallbackDataUrl);
      } else {
        var r = new FileReader();
        r.onload = function () { cb(new Uint8Array(r.result)); };
        r.onerror = fallbackDataUrl;
        r.readAsArrayBuffer(blob);
      }
    }, 'image/jpeg', 0.92);
  } else {
    fallbackDataUrl();
  }
}

function saveSheetPdf() {
  drawSheetCanvas();
  var canvas = document.getElementById('sheetCanvas');
  if (!canvas) return;
  var fileName = sheetPdfFileName();
  sheetJpegBytes(canvas, function (bytes) {
    if (!bytes) { alert('PDFの作成に失敗しました。'); return; }
    var pdf = buildSheetPdf(bytes, canvas.width, canvas.height);
    var blob = new Blob([pdf], { type: 'application/pdf' });
    saveBlobAsFile(blob, fileName, 'application/pdf', function () {
      alert('PDFの保存に失敗しました。');
    });
  });
}
/* 保存・共有ボタンの配線は、共有セクション末尾の委譲ハンドラに一本化
   （シート下部にも同じボタンを置くため、data-act で振り分ける） */

/* ---------- シートの共有 ----------
   保存ではなく、LINE などのアプリへ直接送る。Android アプリ内では
   AndroidShare ブリッジ（ACTION_SEND）を使い、ブラウザでは
   Web Share API が使えるときだけ使う。 */
function androidShareAvailable() {
  return !!(window.AndroidShare && typeof window.AndroidShare.shareFile === 'function');
}
function shareBlobAsFile(blob, fileName, mimeType) {
  if (androidShareAvailable()) {
    blobToBase64(blob, function (b64) {
      if (b64) window.AndroidShare.shareFile(b64, fileName, mimeType);
      else alert('共有の準備に失敗しました。');
    });
    return;
  }
  if (navigator.share && typeof File === 'function') {
    var f = new File([blob], fileName, { type: mimeType });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      navigator.share({ files: [f] }).catch(function () {});
      return;
    }
  }
  alert('この環境では共有できません。保存してから送ってください。');
}
function shareSheetPdf() {
  drawSheetCanvas();
  var canvas = document.getElementById('sheetCanvas');
  if (!canvas) return;
  var fileName = sheetPdfFileName();
  sheetJpegBytes(canvas, function (bytes) {
    if (!bytes) { alert('PDFの作成に失敗しました。'); return; }
    var pdf = buildSheetPdf(bytes, canvas.width, canvas.height);
    shareBlobAsFile(new Blob([pdf], { type: 'application/pdf' }), fileName, 'application/pdf');
  });
}
function shareSheetImage() {
  drawSheetCanvas();
  var canvas = document.getElementById('sheetCanvas');
  if (!canvas) return;
  if (typeof canvas.toBlob === 'function') {
    canvas.toBlob(function (blob) {
      if (!blob) { alert('画像の作成に失敗しました。'); return; }
      shareBlobAsFile(blob, 'scoresheet.png', 'image/png');
    }, 'image/png');
  } else {
    alert('画像の作成に失敗しました。');
  }
}
/* 保存・共有ボタン（シート上部と下部の両方）を data-act で振り分ける */
document.getElementById('tab-sheet').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-act]');
  if (!b) return;
  var act = b.dataset.act;
  if (act === 'saveImage') saveSheetImage();
  else if (act === 'shareImage') shareSheetImage();
  else if (act === 'savePdf') saveSheetPdf();
  else if (act === 'sharePdf') shareSheetPdf();
});

/* スコアシートプレビューの拡大・縮小（スマホでは全体表示だと文字が読めないため。
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
/* 練習モードの見本選手（架空）。各チーム15人分の名前を用意し、
   実際に登録するのは14人か15人（ランダム）にする */
var PRACTICE_POOL = {
  A: [['4', '佐藤さくら', '101'], ['5', '鈴木あおい', '102'], ['6', '高橋ゆい', '103'],
      ['7', '田中りん', '104'], ['8', '伊藤めい', '105'], ['9', '渡辺ほのか', '106'],
      ['10', '山本ことね', '107'], ['11', '中村すず', '108'], ['12', '小林はな', '109'],
      ['13', '加藤ゆず', '110'], ['14', '斉藤ゆら', '111'], ['15', '近藤あんな', '112'],
      ['16', '坂本りお', '113'], ['17', '藤田ももか', '114'], ['18', '西村ひより', '115']],
  B: [['4', '山田みく', '201'], ['5', '佐々木れな', '202'], ['6', '井上かえで', '203'],
      ['7', '山口つむぎ', '204'], ['8', '松本しおり', '205'], ['9', '木村のぞみ', '206'],
      ['10', '林あかり', '207'], ['11', '清水まお', '208'], ['12', '森ことり', '209'],
      ['13', '石川るな', '210'], ['14', '村田さや', '211'], ['15', '大野ちひろ', '212'],
      ['16', '岡田りんか', '213'], ['17', '長谷川ゆめ', '214'], ['18', '吉田あんず', '215']]
};
function practicePlayers(t) {
  var n = 14 + Math.floor(Math.random() * 2); /* 14人か15人 */
  var pool = PRACTICE_POOL[t];
  var players = [];
  for (var i = 0; i < 15; i++) {
    if (i < n) players.push({ no: pool[i][0], name: pool[i][1], license: pool[i][2] });
    else players.push({ no: '', name: '', license: '' });
  }
  return players;
}
function practiceSeed() {
  var s = {
    game: { tournament: '練習カップ', date: '', time: '', venue: 'みどり小学校', gameNo: '', endTime: '', crewChief: '', umpire: '', scorer: '', timer: '', aScorer: '', shotClock: '', use3pt: false, finished: false },
    teams: {
      A: { name: 'さくらミニバス', color: '白', coach: { name: '佐々木 健', license: '047' }, acoach: { name: '中村 翔', license: '059' }, players: practicePlayers('A') },
      B: { name: 'ひまわりミニバス', color: '青', coach: { name: '高田 修', license: '078' }, acoach: { name: '青木 翔', license: '082' }, players: practicePlayers('B') }
    },
    quarter: '1', events: [], fouls: [], participation: { A: {}, B: {} },
    timeouts: { A: {}, B: {} }, toSeq: { A: {}, B: {} }, seqNext: 1, history: []
  };
  var d = new Date();
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  s.game.date = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  return s;
}
/* 保存済みの練習データが旧見本（各チーム10人）のままかどうか */
function isOldPracticeSeed(st) {
  if (!st || !st.teams) return false;
  return ['A', 'B'].every(function (t) {
    var ps = (st.teams[t] && st.teams[t].players) || [];
    for (var i = 0; i < 10; i++) {
      if (!ps[i] || ps[i].name !== PRACTICE_POOL[t][i][1]) return false;
    }
    return !(ps[10] && ps[10].name);
  });
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
  writeText(MODE_KEY, 'practice');
  var st = loadFrom(PRACTICE_KEY);
  /* 練習データが空（選手が一人もいない）ときは、見本の選手で入れ直す。
     「新しい試合」で空の状態が保存されてしまっても、入り直せば復活する */
  if (!st || (!stateHasPlayers(st) && !(st.events || []).length)) st = practiceSeed();
  /* 旧見本（各チーム10人）のまま一度も記録されていない練習データは、
     新しい見本（14〜15人）に入れ替える。記録が入っているものは触らない */
  if (st && !(st.events || []).length && !(st.fouls || []).length && isOldPracticeSeed(st)) st = practiceSeed();
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
  var a = readJson(archiveKey(), []);
  return Array.isArray(a) ? a : [];
}
function saveArchive(a) { writeJson(archiveKey(), a); }
function archiveCurrent() {
  if (!gameHasContent(S)) return;
  var a = loadArchive();
  a.unshift({ savedAt: new Date().toISOString(), state: deepCopy(S) });
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
function buildBackupPayload() {
  var data = {};
  BACKUP_KEYS.forEach(function (k) {
    try { var v = localStorage.getItem(k); if (v != null) data[k] = v; } catch (e) {}
  });
  return {
    app: 'minibas-scoresheet', kind: 'backup', version: 1,
    exportedAt: new Date().toISOString(), data: data
  };
}
function exportBackup() {
  var payload = buildBackupPayload();
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

/* ---------- 自動バックアップ ----------
   「試合終了」にチェックした時点で、その時点の全データをアプリ内
   （localStorage）に自動保存する。最大3件。復元はファイルからの
   復元と同じ検証・確認を通す。端末自体の故障には備えられないので、
   ファイルへの書き出しと併用する想定。 */
var AUTOBACKUP_KEY = 'minibas-scoresheet-autobackup-v1';
function loadAutoBackups() {
  var v = readJson(AUTOBACKUP_KEY, []);
  return Array.isArray(v) ? v : [];
}
function runAutoBackup() {
  var list = loadAutoBackups();
  list.unshift(buildBackupPayload());
  list = list.slice(0, 3);
  writeJson(AUTOBACKUP_KEY, list);
  renderAutoBackupInfo();
}
function renderAutoBackupInfo() {
  var el = document.getElementById('autoBackupInfo');
  var btn = document.getElementById('btnAutoBackupRestore');
  if (!el) return;
  var list = loadAutoBackups();
  if (!list.length) {
    el.textContent = '自動バックアップ：まだありません。';
    if (btn) btn.disabled = true;
    return;
  }
  var d = new Date(list[0].exportedAt);
  el.textContent = '自動バックアップ：最新は ' +
    (isNaN(d.getTime()) ? '日時不明' : d.toLocaleString('ja-JP')) +
    '（' + list.length + '件保存）';
  if (btn) btn.disabled = false;
}
document.getElementById('btnAutoBackupRestore').addEventListener('click', function () {
  var list = loadAutoBackups();
  if (!list.length) return;
  var root = document.getElementById('abModalList');
  root.innerHTML = list.map(function (p, i) {
    var d = new Date(p.exportedAt);
    var when = isNaN(d.getTime()) ? '日時不明' : d.toLocaleString('ja-JP');
    var sum = '';
    try {
      var st = p.data[STORE_KEY] ? JSON.parse(p.data[STORE_KEY]) : null;
      if (st && st.teams) sum = (st.teams.A.name || 'チームA') + ' 対 ' + (st.teams.B.name || 'チームB');
    } catch (e) {}
    return '<button type="button" class="pick-item" data-ab="' + i + '">' + esc(when) +
      (sum ? '<span class="pick-sub">' + esc(sum) + '</span>' : '') + '</button>';
  }).join('');
  document.getElementById('abModal').classList.remove('hidden');
});
document.getElementById('abModalList').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-ab]');
  if (!b) return;
  var list = loadAutoBackups();
  var p = list[Number(b.dataset.ab)];
  document.getElementById('abModal').classList.add('hidden');
  if (p) handleBackupText(JSON.stringify(p));
});
document.getElementById('abModalCancel').addEventListener('click', function () {
  document.getElementById('abModal').classList.add('hidden');
});
renderAutoBackupInfo();

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
    writeText(SCREEN_KEY, chkKeepScreenOnEl.checked ? 'on' : 'off');
    applyKeepScreenOn();
  });
}
applyKeepScreenOn();

/* ---------- 背景のカスタマイズ（一番後ろの背景だけ） ----------
   変えるのは body の背景だけ。公式シートの様式・白いカード類には触れない。
   写真は白かぶせ（60〜97%）を重ねるので、文字の読みにくさは出ない設計。
   設定は localStorage（BG_KEY）に保存し、バックアップの対象キーには含めない
   （端末ごとの見た目の設定なので）。 */
var BG_KEY = 'minibas-scoresheet-bg-v1';
var bgSetting = { kind: 'default', color: '', data: '', overlay: 85 };
try {
  var bgRaw = localStorage.getItem(BG_KEY);
  if (bgRaw) {
    var bgParsed = JSON.parse(bgRaw);
    if (bgParsed && (bgParsed.kind === 'color' || bgParsed.kind === 'image')) {
      bgSetting = {
        kind: bgParsed.kind,
        color: bgParsed.color || '',
        data: bgParsed.data || '',
        overlay: Math.min(97, Math.max(60, Number(bgParsed.overlay) || 85))
      };
    }
  }
} catch (e) {}
function saveBgSetting() { writeJson(BG_KEY, bgSetting); }
function applyBg() {
  var b = document.body;
  if (!b) return;
  b.style.backgroundImage = '';
  b.style.backgroundColor = '';
  b.style.backgroundSize = '';
  b.style.backgroundPosition = '';
  b.style.backgroundRepeat = '';
  b.style.backgroundAttachment = '';
  if (bgSetting.kind === 'color' && bgSetting.color) {
    b.style.backgroundColor = bgSetting.color;
  } else if (bgSetting.kind === 'image' && bgSetting.data) {
    var a = bgSetting.overlay / 100;
    b.style.backgroundColor = '#f4f6f8';
    b.style.backgroundImage = 'linear-gradient(rgba(255,255,255,' + a + '), rgba(255,255,255,' + a + ')), url("' + bgSetting.data + '")';
    b.style.backgroundSize = 'cover';
    b.style.backgroundPosition = 'center center';
    b.style.backgroundRepeat = 'no-repeat';
    b.style.backgroundAttachment = 'fixed';
  }
  var swatches = document.querySelectorAll('.bg-swatch');
  for (var i = 0; i < swatches.length; i++) {
    var v = swatches[i].getAttribute('data-bg');
    var on = (bgSetting.kind === 'default' && v === 'default') ||
             (bgSetting.kind === 'color' && v === bgSetting.color);
    if (on) swatches[i].classList.add('selected'); else swatches[i].classList.remove('selected');
  }
  var ov = document.getElementById('bgOverlay');
  if (ov) ov.value = bgSetting.overlay;
  var ovv = document.getElementById('bgOverlayVal');
  if (ovv) ovv.textContent = bgSetting.overlay + '%';
  var st = document.getElementById('bgStatus');
  if (st) {
    st.textContent = '現在の背景：' + (bgSetting.kind === 'image' ? '写真（白かぶせ ' + bgSetting.overlay + '%）'
      : bgSetting.kind === 'color' ? '色（' + bgSetting.color + '）' : 'デフォルト');
  }
}
window.__bgPicked = function (dataUrl) {
  if (!dataUrl) return;
  bgSetting = { kind: 'image', color: '', data: dataUrl, overlay: bgSetting.overlay || 85 };
  saveBgSetting();
  applyBg();
};
(function wireBgSettings() {
  var sw = document.getElementById('bgSwatches');
  if (sw) {
    sw.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.bg-swatch') : null;
      if (!btn) return;
      var v = btn.getAttribute('data-bg');
      if (v === 'default') {
        bgSetting = { kind: 'default', color: '', data: '', overlay: bgSetting.overlay || 85 };
      } else {
        bgSetting = { kind: 'color', color: v, data: '', overlay: bgSetting.overlay || 85 };
      }
      saveBgSetting();
      applyBg();
    });
  }
  var pick = document.getElementById('btnBgPick');
  var fileInput = document.getElementById('bgFileInput');
  if (pick) {
    pick.addEventListener('click', function () {
      if (window.AndroidBg && typeof AndroidBg.pickImage === 'function') {
        AndroidBg.pickImage();
      } else if (fileInput) {
        fileInput.click();
      }
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      var url = URL.createObjectURL(f);
      var img = new Image();
      img.onload = function () {
        var maxDim = 1080;
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        window.__bgPicked(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { URL.revokeObjectURL(url); };
      img.src = url;
    });
  }
  var reset = document.getElementById('btnBgReset');
  if (reset) {
    reset.addEventListener('click', function () {
      bgSetting = { kind: 'default', color: '', data: '', overlay: 85 };
      saveBgSetting();
      applyBg();
    });
  }
  var ov = document.getElementById('bgOverlay');
  if (ov) {
    ov.addEventListener('input', function () {
      bgSetting.overlay = Math.min(97, Math.max(60, Number(ov.value) || 85));
      if (bgSetting.kind === 'image') { saveBgSetting(); applyBg(); }
      else {
        var ovv = document.getElementById('bgOverlayVal');
        if (ovv) ovv.textContent = bgSetting.overlay + '%';
        saveBgSetting();
      }
    });
  }
})();
applyBg();

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
  /* 結果も失敗も大きく一瞬表示する（体育館でも見やすく）。
     小さなステータス欄だけでは、記録できなかったときに気づけないため、
     「解釈できませんでした」等の失敗も必ずトーストで見せる */
  if (msg) {
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
  /* 音声認識が長音を「ウ／イ」で返す場合（ツウ・つう・スリイ等）を
     「ー」表記にそろえる（この正規化は音声コマンド専用） */
  s = s.replace(/(ツ|つ)[ウゥうぅ]/g, '$1ー');
  s = s.replace(/スリ[イィいぃ]/g, 'スリー');
  s = s.replace(/すり[イィいぃ]/g, 'すりー');
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
  /* タイムアウト：経過分つき（「タイムアウト 4分」）ならそのまま記録し、
     分が無ければ経過分ピッカーを開く（各Qに1回まで） */
  if (s.indexOf('タイムアウト') !== -1) {
    if (timeoutTaken(voiceTeam, S.quarter)) {
      voiceStatus(heard + 'チーム' + voiceTeam + 'は、このクォーターのタイムアウトをすでに取っています');
      return;
    }
    var mt = s.match(/(\d+)\s*分/);
    if (mt) {
      var mn = Number(mt[1]);
      if (addTimeout(voiceTeam, mn)) {
        voiceStatus(heard + 'チーム' + voiceTeam + 'のタイムアウト（経過' + mn + '分）を記録しました');
      } else {
        voiceStatus(heard + '記録しませんでした');
      }
    } else {
      openToModal(voiceTeam, true);
      voiceStatus(heard + 'チーム' + voiceTeam + 'のタイムアウトです。経過分を選んでください');
    }
    return;
  }
  /* ファウル：種別とフリースロー本数も声で指定できる
     「7番 ファウル」→P、「7番 ファウル 2本」→P2、
     「7番 アンスポ 2本」→U2、「7番 テクニカル」→T1、
     「7番 ディスクォリファイイング」→D */
  m = s.match(/(\d+)番/);
  if (m && /(ファウル|ファール|アンスポ|テクニカル|ディスクォリファイイング)/.test(s)) {
    var fi = findPlayerIdxByNo(voiceTeam, Number(m[1]));
    if (fi < 0) { voiceStatus(heard + m[1] + '番の選手が登録されていません'); return; }
    var ftn = s.match(/(\d+)本/);
    var fft = ftn ? Number(ftn[1]) : 0;
    var ftype;
    if (s.indexOf('アンスポ') !== -1) ftype = 'U' + (fft >= 1 && fft <= 2 ? fft : '');
    else if (s.indexOf('テクニカル') !== -1) ftype = 'T1';
    else if (s.indexOf('ディスクォリファイイング') !== -1) ftype = 'D';
    else ftype = 'P' + (fft >= 1 && fft <= 3 ? fft : '');
    if (addFoul(voiceTeam, fi, ftype)) voiceStatus(heard + teamLabel(voiceTeam) + ' ' + m[1] + '番にファウル（' + ftype + '）を追加しました');
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
  /* 得点（カタカナ・ひらがなの言い方）：「4番 スリー」→3点、「4番 ツー」→2点。
     音声認識がひらがなで返す場合（すりー／つー）も同じに扱う */
  m = s.match(/(\d+)番.*(スリー|すりー|ツー|つー)/);
  if (m) {
    var kpts = (m[2] === 'スリー' || m[2] === 'すりー') ? 3 : 2;
    if (kpts === 3 && !S.game.use3pt) {
      voiceStatus(heard + '3ポイントは採用されていません（試合情報タブで有効にしてください）');
      return;
    }
    var ki = findPlayerIdxByNo(voiceTeam, Number(m[1]));
    if (ki < 0) { voiceStatus(heard + m[1] + '番の選手が登録されていません'); return; }
    if (addScore(voiceTeam, ki, kpts)) voiceStatus(heard + teamLabel(voiceTeam) + ' ' + m[1] + '番に' + kpts + '点を追加しました');
    else voiceStatus(heard + '記録しませんでした');
    return;
  }
  /* 得点：「4番 2点」「4番 2ポイント」 */
  m = s.match(/(\d+)番[^\d]*(\d+)(点|ポイント|ポインツ)/);
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
  /* 得点（数字だけの言い方）：「4番2」→2点、「4番1」→1点。
     音声認識が「ツー」を数字の「2」に変換して返すことがあり、その場合は
     「点」が付かない。番号＋数字だけの発話に限って得点として受け付ける
     （「ファウル」等の語がある発話は上の分岐が先に処理する） */
  m = s.match(/^(\d+)番(\d+)(ポイント|ポインツ)?$/);
  if (m) {
    var bpts = Number(m[2]);
    if (bpts < 1 || bpts > 3) { voiceStatus(heard + '解釈できませんでした'); return; }
    if (bpts === 3 && !S.game.use3pt) {
      voiceStatus(heard + '3ポイントは採用されていません（試合情報タブで有効にしてください）');
      return;
    }
    var bi = findPlayerIdxByNo(voiceTeam, Number(m[1]));
    if (bi < 0) { voiceStatus(heard + m[1] + '番の選手が登録されていません'); return; }
    if (addScore(voiceTeam, bi, bpts)) voiceStatus(heard + teamLabel(voiceTeam) + ' ' + m[1] + '番に' + bpts + '点を追加しました');
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

/* ---------- 起動時のバインダー表紙 ----------
   起動直後は表紙を見せ、約1秒で左へ開くアニメーションで外す。
   タップすればすぐ開く。演出だけなので、初期化はこの下で通常どおり進む。 */
(function binderIntro() {
  var cover = document.getElementById('binderCover');
  if (!cover) return;
  var bv = document.getElementById('binderVersion');
  if (bv) bv.textContent = 'バージョン ' + APP_VERSION;
  /* 表紙の絵柄は index.html の <head> 内スクリプトが描画前に抽選し、
     window.__coverVariant に入れてある（クラスも付与済み）。ここでは使うだけ。
     万一入っていない場合のみ、従来どおりここで抽選する（抽選は常に1回だけ）。 */
  var variant = window.__coverVariant;
  if (variant !== 'a' && variant !== 'b' && variant !== 'c' && variant !== 'd' && variant !== 'rare') {
    var COVER_QUEUE_KEY = 'minibas-scoresheet-cover-queue-v1';
    if (Math.random() < 0.10) {
      variant = 'rare';
    } else {
      var queue = [];
      var qRaw = readJson(COVER_QUEUE_KEY, []);
      if (Array.isArray(qRaw)) queue = qRaw.filter(function (v) { return v === 'a' || v === 'b' || v === 'c' || v === 'd'; });
      if (!queue.length) {
        queue = ['a', 'b', 'c', 'd'];
        for (var qi = queue.length - 1; qi > 0; qi--) {
          var qj = Math.floor(Math.random() * (qi + 1));
          var qt = queue[qi]; queue[qi] = queue[qj]; queue[qj] = qt;
        }
      }
      variant = queue.shift();
      writeJson(COVER_QUEUE_KEY, queue);
    }
    window.__coverVariant = variant;
  }
  cover.classList.add('cover-' + variant);
  var done = false;
  function open() {
    if (done) return;
    done = true;
    cover.classList.add('opening');
    setTimeout(function () {
      if (cover.parentNode) cover.parentNode.removeChild(cover);
    }, 760);
  }
  cover.addEventListener('click', open);
  setTimeout(open, 950);
})();

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
