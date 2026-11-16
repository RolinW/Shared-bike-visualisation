/* ==========================================================================
   西南交大 · 共享单车轨迹（v1.6 · 性能优化版）
   渲染策略：
   - 底图与订单路径全部预生成 Path2D（世界坐标），重绘只做 fill/stroke
   - 缩放/拖动只标记脏，由 rAF 每帧最多重绘一次
   - 淡出轨迹按透明度分桶批量描边；进行中轨迹按方向合并成 3 条路径
   - 视口裁剪 + 缩放等级 LOD（低缩放不画建筑/小路）
   ========================================================================== */
(function () {
  'use strict';

  var MAP = window.MAP_DATA;
  var DATA = window.ORDERS_DATA;
  var ORDERS = DATA.orders;

  var W = 0, H = 0, DPR = 1;
  var base = document.getElementById('base');
  var traj = document.getElementById('traj');
  var tint = document.getElementById('tint');
  var bctx = base.getContext('2d');
  var tctx = traj.getContext('2d');
  var xctx = tint.getContext('2d');

  var cam = { x: 0, y: 0, k: 0.25 };
  var t = Math.max(DATA.t0, 20 * 3600);
  var playing = false;
  var speed = 1;
  var selected = null;
  var last = 0;
  var dirty = true;
  var baseDirty = true;

  var SPEEDS = [1, 2, 5, 10, 15, 20, 30, 45, 60];
  var FADE = 2;
  var COLORS = { inner: '#4cc9f0', in: '#7CFC9B', out: '#ffb454' };
  var DIR_LABEL = { inner: '区内', in: '骑入', out: '骑出' };

  var basePaths = null;
  var interacting = false;
  var camIdleTimer = null;
  var baseCam = { x: 0, y: 0, k: 1 };

  /* ---------------------------------------------------------------- 预处理 */
  function polyPath(list) {
    var p = new Path2D();
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      p.moveTo(f[0], f[1]);
      for (var j = 2; j < f.length; j += 2) p.lineTo(f[j], f[j + 1]);
      p.closePath();
    }
    return p;
  }

  function linePath(list) {
    var p = new Path2D();
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      p.moveTo(f[0], f[1]);
      for (var j = 2; j < f.length; j += 2) p.lineTo(f[j], f[j + 1]);
    }
    return p;
  }

  function buildBasePaths() {
    var L = MAP.layers;
    basePaths = {
      green: polyPath(L.green),
      water: polyPath(L.water),
      waterway: linePath(L.waterway),
      buildings: polyPath(L.buildings),
      railway: linePath(L.railway),
      region: linePath(MAP.region),
      roads: {
        path: linePath(L.roads.path),
        local: linePath(L.roads.local),
        secondary: linePath(L.roads.secondary),
        major: linePath(L.roads.major)
      }
    };
  }

  ORDERS.forEach(function (o) {
    var pts = [];
    if (o.r && o.r.length >= 4) {
      for (var i = 0; i < o.r.length; i += 2) pts.push([o.r[i], o.r[i + 1]]);
    } else {
      pts = [[o.sx, o.sy], [o.ex, o.ey]];
    }
    var cum = [0], total = 0;
    var p = new Path2D();
    p.moveTo(pts[0][0], pts[0][1]);
    var minX = pts[0][0], maxX = pts[0][0], minY = pts[0][1], maxY = pts[0][1];
    for (var j = 1; j < pts.length; j++) {
      total += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
      cum.push(total);
      p.lineTo(pts[j][0], pts[j][1]);
      minX = Math.min(minX, pts[j][0]); maxX = Math.max(maxX, pts[j][0]);
      minY = Math.min(minY, pts[j][1]); maxY = Math.max(maxY, pts[j][1]);
    }
    o.pts = pts;
    o.cum = cum;
    o.rl = total;
    o.path = p;
    o.bbox = [minX, minY, maxX, maxY];
    // 忘记还车：按 8 km/h 走完全程，之后静止在终点
    o.motionEnd = o.slow ? o.t0 + total / (8000 / 3600) : o.t1;
    if (o.motionEnd > o.t1) o.motionEnd = o.t1;
  });

  /* ---------------------------------------------------------------- 尺寸 */
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    [base, traj, tint].forEach(function (c) {
      c.width = Math.round(W * DPR);
      c.height = Math.round(H * DPR);
      c.style.width = W + 'px';
      c.style.height = H + 'px';
    });
    baseDirty = true;
    dirty = true;
  }

  function viewRect() {
    var hw = W / 2 / cam.k, hh = H / 2 / cam.k;
    return { x0: cam.x - hw, x1: cam.x + hw, y0: cam.y - hh, y1: cam.y + hh };
  }

  function bboxHit(o, v, margin) {
    var b = o.bbox;
    return b[2] >= v.x0 - margin && b[0] <= v.x1 + margin &&
           b[3] >= v.y0 - margin && b[1] <= v.y1 + margin;
  }

  function fitRegion() {
    var pts = MAP.region[0];
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
    }
    cam.x = (minX + maxX) / 2;
    cam.y = (minY + maxY) / 2;
    var pad = 1.35;
    cam.k = Math.min(W / ((maxX - minX) * pad), H / ((maxY - minY) * pad));
  }

  /* ---------------------------------------------------------------- 底图 */
  function drawBase() {
    bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    bctx.clearRect(0, 0, W, H);

    var g = bctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, '#101a2c');
    g.addColorStop(1, '#070a12');
    bctx.fillStyle = g;
    bctx.fillRect(0, 0, W, H);

    var k = cam.k;
    bctx.setTransform(k * DPR, 0, 0, -k * DPR,
      (W / 2 - cam.x * k) * DPR, (H / 2 + cam.y * k) * DPR);
    bctx.lineCap = 'round';
    bctx.lineJoin = 'round';

    var P = basePaths;

    // 绿地 / 水域
    bctx.fillStyle = '#132a21';
    bctx.strokeStyle = '#1d4233';
    bctx.lineWidth = 0.6 / k;
    bctx.fill(P.green); bctx.stroke(P.green);

    bctx.fillStyle = '#0a2f4a';
    bctx.strokeStyle = '#12507c';
    bctx.fill(P.water); bctx.stroke(P.water);

    if (k >= 0.04) {
      bctx.strokeStyle = '#104267';
      bctx.lineWidth = 2 / k;
      bctx.stroke(P.waterway);
      bctx.strokeStyle = '#4a5368';
      bctx.lineWidth = 1.4 / k;
      bctx.setLineDash([6 / k, 5 / k]);
      bctx.stroke(P.railway);
      bctx.setLineDash([]);
    }

    // 建筑（缩放过小时或交互中省略）
    if (!interacting && k >= 0.10) {
      bctx.fillStyle = '#1b2434';
      bctx.strokeStyle = '#2b3850';
      bctx.lineWidth = 0.55 / k;
      bctx.fill(P.buildings);
      bctx.stroke(P.buildings);
    }

    // 道路（LOD）
    var roads = P.roads;
    if (!interacting && k >= 0.05) {
      bctx.strokeStyle = '#26324a';
      bctx.lineWidth = 1.0 / k;
      bctx.stroke(roads.path);
    }
    if (!interacting && k >= 0.035) {
      bctx.strokeStyle = '#33415c';
      bctx.lineWidth = 1.7 / k;
      bctx.stroke(roads.local);
    }
    bctx.strokeStyle = '#41536f';
    bctx.lineWidth = 2.8 / k;
    bctx.stroke(roads.secondary);
    bctx.strokeStyle = '#50688c';
    bctx.lineWidth = 4.6 / k;
    bctx.stroke(roads.major);

    // 区域
    bctx.strokeStyle = 'rgba(255, 204, 102, .9)';
    bctx.lineWidth = 1.8 / k;
    bctx.setLineDash([9 / k, 6 / k]);
    bctx.stroke(P.region);
    bctx.setLineDash([]);

    baseCam.x = cam.x; baseCam.y = cam.y; baseCam.k = cam.k;
    base.style.transform = '';
  }

  /* ---------------------------------------------------------------- 轨迹 */
  function pointAt(o, d) {
    var pts = o.pts, cum = o.cum;
    if (d <= 0) return pts[0];
    if (d >= o.rl) return pts[pts.length - 1];
    var lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    var seg = cum[hi] - cum[lo] || 1;
    var f = (d - cum[lo]) / seg;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f,
            pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
  }

  var TRAIL_SEC = 50;
  var TRAIL_K = 5;

  function appendPolyline(path, o, s0, e0) {
    var pts = o.pts;
    var a = pointAt(o, s0);
    path.moveTo(a[0], a[1]);
    for (var i = 1; i < pts.length - 1; i++) {
      if (o.cum[i] > s0 && o.cum[i] < e0) path.lineTo(pts[i][0], pts[i][1]);
    }
    var b = pointAt(o, e0);
    path.lineTo(b[0], b[1]);
  }

  function tailLen(o, d) {
    var v = o.rl / Math.max(1, o.motionEnd - o.t0);   // m/s
    var len = Math.min(520, Math.max(35, v * TRAIL_SEC));
    return Math.min(len, d);
  }

  function addTail(paths, o, d) {
    var len = tailLen(o, d);
    if (len <= 0) return;
    for (var b = 0; b < TRAIL_K; b++) {
      var a0 = Math.max(0, d - (b + 1) * len / TRAIL_K);
      var a1 = d - b * len / TRAIL_K;
      if (a1 <= 0) continue;
      var key = o.dir + '|' + b;
      if (!paths[key]) paths[key] = new Path2D();
      appendPolyline(paths[key], o, a0, a1);
    }
  }

  function strokeFadingTail(o, alpha) {
    var d = o.rl;
    var len = tailLen(o, d);
    for (var b = 0; b < TRAIL_K; b++) {
      var a0 = Math.max(0, d - (b + 1) * len / TRAIL_K);
      var a1 = d - b * len / TRAIL_K;
      if (a1 <= 0) continue;
      var p = new Path2D();
      appendPolyline(p, o, a0, a1);
      tctx.globalAlpha = alpha * Math.pow(1 - b / TRAIL_K, 1.4);
      tctx.lineWidth = (2.3 - 1.3 * b / TRAIL_K) / cam.k;
      tctx.strokeStyle = COLORS[o.dir];
      tctx.stroke(p);
    }
    tctx.globalAlpha = 1;
  }

  function drawTrajectories() {
    tctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    tctx.clearRect(0, 0, W, H);

    var k = cam.k;
    tctx.setTransform(k * DPR, 0, 0, -k * DPR,
      (W / 2 - cam.x * k) * DPR, (H / 2 + cam.y * k) * DPR);
    tctx.lineCap = 'round';
    tctx.lineJoin = 'round';

    var view = viewRect();
    var pulseBase = performance.now() / 300;
    var active = 0;

    var bandPaths = {};
    var dots = { inner: null, in: null, out: null };
    var glow = { inner: null, in: null, out: null };
    var whiteGlow = null, whiteDots = null;
    var fading = [];

    for (var i = 0; i < ORDERS.length; i++) {
      var o = ORDERS[i];

      if (o.slow && t > o.motionEnd) {
        // 到达后：轨迹消失，白色位置点保留到订单结束
        if (t <= o.t1 && bboxHit(o, view, 20 / k)) {
          var endPt = o.pts[o.pts.length - 1];
          var EX = (endPt[0] - cam.x) * k + W / 2;
          var EY = H / 2 - (endPt[1] - cam.y) * k;
          whiteGlow = whiteGlow || new Path2D();
          whiteGlow.moveTo(EX + 5.6, EY);
          whiteGlow.arc(EX, EY, 5.6, 0, Math.PI * 2);
          whiteDots = whiteDots || new Path2D();
          whiteDots.moveTo(EX + 3, EY);
          whiteDots.arc(EX, EY, 3, 0, Math.PI * 2);
        }
        continue;
      }

      if (t >= o.t0 && t <= o.motionEnd) {
        if (!bboxHit(o, view, 20 / k)) continue;
        active++;

        var p = o.slow ? (t - o.t0) / (o.motionEnd - o.t0) : (t - o.t0) / o.dur;
        p = Math.max(0, Math.min(1, p));
        var d = p * o.rl;
        addTail(bandPaths, o, d);

        var cur = pointAt(o, d);
        var pulse = 2.0 + 0.5 * Math.sin(pulseBase + i * 1.7);
        var X = (cur[0] - cam.x) * k + W / 2;
        var Y = H / 2 - (cur[1] - cam.y) * k;
        var g2 = glow[o.dir] || (glow[o.dir] = new Path2D());
        g2.moveTo(X + 5.2 + pulse, Y);
        g2.arc(X, Y, 5.2 + pulse, 0, Math.PI * 2);
        var d2 = dots[o.dir] || (dots[o.dir] = new Path2D());
        d2.moveTo(X + pulse, Y);
        d2.arc(X, Y, pulse, 0, Math.PI * 2);
      } else if (t > o.motionEnd) {
        var age = t - o.t1;
        if (age > FADE) continue;
        if (!bboxHit(o, view, 20 / k)) continue;
        fading.push([o, 0.62 * (1 - age / FADE)]);
      }
    }

    // 拖尾：头亮尾淡
    Object.keys(bandPaths).forEach(function (key) {
      var parts = key.split('|');
      var dir = parts[0], b = Number(parts[1]);
      tctx.strokeStyle = COLORS[dir];
      tctx.globalAlpha = Math.pow(1 - b / TRAIL_K, 1.4) * 0.9;
      tctx.lineWidth = (2.3 - 1.3 * b / TRAIL_K) / k;
      tctx.stroke(bandPaths[key]);
    });
    tctx.globalAlpha = 1;

    // 刚结束的订单：拖尾 2 秒淡出
    fading.forEach(function (f) { strokeFadingTail(f[0], f[1]); });

    // 光点
    tctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ['inner', 'in', 'out'].forEach(function (dir) {
      if (glow[dir]) {
        tctx.fillStyle = hexA(COLORS[dir], 0.18);
        tctx.fill(glow[dir]);
      }
      if (dots[dir]) {
        tctx.fillStyle = COLORS[dir];
        tctx.fill(dots[dir]);
      }
    });
    if (whiteGlow) {
      tctx.fillStyle = 'rgba(255,255,255,.22)';
      tctx.fill(whiteGlow);
    }
    if (whiteDots) {
      tctx.fillStyle = '#ffffff';
      tctx.fill(whiteDots);
    }

    document.getElementById('active').textContent = '进行中 ' + active;

    // 选中：整条轨迹白色高亮
    if (selected) {
      tctx.setTransform(k * DPR, 0, 0, -k * DPR,
        (W / 2 - cam.x * k) * DPR, (H / 2 + cam.y * k) * DPR);
      tctx.strokeStyle = '#ffffff';
      tctx.lineWidth = 2.6 / k;
      tctx.stroke(selected.path);
      tctx.setTransform(DPR, 0, 0, DPR, 0, 0);

      var s = selected;
      var start = s.pts[0], end = s.pts[s.pts.length - 1];
      [[start, '起', 'rgba(124,252,155,.95)'], [end, '终', 'rgba(255,180,84,.95)']].forEach(function (pt) {
        var X = (pt[0][0] - cam.x) * k + W / 2;
        var Y = H / 2 - (pt[0][1] - cam.y) * k;
        tctx.fillStyle = pt[2];
        tctx.beginPath(); tctx.arc(X, Y, 6, 0, Math.PI * 2); tctx.fill();
        tctx.strokeStyle = '#fff'; tctx.lineWidth = 1.5; tctx.stroke();
        tctx.fillStyle = '#05070d';
        tctx.font = '9px sans-serif';
        tctx.textAlign = 'center';
        tctx.textBaseline = 'middle';
        tctx.fillText(pt[1], X, Y + 0.5);
      });

      if (t >= s.t0 && t <= s.motionEnd) {
        var sp = pointAt(s, Math.min(1, (t - s.t0) / (s.motionEnd - s.t0)) * s.rl);
        var SX = (sp[0] - cam.x) * k + W / 2;
        var SY = H / 2 - (sp[1] - cam.y) * k;
        tctx.fillStyle = 'rgba(255,255,255,.95)';
        tctx.beginPath(); tctx.arc(SX, SY, 3.6, 0, Math.PI * 2); tctx.fill();
      }
    }
  }

  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---------------------------------------------------------------- 昼夜 */
  function drawTint() {
    var hour = (t / 3600) % 24;
    var stops = [[18, 0.02], [19, 0.06], [20, 0.12], [21, 0.18], [22, 0.24], [23, 0.28]];
    var a = 0.28;
    for (var i = 0; i < stops.length - 1; i++) {
      if (hour >= stops[i][0] && hour <= stops[i + 1][0]) {
        var f = (hour - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
        a = stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f;
        break;
      }
    }
    if (hour < 6) a = 0.28;
    else if (hour < 18) a = 0.02;

    xctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    xctx.clearRect(0, 0, W, H);
    xctx.fillStyle = 'rgba(8,12,26,' + a + ')';
    xctx.fillRect(0, 0, W, H);

    var warm = Math.max(0, 1 - Math.abs(hour - 18.3) / 1.0);
    if (warm > 0) {
      var g = xctx.createLinearGradient(0, H, 0, H * 0.35);
      g.addColorStop(0, 'rgba(255,120,40,' + (0.10 * warm) + ')');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      xctx.fillStyle = g;
      xctx.fillRect(0, 0, W, H);
    }
  }

  /* ---------------------------------------------------------------- 时间 */
  function clampT(v) { return Math.max(DATA.t0, Math.min(DATA.t1, v)); }

  function fmt(tv) {
    var s = Math.floor(tv % 86400);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return [h, m, ss].map(function (x) { return (x < 10 ? '0' : '') + x; }).join(':');
  }

  function updateUI() {
    document.getElementById('clock').textContent = fmt(t);
    document.getElementById('range').value = String(Math.round(t - DATA.t0));
    document.getElementById('play').textContent = playing ? '⏸' : '▶';
    document.getElementById('phase').textContent = (t / 3600) < 19 ? '🌇' : '🌙';
  }

  /* ---------------------------------------------------------------- 详情 */
  function showPanel(o) {
    var el = document.getElementById('panel');
    var body = document.getElementById('panelBody');
    var dist = o.dist >= 1000 ? (o.dist / 1000).toFixed(2) + ' km' : o.dist + ' m';
    var dur = o.dur >= 60 ? Math.floor(o.dur / 60) + ' 分 ' + (o.dur % 60) + ' 秒' : o.dur + ' 秒';
    body.innerHTML =
      '<div class="kv"><span class="k">订单号</span><span class="v">…' + o.id.slice(-8) + '</span></div>' +
      '<div class="kv"><span class="k">车辆</span><span class="v">' + o.bike + '</span></div>' +
      '<div class="kv"><span class="k">方向</span><span class="v dir-' + o.dir + '">' + DIR_LABEL[o.dir] + '</span></div>' +
      '<div class="kv"><span class="k">距离</span><span class="v">' + dist + '</span></div>' +
      '<div class="kv"><span class="k">持续时间</span><span class="v">' + dur + '</span></div>' +
      '<div class="kv"><span class="k">开始</span><span class="v">' + fmt(o.t0) + '</span></div>' +
      '<div class="kv"><span class="k">结束</span><span class="v">' + fmt(o.t1) + '</span></div>' +
      '<div class="kv"><span class="k">拟合速度</span><span class="v">' + (o.speed != null ? o.speed + ' km/h' : '—') + '</span></div>' +
      '<div class="kv"><span class="k">路径</span><span class="v">' + (o.r ? '贴路' : '直线') + '</span></div>' +
      (o.slow ? '<div class="kv"><span class="k">状态</span><span class="v" style="color:#9aa4b2">可能忘记还车（按 8 km/h 模拟）</span></div>' +
        '<div class="kv"><span class="k">模拟到达</span><span class="v">' + fmt(o.motionEnd) + '</span></div>' : '');
    el.classList.remove('hidden');
  }

  function hidePanel() {
    selected = null;
    document.getElementById('panel').classList.add('hidden');
  }

  /* ---------------------------------------------------------------- 拾取 */
  function distToSeg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - x1, py - y1);
    var u = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
    return Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy));
  }

  function pick(px, py) {
    var best = null, bestD = 14;
    var k = cam.k;
    for (var i = 0; i < ORDERS.length; i++) {
      var o = ORDERS[i];
      var X, Y;

      if (t >= o.t0 && t <= o.motionEnd) {
        var p = o.slow ? (t - o.t0) / (o.motionEnd - o.t0) : (t - o.t0) / o.dur;
        var pt = pointAt(o, Math.max(0, Math.min(1, p)) * o.rl);
        X = (pt[0] - cam.x) * k + W / 2;
        Y = H / 2 - (pt[1] - cam.y) * k;
      } else if (o.slow && t > o.motionEnd && t <= o.t1) {
        var ep = o.pts[o.pts.length - 1];
        X = (ep[0] - cam.x) * k + W / 2;
        Y = H / 2 - (ep[1] - cam.y) * k;
      } else {
        continue;
      }

      var d = Math.hypot(px - X, py - Y);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /* ---------------------------------------------------------------- 交互 */
  function stretchBase() {
    var s = cam.k / baseCam.k;
    var dx = (baseCam.x - cam.x) * cam.k + W / 2 * (1 - s);
    var dy = (cam.y - baseCam.y) * cam.k + H / 2 * (1 - s);
    base.style.transformOrigin = '0 0';
    base.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')';
  }

  function setCam() {
    stretchBase();
    baseDirty = false;
    dirty = true;
    interacting = true;
    clearTimeout(camIdleTimer);
    camIdleTimer = setTimeout(function () {
      interacting = false;
      base.style.transform = '';
      baseDirty = true;
    }, 140);
  }

  function bindEvents() {
    var app = document.getElementById('app');

    window.addEventListener('resize', resize);

    app.addEventListener('wheel', function (e) {
      e.preventDefault();
      var mx = e.clientX, my = e.clientY;
      var wx = cam.x + (mx - W / 2) / cam.k;
      var wy = cam.y - (my - H / 2) / cam.k;
      var f = Math.exp(-e.deltaY * 0.0012);
      cam.k = Math.max(0.05, Math.min(2.5, cam.k * f));
      cam.x = wx - (mx - W / 2) / cam.k;
      cam.y = wy + (my - H / 2) / cam.k;
      setCam();
    }, { passive: false });

    var drag = null;
    app.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('#timeline') || e.target.closest('#panel')) return;
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
      app.setPointerCapture(e.pointerId);
    });
    app.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      cam.x -= dx / cam.k;
      cam.y += dy / cam.k;
      drag.x = e.clientX;
      drag.y = e.clientY;
      setCam();
    });
    app.addEventListener('pointerup', function (e) {
      drag = null;
      try { app.releasePointerCapture(e.pointerId); } catch (err) {}
    });

    app.addEventListener('dblclick', function (e) {
      if (e.target.closest('#timeline') || e.target.closest('#panel')) return;
      var o = pick(e.clientX, e.clientY);
      if (o) { selected = o; showPanel(o); }
      else hidePanel();
      dirty = true;
    });

    document.getElementById('close').addEventListener('click', hidePanel);

    var range = document.getElementById('range');
    range.max = String(Math.round(DATA.t1 - DATA.t0));
    range.addEventListener('input', function () {
      t = clampT(DATA.t0 + Number(range.value));
      playing = false;
        updateUI();
      dirty = true;
    });

    // 时间轴悬停：预览鼠标所在位置的时间
    var tip = document.getElementById('timeTip');
    var guide = document.getElementById('timeGuide');
    function hoverTime(clientX) {
      var rect = range.getBoundingClientRect();
      var f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      var tv = DATA.t0 + f * (DATA.t1 - DATA.t0);
      var x = rect.left + f * rect.width;
      tip.hidden = false;
      tip.textContent = fmt(tv);
      tip.style.left = Math.max(52, Math.min(W - 52, x)) + 'px';
      tip.style.top = (rect.top - 8) + 'px';
      guide.hidden = false;
      guide.style.left = x + 'px';
      guide.style.top = (rect.top - 25) + 'px';
      guide.style.height = (rect.height + 50) + 'px';
    }
    range.addEventListener('mousemove', function (e) { hoverTime(e.clientX); });
    range.addEventListener('mouseleave', function () {
      tip.hidden = true;
      guide.hidden = true;
    });

    document.getElementById('play').addEventListener('click', togglePlay);

    var btn = document.getElementById('speedBtn');
    var menu = document.getElementById('speedMenu');
    SPEEDS.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = s + '×';
      b.dataset.speed = s;
      if (s === speed) b.classList.add('on');
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        speed = s;
        btn.textContent = s + '× ▾';
        menu.querySelectorAll('button').forEach(function (x) {
          x.classList.toggle('on', Number(x.dataset.speed) === s);
        });
        menu.classList.add('hidden');
      });
      menu.appendChild(b);
    });
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', function () { menu.classList.add('hidden'); });

    window.addEventListener('keydown', function (e) {
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); t = clampT(t - speed); updateUI(); dirty = true; }
      else if (e.code === 'ArrowRight') { e.preventDefault(); t = clampT(t + speed); updateUI(); dirty = true; }
    });
  }

  function togglePlay() {
    playing = !playing;
    if (playing && t >= DATA.t1) t = DATA.t0;
    last = performance.now();
    updateUI();
  }

  /* ---------------------------------------------------------------- 主循环 */
  function loop(now) {
    var dt = last ? (now - last) / 1000 : 0;
    last = now;

    if (playing && dt > 0) {
      t = clampT(t + dt * speed);
      if (t >= DATA.t1) playing = false;
      updateUI();
      dirty = true;
    }

    if (baseDirty) { drawBase(); baseDirty = false; }
    if (dirty) { drawTrajectories(); drawTint(); dirty = false; }
    requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------------- 启动 */
  function init() {
    buildBasePaths();
    resize();
    fitRegion();
    bindEvents();
    updateUI();
    baseDirty = true;
    dirty = true;
    requestAnimationFrame(loop);
  }

  init();
})();
