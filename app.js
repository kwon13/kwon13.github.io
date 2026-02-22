(() => {
  "use strict";

  const canvas = document.getElementById("evolving-maze-canvas");
  if (!canvas) {
    return;
  }
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return;
  }

  const BRUSH_RADIUS = 2;
  const MUTATION_RATE = 8;
  const INITIAL_WALL_DENSITY = 0.34;
  const RESIZE_WALL_DENSITY = 0.3;
  const GOAL_DISTANCE_RATIO = 0.42;

  const state = {
    width: 0,
    height: 0,
    dpr: 1,
    cellSize: 13,
    cols: 0,
    rows: 0,
    count: 0,
    grid: new Uint8Array(0),
    trail: new Float32Array(0),
    visitHeat: new Float32Array(0),
    lastMutatedFrame: new Uint32Array(0),
    searchMarks: new Uint32Array(0),
    searchQueue: new Int32Array(0)
  };

  const planner = {
    needsReplan: true,
    lastPlanAt: 0,
    replanCooldownMs: 70
  };

  const pointer = {
    inside: false,
    down: false,
    isMouse: true,
    x: 0,
    y: 0,
    movedSinceTick: false
  };

  const agent = {
    cell: -1,
    x: 0,
    y: 0,
    speed: 5.2
  };

  const goal = {
    cell: -1
  };

  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];

  let currentPath = [];
  let pathCursor = 1;
  let fallbackTarget = -1;
  let frameCount = 0;
  let lastFrameTime = performance.now();
  let searchToken = 1;

  class MinHeap {
    constructor() {
      this.items = [];
    }

    push(id, priority) {
      const node = { id, priority };
      this.items.push(node);
      this.bubbleUp(this.items.length - 1);
    }

    pop() {
      if (this.items.length === 0) {
        return -1;
      }

      const top = this.items[0];
      const end = this.items.pop();
      if (this.items.length > 0) {
        this.items[0] = end;
        this.sinkDown(0);
      }
      return top.id;
    }

    get size() {
      return this.items.length;
    }

    bubbleUp(index) {
      let i = index;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (this.items[parent].priority <= this.items[i].priority) {
          break;
        }
        const temp = this.items[parent];
        this.items[parent] = this.items[i];
        this.items[i] = temp;
        i = parent;
      }
    }

    sinkDown(index) {
      let i = index;
      const length = this.items.length;
      while (true) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;

        if (left < length && this.items[left].priority < this.items[smallest].priority) {
          smallest = left;
        }
        if (right < length && this.items[right].priority < this.items[smallest].priority) {
          smallest = right;
        }
        if (smallest === i) {
          break;
        }
        const temp = this.items[i];
        this.items[i] = this.items[smallest];
        this.items[smallest] = temp;
        i = smallest;
      }
    }
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function toIndex(x, y) {
    return y * state.cols + x;
  }

  function indexToX(index) {
    return index % state.cols;
  }

  function indexToY(index) {
    return (index / state.cols) | 0;
  }

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < state.cols && y < state.rows;
  }

  function isValidIndex(index) {
    return index >= 0 && index < state.count;
  }

  function isOpen(index) {
    return isValidIndex(index) && state.grid[index] === 0;
  }

  function manhattan(a, b) {
    const ax = indexToX(a);
    const ay = indexToY(a);
    const bx = indexToX(b);
    const by = indexToY(b);
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  function reinforceBorders() {
    for (let x = 0; x < state.cols; x += 1) {
      state.grid[toIndex(x, 0)] = 1;
      state.grid[toIndex(x, state.rows - 1)] = 1;
    }
    for (let y = 0; y < state.rows; y += 1) {
      state.grid[toIndex(0, y)] = 1;
      state.grid[toIndex(state.cols - 1, y)] = 1;
    }
  }

  function seedRandomWalls(density = INITIAL_WALL_DENSITY) {
    for (let i = 0; i < state.count; i += 1) {
      state.grid[i] = Math.random() < density ? 1 : 0;
    }
    reinforceBorders();
  }

  function hasReachablePath(start, end) {
    if (start === end) {
      return true;
    }
    if (state.grid[start] === 1 || state.grid[end] === 1) {
      return false;
    }

    searchToken += 1;
    if (searchToken === 0) {
      state.searchMarks.fill(0);
      searchToken = 1;
    }

    const marks = state.searchMarks;
    const queue = state.searchQueue;
    let head = 0;
    let tail = 0;

    marks[start] = searchToken;
    queue[tail] = start;
    tail += 1;

    while (head < tail) {
      const current = queue[head];
      head += 1;
      if (current === end) {
        return true;
      }

      const cx = indexToX(current);
      const cy = indexToY(current);
      for (let i = 0; i < DIRS.length; i += 1) {
        const nx = cx + DIRS[i][0];
        const ny = cy + DIRS[i][1];
        if (!inBounds(nx, ny)) {
          continue;
        }
        const next = toIndex(nx, ny);
        if (state.grid[next] === 1 || marks[next] === searchToken) {
          continue;
        }
        marks[next] = searchToken;
        queue[tail] = next;
        tail += 1;
      }
    }

    return false;
  }

  function carveGuaranteedCorridor(start, end) {
    let x = indexToX(start);
    let y = indexToY(start);
    const tx = indexToX(end);
    const ty = indexToY(end);
    const maxSteps = state.cols + state.rows + 24;

    for (let step = 0; step < maxSteps; step += 1) {
      state.grid[toIndex(x, y)] = 0;
      if (x === tx && y === ty) {
        break;
      }

      const dx = tx - x;
      const dy = ty - y;
      const favorX = Math.abs(dx) >= Math.abs(dy);
      const moveX = dx !== 0 && (dy === 0 || (favorX ? Math.random() > 0.2 : Math.random() < 0.2));

      if (moveX) {
        x += Math.sign(dx);
      } else if (dy !== 0) {
        y += Math.sign(dy);
      } else if (dx !== 0) {
        x += Math.sign(dx);
      }

      x = clamp(x, 1, state.cols - 2);
      y = clamp(y, 1, state.rows - 2);
      state.grid[toIndex(x, y)] = 0;
    }

    clearArea(start, 1);
    clearArea(end, 1);
    state.grid[start] = 0;
    state.grid[end] = 0;
  }

  function ensureReachability(silent = false) {
    if (hasReachablePath(agent.cell, goal.cell)) {
      return false;
    }

    carveGuaranteedCorridor(agent.cell, goal.cell);

    if (!hasReachablePath(agent.cell, goal.cell)) {
      let x = indexToX(agent.cell);
      let y = indexToY(agent.cell);
      const tx = indexToX(goal.cell);
      const ty = indexToY(goal.cell);

      while (x !== tx) {
        x += Math.sign(tx - x);
        state.grid[toIndex(x, y)] = 0;
      }
      while (y !== ty) {
        y += Math.sign(ty - y);
        state.grid[toIndex(x, y)] = 0;
      }
    }

    planner.needsReplan = true;
    return true;
  }

  function clearArea(centerIndex, radius) {
    if (!isValidIndex(centerIndex)) {
      return;
    }
    const cx = indexToX(centerIndex);
    const cy = indexToY(centerIndex);
    const radiusSq = radius * radius;
    const minX = clamp(cx - radius, 1, state.cols - 2);
    const maxX = clamp(cx + radius, 1, state.cols - 2);
    const minY = clamp(cy - radius, 1, state.rows - 2);
    const maxY = clamp(cy + radius, 1, state.rows - 2);

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        if ((dx * dx) + (dy * dy) <= radiusSq) {
          state.grid[toIndex(x, y)] = 0;
        }
      }
    }
  }

  function randomOpenCell(excludeIndex = -1, minDistance = 0) {
    const maxAttempts = 2500;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const x = 1 + (Math.random() * (state.cols - 2)) | 0;
      const y = 1 + (Math.random() * (state.rows - 2)) | 0;
      const index = toIndex(x, y);
      if (state.grid[index] === 1 || index === excludeIndex) {
        continue;
      }
      if (excludeIndex >= 0 && manhattan(index, excludeIndex) < minDistance) {
        continue;
      }
      return index;
    }

    for (let y = 1; y < state.rows - 1; y += 1) {
      for (let x = 1; x < state.cols - 1; x += 1) {
        const index = toIndex(x, y);
        if (state.grid[index] === 1 || index === excludeIndex) {
          continue;
        }
        if (excludeIndex >= 0 && manhattan(index, excludeIndex) < minDistance) {
          continue;
        }
        return index;
      }
    }

    return toIndex(1, 1);
  }

  function normalizedCell(normX, normY) {
    const x = clamp((normX * state.cols) | 0, 1, state.cols - 2);
    const y = clamp((normY * state.rows) | 0, 1, state.rows - 2);
    return toIndex(x, y);
  }

  function chooseOpenCell(preferredIndex, excludeIndex, minDistance) {
    if (isOpen(preferredIndex) && preferredIndex !== excludeIndex) {
      if (excludeIndex < 0 || manhattan(preferredIndex, excludeIndex) >= minDistance) {
        return preferredIndex;
      }
    }
    return randomOpenCell(excludeIndex, minDistance);
  }

  function initializeEntities(preferredAgent = -1, preferredGoal = -1) {
    const minGoalDistance = Math.floor((state.cols + state.rows) * GOAL_DISTANCE_RATIO);
    agent.cell = chooseOpenCell(preferredAgent, -1, 0);
    goal.cell = chooseOpenCell(preferredGoal, agent.cell, minGoalDistance);

    clearArea(agent.cell, 1);
    clearArea(goal.cell, 1);
    state.grid[agent.cell] = 0;
    state.grid[goal.cell] = 0;

    agent.x = indexToX(agent.cell) + 0.5;
    agent.y = indexToY(agent.cell) + 0.5;
    ensureReachability(true);
  }

  function configureCanvasAndGrid(preserve = true) {
    const prevCols = state.cols;
    const prevRows = state.rows;
    const prevGrid = state.grid;
    const prevTrail = state.trail;
    const prevAgentNormX = prevCols > 0 ? agent.x / prevCols : Math.random();
    const prevAgentNormY = prevRows > 0 ? agent.y / prevRows : Math.random();
    const prevGoalNormX = prevCols > 0 && goal.cell >= 0 ? indexToX(goal.cell) / prevCols : Math.random();
    const prevGoalNormY = prevRows > 0 && goal.cell >= 0 ? indexToY(goal.cell) / prevRows : Math.random();

    const rect = canvas.getBoundingClientRect();
    state.width = Math.max(1, Math.floor(rect.width));
    state.height = Math.max(1, Math.floor(rect.height));
    state.dpr = Math.max(1, window.devicePixelRatio || 1);
    const shortSide = Math.min(state.width, state.height);
    state.cellSize = shortSide < 520 ? 9 : shortSide < 760 ? 10 : 12;
    state.cols = Math.max(20, Math.floor(state.width / state.cellSize));
    state.rows = Math.max(14, Math.floor(state.height / state.cellSize));
    state.count = state.cols * state.rows;

    canvas.width = Math.floor(state.width * state.dpr);
    canvas.height = Math.floor(state.height * state.dpr);
    canvas.style.width = `${state.width}px`;
    canvas.style.height = `${state.height}px`;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    state.grid = new Uint8Array(state.count);
    state.trail = new Float32Array(state.count);
    state.visitHeat = new Float32Array(state.count);
    state.lastMutatedFrame = new Uint32Array(state.count);
    state.searchMarks = new Uint32Array(state.count);
    state.searchQueue = new Int32Array(state.count);

    if (preserve && prevGrid.length > 0) {
      seedRandomWalls(RESIZE_WALL_DENSITY);
      const copyCols = Math.min(prevCols, state.cols);
      const copyRows = Math.min(prevRows, state.rows);
      for (let y = 0; y < copyRows; y += 1) {
        for (let x = 0; x < copyCols; x += 1) {
          const oldIndex = y * prevCols + x;
          const nextIndex = toIndex(x, y);
          state.grid[nextIndex] = prevGrid[oldIndex];
          state.trail[nextIndex] = prevTrail[oldIndex] * 0.65;
        }
      }
      reinforceBorders();
      initializeEntities(
        normalizedCell(prevAgentNormX, prevAgentNormY),
        normalizedCell(prevGoalNormX, prevGoalNormY)
      );
    } else {
      seedRandomWalls(INITIAL_WALL_DENSITY);
      initializeEntities();
    }

    currentPath = [];
    pathCursor = 1;
    fallbackTarget = -1;
    planner.needsReplan = true;
  }

  function regenerateWorld() {
    seedRandomWalls(INITIAL_WALL_DENSITY);
    state.trail.fill(0);
    state.visitHeat.fill(0);
    state.lastMutatedFrame.fill(0);
    initializeEntities();
    currentPath = [];
    pathCursor = 1;
    fallbackTarget = -1;
    planner.needsReplan = true;
  }

  function shouldMutateFromPointer() {
    if (!pointer.inside) {
      return false;
    }
    if (!pointer.movedSinceTick) {
      return false;
    }
    if (pointer.isMouse) {
      return true;
    }
    return pointer.down;
  }

  function shouldShowPointerBrush() {
    if (!pointer.inside) {
      return false;
    }
    if (pointer.isMouse) {
      return true;
    }
    return pointer.down;
  }

  function mutateNearPointer() {
    const radius = BRUSH_RADIUS;
    const rate = MUTATION_RATE;
    const probability = 0.08 + (rate * 0.085);
    const cooldownFrames = Math.max(1, 12 - rate);

    const centerX = clamp((pointer.x / state.cellSize) | 0, 1, state.cols - 2);
    const centerY = clamp((pointer.y / state.cellSize) | 0, 1, state.rows - 2);
    const radiusSq = radius * radius;

    const minX = clamp(centerX - radius, 1, state.cols - 2);
    const maxX = clamp(centerX + radius, 1, state.cols - 2);
    const minY = clamp(centerY - radius, 1, state.rows - 2);
    const maxY = clamp(centerY + radius, 1, state.rows - 2);

    let changed = false;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - centerX;
        const dy = y - centerY;
        if ((dx * dx) + (dy * dy) > radiusSq) {
          continue;
        }

        const index = toIndex(x, y);
        if (index === agent.cell || index === goal.cell) {
          continue;
        }
        if (frameCount - state.lastMutatedFrame[index] < cooldownFrames) {
          continue;
        }
        if (Math.random() > probability) {
          continue;
        }

        state.grid[index] = state.grid[index] ^ 1;
        state.lastMutatedFrame[index] = frameCount;
        changed = true;
      }
    }

    if (changed) {
      clearArea(agent.cell, 1);
      clearArea(goal.cell, 1);
      state.grid[agent.cell] = 0;
      state.grid[goal.cell] = 0;
      ensureReachability(false);
      planner.needsReplan = true;
    }
  }

  function reconstructPath(cameFrom, end, start) {
    const path = [end];
    while (path[path.length - 1] !== start) {
      const prev = cameFrom[path[path.length - 1]];
      if (prev === -1) {
        return [];
      }
      path.push(prev);
    }
    path.reverse();
    return path;
  }

  function findPath(start, end) {
    if (start === end) {
      return [start];
    }

    const gScore = new Float32Array(state.count);
    gScore.fill(Number.POSITIVE_INFINITY);
    const cameFrom = new Int32Array(state.count);
    cameFrom.fill(-1);
    const closed = new Uint8Array(state.count);
    const open = new MinHeap();

    gScore[start] = 0;
    open.push(start, manhattan(start, end));

    let best = start;
    let bestHeuristic = manhattan(start, end);

    while (open.size > 0) {
      const current = open.pop();
      if (closed[current]) {
        continue;
      }
      closed[current] = 1;

      if (current === end) {
        return reconstructPath(cameFrom, end, start);
      }

      const currentHeuristic = manhattan(current, end);
      if (currentHeuristic < bestHeuristic) {
        bestHeuristic = currentHeuristic;
        best = current;
      }

      const cx = indexToX(current);
      const cy = indexToY(current);
      for (let i = 0; i < DIRS.length; i += 1) {
        const nx = cx + DIRS[i][0];
        const ny = cy + DIRS[i][1];
        if (!inBounds(nx, ny)) {
          continue;
        }
        const neighbor = toIndex(nx, ny);
        if (state.grid[neighbor] === 1 || closed[neighbor]) {
          continue;
        }

        const tentative = gScore[current] + 1;
        if (tentative < gScore[neighbor]) {
          gScore[neighbor] = tentative;
          cameFrom[neighbor] = current;
          const fScore = tentative + manhattan(neighbor, end);
          open.push(neighbor, fScore);
        }
      }
    }

    if (best !== start && cameFrom[best] !== -1) {
      return reconstructPath(cameFrom, best, start);
    }
    return [];
  }

  function maybeReplan(now) {
    if (!planner.needsReplan) {
      return;
    }
    if (now - planner.lastPlanAt < planner.replanCooldownMs) {
      return;
    }

    planner.lastPlanAt = now;
    currentPath = findPath(agent.cell, goal.cell);
    pathCursor = 1;
    fallbackTarget = -1;
    planner.needsReplan = false;
  }

  function moveTowardCell(targetCell, dt) {
    const tx = indexToX(targetCell) + 0.5;
    const ty = indexToY(targetCell) + 0.5;
    const dx = tx - agent.x;
    const dy = ty - agent.y;
    const distance = Math.hypot(dx, dy);
    const maxStep = agent.speed * dt;

    if (distance <= maxStep || distance === 0) {
      agent.x = tx;
      agent.y = ty;
      agent.cell = targetCell;
      return true;
    }

    const nx = dx / distance;
    const ny = dy / distance;
    agent.x += nx * maxStep;
    agent.y += ny * maxStep;

    const gridX = clamp(Math.floor(agent.x), 1, state.cols - 2);
    const gridY = clamp(Math.floor(agent.y), 1, state.rows - 2);
    const sampledIndex = toIndex(gridX, gridY);
    if (state.grid[sampledIndex] === 0) {
      agent.cell = sampledIndex;
    }
    return false;
  }

  function chooseFallbackStep() {
    const ax = indexToX(agent.cell);
    const ay = indexToY(agent.cell);
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < DIRS.length; i += 1) {
      const nx = ax + DIRS[i][0];
      const ny = ay + DIRS[i][1];
      if (!inBounds(nx, ny)) {
        continue;
      }

      const next = toIndex(nx, ny);
      if (state.grid[next] === 1) {
        continue;
      }

      const score = manhattan(next, goal.cell) + (state.visitHeat[next] * 1.55) + (Math.random() * 0.48);
      if (score < bestScore) {
        bestScore = score;
        best = next;
      }
    }

    return best;
  }

  function updateAgent(dt) {
    state.grid[agent.cell] = 0;
    state.grid[goal.cell] = 0;

    if (agent.cell === goal.cell) {
      regenerateWorld();
      return;
    }

    if (currentPath.length > 1 && pathCursor < currentPath.length) {
      const nextCell = currentPath[pathCursor];
      if (state.grid[nextCell] === 1) {
        currentPath = [];
        pathCursor = 1;
        fallbackTarget = -1;
        planner.needsReplan = true;
        return;
      }

      const reached = moveTowardCell(nextCell, dt);
      if (reached) {
        pathCursor += 1;
      }
      if (pathCursor >= currentPath.length && agent.cell !== goal.cell) {
        planner.needsReplan = true;
      }
    } else if (!planner.needsReplan) {
      if (fallbackTarget === -1 || fallbackTarget === agent.cell || state.grid[fallbackTarget] === 1) {
        fallbackTarget = chooseFallbackStep();
      }
      if (fallbackTarget !== -1) {
        const reachedFallback = moveTowardCell(fallbackTarget, dt);
        if (reachedFallback) {
          fallbackTarget = -1;
          planner.needsReplan = true;
        }
      }
    }

    state.trail[agent.cell] = 1;
    state.visitHeat[agent.cell] = Math.min(9, state.visitHeat[agent.cell] + 0.34);
  }

  function decayFields() {
    const decayTrail = 0.985;
    const decayVisit = 0.992;

    for (let i = 0; i < state.count; i += 1) {
      const t = state.trail[i] * decayTrail;
      state.trail[i] = t < 0.005 ? 0 : t;
      if (frameCount % 3 === 0) {
        const v = state.visitHeat[i] * decayVisit;
        state.visitHeat[i] = v < 0.02 ? 0 : v;
      }
    }
  }

  function render(now) {
    ctx.clearRect(0, 0, state.width, state.height);

    ctx.fillStyle = "#1f2430";
    for (let i = 0; i < state.count; i += 1) {
      if (state.grid[i] === 1) {
        const x = indexToX(i) * state.cellSize;
        const y = indexToY(i) * state.cellSize;
        ctx.fillRect(x, y, state.cellSize, state.cellSize);
      }
    }

    ctx.fillStyle = "#2e77d0";
    for (let i = 0; i < state.count; i += 1) {
      const intensity = state.trail[i];
      if (intensity <= 0.03 || state.grid[i] === 1) {
        continue;
      }
      const x = indexToX(i) * state.cellSize;
      const y = indexToY(i) * state.cellSize;
      ctx.globalAlpha = Math.min(0.28, intensity * 0.36);
      ctx.fillRect(x + 1, y + 1, state.cellSize - 2, state.cellSize - 2);
    }
    ctx.globalAlpha = 1;

    if (currentPath.length > 1 && pathCursor < currentPath.length) {
      ctx.strokeStyle = "rgba(46, 119, 208, 0.2)";
      ctx.lineWidth = Math.max(1, state.cellSize * 0.16);
      ctx.beginPath();
      ctx.moveTo(agent.x * state.cellSize, agent.y * state.cellSize);
      for (let i = pathCursor; i < currentPath.length; i += 1) {
        const px = (indexToX(currentPath[i]) + 0.5) * state.cellSize;
        const py = (indexToY(currentPath[i]) + 0.5) * state.cellSize;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    const goalX = (indexToX(goal.cell) + 0.5) * state.cellSize;
    const goalY = (indexToY(goal.cell) + 0.5) * state.cellSize;
    const pulse = (Math.sin(now * 0.0065) + 1) * 0.5;

    ctx.fillStyle = `rgba(255, 142, 26, ${0.42 + (pulse * 0.3)})`;
    ctx.beginPath();
    ctx.arc(goalX, goalY, (state.cellSize * 0.55) + (pulse * state.cellSize * 0.2), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ff8e1a";
    ctx.beginPath();
    ctx.arc(goalX, goalY, state.cellSize * 0.34, 0, Math.PI * 2);
    ctx.fill();

    const agentX = agent.x * state.cellSize;
    const agentY = agent.y * state.cellSize;
    ctx.fillStyle = "#1382ff";
    ctx.beginPath();
    ctx.arc(agentX, agentY, state.cellSize * 0.37, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
    ctx.beginPath();
    ctx.arc(agentX - (state.cellSize * 0.1), agentY - (state.cellSize * 0.1), state.cellSize * 0.1, 0, Math.PI * 2);
    ctx.fill();

    if (shouldShowPointerBrush()) {
      const radius = BRUSH_RADIUS * state.cellSize;
      ctx.strokeStyle = "rgba(46, 119, 208, 0.52)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    frameCount += 1;

    if (shouldMutateFromPointer()) {
      mutateNearPointer();
    }
    pointer.movedSinceTick = false;

    decayFields();
    maybeReplan(now);
    updateAgent(dt);

    render(now);
    requestAnimationFrame(tick);
  }

  function updatePointerFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const nextX = clamp(event.clientX - rect.left, 0, rect.width);
    const nextY = clamp(event.clientY - rect.top, 0, rect.height);
    const moved = Math.abs(nextX - pointer.x) > 0.001 || Math.abs(nextY - pointer.y) > 0.001;
    pointer.x = nextX;
    pointer.y = nextY;
    pointer.isMouse = event.pointerType === "mouse";
    return moved;
  }

  canvas.addEventListener("pointerenter", (event) => {
    pointer.inside = true;
    updatePointerFromEvent(event);
  });

  canvas.addEventListener("pointerleave", () => {
    pointer.inside = false;
    pointer.down = false;
    pointer.movedSinceTick = false;
  });

  canvas.addEventListener("pointerdown", (event) => {
    pointer.inside = true;
    pointer.down = true;
    updatePointerFromEvent(event);
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (_) {
        // Ignore non-critical capture errors on older engines.
      }
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!pointer.inside && event.pointerType === "mouse") {
      return;
    }
    if (updatePointerFromEvent(event)) {
      pointer.movedSinceTick = true;
    }
  });

  canvas.addEventListener("pointerup", (event) => {
    pointer.down = false;
    if (canvas.releasePointerCapture) {
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch (_) {
        // Ignore non-critical release errors.
      }
    }
  });

  canvas.addEventListener("pointercancel", (event) => {
    pointer.down = false;
    if (canvas.releasePointerCapture) {
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch (_) {
        // Ignore non-critical release errors.
      }
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "r" || event.key === "R") {
      regenerateWorld();
    }
  });

  let resizeRaf = 0;
  function scheduleResizeReconfigure() {
    if (resizeRaf !== 0) {
      return;
    }
    resizeRaf = window.requestAnimationFrame(() => {
      resizeRaf = 0;
      configureCanvasAndGrid(true);
    });
  }

  if (typeof ResizeObserver === "function") {
    const observerTarget = canvas.parentElement || canvas;
    const resizeObserver = new ResizeObserver(scheduleResizeReconfigure);
    resizeObserver.observe(observerTarget);
  } else {
    window.addEventListener("resize", scheduleResizeReconfigure);
  }

  configureCanvasAndGrid(false);
  requestAnimationFrame(tick);
})();

(() => {
  "use strict";

  const DEFAULT_POSTS = [
    {
      title: "Evolve, Verify, Solve: Stabilizing Frontier Co-evolution for Code Tasks",
      description: "Anchored Frontier Evolution",
      endDate: "Ongoing",
      url: "https://www.notion.so/fiveflow/AI-with-Recursive-Self-Improvement-3014cec6dd27806e8393c923803ea67e?source=copy_link",
      cover: "",
      disableLink: true
    },
    {
      title: "LLM-based Evolution Strategy (Merging)",
      description: "Language Models as Evolutionary Operators, Not Optimization Targets",
      endDate: "2024-10-21",
      url: "https://fiveflow.notion.site/LLM-based-Evolution-Strategy-Merging-1254cec6dd278041a7f6c07dc4039fe8",
      cover: ""
    },
    {
      title: "RL-Driven Alignment Training",
      description: "Inside RLOO: How Advantage Is Computed Without a Value Model",
      endDate: "2024-12-16",
      url: "https://fiveflow.notion.site/RL-Driven-Alignment-Training-Enhancing-Summarization-Models-with-RLOO-2994cec6dd2780829826c4145f85de76",
      cover: ""
    }
  ];

  function parseNotionTitle(page) {
    if (!page || !page.properties) {
      return "Untitled";
    }

    const keys = Object.keys(page.properties);
    for (let i = 0; i < keys.length; i += 1) {
      const prop = page.properties[keys[i]];
      if (prop && prop.type === "title" && Array.isArray(prop.title) && prop.title.length > 0) {
        return prop.title.map((item) => item.plain_text || "").join("").trim() || "Untitled";
      }
    }

    return "Untitled";
  }

  function parseNotionDate(page) {
    if (!page || !page.properties) {
      return "";
    }

    const keys = Object.keys(page.properties);
    for (let i = 0; i < keys.length; i += 1) {
      const prop = page.properties[keys[i]];
      if (prop && prop.type === "date" && prop.date && prop.date.start) {
        return prop.date.start;
      }
    }

    return page.created_time || "";
  }

  function parseNotionTags(page) {
    if (!page || !page.properties) {
      return [];
    }

    const keys = Object.keys(page.properties);
    for (let i = 0; i < keys.length; i += 1) {
      const prop = page.properties[keys[i]];
      if (!prop) {
        continue;
      }

      if (prop.type === "multi_select" && Array.isArray(prop.multi_select) && prop.multi_select.length > 0) {
        return prop.multi_select.map((item) => item.name).filter(Boolean).slice(0, 3);
      }

      if (prop.type === "select" && prop.select && prop.select.name) {
        return [prop.select.name];
      }
    }

    return [];
  }

  function parseNotionCover(page) {
    if (!page) {
      return "";
    }

    if (page.cover && page.cover.type === "external" && page.cover.external && page.cover.external.url) {
      return page.cover.external.url;
    }

    if (page.cover && page.cover.type === "file" && page.cover.file && page.cover.file.url) {
      return page.cover.file.url;
    }

    if (page.properties) {
      const keys = Object.keys(page.properties);
      for (let i = 0; i < keys.length; i += 1) {
        const prop = page.properties[keys[i]];
        if (!prop || prop.type !== "files" || !Array.isArray(prop.files) || prop.files.length === 0) {
          continue;
        }

        const first = prop.files[0];
        if (first.type === "external" && first.external && first.external.url) {
          return first.external.url;
        }

        if (first.type === "file" && first.file && first.file.url) {
          return first.file.url;
        }
      }
    }

    return "";
  }

  function normalizePost(rawPost) {
    if (!rawPost) {
      return null;
    }

    if (rawPost.properties && rawPost.object === "page") {
      return {
        title: parseNotionTitle(rawPost),
        description: "",
        endDate: parseNotionDate(rawPost),
        url: rawPost.url || "#",
        cover: parseNotionCover(rawPost),
        disableLink: false
      };
    }

    return {
      title: rawPost.title || rawPost.name || "Untitled",
      description: rawPost.description || rawPost.summary || "",
      endDate: rawPost.endDate || rawPost.date || rawPost.publishedAt || rawPost.createdAt || "",
      url: rawPost.url || "#",
      cover: rawPost.cover || rawPost.thumbnail || "",
      disableLink: Boolean(rawPost.disableLink || rawPost.noLink)
    };
  }

  function titleFromNotionUrl(url) {
    try {
      const parsed = new URL(url);
      const last = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
      const withoutId = last.replace(/-[0-9a-f]{32}$/i, "");
      const words = withoutId
        .replace(/[-_]+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean);

      if (words.length === 0) {
        return "Untitled";
      }

      return words.map((word) => {
        if (word.toUpperCase() === word || word.length <= 3) {
          return word.toUpperCase();
        }
        return word.charAt(0).toUpperCase() + word.slice(1);
      }).join(" ");
    } catch (_error) {
      return "Untitled";
    }
  }

  function normalizeManualPage(entry) {
    if (typeof entry === "string") {
      return { url: entry };
    }
    if (entry && typeof entry === "object") {
      return entry;
    }
    return null;
  }

  function buildManualPosts(manualPages, maxPosts) {
    if (!Array.isArray(manualPages) || manualPages.length === 0) {
      return [];
    }

    const posts = [];
    for (let i = 0; i < manualPages.length; i += 1) {
      const page = normalizeManualPage(manualPages[i]);
      if (!page) {
        continue;
      }

      const disableLink = Boolean(page.disableLink || page.noLink);
      let validUrl = "";
      if (typeof page.url === "string" && page.url.trim()) {
        try {
          validUrl = new URL(page.url).toString();
        } catch (_error) {
          if (!disableLink) {
            continue;
          }
        }
      }

      if (!validUrl && !disableLink) {
        continue;
      }

      posts.push({
        title: page.title || (validUrl ? titleFromNotionUrl(validUrl) : "Untitled"),
        description: page.description || "",
        endDate: page.endDate || page.date || "",
        url: validUrl || "#",
        cover: page.cover || "",
        disableLink
      });
    }

    return posts.slice(0, maxPosts);
  }

  function formatDate(value) {
    if (!value) {
      return "Draft";
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }

    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric"
    }).format(parsed);
  }

  function createBlogCard(post) {
    const hasExternal = !post.disableLink && typeof post.url === "string" && /^https?:\/\//i.test(post.url);
    const card = document.createElement(hasExternal ? "a" : "article");
    card.className = "blog-card";
    if (!hasExternal) {
      card.classList.add("is-static");
    }
    card.role = "listitem";

    if (hasExternal) {
      card.href = post.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
    }

    const body = document.createElement("div");
    body.className = "blog-body";

    const title = document.createElement("h3");
    title.className = "blog-title";
    title.textContent = post.title || "Untitled";

    const desc = document.createElement("p");
    desc.className = "blog-desc";
    desc.textContent = post.description || "Description will be added.";

    const end = document.createElement("p");
    end.className = "blog-end";
    end.textContent = `종료일: ${formatDate(post.endDate || "TBD")}`;

    body.appendChild(title);
    body.appendChild(desc);
    body.appendChild(end);
    card.appendChild(body);

    return card;
  }

  function extractPostList(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && Array.isArray(payload.posts)) {
      return payload.posts;
    }

    if (payload && Array.isArray(payload.results)) {
      return payload.results;
    }

    return [];
  }

  function endDateSortValue(value) {
    if (!value) {
      return Number.POSITIVE_INFINITY;
    }

    const text = String(value).trim();
    if (!text) {
      return Number.POSITIVE_INFINITY;
    }

    if (/^(ongoing|present|tbd|draft)$/i.test(text)) {
      return Number.POSITIVE_INFINITY;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const parsedDate = new Date(`${text}T00:00:00Z`);
      return Number.isNaN(parsedDate.getTime()) ? Number.POSITIVE_INFINITY : parsedDate.getTime();
    }

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? Number.POSITIVE_INFINITY : parsed.getTime();
  }

  function sortPostsByEndDate(posts) {
    return posts
      .slice()
      .sort((a, b) => {
        const aText = String(a.endDate || "").trim();
        const bText = String(b.endDate || "").trim();
        const aIsOngoing = /^(ongoing|present)$/i.test(aText);
        const bIsOngoing = /^(ongoing|present)$/i.test(bText);

        if (aIsOngoing !== bIsOngoing) {
          return aIsOngoing ? -1 : 1;
        }

        const av = endDateSortValue(a.endDate);
        const bv = endDateSortValue(b.endDate);
        const aHasConcreteDate = Number.isFinite(av);
        const bHasConcreteDate = Number.isFinite(bv);

        if (aHasConcreteDate !== bHasConcreteDate) {
          return aHasConcreteDate ? -1 : 1;
        }

        if (av === bv) {
          return (a.title || "").localeCompare(b.title || "");
        }
        return bv - av;
      });
  }

  async function fetchNotionPosts(config) {
    const maxPosts = Number.isInteger(config.maxPosts) ? config.maxPosts : 6;
    const manualPosts = buildManualPosts(config.manualPages, maxPosts);
    if (manualPosts.length > 0) {
      return manualPosts;
    }

    if (config.endpoint) {
      const response = await fetch(config.endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Endpoint request failed: ${response.status}`);
      }

      const payload = await response.json();
      return extractPostList(payload).map(normalizePost).filter(Boolean).slice(0, maxPosts);
    }

    if (config.databaseId && config.token) {
      const notionResponse = await fetch(`https://api.notion.com/v1/databases/${config.databaseId}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
          "Notion-Version": config.notionVersion || "2022-06-28"
        },
        body: JSON.stringify({
          page_size: maxPosts,
          sorts: [
            {
              timestamp: "last_edited_time",
              direction: "descending"
            }
          ]
        })
      });

      if (!notionResponse.ok) {
        throw new Error(`Notion API request failed: ${notionResponse.status}`);
      }

      const notionPayload = await notionResponse.json();
      return extractPostList(notionPayload).map(normalizePost).filter(Boolean).slice(0, maxPosts);
    }

    return [];
  }

  async function initBlogSection() {
    const grid = document.getElementById("blog-grid");
    const expandButton = document.getElementById("blog-expand-btn");
    if (!grid) {
      return;
    }

    const config = window.NOTION_BLOG_CONFIG || {};
    const maxPosts = Number.isInteger(config.maxPosts) ? config.maxPosts : 6;

    let posts = [];

    try {
      posts = await fetchNotionPosts(config);
    } catch (_error) {
      posts = [];
    }

    if (posts.length === 0) {
      posts = DEFAULT_POSTS.slice(0, maxPosts).map((post) => ({ ...post }));
    }

    posts = sortPostsByEndDate(posts);

    grid.innerHTML = "";

    if (posts.length === 0) {
      const empty = document.createElement("p");
      empty.className = "blog-empty";
      empty.textContent = "No entries are available yet.";
      grid.appendChild(empty);
      return;
    }

    const initialVisibleCount = 2;
    const hasExpandableList = posts.length > initialVisibleCount;
    let expanded = false;

    const renderVisiblePosts = () => {
      grid.innerHTML = "";

      const visibleCount = hasExpandableList && !expanded ? initialVisibleCount : posts.length;
      const visiblePosts = posts.slice(0, visibleCount);

      for (let i = 0; i < visiblePosts.length; i += 1) {
        grid.appendChild(createBlogCard(visiblePosts[i]));
      }

      if (!expandButton) {
        return;
      }

      if (!hasExpandableList) {
        expandButton.hidden = true;
        return;
      }

      expandButton.hidden = false;
      expandButton.classList.toggle("is-expanded", expanded);
      expandButton.setAttribute("aria-expanded", expanded ? "true" : "false");
      expandButton.setAttribute("aria-label", expanded ? "Collapse posts" : "Expand posts");
    };

    renderVisiblePosts();

    if (expandButton) {
      expandButton.onclick = () => {
        expanded = !expanded;
        renderVisiblePosts();
      };
    }
  }

  function bootstrap() {
    initBlogSection();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
