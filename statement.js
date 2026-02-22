(() => {
  "use strict";

  const HARD_MAP = {
    cols: 88,
    rows: 44,
    start: { x: 8, y: 38 },
    goal: { x: 8, y: 5 },
    wallRects: [
      [3, 24, 37, 25],
      [36, 8, 38, 33],
      [4, 10, 15, 12],
      [64, 6, 66, 17],
      [74, 12, 76, 26],
      [39, 19, 47, 21],
      [39, 22, 46, 23],
      [18, 30, 30, 31],
      [22, 34, 34, 35],
      [44, 6, 46, 16],
      [48, 11, 60, 12],
      [50, 16, 68, 17],
      [45, 30, 60, 31],
      [62, 34, 80, 35],
      [68, 20, 69, 33],
      [26, 4, 31, 5],
      [15, 28, 19, 29],
      [52, 24, 63, 25]
    ],
    wallLines: [
      [17, 12, 34, 7, 1],
      [8, 18, 14, 24, 1],
      [41, 13, 62, 23, 1],
      [41, 27, 80, 38, 2],
      [34, 35, 22, 43, 2],
      [53, 18, 70, 19, 1],
      [56, 24, 74, 27, 1],
      [26, 30, 40, 26, 1],
      [46, 23, 58, 28, 1],
      [60, 8, 78, 7, 1],
      [72, 9, 84, 18, 1],
      [70, 28, 82, 24, 1],
      [48, 36, 66, 40, 1],
      [13, 33, 20, 37, 1]
    ],
    carveRects: [
      [36, 24, 38, 25],
      [36, 22, 38, 23],
      [36, 20, 38, 21],
      [45, 30, 46, 31],
      [68, 24, 69, 25],
      [30, 4, 31, 5],
      [60, 16, 61, 17],
      [25, 34, 26, 35]
    ]
  };

  const DIRS_4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];

  const DIRS_8 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function createSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state += 0x6d2b79f5;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class DeceptiveMazeSimulator {
    constructor(options) {
      this.canvas = options.canvas;
      this.ctx = this.canvas.getContext("2d");
      this.statusEl = options.statusEl;
      this.resetButton = options.resetButton;

      this.cols = HARD_MAP.cols;
      this.rows = HARD_MAP.rows;
      this.count = this.cols * this.rows;

      this.wall = new Uint8Array(this.count);

      this.width = 1;
      this.height = 1;
      this.panelWidth = 1;
      this.panelHeight = 1;
      this.stackedPanels = false;
      this.dpr = 1;
      this.cellW = 1;
      this.cellH = 1;

      this.totalAgents = 0;
      this.elapsed = 0;
      this.resetCount = 0;

      this.lastTs = performance.now();
      this.accumulator = 0;
      this.stepInterval = 1 / 26;
      this.maxAgentSteps = 320;
      this.rafId = 0;
      this.resizeRaf = 0;

      this.panels = {
        exploit: this.createPanelState("exploit", 92317),
        explore: this.createPanelState("explore", 12973)
      };

      this.buildHardMap();
      this.bindEvents();
      this.resizeCanvas();

      this.tick = this.tick.bind(this);
      this.rafId = window.requestAnimationFrame(this.tick);
    }

    createPanelState(kind, seedBase) {
      const trailCanvas = document.createElement("canvas");
      const trailCtx = trailCanvas.getContext("2d");

      return {
        kind,
        seedBase,
        rng: createSeededRandom(seedBase),
        visit: new Float32Array(this.count),
        occupancy: new Uint16Array(this.count),
        agents: [],
        escaped: 0,
        movedRatio: 1,
        trailCanvas,
        trailCtx
      };
    }

    idx(x, y) {
      return y * this.cols + x;
    }

    inBounds(x, y) {
      return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
    }

    isWall(x, y) {
      if (!this.inBounds(x, y)) {
        return true;
      }
      return this.wall[this.idx(x, y)] === 1;
    }

    setRect(x0, y0, x1, y1, value) {
      const minX = clamp(Math.min(x0, x1), 0, this.cols - 1);
      const maxX = clamp(Math.max(x0, x1), 0, this.cols - 1);
      const minY = clamp(Math.min(y0, y1), 0, this.rows - 1);
      const maxY = clamp(Math.max(y0, y1), 0, this.rows - 1);

      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          this.wall[this.idx(x, y)] = value;
        }
      }
    }

    paintDisc(cx, cy, radius, value) {
      const minX = clamp(cx - radius, 0, this.cols - 1);
      const maxX = clamp(cx + radius, 0, this.cols - 1);
      const minY = clamp(cy - radius, 0, this.rows - 1);
      const maxY = clamp(cy + radius, 0, this.rows - 1);
      const r2 = radius * radius;

      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const dx = x - cx;
          const dy = y - cy;
          if ((dx * dx) + (dy * dy) <= r2) {
            this.wall[this.idx(x, y)] = value;
          }
        }
      }
    }

    setLine(x0, y0, x1, y1, thickness, value) {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      const radius = Math.max(0, Math.floor((thickness - 1) / 2));

      for (let i = 0; i <= steps; i += 1) {
        const t = steps === 0 ? 0 : i / steps;
        const x = Math.round(x0 + ((x1 - x0) * t));
        const y = Math.round(y0 + ((y1 - y0) * t));

        if (radius === 0) {
          this.wall[this.idx(x, y)] = value;
        } else {
          this.paintDisc(x, y, radius, value);
        }
      }
    }

    clearRadius(cx, cy, radius) {
      const r2 = radius * radius;
      const minX = clamp(cx - radius, 1, this.cols - 2);
      const maxX = clamp(cx + radius, 1, this.cols - 2);
      const minY = clamp(cy - radius, 1, this.rows - 2);
      const maxY = clamp(cy + radius, 1, this.rows - 2);

      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const dx = x - cx;
          const dy = y - cy;
          if ((dx * dx) + (dy * dy) <= r2) {
            this.wall[this.idx(x, y)] = 0;
          }
        }
      }
    }

    randomInt(rng, min, max) {
      return min + ((rng() * ((max - min) + 1)) | 0);
    }

    hasReachablePath() {
      const startIndex = this.idx(HARD_MAP.start.x, HARD_MAP.start.y);
      const goalIndex = this.idx(HARD_MAP.goal.x, HARD_MAP.goal.y);

      if (this.wall[startIndex] === 1 || this.wall[goalIndex] === 1) {
        return false;
      }

      const visited = new Uint8Array(this.count);
      const queue = new Int32Array(this.count);
      let head = 0;
      let tail = 0;

      visited[startIndex] = 1;
      queue[tail] = startIndex;
      tail += 1;

      while (head < tail) {
        const current = queue[head];
        head += 1;

        if (current === goalIndex) {
          return true;
        }

        const cx = current % this.cols;
        const cy = (current / this.cols) | 0;

        for (let i = 0; i < DIRS_4.length; i += 1) {
          const nx = cx + DIRS_4[i][0];
          const ny = cy + DIRS_4[i][1];
          if (!this.inBounds(nx, ny)) {
            continue;
          }

          const next = this.idx(nx, ny);
          if (this.wall[next] === 1 || visited[next] === 1) {
            continue;
          }

          visited[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }

      return false;
    }

    buildHardMap() {
      const maxAttempts = 22;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const seed = ((Date.now() >>> 0) ^ ((this.resetCount + 1) * 0x9e3779b1) ^ (attempt * 0x85ebca6b)) >>> 0;
        const rng = createSeededRandom(seed);

        this.wall.fill(0);

        this.setRect(0, 0, this.cols - 1, 0, 1);
        this.setRect(0, this.rows - 1, this.cols - 1, this.rows - 1, 1);
        this.setRect(0, 0, 0, this.rows - 1, 1);
        this.setRect(this.cols - 1, 0, this.cols - 1, this.rows - 1, 1);

        for (let i = 0; i < HARD_MAP.wallRects.length; i += 1) {
          const [x0, y0, x1, y1] = HARD_MAP.wallRects[i];
          const jx = this.randomInt(rng, -2, 2);
          const jy = this.randomInt(rng, -2, 2);
          this.setRect(x0 + jx, y0 + jy, x1 + jx, y1 + jy, 1);
        }

        for (let i = 0; i < HARD_MAP.wallLines.length; i += 1) {
          const [x0, y0, x1, y1, thickness] = HARD_MAP.wallLines[i];
          const jx0 = this.randomInt(rng, -2, 2);
          const jy0 = this.randomInt(rng, -2, 2);
          const jx1 = this.randomInt(rng, -2, 2);
          const jy1 = this.randomInt(rng, -2, 2);
          this.setLine(x0 + jx0, y0 + jy0, x1 + jx1, y1 + jy1, thickness, 1);
        }

        for (let i = 0; i < HARD_MAP.carveRects.length; i += 1) {
          const [x0, y0, x1, y1] = HARD_MAP.carveRects[i];
          const jx = this.randomInt(rng, -1, 1);
          const jy = this.randomInt(rng, -1, 1);
          this.setRect(x0 + jx, y0 + jy, x1 + jx, y1 + jy, 0);
        }

        const extraRects = 5 + this.randomInt(rng, 0, 4);
        for (let i = 0; i < extraRects; i += 1) {
          const horizontal = rng() < 0.62;
          const w = horizontal ? this.randomInt(rng, 4, 12) : this.randomInt(rng, 1, 3);
          const h = horizontal ? this.randomInt(rng, 1, 2) : this.randomInt(rng, 4, 12);
          const x = this.randomInt(rng, 11, this.cols - 16);
          const y = this.randomInt(rng, 7, this.rows - 11);

          const nearStart = Math.abs(x - HARD_MAP.start.x) < 9 && Math.abs(y - HARD_MAP.start.y) < 9;
          const nearGoal = Math.abs(x - HARD_MAP.goal.x) < 9 && Math.abs(y - HARD_MAP.goal.y) < 9;
          if (nearStart || nearGoal) {
            continue;
          }

          this.setRect(x, y, x + w, y + h, 1);
        }

        const extraCarves = 3 + this.randomInt(rng, 0, 4);
        for (let i = 0; i < extraCarves; i += 1) {
          const x = this.randomInt(rng, 12, this.cols - 13);
          const y = this.randomInt(rng, 8, this.rows - 9);
          this.setRect(x, y, x + this.randomInt(rng, 0, 2), y + this.randomInt(rng, 0, 2), 0);
        }

        this.clearRadius(HARD_MAP.start.x, HARD_MAP.start.y, 2);
        this.clearRadius(HARD_MAP.goal.x, HARD_MAP.goal.y, 2);
        this.wall[this.idx(HARD_MAP.start.x, HARD_MAP.start.y)] = 0;
        this.wall[this.idx(HARD_MAP.goal.x, HARD_MAP.goal.y)] = 0;

        if (this.hasReachablePath()) {
          return;
        }
      }

      this.wall.fill(0);
      this.setRect(0, 0, this.cols - 1, 0, 1);
      this.setRect(0, this.rows - 1, this.cols - 1, this.rows - 1, 1);
      this.setRect(0, 0, 0, this.rows - 1, 1);
      this.setRect(this.cols - 1, 0, this.cols - 1, this.rows - 1, 1);
      for (let i = 0; i < HARD_MAP.wallRects.length; i += 1) {
        const [x0, y0, x1, y1] = HARD_MAP.wallRects[i];
        this.setRect(x0, y0, x1, y1, 1);
      }
      for (let i = 0; i < HARD_MAP.wallLines.length; i += 1) {
        const [x0, y0, x1, y1, thickness] = HARD_MAP.wallLines[i];
        this.setLine(x0, y0, x1, y1, thickness, 1);
      }
      for (let i = 0; i < HARD_MAP.carveRects.length; i += 1) {
        const [x0, y0, x1, y1] = HARD_MAP.carveRects[i];
        this.setRect(x0, y0, x1, y1, 0);
      }
      this.clearRadius(HARD_MAP.start.x, HARD_MAP.start.y, 2);
      this.clearRadius(HARD_MAP.goal.x, HARD_MAP.goal.y, 2);
      this.wall[this.idx(HARD_MAP.start.x, HARD_MAP.start.y)] = 0;
      this.wall[this.idx(HARD_MAP.goal.x, HARD_MAP.goal.y)] = 0;
    }

    getAgentsPerPanel() {
      return this.stackedPanels ? 50 : 90;
    }

    spawnNearStart(rng) {
      const sx = HARD_MAP.start.x;
      const sy = HARD_MAP.start.y;

      for (let attempt = 0; attempt < 60; attempt += 1) {
        const nx = clamp(sx + ((rng() * 7) | 0) - 3, 1, this.cols - 2);
        const ny = clamp(sy + ((rng() * 7) | 0) - 3, 1, this.rows - 2);
        if (!this.isWall(nx, ny)) {
          return { x: nx, y: ny };
        }
      }

      return { x: sx, y: sy };
    }

    configurePanelCanvases() {
      const panelPixelWidth = Math.max(1, Math.floor(this.panelWidth * this.dpr));
      const panelPixelHeight = Math.max(1, Math.floor(this.panelHeight * this.dpr));

      const panelList = [this.panels.exploit, this.panels.explore];
      for (let i = 0; i < panelList.length; i += 1) {
        const panel = panelList[i];
        panel.trailCanvas.width = panelPixelWidth;
        panel.trailCanvas.height = panelPixelHeight;
        panel.trailCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        panel.trailCtx.clearRect(0, 0, this.panelWidth, this.panelHeight);
      }
    }

    resizeCanvas() {
      const rect = this.canvas.getBoundingClientRect();
      this.width = Math.max(1, Math.floor(rect.width));
      this.height = Math.max(1, Math.floor(rect.height));
      this.stackedPanels = window.matchMedia("(max-width: 760px)").matches;
      if (this.stackedPanels) {
        this.panelWidth = this.width;
        this.panelHeight = this.height / 2;
      } else {
        this.panelWidth = this.width / 2;
        this.panelHeight = this.height;
      }
      this.dpr = Math.max(1, window.devicePixelRatio || 1);

      this.canvas.width = Math.floor(this.width * this.dpr);
      this.canvas.height = Math.floor(this.height * this.dpr);
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      this.cellW = this.panelWidth / this.cols;
      this.cellH = this.panelHeight / this.rows;

      this.configurePanelCanvases();
      this.resetAll();
    }

    resetPanel(panel) {
      panel.rng = createSeededRandom(panel.seedBase + (this.resetCount * 131));
      panel.visit.fill(0);
      panel.occupancy.fill(0);
      panel.escaped = 0;
      panel.movedRatio = 1;
      panel.agents = new Array(this.totalAgents);
      panel.trailCtx.clearRect(0, 0, this.panelWidth, this.panelHeight);

      for (let i = 0; i < this.totalAgents; i += 1) {
        const spawn = this.spawnNearStart(panel.rng);
        panel.agents[i] = {
          x: spawn.x,
          y: spawn.y,
          prevX: spawn.x,
          prevY: spawn.y,
          dx: 0,
          dy: 0,
          detourSteps: 0,
          escaped: false,
          alive: true,
          age: 0
        };
        panel.visit[this.idx(spawn.x, spawn.y)] += 1;
      }
    }

    resetAll() {
      this.resetCount += 1;
      this.elapsed = 0;
      this.buildHardMap();
      this.totalAgents = this.getAgentsPerPanel();
      this.resetPanel(this.panels.exploit);
      this.resetPanel(this.panels.explore);
      this.updateStatus();
    }

    bindEvents() {
      this.resetButton.addEventListener("click", () => this.resetAll());

      if (typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(() => {
          if (this.resizeRaf !== 0) {
            return;
          }
          this.resizeRaf = window.requestAnimationFrame(() => {
            this.resizeRaf = 0;
            this.resizeCanvas();
          });
        });
        this.resizeObserver.observe(this.canvas);
      } else {
        window.addEventListener("resize", () => {
          if (this.resizeRaf !== 0) {
            return;
          }
          this.resizeRaf = window.requestAnimationFrame(() => {
            this.resizeRaf = 0;
            this.resizeCanvas();
          });
        });
      }
    }

    manhattan(ax, ay, bx, by) {
      return Math.abs(ax - bx) + Math.abs(ay - by);
    }

    euclidean(ax, ay, bx, by) {
      return Math.hypot(ax - bx, ay - by);
    }

    chooseExploitMove(panel, agent) {
      const gx = HARD_MAP.goal.x;
      const gy = HARD_MAP.goal.y;
      const current = this.manhattan(agent.x, agent.y, gx, gy);

      let bestDist = current;
      const improving = [];
      const neighbors = [];

      for (let i = 0; i < DIRS_8.length; i += 1) {
        const ox = DIRS_8[i][0];
        const oy = DIRS_8[i][1];
        const nx = agent.x + ox;
        const ny = agent.y + oy;

        if (this.isWall(nx, ny)) {
          continue;
        }

        const dist = this.manhattan(nx, ny, gx, gy);
        neighbors.push([nx, ny, dist, ox, oy]);

        if (dist < bestDist) {
          bestDist = dist;
          improving.length = 0;
          improving.push([nx, ny, dist, ox, oy]);
        } else if (dist === bestDist && dist < current) {
          improving.push([nx, ny, dist, ox, oy]);
        }
      }

      if (neighbors.length === 0) {
        return null;
      }

      if (typeof agent.detourSteps !== "number") {
        agent.detourSteps = 0;
      }

      const stepX = Math.sign(gx - agent.x);
      const stepY = Math.sign(gy - agent.y);
      if (stepX !== 0 || stepY !== 0) {
        const directX = agent.x + stepX;
        const directY = agent.y + stepY;
        if (this.isWall(directX, directY)) {
          agent.detourSteps = Math.max(agent.detourSteps, 7);
        }
      }

      if (agent.detourSteps > 0) {
        let detourBest = null;
        let detourScore = -Infinity;

        for (let i = 0; i < neighbors.length; i += 1) {
          const nx = neighbors[i][0];
          const ny = neighbors[i][1];
          const dist = neighbors[i][2];
          const ox = neighbors[i][3];
          const oy = neighbors[i][4];
          const idx = this.idx(nx, ny);

          let score = -(dist * 0.62);
          score += 1.05 / (1 + panel.visit[idx]);
          score -= 0.16 * panel.occupancy[idx];
          score += panel.rng() * 0.12;

          if (nx === (agent.x - agent.dx) && ny === (agent.y - agent.dy)) {
            score -= 0.7;
          }
          if (ox !== agent.dx || oy !== agent.dy) {
            score += 0.08;
          }

          if (score > detourScore) {
            detourScore = score;
            detourBest = neighbors[i];
          }
        }

        if (detourBest) {
          agent.detourSteps -= 1;
          return detourBest;
        }
        agent.detourSteps = 0;
      }

      if (improving.length > 0) {
        const pick = (panel.rng() * improving.length) | 0;
        return improving[pick];
      }

      let minNeighborDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < neighbors.length; i += 1) {
        if (neighbors[i][2] < minNeighborDist) {
          minNeighborDist = neighbors[i][2];
        }
      }

      const basinMoves = [];
      for (let i = 0; i < neighbors.length; i += 1) {
        if (neighbors[i][2] === minNeighborDist) {
          basinMoves.push(neighbors[i]);
        }
      }

      if (basinMoves.length === 0) {
        return neighbors[(panel.rng() * neighbors.length) | 0];
      }

      if (agent.dx !== 0 || agent.dy !== 0) {
        const backX = agent.x - agent.dx;
        const backY = agent.y - agent.dy;
        for (let i = 0; i < basinMoves.length; i += 1) {
          if (basinMoves[i][0] === backX && basinMoves[i][1] === backY) {
            if (panel.rng() < 0.75) {
              return basinMoves[i];
            }
            break;
          }
        }
      }

      return basinMoves[(panel.rng() * basinMoves.length) | 0];
    }

    chooseExploreMove(panel, agent) {
      const gx = HARD_MAP.goal.x;
      const gy = HARD_MAP.goal.y;

      let bestScore = -Infinity;
      let choice = null;

      for (let i = 0; i < DIRS_8.length; i += 1) {
        const ox = DIRS_8[i][0];
        const oy = DIRS_8[i][1];
        const nx = agent.x + ox;
        const ny = agent.y + oy;

        if (this.isWall(nx, ny)) {
          continue;
        }

        const idx = this.idx(nx, ny);
        const dist = this.euclidean(nx, ny, gx, gy);

        const novelty = 2.7 / (1 + panel.visit[idx]);
        const goal = 0.33 / (1 + dist);
        const crowd = -0.21 * panel.occupancy[idx];
        const unseen = panel.visit[idx] < 0.35 ? 0.34 : 0;
        const momentum = (agent.dx === ox && agent.dy === oy) ? 0.06 : 0;
        const noise = panel.rng() * 0.18;

        const score = novelty + goal + crowd + unseen + momentum + noise;
        if (score > bestScore) {
          bestScore = score;
          choice = [nx, ny, ox, oy];
        }
      }

      return choice;
    }

    drawTrail(panel, agent) {
      const fromX = (agent.prevX + 0.5) * this.cellW;
      const fromY = (agent.prevY + 0.5) * this.cellH;
      const toX = (agent.x + 0.5) * this.cellW;
      const toY = (agent.y + 0.5) * this.cellH;

      panel.trailCtx.strokeStyle = panel.kind === "exploit"
        ? "rgba(46, 119, 208, 0.2)"
        : "rgba(231, 155, 47, 0.2)";
      panel.trailCtx.lineWidth = Math.max(1, Math.min(this.cellW, this.cellH) * 0.42);
      panel.trailCtx.lineCap = "round";
      panel.trailCtx.beginPath();
      panel.trailCtx.moveTo(fromX, fromY);
      panel.trailCtx.lineTo(toX, toY);
      panel.trailCtx.stroke();
    }

    stepPanel(panel) {
      panel.occupancy.fill(0);
      for (let i = 0; i < panel.agents.length; i += 1) {
        const agent = panel.agents[i];
        if (agent.alive && !agent.escaped) {
          panel.occupancy[this.idx(agent.x, agent.y)] += 1;
        }
      }

      let movedCount = 0;
      let activeCount = 0;

      for (let i = 0; i < panel.agents.length; i += 1) {
        const agent = panel.agents[i];
        if (!agent.alive || agent.escaped) {
          continue;
        }

        activeCount += 1;
        agent.prevX = agent.x;
        agent.prevY = agent.y;

        let next = null;
        if (panel.kind === "exploit") {
          next = this.chooseExploitMove(panel, agent);
          if (next) {
            agent.x = next[0];
            agent.y = next[1];
            agent.dx = agent.x - agent.prevX;
            agent.dy = agent.y - agent.prevY;
          }
        } else {
          next = this.chooseExploreMove(panel, agent);
          if (next) {
            agent.x = next[0];
            agent.y = next[1];
            agent.dx = next[2];
            agent.dy = next[3];
          }
        }

        if (agent.x !== agent.prevX || agent.y !== agent.prevY) {
          movedCount += 1;
          this.drawTrail(panel, agent);
        }

        panel.visit[this.idx(agent.x, agent.y)] += 1;
        agent.age += 1;

        if (agent.age >= this.maxAgentSteps && !agent.escaped) {
          agent.alive = false;
          continue;
        }

        if (agent.x === HARD_MAP.goal.x && agent.y === HARD_MAP.goal.y) {
          agent.escaped = true;
          panel.escaped += 1;
        }
      }

      if (panel.kind === "explore") {
        for (let i = 0; i < panel.visit.length; i += 1) {
          panel.visit[i] *= 0.998;
        }
      }

      panel.movedRatio = activeCount > 0 ? movedCount / activeCount : 0;
    }

    updateStatus() {
      const exploit = this.panels.exploit;
      const explore = this.panels.explore;
      this.statusEl.textContent = `Reward escaped: ${exploit.escaped}/${this.totalAgents} | Novelty escaped: ${explore.escaped}/${this.totalAgents}`;
    }

    drawWalls(offsetX, offsetY) {
      this.ctx.fillStyle = "#2f2c27";
      for (let y = 1; y < this.rows - 1; y += 1) {
        for (let x = 1; x < this.cols - 1; x += 1) {
          if (this.wall[this.idx(x, y)] === 1) {
            this.ctx.fillRect(offsetX + (x * this.cellW), offsetY + (y * this.cellH), this.cellW, this.cellH);
          }
        }
      }

      this.ctx.fillRect(offsetX, offsetY, this.panelWidth, 1);
      this.ctx.fillRect(offsetX, (offsetY + this.panelHeight) - 1, this.panelWidth, 1);
      this.ctx.fillRect(offsetX, offsetY, 1, this.panelHeight);
      this.ctx.fillRect((offsetX + this.panelWidth) - 1, offsetY, 1, this.panelHeight);
    }

    drawGoalAndStart(offsetX, offsetY) {
      const goalX = offsetX + ((HARD_MAP.goal.x + 0.5) * this.cellW);
      const goalY = offsetY + ((HARD_MAP.goal.y + 0.5) * this.cellH);
      const startX = offsetX + ((HARD_MAP.start.x + 0.5) * this.cellW);
      const startY = offsetY + ((HARD_MAP.start.y + 0.5) * this.cellH);

      const rGoal = Math.max(2.2, Math.min(this.cellW, this.cellH) * 0.34);
      const rStart = Math.max(2, Math.min(this.cellW, this.cellH) * 0.34);

      this.ctx.fillStyle = "#111";
      this.ctx.beginPath();
      this.ctx.arc(goalX, goalY, rGoal, 0, Math.PI * 2);
      this.ctx.fill();

      this.ctx.strokeStyle = "#111";
      this.ctx.lineWidth = Math.max(1.3, Math.min(this.cellW, this.cellH) * 0.2);
      this.ctx.beginPath();
      this.ctx.arc(startX, startY, rStart, 0, Math.PI * 2);
      this.ctx.stroke();
    }

    drawAgents(panel, offsetX, offsetY) {
      const radius = Math.max(1.45, Math.min(this.cellW, this.cellH) * 0.27);

      for (let i = 0; i < panel.agents.length; i += 1) {
        const agent = panel.agents[i];
        if (!agent.alive && !agent.escaped) {
          continue;
        }
        const x = offsetX + ((agent.x + 0.5) * this.cellW);
        const y = offsetY + ((agent.y + 0.5) * this.cellH);

        if (agent.escaped) {
          this.ctx.fillStyle = "#4f9a6f";
        } else {
          this.ctx.fillStyle = panel.kind === "exploit" ? "#2e77d0" : "#e79b2f";
        }

        this.ctx.beginPath();
        this.ctx.arc(x, y, radius, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }

    drawPanelLabel(offsetX, offsetY, text) {
      this.ctx.fillStyle = "rgba(36, 33, 29, 0.86)";
      this.ctx.font = `${Math.max(10, Math.floor(Math.min(this.panelWidth, this.panelHeight) * 0.035))}px Geist`;
      this.ctx.fillText(text, offsetX + 10, offsetY + 18);
    }

    drawPanel(panel, offsetX, offsetY) {
      this.ctx.fillStyle = "#f4f1e8";
      this.ctx.fillRect(offsetX, offsetY, this.panelWidth, this.panelHeight);

      this.drawWalls(offsetX, offsetY);

      this.ctx.drawImage(panel.trailCanvas, offsetX, offsetY, this.panelWidth, this.panelHeight);

      this.drawGoalAndStart(offsetX, offsetY);
      this.drawAgents(panel, offsetX, offsetY);

      const title = panel.kind === "exploit" ? "Reward-only" : "Novelty search";
      this.drawPanelLabel(offsetX, offsetY, title);
    }

    render() {
      this.ctx.clearRect(0, 0, this.width, this.height);

      if (this.stackedPanels) {
        this.drawPanel(this.panels.exploit, 0, 0);
        this.drawPanel(this.panels.explore, 0, this.panelHeight);

        this.ctx.strokeStyle = "rgba(55, 48, 40, 0.44)";
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, this.panelHeight);
        this.ctx.lineTo(this.width, this.panelHeight);
        this.ctx.stroke();
        return;
      }

      this.drawPanel(this.panels.exploit, 0, 0);
      this.drawPanel(this.panels.explore, this.panelWidth, 0);

      this.ctx.strokeStyle = "rgba(55, 48, 40, 0.44)";
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(this.panelWidth, 0);
      this.ctx.lineTo(this.panelWidth, this.height);
      this.ctx.stroke();
    }

    tick(now) {
      const dt = Math.min(0.1, Math.max(0, (now - this.lastTs) / 1000));
      this.lastTs = now;
      this.accumulator += dt;

      while (this.accumulator >= this.stepInterval) {
        this.accumulator -= this.stepInterval;
        this.stepPanel(this.panels.exploit);
        this.stepPanel(this.panels.explore);
        this.elapsed += this.stepInterval;
        this.updateStatus();
      }

      this.render();
      this.rafId = window.requestAnimationFrame(this.tick);
    }
  }

  function initDeceptiveMazes() {
    const figures = document.querySelectorAll("[data-deceptive-maze]");
    const simulators = [];

    for (let i = 0; i < figures.length; i += 1) {
      const figure = figures[i];
      const canvas = figure.querySelector("[data-deceptive-maze-canvas]");
      const statusEl = figure.querySelector("[data-maze-status]");
      const resetButton = figure.querySelector("[data-maze-reset]");

      if (!canvas || !statusEl || !resetButton) {
        continue;
      }

      const rect = canvas.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) {
        continue;
      }

      simulators.push(new DeceptiveMazeSimulator({
        canvas,
        statusEl,
        resetButton
      }));
    }

    return simulators;
  }

  function initExpansionBridge() {
    const bridges = document.querySelectorAll("[data-expansion-bridge]");
    if (bridges.length === 0) {
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || typeof IntersectionObserver !== "function") {
      for (let i = 0; i < bridges.length; i += 1) {
        bridges[i].classList.add("is-visible");
      }
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      for (let i = 0; i < entries.length; i += 1) {
        if (!entries[i].isIntersecting) {
          continue;
        }

        const target = entries[i].target;
        target.classList.add("is-visible");
        if (target.classList.contains("animate-once")) {
          observer.unobserve(target);
        }
      }
    }, {
      threshold: 0.34
    });

    for (let i = 0; i < bridges.length; i += 1) {
      observer.observe(bridges[i]);
    }
  }

  function initSelfEvolvingLoop() {
    const loopRoots = document.querySelectorAll("[data-self-evolving-loop]");
    if (loopRoots.length === 0) {
      return;
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (let i = 0; i < loopRoots.length; i += 1) {
      loopRoots[i].classList.toggle("is-static", reduced);
    }
  }

  function bootstrap() {
    initDeceptiveMazes();
    initExpansionBridge();
    initSelfEvolvingLoop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
