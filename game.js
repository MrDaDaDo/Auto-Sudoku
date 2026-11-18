const DIFFS = ['beginner', 'easy', 'medium', 'hard', 'expert', 'hell', 'custom'];
const SETTINGS_KEY = 'sudokuSettings';
const BEST_KEY = 'sudokuBest';
const STATS_KEY = 'sudokuStats';
const RESTART_MS = 1200;
const CENTER = 40;

const $ = id => document.getElementById(id);
const boardEl = $('board');
const padEl = $('pad');
const mistakesEl = $('mistakes');
const timeEl = $('time');
const bestEl = $('best');
const overlayEl = $('overlay');
const diffSelect = $('diffSelect');
const customBox = $('customBox');
const customInput = $('customInput');
const customMsg = $('customMsg');
const noteModeBtn = $('noteMode');
const aiToggle = $('aiToggle');
const aiStatus = $('aiStatus');
const statsEl = $('stats');
const t = I18N.t;

function loadJSON(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...fallback }; }
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 無法存取 localStorage 時忽略 */ }
}

const DEFAULT_SETTINGS = {
  diff: 'easy',
  delay: 150,
  autoRestart: false,
  showCands: false,
  autoCheck: true,
};
const settings = loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS);
if (!DIFFS.includes(settings.diff)) settings.diff = DEFAULT_SETTINGS.diff;
const bestTimes = loadJSON(BEST_KEY, {});
const stats = loadJSON(STATS_KEY, {});

// puzzle 題目給的數字、solution 解答、grid 目前盤面、notes 每格筆記的位元遮罩
let puzzle, solution, grid, notes;
// editing：自訂題目的輸入階段，此時填入的數字都算題目
let editing, started, over, mistakes;
let selected = -1;
let history = [];
let startTime = 0, endTime = 0, timerId = null;
// humanPlayed / aiPlayed：本局是否有玩家或 AI 操作，用來決定要記錄最佳時間還是 AI 戰績
let humanPlayed, aiPlayed, actingAi = false;
let hintIdx = -1;
let noteMode = false;
let customMsgKey = '';
let cellEls = [];
let cellKeys = [];
let padEls = [];

function newGame(keepAi = false) {
  if (!keepAi) stopAi();
  stopTimer();
  editing = settings.diff === 'custom';
  puzzle = new Uint8Array(81);
  solution = null;
  if (!editing) ({ puzzle, solution } = Solver.generate(settings.diff));
  grid = Uint8Array.from(puzzle);
  notes = new Uint16Array(81);
  started = false;
  over = false;
  mistakes = 0;
  selected = -1;
  history = [];
  humanPlayed = false;
  aiPlayed = false;
  hintIdx = -1;
  overlayEl.classList.remove('show');
  setCustomMsg(editing ? 'customHint' : '');
  render();
  updateCounters();
  updateStats();
}

function buildBoard() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 81; i++) {
    const r = Math.floor(i / 9), c = i % 9;
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.i = i;
    // 每三格後多一條框線軌道，所以要跳過那些欄列
    el.style.gridRow = r + 1 + Math.floor(r / 3);
    el.style.gridColumn = c + 1 + Math.floor(c / 3);
    frag.appendChild(el);
    cellEls.push(el);
  }
  boardEl.appendChild(frag);
  for (let d = 1; d <= 9; d++) {
    const btn = document.createElement('button');
    btn.textContent = d;
    btn.dataset.d = d;
    padEl.appendChild(btn);
    padEls.push(btn);
  }
}

// ---------- 遊戲規則 ----------

// 每次變更盤面前呼叫：記錄操作者、啟動計時、存下可復原的狀態
function beginChange() {
  if (actingAi) aiPlayed = true;
  else humanPlayed = true;
  if (!started) {
    started = true;
    startTimer();
  }
  history.push({ grid: Uint8Array.from(grid), notes: Uint16Array.from(notes) });
}

function setDigit(i, d) {
  if (over || i < 0) return;
  if (editing) {
    grid[i] = grid[i] === d ? 0 : d;
    return;
  }
  if (puzzle[i]) return;
  const bit = 1 << (d - 1);
  if (noteMode && !actingAi) {
    if (grid[i]) return;
    beginChange();
    notes[i] ^= bit;
    return;
  }
  beginChange();
  // 再按一次同樣的數字等於清除
  if (grid[i] === d) {
    grid[i] = 0;
    return;
  }
  grid[i] = d;
  notes[i] = 0;
  for (const p of Solver.PEERS[i]) notes[p] &= ~bit;
  if (d !== solution[i]) mistakes++;
  else if (grid.every((v, k) => v === solution[k])) finishGame();
}

function erase(i) {
  if (over || i < 0) return;
  if (editing) {
    grid[i] = 0;
    return;
  }
  if (puzzle[i] || (!grid[i] && !notes[i])) return;
  beginChange();
  grid[i] = 0;
  notes[i] = 0;
}

function undo() {
  if (over || editing || !history.length) return;
  const prev = history.pop();
  grid = prev.grid;
  notes = prev.notes;
  humanPlayed = true;
}

function isWrong(i) {
  return !editing && grid[i] && !puzzle[i] && grid[i] !== solution[i];
}

function finishGame() {
  over = true;
  stopTimer();
  const key = settings.diff;
  if (aiPlayed && !humanPlayed) {
    const s = stats[key] || (stats[key] = { solved: 0 });
    s.solved++;
    saveJSON(STATS_KEY, stats);
  }
  if (humanPlayed && !aiPlayed && key !== 'custom') {
    const time = Math.round(elapsed());
    if (!bestTimes[key] || time < bestTimes[key]) {
      bestTimes[key] = time;
      saveJSON(BEST_KEY, bestTimes);
    }
  }
  overlayEl.classList.add('show');
  updateStats();
}

// 執行一次操作並重繪；byAi 用來區分是玩家還是 AI 的操作
function act(fn, byAi = false) {
  if (over) return;
  actingAi = byAi;
  fn();
  actingAi = false;
  hintIdx = -1;
  render();
  updateCounters();
}

// ---------- 自訂題目 ----------

function setCustomMsg(key, isError = false) {
  customMsgKey = key;
  customMsg.textContent = key ? t(key) : '';
  customMsg.classList.toggle('error', isError);
}

// 把貼上的 81 個字元（0 或 . 代表空格）載入盤面
function loadCustomString() {
  const text = customInput.value.replace(/\s+/g, '');
  if (!/^[0-9.]{81}$/.test(text)) {
    setCustomMsg('customBad', true);
    return;
  }
  newGame();
  for (let i = 0; i < 81; i++) grid[i] = text[i] === '.' ? 0 : Number(text[i]);
  render();
}

// 檢查輸入的題目恰有一組解，通過後才開始遊戲
function startCustom() {
  if (!editing) return true;
  const result = Solver.countSolutions(grid, 2);
  if (result.count !== 1) {
    setCustomMsg(result.count ? 'customMulti' : 'customNone', true);
    return false;
  }
  puzzle = Uint8Array.from(grid);
  solution = result.solution;
  editing = false;
  setCustomMsg('');
  render();
  return true;
}

$('loadCustom').addEventListener('click', loadCustomString);
$('startCustom').addEventListener('click', startCustom);
customInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') loadCustomString();
});

// ---------- 計時與顯示 ----------

function startTimer() {
  startTime = performance.now();
  timerId = setInterval(updateTime, 250);
}

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
    endTime = performance.now();
  }
}

function elapsed() {
  if (!started) return 0;
  return ((timerId ? performance.now() : endTime) - startTime) / 1000;
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function updateTime() {
  timeEl.textContent = formatTime(elapsed());
}

function updateCounters() {
  mistakesEl.textContent = settings.autoCheck ? mistakes : '—';
  updateTime();
  const best = bestTimes[settings.diff];
  bestEl.textContent = best ? formatTime(best) : '—';
}

function updateStats() {
  const s = stats[settings.diff];
  statsEl.textContent = s && s.solved ? t('stats', { n: s.solved }) : t('statsNone');
}

function notesHtml(mask) {
  let html = '<span class="notes">';
  for (let d = 0; d < 9; d++) html += '<i>' + (mask & (1 << d) ? d + 1 : '') + '</i>';
  return html + '</span>';
}

function render() {
  const auto = settings.showCands && !editing && !over ? Solver.candidates(grid) : null;
  const selDigit = selected >= 0 ? grid[selected] : 0;
  const counts = new Uint8Array(10);
  for (let i = 0; i < 81; i++) {
    const el = cellEls[i];
    const d = grid[i];
    counts[d]++;
    let cls = 'cell';
    if (d) {
      cls += editing || puzzle[i] ? ' given' : ' user';
      // 違反規則的重複數字一律標示；與解答不符的數字只在開啟「標示錯誤」時標示
      const conflict = Solver.PEERS[i].some(p => grid[p] === d);
      if (conflict || (settings.autoCheck && isWrong(i))) cls += ' wrong';
      if (d === selDigit) cls += ' same';
    }
    if (i === selected) cls += ' sel';
    else if (selected >= 0 && Solver.IS_PEER[selected][i]) cls += ' peer';
    if (i === hintIdx) cls += ' hint';
    if (el.className !== cls) el.className = cls;
    const mask = d ? 0 : auto ? auto[i] : notes[i];
    const key = d + ':' + mask;
    if (cellKeys[i] !== key) {
      cellKeys[i] = key;
      if (d) el.textContent = d;
      else if (mask) el.innerHTML = notesHtml(mask);
      else el.textContent = '';
    }
  }
  padEls.forEach((btn, k) => btn.classList.toggle('done', counts[k + 1] >= 9));
}

// ---------- 滑鼠 / 鍵盤操作 ----------

function select(i) {
  selected = i;
  hintIdx = -1;
  render();
}

boardEl.addEventListener('click', e => {
  const el = e.target.closest('.cell');
  if (el) select(Number(el.dataset.i));
});

padEl.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (btn) act(() => setDigit(selected, Number(btn.dataset.d)));
});

function toggleNoteMode() {
  noteMode = !noteMode;
  noteModeBtn.classList.toggle('active', noteMode);
}

const ARROWS = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };

document.addEventListener('keydown', e => {
  if (e.key === 'F2') {
    e.preventDefault();
    newGame();
    return;
  }
  if (e.target.matches('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    act(undo);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key in ARROWS) {
    e.preventDefault();
    if (selected < 0) {
      select(CENTER);
      return;
    }
    const step = ARROWS[e.key];
    const next = selected + step;
    // 左右移動不可跨到上一列或下一列
    const sameRow = Math.floor(next / 9) === Math.floor(selected / 9);
    if (next >= 0 && next < 81 && (Math.abs(step) === 9 || sameRow)) select(next);
  } else if (e.key >= '1' && e.key <= '9') {
    act(() => setDigit(selected, Number(e.key)));
  } else if (e.key === '0' || e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    act(() => erase(selected));
  } else if (e.key.toLowerCase() === 'n') {
    toggleNoteMode();
  }
});

noteModeBtn.addEventListener('click', toggleNoteMode);
$('undoBtn').addEventListener('click', () => act(undo));
$('eraseBtn').addEventListener('click', () => act(() => erase(selected)));
$('newGame').addEventListener('click', () => newGame());
$('retryBtn').addEventListener('click', () => newGame());

// ---------- 難度 ----------

function buildDiffSelect() {
  diffSelect.innerHTML = '';
  for (const key of DIFFS) diffSelect.add(new Option(t('diff_' + key), key));
  diffSelect.value = settings.diff;
  customBox.classList.toggle('show', settings.diff === 'custom');
}

diffSelect.addEventListener('change', () => {
  settings.diff = diffSelect.value;
  saveJSON(SETTINGS_KEY, settings);
  customBox.classList.toggle('show', settings.diff === 'custom');
  newGame();
});

// ---------- AI ----------

let aiRunning = false;
let aiRunId = 0;
let aiTimer = null;
let aiMoves = 0;

function updateAiToggle() {
  aiToggle.textContent = t(aiRunning ? 'aiStop' : 'aiStart');
  aiToggle.classList.toggle('running', aiRunning);
}

function startAi() {
  if (over) newGame();
  if (editing && !startCustom()) return;
  aiRunning = true;
  aiRunId++;
  aiMoves = 0;
  aiStatus.textContent = '';
  updateAiToggle();
  scheduleAi(aiRunId, 0);
}

function stopAi() {
  aiRunning = false;
  aiRunId++;
  clearTimeout(aiTimer);
  updateAiToggle();
}

function scheduleAi(runId, ms) {
  clearTimeout(aiTimer);
  aiTimer = setTimeout(() => aiStep(runId), ms);
}

// 下一個要執行的動作：盤面上有填錯的數字就先清掉，否則請求解器推出下一格
function nextAiAction() {
  for (let i = 0; i < 81; i++) {
    if (isWrong(i)) return { type: 'erase', i, tech: 'fix' };
  }
  const move = Solver.nextMove(grid);
  return move && { type: 'place', i: move.cell, d: move.digit, tech: move.tech };
}

// 每一步只填一格，並顯示這一步用到的技巧，方便觀看 AI 的推理過程
function aiStep(runId) {
  if (runId !== aiRunId) return;
  if (over) {
    newGame(true);
    aiMoves = 0;
    scheduleAi(runId, settings.delay);
    return;
  }
  const action = nextAiAction();
  if (!action) {
    stopAi();
    return;
  }
  act(() => {
    selected = action.i;
    if (action.type === 'erase') erase(action.i);
    else setDigit(action.i, action.d);
  }, true);
  aiMoves++;
  aiStatus.textContent = t('aiStatus', { n: aiMoves, tech: t('tech_' + action.tech) });
  // 自訂題目解完後沒有下一題可以自動開始
  if (over && (!settings.autoRestart || settings.diff === 'custom')) {
    stopAi();
    return;
  }
  scheduleAi(runId, over ? Math.max(RESTART_MS, settings.delay) : settings.delay);
}

aiToggle.addEventListener('click', () => (aiRunning ? stopAi() : startAi()));

$('hintBtn').addEventListener('click', () => {
  if (over || (editing && !startCustom())) return;
  const action = nextAiAction();
  if (!action) return;
  selected = action.i;
  hintIdx = action.i;
  render();
  aiStatus.textContent = action.type === 'erase'
    ? t('hintFix')
    : t('hintMsg', { tech: t('tech_' + action.tech) });
});

$('resetStats').addEventListener('click', () => {
  delete stats[settings.diff];
  saveJSON(STATS_KEY, stats);
  updateStats();
});

// ---------- 參數 ----------

const delayInput = $('delay');
const delayVal = $('delayVal');
delayInput.value = settings.delay;
delayVal.textContent = settings.delay;
delayInput.addEventListener('input', () => {
  settings.delay = Number(delayInput.value);
  delayVal.textContent = settings.delay;
  saveJSON(SETTINGS_KEY, settings);
});

for (const id of ['autoRestart', 'showCands', 'autoCheck']) {
  const input = $(id);
  input.checked = settings[id];
  input.addEventListener('change', () => {
    settings[id] = input.checked;
    saveJSON(SETTINGS_KEY, settings);
    render();
    updateCounters();
  });
}

// ---------- 語言 ----------

const langSelect = $('langSelect');

function buildLangSelect() {
  for (const [code, name] of Object.entries(I18N.NAMES)) {
    langSelect.add(new Option(name, code));
  }
  langSelect.value = I18N.getLang();
  langSelect.addEventListener('change', () => I18N.setLang(langSelect.value));
}

function applyDynamicText() {
  buildDiffSelect();
  updateAiToggle();
  updateStats();
  customInput.placeholder = t('customPlaceholder');
  customMsg.textContent = customMsgKey ? t(customMsgKey) : '';
  aiStatus.textContent = '';
}

I18N.onChange(applyDynamicText);

I18N.apply();
buildLangSelect();
buildBoard();
applyDynamicText();
newGame();
