(() => {
  "use strict";

  const STORAGE_KEY = "court-motion-workspace-v1";
  const API_URL = "/api/workspace";
  const PLAYER_KEYS = ["home1", "home2", "home3", "home4", "home5", "away1", "away2", "away3", "away4", "away5", "ball"];
  const TEAM_KEYS = {
    home: ["home1", "home2", "home3", "home4", "home5"],
    away: ["away1", "away2", "away3", "away4", "away5"],
  };
  const CONFIG = {
    full: { label: "全场", aspect: 0.57, width: 50, height: 94 },
    half: { label: "半场", aspect: 1.0638, width: 50, height: 47 },
  };
  const COLORS = {
    ink: "#19201c",
    paper: "#f8f6ef",
    line: "#f7f0df",
    wood: "#c98d51",
    woodDark: "#b7773d",
    woodLight: "#d89f64",
    green: "#146349",
    red: "#e63b4e",
    redDark: "#a91f31",
    blue: "#2468e5",
    blueDark: "#1545a3",
    orange: "#e4872b",
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);
  const canvas = $("#courtCanvas");
  const ctx = canvas.getContext("2d");
  const exportCanvas = $("#exportCanvas");
  const exportCtx = exportCanvas.getContext("2d");
  const courtWrap = $("#courtWrap");
  const turnList = $("#turnList");
  const tacticList = $("#tacticList");
  const exportOverlay = $("#exportOverlay");
  const exportMenu = $("#exportMenu");
  const toastRegion = $("#toastRegion");

  let mode = "full";
  let store = loadStore();
  let selected = null;
  let dragging = null;
  let resizeObserver;
  let toastTimer;
  let timelineSignature = "";
  let tacticSignature = "";
  let pathEditorSignature = "";
  let mediaBunnyPromise;
  let speed = 1.5;
  let editingWaypoint = -1;
  let tacticEditMode = false;
  let turnEditMode = false;
  let pendingDeletion = null;
  let serverSaveTimer = 0;
  let serverSyncInFlight = null;
  let localRevision = 0;
  let player = {
    playing: false,
    paused: false,
    segment: 0,
    progress: 0,
    lastTs: 0,
    raf: 0,
  };

  function makePositions(modeName, variant = 0) {
    if (modeName === "half") {
      return {
        home1: { x: 0.50, y: 0.77 },
        home2: { x: 0.19, y: 0.61 },
        home3: { x: 0.81, y: 0.61 },
        home4: { x: 0.27, y: 0.37 },
        home5: { x: 0.72, y: 0.30 },
        away1: { x: 0.50, y: 0.53 },
        away2: { x: 0.17, y: 0.45 },
        away3: { x: 0.83, y: 0.42 },
        away4: { x: 0.34, y: 0.21 },
        away5: { x: 0.66, y: 0.19 },
        ball: { x: 0.53, y: 0.71 },
      };
    }

    const spread = variant ? 0.03 : 0;
    return {
      home1: { x: 0.50, y: 0.77 },
      home2: { x: 0.25 - spread, y: 0.67 },
      home3: { x: 0.75 + spread, y: 0.67 },
      home4: { x: 0.34, y: 0.52 },
      home5: { x: 0.66, y: 0.52 },
      away1: { x: 0.50, y: 0.23 },
      away2: { x: 0.25 + spread, y: 0.33 },
      away3: { x: 0.75 - spread, y: 0.33 },
      away4: { x: 0.34, y: 0.48 },
      away5: { x: 0.66, y: 0.48 },
      ball: { x: 0.50, y: 0.71 },
    };
  }

  function clonePositions(positions) {
    return Object.fromEntries(PLAYER_KEYS.map((key) => [key, { x: positions[key].x, y: positions[key].y }]));
  }

  function cloneOpportunity(opportunity) {
    if (!opportunity || typeof opportunity !== "object") return null;
    const from = typeof opportunity.from === "string" ? opportunity.from : "";
    const to = typeof opportunity.to === "string" ? opportunity.to : "";
    if (!PLAYER_KEYS.includes(from) || !PLAYER_KEYS.includes(to) || from === to || from === "ball" || to === "ball") return null;
    return { from, to };
  }

  function createModes() {
    return {
      full: { turns: [{ id: uid(), name: "初始位置", positions: makePositions("full"), waypoints: [], opportunity: null }] },
      half: { turns: [{ id: uid(), name: "初始位置", positions: makePositions("half"), waypoints: [], opportunity: null }] },
    };
  }

  function createTactic(index) {
    return {
      id: uid(),
      name: `战术 ${index}`,
      modes: createModes(),
    };
  }

  function createInitialStore() {
    const tactic = createTactic(1);
    return {
      version: 5,
      activeTacticId: tactic.id,
      tactics: [tactic],
    };
  }

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function isValidPositions(positions) {
    return positions && PLAYER_KEYS.every((key) => positions[key] && Number.isFinite(positions[key].x) && Number.isFinite(positions[key].y));
  }

  function normalizeModes(sourceModes, sourceVersion) {
    const modes = createModes();
    ["full", "half"].forEach((name) => {
      const turns = sourceModes?.[name]?.turns;
      if (!Array.isArray(turns) || !turns.length) return;
      const validTurns = turns
        .filter((turn) => isValidPositions(turn.positions))
        .slice(0, 24)
        .map((turn, index) => ({
          id: typeof turn.id === "string" ? turn.id : uid(),
          name: index === 0 ? "初始位置" : (typeof turn.name === "string" && turn.name.trim() ? turn.name.trim().slice(0, 30) : `回合 ${index}`),
          positions: rotateLegacyFullCourt(name, clonePositions(turn.positions), sourceVersion),
          waypoints: index === 0 || !Array.isArray(turn.waypoints) ? [] : turn.waypoints
            .filter((waypoint) => isValidPositions(waypoint?.positions))
            .slice(0, 6)
            .map((waypoint) => ({
              id: typeof waypoint.id === "string" ? waypoint.id : uid(),
              positions: rotateLegacyFullCourt(name, clonePositions(waypoint.positions), sourceVersion),
            })),
          opportunity: index === 0 ? null : cloneOpportunity(turn.opportunity),
        }));
      if (validTurns.length) modes[name].turns = validTurns;
    });
    return modes;
  }

  function normalizeTactic(candidate, index, sourceVersion) {
    return {
      id: typeof candidate?.id === "string" ? candidate.id : uid(),
      name: typeof candidate?.name === "string" && candidate.name.trim() ? candidate.name.trim().slice(0, 30) : `战术 ${index + 1}`,
      modes: normalizeModes(candidate?.modes, sourceVersion),
    };
  }

  function normalizeStore(candidate) {
    if (!candidate || typeof candidate !== "object") return createInitialStore();
    const sourceVersion = Number(candidate.version) || 1;
    if (sourceVersion >= 3 && Array.isArray(candidate.tactics) && candidate.tactics.length) {
      const tactics = candidate.tactics.slice(0, 40).map((tactic, index) => normalizeTactic(tactic, index, sourceVersion));
      const activeTacticId = tactics.some((tactic) => tactic.id === candidate.activeTacticId) ? candidate.activeTacticId : tactics[0].id;
      return { version: 5, activeTacticId, tactics };
    }

    const tactic = {
      id: uid(),
      name: "战术 1",
      modes: normalizeModes(candidate.modes, sourceVersion),
    };
    return { version: 5, activeTacticId: tactic.id, tactics: [tactic] };
  }

  function rotateLegacyFullCourt(modeName, positions, sourceVersion) {
    if (modeName !== "full" || sourceVersion >= 2) return positions;
    return Object.fromEntries(PLAYER_KEYS.map((key) => [key, {
      x: positions[key].y,
      y: positions[key].x,
    }]));
  }

  function loadStore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return normalizeStore(saved);
    } catch {
      return createInitialStore();
    }
  }

  function persist() {
    localRevision += 1;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // Storage can be unavailable in private browsing; the editor still works in memory.
    }
    scheduleServerSync();
  }

  function setSyncStatus(message, state = "") {
    const status = $("#syncStatus");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
  }

  function workspacePayload() {
    return {
      ...store,
      activeMode: mode,
      savedAt: new Date().toISOString(),
    };
  }

  async function syncToServer() {
    if (window.location.protocol === "file:") {
      setSyncStatus("仅本地保存", "offline");
      return false;
    }
    if (serverSyncInFlight) await serverSyncInFlight;
    const request = fetch(API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workspacePayload()),
    });
    serverSyncInFlight = request;
    setSyncStatus("正在保存…", "saving");
    try {
      const response = await request;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSyncStatus("已保存到数据库", "saved");
      return true;
    } catch (error) {
      console.warn("Database sync unavailable", error);
      setSyncStatus("本地已保存", "local");
      return false;
    } finally {
      if (serverSyncInFlight === request) serverSyncInFlight = null;
    }
  }

  function scheduleServerSync() {
    if (window.location.protocol === "file:") {
      setSyncStatus("仅本地保存", "offline");
      return;
    }
    clearTimeout(serverSaveTimer);
    serverSaveTimer = setTimeout(() => { syncToServer(); }, 350);
  }

  async function hydrateFromServer() {
    if (window.location.protocol === "file:") {
      setSyncStatus("仅本地保存", "offline");
      return;
    }
    const revisionAtStart = localRevision;
    try {
      const response = await fetch(API_URL, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const workspace = typeof result.workspace === "string" ? JSON.parse(result.workspace) : result.workspace;
      if (workspace && localRevision === revisionAtStart) {
        store = normalizeStore(workspace);
        mode = workspace.activeMode === "half" ? "half" : "full";
        $(".mode-button.active")?.classList.remove("active");
        $(`.mode-button[data-mode="${mode}"]`)?.classList.add("active");
        courtWrap.classList.toggle("full", mode === "full");
        courtWrap.classList.toggle("half", mode === "half");
        stopPlayback(true);
        selected = null;
        editingWaypoint = -1;
        timelineSignature = "";
        tacticSignature = "";
        pathEditorSignature = "";
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch {}
        draw();
        setSyncStatus("已从数据库加载", "saved");
      } else if (workspace) {
        setSyncStatus("保留本地编辑并同步…", "saving");
        await syncToServer();
      } else {
        await syncToServer();
      }
    } catch (error) {
      console.warn("Database load unavailable", error);
      setSyncStatus("本地已保存", "local");
    }
  }

  function activeTactic() {
    return store.tactics.find((tactic) => tactic.id === store.activeTacticId) || store.tactics[0];
  }

  function turns() {
    return activeTactic().modes[mode].turns;
  }

  function waypointsFor(index = activeIndex()) {
    const turn = turns()[index];
    if (!turn) return [];
    if (!Array.isArray(turn.waypoints)) turn.waypoints = [];
    return turn.waypoints;
  }

  function opportunityFor(index = activeIndex()) {
    const turn = turns()[index];
    if (!turn || index <= 0) return null;
    return cloneOpportunity(turn.opportunity);
  }

  function transitionPath(segment) {
    const list = turns();
    if (segment < 0 || segment >= list.length - 1) {
      const positions = list[Math.max(0, Math.min(segment, list.length - 1))]?.positions;
      return positions ? [positions] : [];
    }
    return [
      list[segment].positions,
      ...waypointsFor(segment + 1).map((waypoint) => waypoint.positions),
      list[segment + 1].positions,
    ];
  }

  function interpolatePositions(from, to, progress) {
    const t = smoothstep(progress);
    return Object.fromEntries(PLAYER_KEYS.map((key) => [key, {
      x: from[key].x + (to[key].x - from[key].x) * t,
      y: from[key].y + (to[key].y - from[key].y) * t,
    }]));
  }

  function transitionState(segment, progress) {
    const path = transitionPath(segment);
    if (path.length < 2) return { positions: path[0], path, leg: 0, legProgress: 1 };
    const clamped = Math.max(0, Math.min(1, progress));
    const scaled = clamped * (path.length - 1);
    const leg = Math.min(path.length - 2, Math.floor(scaled));
    const legProgress = clamped >= 1 ? 1 : scaled - leg;
    return {
      positions: interpolatePositions(path[leg], path[leg + 1], legProgress),
      path,
      leg,
      legProgress,
    };
  }

  function editablePositions() {
    const index = activeIndex();
    const waypoint = index > 0 && editingWaypoint >= 0 ? waypointsFor(index)[editingWaypoint] : null;
    return waypoint?.positions || turns()[index].positions;
  }

  function activeIndex() {
    return Math.min(player.segment, turns().length - 1);
  }

  function currentPositions() {
    if ((player.playing || player.paused) && player.segment < turns().length - 1) {
      return transitionState(player.segment, player.progress).positions;
    }
    return editablePositions();
  }

  function smoothstep(value) {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  }

  function saveCurrentPosition(key, point) {
    if (player.playing || player.paused) return;
    editablePositions()[key] = {
      x: Math.max(0.045, Math.min(0.955, point.x)),
      y: Math.max(0.065, Math.min(0.935, point.y)),
    };
    persist();
  }

  function screenPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function hitTest(point) {
    const rect = canvas.getBoundingClientRect();
    let closest = null;
    let closestDistance = Infinity;
    PLAYER_KEYS.forEach((key) => {
      const item = currentPositions()[key];
      const dx = (item.x - point.x) * rect.width;
      const dy = (item.y - point.y) * rect.height;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const radius = key === "ball" ? 24 : 31;
      if (distance < radius && distance < closestDistance) {
        closest = key;
        closestDistance = distance;
      }
    });
    return closest;
  }

  function labelFor(key) {
    if (key === "ball") return "篮球";
    const team = key.startsWith("home") ? "红队" : "蓝队";
    return `${team} ${key.slice(-1)}号`;
  }

  function teamFor(key) {
    if (key === "ball") return "ball";
    return key.startsWith("home") ? "home" : "away";
  }

  function draw() {
    resizeCanvas();
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 32) return;
    const positions = currentPositions();
    const transition = player.playing || player.paused || $("#trailToggle").checked;
    const index = activeIndex();
    const pathSegment = player.playing || player.paused ? index : index > 0 ? index - 1 : 0;
    const pathPositions = transitionPath(pathSegment);
    drawScene(ctx, rect.width, rect.height, mode, positions, {
      selected,
      showTrails: transition && $("#trailToggle").checked,
      pathPositions,
      playing: player.playing || player.paused,
      progress: player.progress,
      segment: player.segment,
      opportunity: opportunityFor(player.playing || player.paused ? player.segment + 1 : index),
    });
    updateReadout();
    updateTacticList();
    updateTimeline();
    updatePathEditor();
    updateOpportunityEditor();
    const progress = $("#courtProgress");
    progress.classList.toggle("visible", player.playing || player.paused);
    progress.firstElementChild.style.width = `${player.progress * 100}%`;
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawScene(targetCtx, width, height, modeName, positions, options = {}) {
    const config = CONFIG[modeName];
    const pad = Math.max(10, Math.min(width, height) * 0.045);
    const left = pad;
    const top = pad;
    const right = width - pad;
    const bottom = height - pad;
    const courtWidth = right - left;
    const courtHeight = bottom - top;
    const px = (x) => left + x * courtWidth;
    const py = (y) => top + y * courtHeight;
    const unit = Math.min(courtWidth / config.width, courtHeight / config.height);
    const lineWidth = Math.max(1.5, unit * 0.11);
    const centerY = py(0.5);
    const centerX = px(0.5);

    targetCtx.clearRect(0, 0, width, height);
    targetCtx.fillStyle = COLORS.wood;
    targetCtx.fillRect(0, 0, width, height);

    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.rect(left, top, courtWidth, courtHeight);
    targetCtx.clip();
    const plank = Math.max(18, unit * 2.6);
    for (let x = left - plank; x < right + plank; x += plank) {
      targetCtx.fillStyle = Math.round((x - left) / plank) % 2 === 0 ? "rgba(255,245,219,.075)" : "rgba(99,46,18,.04)";
      targetCtx.fillRect(x, top, plank / 2, courtHeight);
    }
    for (let y = top; y < bottom; y += plank * 1.6) {
      targetCtx.strokeStyle = "rgba(90, 44, 18, .09)";
      targetCtx.lineWidth = 1;
      targetCtx.beginPath();
      targetCtx.moveTo(left, y);
      targetCtx.lineTo(right, y);
      targetCtx.stroke();
    }
    targetCtx.restore();

    targetCtx.strokeStyle = COLORS.line;
    targetCtx.lineWidth = lineWidth;
    targetCtx.lineCap = "round";
    targetCtx.lineJoin = "round";
    targetCtx.strokeRect(left, top, courtWidth, courtHeight);

    if (modeName === "full") {
      drawFullCourt(targetCtx, { left, top, right, bottom, px, py, courtWidth, courtHeight, lineWidth, unit, centerX, centerY });
    } else {
      drawHalfCourt(targetCtx, { left, top, right, bottom, px, py, courtWidth, courtHeight, lineWidth, unit, centerX, centerY });
    }

    if (options.showTrails && options.pathPositions?.length > 1) {
      drawTrails(targetCtx, positions, options.pathPositions, { px, py, unit, playing: options.playing, progress: options.progress });
    }

    if (options.opportunity) {
      drawOpportunityArrow(targetCtx, options.opportunity, positions, { px, py, unit, playing: options.playing });
    }

    PLAYER_KEYS.forEach((key) => {
      const item = positions[key];
      if (!item) return;
      drawPiece(targetCtx, key, px(item.x), py(item.y), unit, options.selected === key);
    });

    if (options.playing) {
      targetCtx.save();
      targetCtx.fillStyle = "rgba(18, 26, 22, .74)";
      targetCtx.fillRect(left + 10, top + 10, Math.min(160, courtWidth * 0.25), 28);
      targetCtx.fillStyle = "#fff";
      targetCtx.font = `700 ${Math.max(10, unit * 1.8)}px Inter, sans-serif`;
      targetCtx.textBaseline = "middle";
      targetCtx.fillText(`${CONFIG[modeName].label}  ·  回合 ${Math.min(options.segment ?? 0, 99)} → ${Math.min((options.segment ?? 0) + 1, 99)}`, left + 19, top + 24);
      targetCtx.restore();
    }
  }

  function drawFullCourt(targetCtx, geo) {
    const { left, top, right, bottom, px, py, courtWidth, courtHeight, lineWidth, unit, centerX, centerY } = geo;
    targetCtx.save();
    targetCtx.strokeStyle = COLORS.line;
    targetCtx.lineWidth = lineWidth;
    drawPaintedKey(targetCtx, px, py, courtWidth, courtHeight, 0.35, 0.04, 0.30, 0.22, "top");
    drawPaintedKey(targetCtx, px, py, courtWidth, courtHeight, 0.35, 0.74, 0.30, 0.22, "bottom");
    targetCtx.beginPath();
    targetCtx.moveTo(left, centerY);
    targetCtx.lineTo(right, centerY);
    targetCtx.stroke();
    targetCtx.beginPath();
    targetCtx.arc(centerX, centerY, courtWidth * 0.12, 0, Math.PI * 2);
    targetCtx.stroke();
    drawVerticalThreePointLine(targetCtx, px, py, "top", 0.245);
    drawVerticalThreePointLine(targetCtx, px, py, "bottom", 0.245);
    drawBasket(targetCtx, centerX, py(0.026), unit, "top");
    drawBasket(targetCtx, centerX, py(0.974), unit, "bottom");
    targetCtx.restore();
  }

  function drawHalfCourt(targetCtx, geo) {
    const { left, top, right, bottom, px, py, courtWidth, courtHeight, lineWidth, unit, centerX } = geo;
    targetCtx.save();
    targetCtx.strokeStyle = COLORS.line;
    targetCtx.lineWidth = lineWidth;
    drawPaintedKey(targetCtx, px, py, courtWidth, courtHeight, 0.34, 0.04, 0.32, 0.25, "top");
    drawVerticalThreePointLine(targetCtx, px, py, "top", 0.46);
    targetCtx.beginPath();
    targetCtx.moveTo(left, bottom);
    targetCtx.lineTo(right, bottom);
    targetCtx.stroke();
    drawBasket(targetCtx, centerX, py(0.025), unit, "top");
    targetCtx.restore();
  }

  function drawPaintedKey(targetCtx, px, py, courtWidth, courtHeight, x, y, width, height, side) {
    targetCtx.fillStyle = "rgba(26, 103, 73, .13)";
    targetCtx.fillRect(px(x), py(y), courtWidth * width, courtHeight * height);
    targetCtx.strokeStyle = COLORS.line;
    targetCtx.strokeRect(px(x), py(y), courtWidth * width, courtHeight * height);
    targetCtx.beginPath();
    const arcY = side === "top" ? py(y + height) : py(y);
    const start = side === "top" ? 0 : Math.PI;
    const end = side === "top" ? Math.PI : Math.PI * 2;
    targetCtx.arc(px(0.5), arcY, courtWidth * 0.15, start, end);
    targetCtx.stroke();
  }

  function drawVerticalThreePointLine(targetCtx, px, py, side, arcDepth) {
    const top = side === "top";
    const baseline = top ? 0.045 : 0.955;
    const arcCenterY = top ? 0.14 : 0.86;
    const radiusX = Math.abs(px(0.965) - px(0.5));
    const radiusY = Math.abs(py(arcDepth) - py(0));
    const leftCorner = px(0.035);
    const rightCorner = px(0.965);
    targetCtx.beginPath();
    targetCtx.moveTo(leftCorner, py(baseline));
    targetCtx.lineTo(leftCorner, py(arcCenterY));
    targetCtx.ellipse(px(0.5), py(arcCenterY), radiusX, radiusY, 0, Math.PI, 0, top);
    targetCtx.lineTo(rightCorner, py(baseline));
    targetCtx.strokeStyle = COLORS.line;
    targetCtx.stroke();
  }

  function drawBasket(targetCtx, x, y, unit, side) {
    targetCtx.save();
    targetCtx.strokeStyle = COLORS.line;
    targetCtx.fillStyle = COLORS.orange;
    targetCtx.lineWidth = Math.max(1.5, unit * 0.14);
    targetCtx.beginPath();
    if (side === "top" || side === "bottom") {
      targetCtx.moveTo(x - unit * 0.9, y);
      targetCtx.lineTo(x + unit * 0.9, y);
      targetCtx.stroke();
      targetCtx.beginPath();
      targetCtx.arc(x, y + (side === "top" ? unit * 0.9 : -unit * 0.9), unit * 0.65, 0, Math.PI * 2);
    } else {
      targetCtx.moveTo(x, y - unit * 0.9);
      targetCtx.lineTo(x, y + unit * 0.9);
      targetCtx.stroke();
      targetCtx.beginPath();
      targetCtx.arc(x + (side === "left" ? unit * 0.9 : -unit * 0.9), y, unit * 0.65, 0, Math.PI * 2);
    }
    targetCtx.stroke();
    targetCtx.restore();
  }

  function drawTrails(targetCtx, positions, path, geo) {
    if (!Array.isArray(path) || path.length < 2) return;
    const { px, py, unit, playing, progress } = geo;
    const scaled = Math.max(0, Math.min(1, progress || 0)) * (path.length - 1);
    const leg = Math.min(path.length - 2, Math.floor(scaled));
    PLAYER_KEYS.forEach((key) => {
      const route = playing
        ? [positions[key], ...path.slice(leg + 1).map((frame) => frame[key])]
        : path.map((frame) => frame[key]);
      if (route.some((point) => !point)) return;
      const same = route.slice(1).every((point, index) => Math.abs(point.x - route[index].x) + Math.abs(point.y - route[index].y) < 0.012);
      if (same) return;
      targetCtx.save();
      targetCtx.setLineDash([Math.max(3, unit * 0.5), Math.max(4, unit * 0.75)]);
      targetCtx.lineWidth = Math.max(1.2, unit * (key === "ball" ? 0.28 : 0.2));
      targetCtx.strokeStyle = key === "ball" ? "rgba(228,135,43,.78)" : teamFor(key) === "home" ? "rgba(230,59,78,.55)" : "rgba(36,104,229,.55)";
      targetCtx.beginPath();
      targetCtx.moveTo(px(route[0].x), py(route[0].y));
      route.slice(1).forEach((point) => targetCtx.lineTo(px(point.x), py(point.y)));
      targetCtx.stroke();
      targetCtx.setLineDash([]);
      targetCtx.fillStyle = targetCtx.strokeStyle;
      route.slice(1).forEach((point, routeIndex) => {
        targetCtx.beginPath();
        targetCtx.arc(px(point.x), py(point.y), Math.max(2, unit * (routeIndex === route.length - 2 ? 0.3 : 0.23)), 0, Math.PI * 2);
        targetCtx.fill();
      });
      if (playing) {
        const next = route.slice(1).find((point) => Math.abs(point.x - positions[key].x) + Math.abs(point.y - positions[key].y) >= 0.006);
        if (!next) {
          targetCtx.restore();
          return;
        }
        const angle = Math.atan2(next.y - positions[key].y, next.x - positions[key].x);
        const x = px(positions[key].x);
        const y = py(positions[key].y);
        targetCtx.translate(x, y);
        targetCtx.rotate(angle);
        targetCtx.beginPath();
        targetCtx.moveTo(unit * 1.4, 0);
        targetCtx.lineTo(unit * 0.45, -unit * 0.45);
        targetCtx.lineTo(unit * 0.45, unit * 0.45);
        targetCtx.closePath();
        targetCtx.fill();
      }
      targetCtx.restore();
    });
  }

  function drawOpportunityArrow(targetCtx, opportunity, positions, geo) {
    const from = positions?.[opportunity.from];
    const to = positions?.[opportunity.to];
    if (!from || !to) return;
    const { px, py, unit, playing } = geo;
    const startX = px(from.x);
    const startY = py(from.y);
    const endX = px(to.x);
    const endY = py(to.y);
    const dx = endX - startX;
    const dy = endY - startY;
    const distance = Math.hypot(dx, dy);
    if (distance < unit * 1.2) return;
    const ux = dx / distance;
    const uy = dy / distance;
    const inset = Math.max(unit * 1.6, Math.min(distance * 0.2, unit * 3.2));
    const x1 = startX + ux * inset;
    const y1 = startY + uy * inset;
    const x2 = endX - ux * inset;
    const y2 = endY - uy * inset;
    const head = Math.max(5, unit * 1.15);
    const color = playing ? "rgba(20, 99, 73, .92)" : "rgba(20, 99, 73, .78)";
    targetCtx.save();
    targetCtx.strokeStyle = color;
    targetCtx.fillStyle = color;
    targetCtx.lineWidth = Math.max(1.6, unit * 0.24);
    targetCtx.lineCap = "round";
    targetCtx.setLineDash([Math.max(4, unit * 0.72), Math.max(4, unit * 0.62)]);
    targetCtx.beginPath();
    targetCtx.moveTo(x1, y1);
    targetCtx.lineTo(x2, y2);
    targetCtx.stroke();
    targetCtx.setLineDash([]);
    targetCtx.translate(x2, y2);
    targetCtx.rotate(Math.atan2(dy, dx));
    targetCtx.beginPath();
    targetCtx.moveTo(head, 0);
    targetCtx.lineTo(-head * 0.65, -head * 0.58);
    targetCtx.lineTo(-head * 0.65, head * 0.58);
    targetCtx.closePath();
    targetCtx.fill();
    targetCtx.restore();
  }

  function drawPiece(targetCtx, key, x, y, unit, isSelected) {
    const isBall = key === "ball";
    const team = teamFor(key);
    const radius = isBall ? Math.max(7, unit * 0.62) : Math.max(13, unit * 1.45);
    targetCtx.save();
    targetCtx.shadowColor = "rgba(18, 24, 21, .32)";
    targetCtx.shadowBlur = Math.max(2, unit * 0.5);
    targetCtx.shadowOffsetY = Math.max(1, unit * 0.22);
    if (isBall) {
      targetCtx.fillStyle = COLORS.orange;
      targetCtx.strokeStyle = "#783d0a";
      targetCtx.lineWidth = Math.max(1, unit * 0.18);
      targetCtx.beginPath();
      targetCtx.arc(x, y, radius, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.stroke();
      targetCtx.shadowColor = "transparent";
      targetCtx.strokeStyle = "rgba(100,49,9,.8)";
      targetCtx.lineWidth = Math.max(0.8, unit * 0.12);
      targetCtx.beginPath();
      targetCtx.arc(x, y, radius * 0.82, -Math.PI * 0.95, Math.PI * 0.12);
      targetCtx.stroke();
      targetCtx.beginPath();
      targetCtx.arc(x, y, radius * 0.82, Math.PI * 0.05, Math.PI * 1.1);
      targetCtx.stroke();
    } else {
      targetCtx.fillStyle = team === "home" ? COLORS.red : COLORS.blue;
      targetCtx.strokeStyle = "rgba(255,255,255,.92)";
      targetCtx.lineWidth = Math.max(1.5, unit * 0.24);
      targetCtx.beginPath();
      targetCtx.arc(x, y, radius, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.stroke();
      targetCtx.shadowColor = "transparent";
      targetCtx.fillStyle = "#fff";
      targetCtx.font = `800 ${Math.max(10, unit * 1.15)}px Inter, sans-serif`;
      targetCtx.textAlign = "center";
      targetCtx.textBaseline = "middle";
      targetCtx.fillText(key.slice(-1), x, y + 0.5);
    }
    if (isSelected) {
      targetCtx.shadowColor = "transparent";
      targetCtx.strokeStyle = "#fff";
      targetCtx.lineWidth = Math.max(2, unit * 0.28);
      targetCtx.setLineDash([Math.max(3, unit * 0.55), Math.max(3, unit * 0.55)]);
      targetCtx.beginPath();
      targetCtx.arc(x, y, radius + Math.max(4, unit * 0.55), 0, Math.PI * 2);
      targetCtx.stroke();
    }
    targetCtx.restore();
  }

  function updateReadout() {
    const title = player.playing || player.paused
      ? `回合 ${player.segment} → ${Math.min(player.segment + 1, turns().length - 1)}`
      : `${activeIndex()} · ${turns()[activeIndex()].name}`;
    $("#roundTitle").textContent = title;
    $("#editStatus").textContent = player.playing
      ? `正在运行 · ${Math.round(player.progress * 100)}%`
      : player.paused ? `已暂停 · ${Math.round(player.progress * 100)}%` : "可拖动编辑";
    const editLabel = editingWaypoint >= 0 && !player.playing && !player.paused ? `转折 ${editingWaypoint + 1} · ` : "";
    $("#selectionReadout").textContent = selected ? `${editLabel}${labelFor(selected)} · ${Math.round(currentPositions()[selected].x * 100)}% / ${Math.round(currentPositions()[selected].y * 100)}%` : `${editLabel}选择并拖动球员或篮球`;
    const playButton = $("#playButton");
    const buttonState = player.playing ? "pause" : player.paused ? "resume" : "play";
    if (playButton.dataset.state !== buttonState) {
      playButton.dataset.state = buttonState;
      playButton.innerHTML = player.playing
        ? '<i data-lucide="pause" aria-hidden="true"></i><span>暂停</span>'
        : `<i data-lucide="play" aria-hidden="true"></i><span>${player.paused ? "继续" : "运行"}</span>`;
      if (window.lucide) window.lucide.createIcons();
    }
  }

  function updateTimeline() {
    const list = turns();
    const index = activeIndex();
    turnList.classList.toggle("is-editing", turnEditMode);
    const turnEditButton = $("#editTurnsButton");
    turnEditButton.setAttribute("aria-pressed", String(turnEditMode));
    turnEditButton.setAttribute("aria-label", turnEditMode ? "完成编辑回合列表" : "编辑回合列表");
    turnEditButton.title = turnEditMode ? "完成编辑回合列表" : "编辑回合列表";
    turnEditButton.querySelector("span").textContent = turnEditMode ? "完成" : "编辑";
    const signature = `${mode}:${index}:${turnEditMode}:${list.map((turn) => `${turn.id}:${turn.name}:${turn.waypoints?.length || 0}:${turn.opportunity?.from || ""}-${turn.opportunity?.to || ""}`).join("|")}`;
    if (signature === timelineSignature) return;
    timelineSignature = signature;
    turnList.innerHTML = list.map((turn, i) => `
      <li class="turn-item ${i === index ? "active" : ""}" data-index="${i}" tabindex="0" aria-current="${i === index ? "step" : "false"}">
        <span class="turn-number">${i}</span>
        <span class="turn-copy"><strong>${escapeHtml(turn.name)}</strong><span>${i === 0 ? "起始站位" : `${turn.waypoints?.length ? `${turn.waypoints.length} 个转折点` : "直线路径"} · ${turn.opportunity ? "潜在传球" : "无潜在传球"}`}</span></span>
        ${i > 0 ? `<button class="turn-delete" type="button" data-delete="${i}" aria-label="删除回合 ${i}" title="删除回合"><i data-lucide="trash-2" aria-hidden="true"></i><span>删除</span></button>` : "<span></span>"}
      </li>
    `).join("");
    if (window.lucide) window.lucide.createIcons();
  }

  function updatePathEditor() {
    const editor = $("#pathEditor");
    const index = activeIndex();
    const available = !player.playing && !player.paused && index > 0;
    editor.hidden = !available;
    $("#resetTurnLabel").textContent = "重置本回合";
    if (!available) return;

    const points = waypointsFor(index);
    if (editingWaypoint >= points.length) editingWaypoint = -1;
    const signature = `${mode}:${turns()[index].id}:${points.map((point) => point.id).join("|")}:${editingWaypoint}`;
    if (signature !== pathEditorSignature) {
      pathEditorSignature = signature;
      $("#pathStepList").innerHTML = [
        ...points.map((point, pointIndex) => `<button class="path-step-button ${editingWaypoint === pointIndex ? "active" : ""}" type="button" data-waypoint="${pointIndex}" aria-pressed="${editingWaypoint === pointIndex}">转折 ${pointIndex + 1}</button>`),
        `<button class="path-step-button ${editingWaypoint === -1 ? "active" : ""}" type="button" data-waypoint="-1" aria-pressed="${editingWaypoint === -1}">终点</button>`,
      ].join("");
    }
    $("#addWaypointButton").disabled = points.length >= 6;
    $("#deleteWaypointButton").disabled = editingWaypoint < 0;
  }

  function updateOpportunityEditor() {
    const editor = $("#opportunityEditor");
    const index = activeIndex();
    const available = !player.playing && !player.paused && index > 0;
    editor.hidden = !available;
    if (!available) return;

    const fromSelect = $("#opportunityFrom");
    const toSelect = $("#opportunityTo");
    const options = PLAYER_KEYS
      .filter((key) => key !== "ball")
      .map((key) => `<option value="${key}">${escapeHtml(labelFor(key))}</option>`)
      .join("");
    if (fromSelect.dataset.options !== options) {
      fromSelect.innerHTML = options;
      toSelect.innerHTML = options;
      fromSelect.dataset.options = options;
    }

    const opportunity = opportunityFor(index);
    fromSelect.value = opportunity?.from || "home1";
    toSelect.value = opportunity?.to || "away1";
    if (fromSelect.value === toSelect.value) {
      toSelect.value = PLAYER_KEYS.find((key) => key !== "ball" && key !== fromSelect.value) || "away1";
    }
    $("#addOpportunityButton span").textContent = opportunity ? "更新箭头" : "添加箭头";
    $("#removeOpportunityButton").hidden = !opportunity;
  }

  function updateTacticList() {
    tacticList.classList.toggle("is-editing", tacticEditMode);
    const tacticEditButton = $("#editTacticsButton");
    tacticEditButton.setAttribute("aria-pressed", String(tacticEditMode));
    tacticEditButton.setAttribute("aria-label", tacticEditMode ? "完成编辑战术列表" : "编辑战术列表");
    tacticEditButton.title = tacticEditMode ? "完成编辑战术列表" : "编辑战术列表";
    tacticEditButton.querySelector("span").textContent = tacticEditMode ? "完成" : "编辑";
    const signature = `${store.activeTacticId}:${tacticEditMode}:${store.tactics.map((tactic) => `${tactic.id}:${tactic.name}:${tactic.modes.full.turns.length}:${tactic.modes.half.turns.length}`).join("|")}`;
    if (signature === tacticSignature) return;
    tacticSignature = signature;
    $("#tacticCount").textContent = store.tactics.length;
    tacticList.innerHTML = store.tactics.map((tactic, index) => {
      const rounds = tactic.modes.full.turns.length + tactic.modes.half.turns.length;
      return `
        <li class="tactic-list-item">
          <button class="tactic-item ${tactic.id === store.activeTacticId ? "active" : ""}" type="button" data-tactic-id="${escapeHtml(tactic.id)}" aria-current="${tactic.id === store.activeTacticId ? "true" : "false"}">
            <span class="tactic-number">${String(index + 1).padStart(2, "0")}</span>
            <span class="tactic-copy"><strong>${escapeHtml(tactic.name)}</strong><small>${rounds} 个回合</small></span>
          </button>
          ${tacticEditMode ? `<div class="tactic-item-actions"><button class="tactic-rename" type="button" data-rename-tactic="${escapeHtml(tactic.id)}" aria-label="重命名${escapeHtml(tactic.name)}" title="重命名战术"><i data-lucide="pencil" aria-hidden="true"></i><span>改名</span></button><button class="tactic-delete" type="button" data-delete-tactic="${escapeHtml(tactic.id)}" aria-label="删除${escapeHtml(tactic.name)}" title="${store.tactics.length <= 1 ? "至少保留一套战术" : "删除战术"}"${store.tactics.length <= 1 ? " disabled" : ""}><i data-lucide="trash-2" aria-hidden="true"></i><span>删除</span></button></div>` : ""}
        </li>
      `;
    }).join("");
  }

  function escapeHtml(value) {
    return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
  }

  function selectTurn(index) {
    stopPlayback(false);
    player.segment = Math.max(0, Math.min(index, turns().length - 1));
    player.progress = 0;
    editingWaypoint = -1;
    pathEditorSignature = "";
    selected = null;
    draw();
  }

  function selectTactic(id) {
    if (!store.tactics.some((tactic) => tactic.id === id) || id === store.activeTacticId) return;
    stopPlayback(true);
    store.activeTacticId = id;
    editingWaypoint = -1;
    selected = null;
    timelineSignature = "";
    pathEditorSignature = "";
    persist();
    draw();
  }

  function addTurn() {
    stopPlayback(false);
    const list = turns();
    if (list.length >= 24) {
      showToast("最多可编辑 24 个回合");
      return;
    }
    const source = list[activeIndex()].positions;
    list.push({ id: uid(), name: `回合 ${list.length}`, positions: clonePositions(source), waypoints: [], opportunity: null });
    player.segment = list.length - 1;
    player.progress = 0;
    editingWaypoint = -1;
    pathEditorSignature = "";
    selected = null;
    persist();
    draw();
    requestAnimationFrame(() => turnList.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  function deleteTurn(index) {
    if (index <= 0 || turns().length <= 1) return;
    stopPlayback(false);
    turns().splice(index, 1);
    player.segment = Math.min(activeIndex(), turns().length - 1);
    player.progress = 0;
    editingWaypoint = -1;
    pathEditorSignature = "";
    selected = null;
    persist();
    draw();
    showToast(`已删除回合 ${index}`);
  }

  function deleteTactic(id) {
    if (store.tactics.length <= 1) {
      showToast("至少需要保留一套战术");
      return;
    }
    const index = store.tactics.findIndex((tactic) => tactic.id === id);
    if (index < 0) return;
    const wasActive = store.activeTacticId === id;
    store.tactics.splice(index, 1);
    if (wasActive) {
      store.activeTacticId = store.tactics[Math.max(0, index - 1)].id;
      stopPlayback(true);
      mode = "full";
      editingWaypoint = -1;
      selected = null;
      $(".mode-button.active")?.classList.remove("active");
      $(".mode-button[data-mode=full]")?.classList.add("active");
      courtWrap.classList.add("full");
      courtWrap.classList.remove("half");
    }
    timelineSignature = "";
    tacticSignature = "";
    pathEditorSignature = "";
    persist();
    draw();
    showToast("战术已删除");
  }

  function renameTactic(id) {
    if (!tacticEditMode) return;
    const tactic = store.tactics.find((item) => item.id === id);
    if (!tactic) return;
    const nextName = window.prompt("请输入战术名称", tactic.name);
    if (nextName === null) return;
    const name = nextName.trim().slice(0, 30);
    if (!name) {
      showToast("战术名称不能为空");
      return;
    }
    if (name === tactic.name) return;
    tactic.name = name;
    tacticSignature = "";
    persist();
    draw();
    showToast(`已将战术改名为“${name}”`);
  }

  function requestDeleteTurn(index) {
    if (!turnEditMode || index <= 0 || turns().length <= 1) return;
    const turn = turns()[index];
    pendingDeletion = { type: "turn", index, label: `回合 ${index}` };
    $("#confirmTitle").textContent = `删除${turn.name || `回合 ${index}`}？`;
    $("#confirmDetail").textContent = "删除后该回合的位置和转折点都无法恢复。";
    $("#confirmOverlay").hidden = false;
    $("#confirmDeleteButton").focus();
  }

  function requestDeleteTactic(id) {
    if (!tacticEditMode || store.tactics.length <= 1) {
      if (store.tactics.length <= 1) showToast("至少需要保留一套战术");
      return;
    }
    const tactic = store.tactics.find((item) => item.id === id);
    if (!tactic) return;
    pendingDeletion = { type: "tactic", id, label: tactic.name };
    $("#confirmTitle").textContent = `删除${tactic.name}？`;
    $("#confirmDetail").textContent = "删除后其中的全场、半场回合和转折点都无法恢复。";
    $("#confirmOverlay").hidden = false;
    $("#confirmDeleteButton").focus();
  }

  function closeDeleteConfirm() {
    pendingDeletion = null;
    $("#confirmOverlay").hidden = true;
  }

  function confirmDelete() {
    if (!pendingDeletion) return;
    const deletion = pendingDeletion;
    closeDeleteConfirm();
    if (deletion.type === "turn") deleteTurn(deletion.index);
    if (deletion.type === "tactic") deleteTactic(deletion.id);
  }

  function resetTurn() {
    stopPlayback(false);
    const index = activeIndex();
    turns()[index].positions = index === 0 ? makePositions(mode) : clonePositions(turns()[index - 1].positions);
    turns()[index].waypoints = [];
    turns()[index].opportunity = null;
    editingWaypoint = -1;
    pathEditorSignature = "";
    selected = null;
    persist();
    draw();
    showToast(index === 0 ? "已恢复默认站位" : "已恢复为上一回合位置");
  }

  function selectWaypoint(index) {
    if (activeIndex() <= 0 || player.playing || player.paused) return;
    const next = Number(index);
    if (next < -1 || next >= waypointsFor().length) return;
    editingWaypoint = next;
    selected = null;
    pathEditorSignature = "";
    draw();
  }

  function addWaypoint() {
    if (activeIndex() <= 0 || player.playing || player.paused) {
      showToast("请先选择第 1 回合或之后的回合");
      return;
    }
    const index = activeIndex();
    const points = waypointsFor(index);
    if (points.length >= 6) {
      showToast("每个回合最多添加 6 个转折点");
      return;
    }
    const before = points.length ? points[points.length - 1].positions : turns()[index - 1].positions;
    points.push({ id: uid(), positions: interpolatePositions(before, turns()[index].positions, 0.5) });
    editingWaypoint = points.length - 1;
    selected = null;
    timelineSignature = "";
    pathEditorSignature = "";
    persist();
    draw();
    showToast(`已添加转折点 ${points.length}`);
  }

  function deleteWaypoint() {
    const points = waypointsFor();
    if (activeIndex() <= 0 || editingWaypoint < 0 || !points[editingWaypoint]) return;
    const removed = editingWaypoint + 1;
    points.splice(editingWaypoint, 1);
    editingWaypoint = points.length ? Math.min(editingWaypoint, points.length - 1) : -1;
    selected = null;
    timelineSignature = "";
    pathEditorSignature = "";
    persist();
    draw();
    showToast(`已删除转折点 ${removed}`);
  }

  function saveOpportunity() {
    const index = activeIndex();
    if (index <= 0 || player.playing || player.paused) return;
    const from = $("#opportunityFrom").value;
    const to = $("#opportunityTo").value;
    if (!from || !to || from === to) {
      showToast("请选择不同的传球球员和接球队员");
      return;
    }
    turns()[index].opportunity = { from, to };
    timelineSignature = "";
    persist();
    draw();
    showToast("已添加本回合潜在传球箭头");
  }

  function removeOpportunity() {
    const index = activeIndex();
    if (index <= 0 || !opportunityFor(index)) return;
    turns()[index].opportunity = null;
    timelineSignature = "";
    persist();
    draw();
    showToast("已移除本回合潜在传球箭头");
  }

  function previousTurn() {
    selectTurn(Math.max(0, activeIndex() - 1));
  }

  function nextTurn() {
    selectTurn(Math.min(turns().length - 1, activeIndex() + 1));
  }

  function playOrPause() {
    if (player.playing) {
      pausePlayback();
      return;
    }
    if (turns().length < 2) {
      showToast("请先新增一个回合，再运行轨迹");
      return;
    }
    if (activeIndex() >= turns().length - 1) {
      player.segment = 0;
      player.progress = 0;
    } else {
      player.segment = activeIndex();
    }
    editingWaypoint = -1;
    pathEditorSignature = "";
    player.playing = true;
    player.paused = false;
    player.lastTs = performance.now();
    player.raf = requestAnimationFrame(playFrame);
    draw();
  }

  function pausePlayback() {
    player.playing = false;
    player.paused = true;
    if (player.raf) cancelAnimationFrame(player.raf);
    player.raf = 0;
    draw();
  }

  function stopPlayback(resetToStart = true) {
    if (player.raf) cancelAnimationFrame(player.raf);
    player.playing = false;
    player.paused = false;
    player.raf = 0;
    player.progress = 0;
    if (resetToStart) player.segment = 0;
  }

  function playFrame(timestamp) {
    if (!player.playing) return;
    const elapsed = Math.min(0.1, (timestamp - player.lastTs) / 1000);
    player.lastTs = timestamp;
    player.progress += elapsed / speed;
    if (player.progress >= 1) {
      player.segment += 1;
      player.progress = 0;
      if (player.segment >= turns().length - 1) {
        player.segment = turns().length - 1;
        player.progress = 1;
        player.playing = false;
        player.paused = false;
      }
    }
    draw();
    if (player.playing) player.raf = requestAnimationFrame(playFrame);
  }

  function setMode(nextMode) {
    if (!CONFIG[nextMode] || nextMode === mode) return;
    stopPlayback(true);
    mode = nextMode;
    editingWaypoint = -1;
    pathEditorSignature = "";
    selected = null;
    $(".mode-button.active")?.classList.remove("active");
    $(`.mode-button[data-mode="${mode}"]`)?.classList.add("active");
    courtWrap.classList.toggle("full", mode === "full");
    courtWrap.classList.toggle("half", mode === "half");
    draw();
  }

  function toggleTacticEditMode() {
    tacticEditMode = !tacticEditMode;
    tacticSignature = "";
    draw();
  }

  function toggleTurnEditMode() {
    turnEditMode = !turnEditMode;
    timelineSignature = "";
    draw();
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toastRegion.innerHTML = `<div class="toast">${escapeHtml(message)}</div>`;
    toastTimer = setTimeout(() => { toastRegion.innerHTML = ""; }, 3400);
  }

  function closeExportMenu() {
    exportMenu.hidden = true;
    $("#exportButton").setAttribute("aria-expanded", "false");
  }

  function openExportMenu() {
    exportMenu.hidden = !exportMenu.hidden;
    $("#exportButton").setAttribute("aria-expanded", String(!exportMenu.hidden));
  }

  function updateExportDialog(title, detail, progress) {
    $("#exportTitle").textContent = title;
    $("#exportDetail").textContent = detail;
    $("#exportProgressBar").style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  }

  function startExportDialog(title) {
    exportOverlay.hidden = false;
    updateExportDialog(title, "准备画面…", 0);
  }

  function finishExportDialog() {
    exportOverlay.hidden = true;
  }

  function exportPositionsAt(seconds) {
    const list = turns();
    const total = (list.length - 1) * speed;
    if (seconds >= total || list.length < 2) return list[list.length - 1].positions;
    const segment = Math.min(list.length - 2, Math.floor(seconds / speed));
    const progress = (seconds - segment * speed) / speed;
    return transitionState(segment, progress).positions;
  }

  function drawExportFrame(seconds, width, height) {
    const list = turns();
    const total = (list.length - 1) * speed;
    const safeSeconds = Math.min(total, Math.max(0, seconds));
    const segment = Math.min(list.length - 2, Math.floor(safeSeconds / speed));
    const progress = total ? Math.min(1, (safeSeconds - segment * speed) / speed) : 1;
    const positions = exportPositionsAt(safeSeconds);
    exportCtx.setTransform(1, 0, 0, 1, 0, 0);
    drawScene(exportCtx, width, height, mode, positions, {
      selected: null,
      showTrails: true,
      pathPositions: transitionPath(segment),
      playing: safeSeconds < total,
      progress,
      segment,
      opportunity: opportunityFor(segment + 1),
    });
  }

  function getVideoDimensions() {
    const width = mode === "full" ? 720 : 900;
    const rawHeight = Math.round(width / CONFIG[mode].aspect);
    return { width, height: rawHeight + (rawHeight % 2) };
  }

  function loadMediaBunny() {
    if (!mediaBunnyPromise) {
      mediaBunnyPromise = import("https://cdn.jsdelivr.net/npm/mediabunny@1.54.0/+esm").catch((error) => {
        mediaBunnyPromise = null;
        throw error;
      });
    }
    return mediaBunnyPromise;
  }

  async function exportMp4() {
    if (turns().length < 2) {
      showToast("至少需要两个回合才能导出");
      return;
    }
    closeExportMenu();
    stopPlayback(false);
    const { width, height } = getVideoDimensions();
    exportCanvas.width = width;
    exportCanvas.height = height;
    const fps = 30;
    const total = (turns().length - 1) * speed + 0.55;
    const nativeType = typeof MediaRecorder === "undefined" ? null : [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=avc1",
      "video/mp4",
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));

    if (nativeType && exportCanvas.captureStream) {
      const blob = await recordCanvasVideo(nativeType, "正在生成 MP4 视频", width, height, total, fps);
      finishExportDialog();
      downloadBlob(blob, `court-motion-${mode}.mp4`);
      showToast("MP4 视频已下载");
      return;
    }

    if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
      throw new Error("当前浏览器不支持 H.264 视频编码");
    }

    startExportDialog("正在生成 MP4 视频");
    updateExportDialog("正在加载 MP4 编码器", "首次使用需要连接网络", 0.03);
    const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, Quality } = await loadMediaBunny();
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    const source = new CanvasSource(exportCanvas, {
      codec: "avc",
      fullCodecString: "avc1.42001f",
      quality: new Quality({ bitrate: mode === "full" ? 5_000_000 : 4_000_000 }),
      keyFrameInterval: 2,
    });
    output.addVideoTrack(source, { frameRate: fps });
    output.setMetadataTags({ title: `${activeTactic().name} · ${CONFIG[mode].label}` });
    await output.start();

    const frameCount = Math.max(2, Math.ceil(total * fps));
    for (let frame = 0; frame < frameCount; frame += 1) {
      const seconds = Math.min(total, frame / fps);
      drawExportFrame(seconds, width, height);
      await source.add(frame / fps, 1 / fps, { keyFrame: frame % (fps * 2) === 0 });
      if (frame % 3 === 0 || frame === frameCount - 1) {
        const progress = (frame + 1) / frameCount;
        updateExportDialog("正在生成 MP4 视频", `${frame + 1} / ${frameCount} 帧`, 0.08 + progress * 0.84);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    source.close();
    updateExportDialog("正在封装 MP4 视频", "写入视频索引…", 0.95);
    await output.finalize();
    if (!target.buffer) throw new Error("MP4 封装没有返回数据");
    finishExportDialog();
    downloadBlob(new Blob([target.buffer], { type: "video/mp4" }), `court-motion-${mode}.mp4`);
    showToast("MP4 视频已下载");
  }

  async function recordCanvasVideo(mimeType, title, width, height, total, fps) {
    const stream = exportCanvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    startExportDialog(title);
    const finished = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(200);
    await new Promise((resolve) => {
      const startedAt = performance.now();
      const render = (timestamp) => {
        const current = Math.min(total, (timestamp - startedAt) / 1000);
        drawExportFrame(current, width, height);
        updateExportDialog(title, `${Math.round((current / total) * 100)}% · ${CONFIG[mode].label}`, current / total);
        if (current >= total) {
          recorder.stop();
          resolve();
          return;
        }
        requestAnimationFrame(render);
      };
      requestAnimationFrame(render);
    });
    await finished;
    stream.getTracks().forEach((track) => track.stop());
    return new Blob(chunks, { type: mimeType });
  }

  async function exportWebm() {
    if (turns().length < 2) {
      showToast("至少需要两个回合才能导出");
      return;
    }
    if (!exportCanvas.captureStream || typeof MediaRecorder === "undefined") {
      showToast("当前浏览器不支持视频导出，请改用 GIF");
      return;
    }
    closeExportMenu();
    stopPlayback(false);
    const { width, height } = getVideoDimensions();
    exportCanvas.width = width;
    exportCanvas.height = height;
    const fps = 30;
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) {
      showToast("当前浏览器没有可用的视频编码器，请改用 GIF");
      return;
    }
    const total = (turns().length - 1) * speed + 0.55;
    const blob = await recordCanvasVideo(mimeType, "正在生成 WebM 视频", width, height, total, fps);
    finishExportDialog();
    downloadBlob(blob, `court-motion-${mode}.webm`);
    showToast("WebM 视频已下载");
  }

  async function exportGif() {
    if (turns().length < 2) {
      showToast("至少需要两个回合才能导出");
      return;
    }
    closeExportMenu();
    stopPlayback(false);
    const width = mode === "full" ? 480 : 420;
    const height = Math.round(width / CONFIG[mode].aspect);
    exportCanvas.width = width;
    exportCanvas.height = height;
    const total = (turns().length - 1) * speed + 0.55;
    const frameCount = Math.max(2, Math.min(240, Math.ceil(total * 10)));
    const delay = Math.max(3, Math.round((total / frameCount) * 100));
    const gif = new GifWriter(width, height);
    startExportDialog("正在生成 GIF 动图");
    for (let frame = 0; frame < frameCount; frame += 1) {
      const seconds = total * (frame / (frameCount - 1));
      drawExportFrame(seconds, width, height);
      const pixels = exportCtx.getImageData(0, 0, width, height).data;
      gif.addFrame(quantize332(pixels), delay);
      if (frame % 4 === 0 || frame === frameCount - 1) {
        updateExportDialog("正在生成 GIF 动图", `${frame + 1} / ${frameCount} 帧`, (frame + 1) / frameCount);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    finishExportDialog();
    downloadBlob(gif.finish(), `court-motion-${mode}.gif`);
    showToast("GIF 动图已下载");
  }

  function quantize332(data) {
    const pixels = new Uint8Array(data.length / 4);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      pixels[p] = (data[i] & 0xe0) | ((data[i + 1] & 0xe0) >> 3) | (data[i + 2] >> 6);
    }
    return pixels;
  }

  class GifWriter {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.bytes = [];
      this.writeHeader();
    }

    byte(...values) {
      this.bytes.push(...values);
    }

    word(value) {
      this.byte(value & 255, (value >> 8) & 255);
    }

    writeHeader() {
      Array.from("GIF89a").forEach((character) => this.byte(character.charCodeAt(0)));
      this.word(this.width);
      this.word(this.height);
      this.byte(0xf7, 0, 0);
      for (let index = 0; index < 256; index += 1) {
        this.byte(((index >> 5) & 7) * 255 / 7, ((index >> 2) & 7) * 255 / 7, (index & 3) * 255 / 3);
      }
      this.byte(0x21, 0xff, 0x0b);
      Array.from("NETSCAPE2.0").forEach((character) => this.byte(character.charCodeAt(0)));
      this.byte(0x03, 0x01, 0x00, 0x00, 0x00);
    }

    addFrame(indexes, delay) {
      this.byte(0x21, 0xf9, 0x04, 0x00, delay & 255, (delay >> 8) & 255, 0x00, 0x00);
      this.byte(0x2c, 0x00, 0x00, 0x00, 0x00);
      this.word(this.width);
      this.word(this.height);
      this.byte(0x00, 0x08);
      const compressed = lzwEncode(indexes, 8);
      for (let offset = 0; offset < compressed.length; offset += 255) {
        const chunk = compressed.slice(offset, offset + 255);
        this.byte(chunk.length, ...chunk);
      }
      this.byte(0x00);
    }

    finish() {
      this.byte(0x3b);
      return new Blob([new Uint8Array(this.bytes)], { type: "image/gif" });
    }
  }

  function lzwEncode(indexes, minimumCodeSize) {
    const clear = 1 << minimumCodeSize;
    const end = clear + 1;
    let nextCode = end + 1;
    let codeSize = minimumCodeSize + 1;
    let dictionary = new Map();
    let buffer = 0;
    let bits = 0;
    const bytes = [];
    const writeCode = (code) => {
      buffer |= code << bits;
      bits += codeSize;
      while (bits >= 8) {
        bytes.push(buffer & 255);
        buffer >>>= 8;
        bits -= 8;
      }
    };
    writeCode(clear);
    let prefix = indexes[0] ?? 0;
    for (let index = 1; index < indexes.length; index += 1) {
      const suffix = indexes[index];
      const key = (prefix << 8) | suffix;
      const existing = dictionary.get(key);
      if (existing !== undefined) {
        prefix = existing;
        continue;
      }
      writeCode(prefix);
      if (nextCode < 4096) {
        dictionary.set(key, nextCode);
        nextCode += 1;
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
      } else {
        writeCode(clear);
        dictionary = new Map();
        codeSize = minimumCodeSize + 1;
        nextCode = end + 1;
      }
      prefix = suffix;
    }
    writeCode(prefix);
    writeCode(end);
    if (bits > 0) bytes.push(buffer & 255);
    return bytes;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function downloadWorkspace() {
    const payload = {
      ...store,
      exportedAt: new Date().toISOString(),
      activeMode: mode,
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `court-motion-${mode}.json`);
    showToast("战术文件已下载");
  }

  function createNewTactic() {
    stopPlayback(true);
    const tactic = createTactic(store.tactics.length + 1);
    store.tactics.push(tactic);
    store.activeTacticId = tactic.id;
    mode = "full";
    editingWaypoint = -1;
    selected = null;
    timelineSignature = "";
    tacticSignature = "";
    pathEditorSignature = "";
    $(".mode-button.active")?.classList.remove("active");
    $(".mode-button[data-mode=full]")?.classList.add("active");
    courtWrap.classList.add("full");
    courtWrap.classList.remove("half");
    persist();
    draw();
    showToast(`已新建 ${tactic.name}`);
  }

  function importWorkspace(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        store = normalizeStore(parsed);
        mode = parsed.activeMode === "half" ? "half" : mode;
        $(".mode-button.active")?.classList.remove("active");
        $(`.mode-button[data-mode="${mode}"]`)?.classList.add("active");
        courtWrap.classList.toggle("full", mode === "full");
        courtWrap.classList.toggle("half", mode === "half");
        stopPlayback(true);
        editingWaypoint = -1;
        selected = null;
        timelineSignature = "";
        tacticSignature = "";
        pathEditorSignature = "";
        persist();
        draw();
        showToast("战术文件已打开");
      } catch {
        showToast("文件格式无法读取");
      }
    };
    reader.readAsText(file);
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (player.playing || player.paused) return;
    const point = screenPoint(event);
    const key = hitTest(point);
    selected = key;
    if (!key) {
      draw();
      return;
    }
    dragging = key;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();
    draw();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging || player.playing || player.paused) return;
    saveCurrentPosition(dragging, screenPoint(event));
    draw();
  });

  function releasePointer(event) {
    if (!dragging) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    dragging = null;
    canvas.classList.remove("dragging");
  }

  canvas.addEventListener("pointerup", releasePointer);
  canvas.addEventListener("pointercancel", releasePointer);
  canvas.addEventListener("keydown", (event) => {
    if (!selected || player.playing || player.paused || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const point = currentPositions()[selected];
    const step = event.shiftKey ? 0.01 : 0.003;
    const next = { x: point.x, y: point.y };
    if (event.key === "ArrowUp") next.y -= step;
    if (event.key === "ArrowDown") next.y += step;
    if (event.key === "ArrowLeft") next.x -= step;
    if (event.key === "ArrowRight") next.x += step;
    saveCurrentPosition(selected, next);
    draw();
  });

  turnList.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete]");
    if (deleteButton) {
      event.stopPropagation();
      requestDeleteTurn(Number(deleteButton.dataset.delete));
      return;
    }
    const item = event.target.closest(".turn-item");
    if (item) selectTurn(Number(item.dataset.index));
  });

  turnList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const item = event.target.closest(".turn-item");
    if (item) {
      event.preventDefault();
      selectTurn(Number(item.dataset.index));
    }
  });

  tacticList.addEventListener("click", (event) => {
    const renameButton = event.target.closest("[data-rename-tactic]");
    if (renameButton) {
      event.stopPropagation();
      renameTactic(renameButton.dataset.renameTactic);
      return;
    }
    const deleteButton = event.target.closest("[data-delete-tactic]");
    if (deleteButton) {
      event.stopPropagation();
      requestDeleteTactic(deleteButton.dataset.deleteTactic);
      return;
    }
    const item = event.target.closest("[data-tactic-id]");
    if (item) selectTactic(item.dataset.tacticId);
  });

  $("#pathStepList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-waypoint]");
    if (button) selectWaypoint(Number(button.dataset.waypoint));
  });

  $$(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $("#playButton").addEventListener("click", playOrPause);
  $("#stopButton").addEventListener("click", () => { stopPlayback(true); selected = null; draw(); });
  $("#previousButton").addEventListener("click", previousTurn);
  $("#nextButton").addEventListener("click", nextTurn);
  $("#addTurnButton").addEventListener("click", addTurn);
  $("#addTurnWideButton").addEventListener("click", addTurn);
  $("#addTacticButton").addEventListener("click", createNewTactic);
  $("#editTacticsButton").addEventListener("click", toggleTacticEditMode);
  $("#editTurnsButton").addEventListener("click", toggleTurnEditMode);
  $("#addWaypointButton").addEventListener("click", addWaypoint);
  $("#deleteWaypointButton").addEventListener("click", deleteWaypoint);
  $("#addOpportunityButton").addEventListener("click", saveOpportunity);
  $("#removeOpportunityButton").addEventListener("click", removeOpportunity);
  $("#resetTurnButton").addEventListener("click", resetTurn);
  $("#speedRange").addEventListener("input", (event) => {
    speed = Number(event.target.value);
    $("#speedOutput").textContent = `${speed.toFixed(1)} 秒`;
  });
  $("#exportButton").addEventListener("click", (event) => { event.stopPropagation(); openExportMenu(); });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#exportMenu") && !event.target.closest("#exportButton")) closeExportMenu();
  });
  $("[data-export=mp4]").addEventListener("click", () => exportMp4().catch((error) => {
    console.error("MP4 export failed", error);
    finishExportDialog();
    showToast("MP4 生成失败，请使用最新版 Chrome、Edge 或 Safari");
  }));
  $("[data-export=webm]").addEventListener("click", () => exportWebm().catch((error) => {
    console.error("WebM export failed", error);
    finishExportDialog();
    showToast("视频生成失败，请改用 GIF");
  }));
  $("[data-export=gif]").addEventListener("click", () => exportGif().catch((error) => {
    console.error("GIF export failed", error);
    finishExportDialog();
    showToast("GIF 生成失败，请重试");
  }));
  $("#newTacticButton").addEventListener("click", createNewTactic);
  $("#cancelDeleteButton").addEventListener("click", closeDeleteConfirm);
  $("#confirmDeleteButton").addEventListener("click", confirmDelete);
  $("#confirmOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeDeleteConfirm();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pendingDeletion) closeDeleteConfirm();
  });
  $("#saveButton").addEventListener("click", async () => {
    downloadWorkspace();
    const synced = await syncToServer();
    showToast(synced ? "战术文件已保存，并已同步数据库" : "战术文件已保存到下载文件");
  });
  $("#importButton").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (event) => { importWorkspace(event.target.files[0]); event.target.value = ""; });

  resizeObserver = new ResizeObserver(() => draw());
  resizeObserver.observe(courtWrap);
  window.addEventListener("resize", draw);
  window.addEventListener("pagehide", () => {
    if (window.location.protocol === "file:") return;
    clearTimeout(serverSaveTimer);
    fetch(API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workspacePayload()),
      keepalive: true,
    }).catch(() => {});
  });
  draw();
  if (window.lucide) window.lucide.createIcons();
  hydrateFromServer();
})();
