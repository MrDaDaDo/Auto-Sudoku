// 數獨求解器：以人類解題技巧逐步推理（唯一數、區塊排除、數對、X-Wing…），推不下去才用回溯搜尋；也負責出題與難度分級
const Solver = (() => {
  const ALL = 0x1ff; // 9 個候選數的位元遮罩，第 d-1 位代表數字 d
  const MAX_ATTEMPTS = 500; // 出題時最多重試幾次來湊到目標難度（專家級平均約需 16 次）
  const SEARCH_LEVEL = 4;

  // 單元編號：0~8 橫列、9~17 直行、18~26 九宮格
  const ROW = new Uint8Array(81);
  const COL = new Uint8Array(81);
  const BOX = new Uint8Array(81);
  const UNITS = Array.from({ length: 27 }, () => []);
  for (let i = 0; i < 81; i++) {
    ROW[i] = Math.floor(i / 9);
    COL[i] = i % 9;
    BOX[i] = Math.floor(ROW[i] / 3) * 3 + Math.floor(COL[i] / 3);
    UNITS[ROW[i]].push(i);
    UNITS[9 + COL[i]].push(i);
    UNITS[18 + BOX[i]].push(i);
  }
  const unitsOf = i => [ROW[i], 9 + COL[i], 18 + BOX[i]];
  const inUnit = (u, i) => (u < 9 ? ROW[i] === u : u < 18 ? COL[i] === u - 9 : BOX[i] === u - 18);

  // 每格的 20 個同列、同行、同宮格子
  const IS_PEER = [];
  const PEERS = [];
  for (let i = 0; i < 81; i++) {
    const flags = new Uint8Array(81);
    for (const u of unitsOf(i)) for (const j of UNITS[u]) if (j !== i) flags[j] = 1;
    IS_PEER.push(flags);
    PEERS.push([...flags.keys()].filter(j => flags[j]));
  }

  // BITS[m]：遮罩中有幾個候選數；LOW[m]：最小候選數的位元位置
  const BITS = new Uint8Array(512);
  const LOW = new Uint8Array(512);
  for (let m = 1; m < 512; m++) {
    BITS[m] = BITS[m >> 1] + (m & 1);
    LOW[m] = m & 1 ? 0 : LOW[m >> 1] + 1;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- 回溯搜尋 ----------

  // 計算解的數量（最多數到 limit）並回傳找到的第一組解；random 為 true 時以隨機順序嘗試，用來產生完整盤面
  function countSolutions(grid, limit = 2, random = false) {
    const g = Uint8Array.from(grid);
    const row = new Uint16Array(9);
    const col = new Uint16Array(9);
    const box = new Uint16Array(9);
    for (let i = 0; i < 81; i++) {
      if (!g[i]) continue;
      const bit = 1 << (g[i] - 1);
      if ((row[ROW[i]] | col[COL[i]] | box[BOX[i]]) & bit) return { count: 0, solution: null };
      row[ROW[i]] |= bit;
      col[COL[i]] |= bit;
      box[BOX[i]] |= bit;
    }
    let count = 0;
    let solution = null;

    function rec() {
      // 每次挑候選數最少的空格來試，能大幅減少分支
      let best = -1, bestMask = 0, bestN = 10;
      for (let i = 0; i < 81; i++) {
        if (g[i]) continue;
        const m = ALL & ~(row[ROW[i]] | col[COL[i]] | box[BOX[i]]);
        if (BITS[m] < bestN) {
          best = i;
          bestMask = m;
          bestN = BITS[m];
          if (bestN <= 1) break;
        }
      }
      if (best < 0) {
        count++;
        if (!solution) solution = Uint8Array.from(g);
        return;
      }
      const bits = [];
      for (let m = bestMask; m; m &= m - 1) bits.push(m & -m);
      if (random) shuffle(bits);
      const r = ROW[best], c = COL[best], b = BOX[best];
      for (const bit of bits) {
        g[best] = LOW[bit] + 1;
        row[r] |= bit; col[c] |= bit; box[b] |= bit;
        rec();
        row[r] ^= bit; col[c] ^= bit; box[b] ^= bit;
        if (count >= limit) break;
      }
      g[best] = 0;
    }
    rec();
    return { count, solution };
  }

  // ---------- 邏輯推理 ----------

  // 推理狀態：g 為盤面，cand 為每個空格的候選數遮罩
  function makeState(grid) {
    const g = Uint8Array.from(grid);
    const cand = new Uint16Array(81);
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      let m = ALL;
      for (const p of PEERS[i]) if (g[p]) m &= ~(1 << (g[p] - 1));
      cand[i] = m;
    }
    return { g, cand };
  }

  function place(s, i, d) {
    const bit = 1 << (d - 1);
    s.g[i] = d;
    s.cand[i] = 0;
    for (const p of PEERS[i]) s.cand[p] &= ~bit;
  }

  // 從 arr 中列舉所有 k 個元素的組合，回傳 fn 第一個非空的結果
  function combos(arr, k, fn) {
    const sel = [];
    function rec(start) {
      if (sel.length === k) return fn(sel);
      for (let i = start; i <= arr.length - (k - sel.length); i++) {
        sel.push(arr[i]);
        const r = rec(i + 1);
        sel.pop();
        if (r) return r;
      }
      return null;
    }
    return rec(0);
  }

  // 唯一候選數：某格只剩一個數字可填
  function nakedSingle({ g, cand }) {
    for (let i = 0; i < 81; i++) {
      if (!g[i] && BITS[cand[i]] === 1) return { cell: i, digit: LOW[cand[i]] + 1 };
    }
    return null;
  }

  // 隱性唯一數：某個數字在一個單元中只剩一格可放（先看九宮格，較符合人的習慣）
  function hiddenSingle({ cand }) {
    for (let k = 0; k < 27; k++) {
      const u = (k + 18) % 27;
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        let where = -1, n = 0;
        for (const i of UNITS[u]) {
          if (cand[i] & bit) { where = i; n++; }
        }
        if (n === 1) return { cell: where, digit: d + 1, unit: u };
      }
    }
    return null;
  }

  // 區塊排除：某數字在一個單元中的候選格全落在另一個單元內，就能從後者的其他格刪掉它
  function locked({ cand }) {
    for (let u = 0; u < 27; u++) {
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        const cells = UNITS[u].filter(i => cand[i] & bit);
        if (cells.length < 2 || cells.length > 3) continue;
        for (const v of unitsOf(cells[0])) {
          if (v === u || !cells.every(i => inUnit(v, i))) continue;
          const elim = UNITS[v].filter(i => (cand[i] & bit) && !cells.includes(i)).map(i => [i, bit]);
          if (elim.length) return { elim };
        }
      }
    }
    return null;
  }

  // 顯性數組：單元中有 k 格的候選數合起來剛好 k 個，其他格就不能是這些數字
  function nakedSubset(k) {
    return ({ cand }) => {
      for (let u = 0; u < 27; u++) {
        const cells = UNITS[u].filter(i => cand[i]);
        if (cells.length <= k) continue;
        const pool = cells.filter(i => BITS[cand[i]] <= k);
        const hit = combos(pool, k, sel => {
          let m = 0;
          for (const i of sel) m |= cand[i];
          if (BITS[m] !== k) return null;
          const elim = cells.filter(i => !sel.includes(i) && (cand[i] & m)).map(i => [i, cand[i] & m]);
          return elim.length ? { elim } : null;
        });
        if (hit) return hit;
      }
      return null;
    };
  }

  // 隱性數組：單元中有 k 個數字只出現在 k 格內，這些格的其他候選數都能刪掉
  function hiddenSubset(k) {
    return ({ cand }) => {
      for (let u = 0; u < 27; u++) {
        const cells = UNITS[u].filter(i => cand[i]);
        if (cells.length <= k) continue;
        let left = 0;
        for (const i of cells) left |= cand[i];
        const digits = [];
        for (let m = left; m; m &= m - 1) digits.push(m & -m);
        const hit = combos(digits, k, sel => {
          let m = 0;
          for (const bit of sel) m |= bit;
          const holders = cells.filter(i => cand[i] & m);
          if (holders.length !== k) return null;
          const elim = holders.filter(i => cand[i] & ~m).map(i => [i, cand[i] & ~m]);
          return elim.length ? { elim } : null;
        });
        if (hit) return hit;
      }
      return null;
    };
  }

  // 魚形（k = 2 為 X-Wing，k = 3 為劍魚）：某數字在 k 條線上的候選格只落在 k 條交叉線上，
  // 就能從這些交叉線的其他格刪掉它
  function fish(k) {
    return ({ cand }) => {
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        for (const base of [0, 9]) {
          const lines = [];
          for (let u = base; u < base + 9; u++) {
            let m = 0;
            UNITS[u].forEach((i, pos) => { if (cand[i] & bit) m |= 1 << pos; });
            if (BITS[m] >= 2 && BITS[m] <= k) lines.push({ u, m });
          }
          const hit = combos(lines, k, sel => {
            let m = 0;
            for (const line of sel) m |= line.m;
            if (BITS[m] !== k) return null;
            const elim = [];
            for (let rest = m; rest; rest &= rest - 1) {
              const cover = (base === 0 ? 9 : 0) + LOW[rest & -rest];
              for (const i of UNITS[cover]) {
                if ((cand[i] & bit) && !sel.some(line => inUnit(line.u, i))) elim.push([i, bit]);
              }
            }
            return elim.length ? { elim } : null;
          });
          if (hit) return hit;
        }
      }
      return null;
    };
  }

  // XY-Wing：樞紐格 {x,y} 看得到兩個翼格 {x,z}、{y,z}，同時看得到兩個翼格的格子不可能是 z
  function xyWing({ cand }) {
    for (let p = 0; p < 81; p++) {
      if (BITS[cand[p]] !== 2) continue;
      const wings = PEERS[p].filter(i => BITS[cand[i]] === 2 && BITS[cand[i] & cand[p]] === 1);
      for (let x = 0; x < wings.length; x++) {
        for (let y = x + 1; y < wings.length; y++) {
          const a = wings[x], b = wings[y];
          const z = cand[a] & cand[b] & ~cand[p];
          if (BITS[z] !== 1 || ((cand[a] | cand[b]) & cand[p]) !== cand[p]) continue;
          const elim = [];
          for (let i = 0; i < 81; i++) {
            if ((cand[i] & z) && i !== a && i !== b && IS_PEER[a][i] && IS_PEER[b][i]) elim.push([i, z]);
          }
          if (elim.length) return { elim };
        }
      }
    }
    return null;
  }

  // 由易到難依序嘗試；level 用來替題目分級
  const TECHS = [
    { name: 'nakedSingle', level: 1, find: nakedSingle },
    { name: 'hiddenSingle', level: 1, find: hiddenSingle },
    { name: 'locked', level: 2, find: locked },
    { name: 'nakedPair', level: 2, find: nakedSubset(2) },
    { name: 'hiddenPair', level: 2, find: hiddenSubset(2) },
    { name: 'nakedTriple', level: 3, find: nakedSubset(3) },
    { name: 'hiddenTriple', level: 3, find: hiddenSubset(3) },
    { name: 'xWing', level: 3, find: fish(2) },
    { name: 'xyWing', level: 3, find: xyWing },
    { name: 'nakedQuad', level: 3, find: nakedSubset(4) },
    { name: 'swordfish', level: 3, find: fish(3) },
  ];

  // 找出下一個推理步驟：填入一格（cell / digit），或刪去一些候選數（elim）
  function findStep(s) {
    for (const tech of TECHS) {
      const step = tech.find(s);
      if (step) return { ...step, tech: tech.name, level: tech.level };
    }
    return null;
  }

  function applyElim(s, elim) {
    for (const [i, mask] of elim) s.cand[i] &= ~mask;
  }

  // 只用邏輯技巧解題，回傳所需的最高技巧等級（解不完則為 SEARCH_LEVEL）、各技巧使用次數，
  // 以及邏輯推不下去時還剩幾個空格（stuck，越多代表越難）
  function grade(puzzle) {
    const s = makeState(puzzle);
    const techs = {};
    let level = 0;
    for (;;) {
      const step = findStep(s);
      if (!step) break;
      techs[step.tech] = (techs[step.tech] || 0) + 1;
      level = Math.max(level, step.level);
      if (step.elim) applyElim(s, step.elim);
      else place(s, step.cell, step.digit);
    }
    let stuck = 0;
    for (let i = 0; i < 81; i++) if (!s.g[i]) stuck++;
    return { level: stuck ? SEARCH_LEVEL : level, solved: !stuck, techs, stuck };
  }

  // 下一個要填的格子與數字。tech 為過程中用到的最難技巧；邏輯推不出來時改用回溯搜尋（tech 為 'search'）
  // 盤面無解時回傳 null
  function nextMove(grid) {
    const s = makeState(grid);
    let hardest = null;
    for (;;) {
      const step = findStep(s);
      if (!step) break;
      if (!step.elim) {
        const tech = hardest && hardest.level > step.level ? hardest.tech : step.tech;
        return { cell: step.cell, digit: step.digit, tech, unit: step.unit };
      }
      applyElim(s, step.elim);
      if (!hardest || step.level > hardest.level) hardest = step;
    }
    const { solution } = countSolutions(grid, 1);
    if (!solution) return null;
    let cell = -1;
    for (let i = 0; i < 81; i++) {
      if (!grid[i] && (cell < 0 || BITS[s.cand[i]] < BITS[s.cand[cell]])) cell = i;
    }
    return cell < 0 ? null : { cell, digit: solution[cell], tech: 'search' };
  }

  // ---------- 出題 ----------

  // minGivens：提示數下限；maxLevel：挖洞時允許的最高技巧等級；minLevel：成品至少要用到的等級
  // 地獄級不限技巧、不要求對稱（能挖得更乾淨），而且邏輯卡住時至少還要剩 minStuck 個空格，只能靠試誤法
  const SPECS = {
    beginner: { minGivens: 46, maxLevel: 1, minLevel: 1 },
    easy: { minGivens: 38, maxLevel: 1, minLevel: 1 },
    medium: { minGivens: 28, maxLevel: 1, minLevel: 1 },
    hard: { minGivens: 24, maxLevel: 2, minLevel: 2 },
    expert: { minGivens: 22, maxLevel: 3, minLevel: 3 },
    hell: { minGivens: 17, maxLevel: SEARCH_LEVEL, minLevel: SEARCH_LEVEL, minStuck: 40, symmetric: false },
  };

  // 先產生完整盤面，再隨機挖洞（預設中心對稱，一次挖兩格）；每挖一次都確認仍是唯一解且不超過目標難度
  function generate(diff) {
    const spec = SPECS[diff] || SPECS.easy;
    let fallback = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const { solution } = countSolutions(new Uint8Array(81), 1, true);
      const puzzle = Uint8Array.from(solution);
      let givens = 81;
      for (const i of shuffle([...Array(81).keys()])) {
        if (givens <= spec.minGivens) break;
        if (!puzzle[i]) continue;
        const j = spec.symmetric === false ? i : 80 - i;
        puzzle[i] = 0;
        puzzle[j] = 0;
        // 邏輯技巧能解完就代表唯一解；最高難度不限技巧，直接檢查解的數量
        const ok = spec.maxLevel >= SEARCH_LEVEL
          ? countSolutions(puzzle, 2).count === 1
          : grade(puzzle).level <= spec.maxLevel;
        if (ok) {
          givens -= i === j ? 1 : 2;
        } else {
          puzzle[i] = solution[i];
          puzzle[j] = solution[j];
        }
      }
      const { level, stuck } = grade(puzzle);
      const result = { puzzle, solution, level, stuck };
      if (level >= spec.minLevel && stuck >= (spec.minStuck || 0)) return result;
      if (!fallback || level > fallback.level || (level === fallback.level && stuck > fallback.stuck)) fallback = result;
    }
    return fallback;
  }

  return {
    generate,
    nextMove,
    grade,
    countSolutions,
    candidates: grid => makeState(grid).cand,
    PEERS,
    IS_PEER,
  };
})();
