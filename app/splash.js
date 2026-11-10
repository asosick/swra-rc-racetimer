/* Loading screen: a full-screen waving checkered flag with the SWRA badge.
 * When the app is ready, an RC racer flies from bottom-left to top-right,
 * its smoke trail billows until it covers the screen, then the smoke clears
 * to reveal the app.
 *
 * Plain script (not a module) so the flag starts waving on first paint.
 * The app calls window.SPLASH.go() once its sounds are loaded.
 */
(function () {
  'use strict';
  var root = document.getElementById('splash');
  if (!root) return;
  // Loading animation switched off in Settings: go straight to the app.
  try {
    if (JSON.parse(localStorage.getItem('settings') || '{}').splash === false) { root.remove(); return; }
  } catch (e) {}
  var flagCanvas = document.getElementById('splashFlag');
  var fx = document.getElementById('splashFx');
  var g2 = fx.getContext('2d');
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var MIN_FLAG = 1300;   // ms the flag is shown before the plane may fly
  var MAX_WAIT = 4500;   // fly even if the app never says it's ready
  var FLY = 1500;        // ms for the plane to cross the screen
  var COVER = 450;       // ms for the smoke to close up after the plane
  var FADE = 750;        // ms for the smoke to clear (CSS transition)

  var W = 0, H = 0, DPR = 1;
  var t0 = performance.now();
  var goAt = null;       // time the plane launched
  var ready = false;
  var finished = false;

  /* ------------------------------------------------------------------ *
   * Flag (WebGL fragment shader; CSS checkerboard fallback)
   * ------------------------------------------------------------------ */
  var gl = null, prog = null, uRes = null, uT = null;
  try { gl = flagCanvas.getContext('webgl', { antialias: false, alpha: false }); } catch (e) {}
  if (gl) {
    var vs = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
    var fs = [
      'precision mediump float;',
      'uniform vec2 res; uniform float t;',
      'const float PI = 3.14159265;',
      'void main(){',
      '  vec2 uv = gl_FragCoord.xy / res;',
      '  vec2 p = vec2(uv.x * res.x / res.y, uv.y);',
      // two travelling waves; ripples grow away from the hoist (left edge)
      '  float amp = 0.018 + 0.05 * uv.x;',
      '  float a1 = p.x * 5.0 - t * 3.1 + p.y * 1.6;',
      '  float a2 = p.x * 9.5 - t * 4.6 + p.y * 3.2;',
      '  float w  = sin(a1) * amp + sin(a2) * amp * 0.3;',
      '  float dw = cos(a1) * amp * 5.0 + cos(a2) * amp * 0.3 * 9.5;',
      '  vec2 q = p + vec2(w * 0.35, w);',
      // checker cells: 6 across the short side, anti-aliased with a 1px ramp
      '  float cell = min(res.x, res.y) / 6.0 / res.y;',
      '  vec2 g = q / cell;',
      '  float px = 1.0 / (cell * res.y);',
      '  float sx = clamp(sin(PI * g.x) / (PI * px), -1.0, 1.0);',
      '  float sy = clamp(sin(PI * g.y) / (PI * px), -1.0, 1.0);',
      '  float c = 0.5 + 0.5 * sx * sy;',
      '  vec3 col = mix(vec3(0.05, 0.055, 0.07), vec3(0.95, 0.95, 0.94), c);',
      // light across the folds + a soft sheen + vignette
      '  float light = clamp(0.86 + 0.95 * dw, 0.42, 1.18);',
      '  float sheen = pow(max(0.0, dw * 2.2), 3.0) * 0.35;',
      '  col = col * light + sheen;',
      '  float v = 1.0 - 0.55 * pow(length(uv - 0.5) * 1.25, 2.0);',
      '  gl_FragColor = vec4(col * v, 1.0);',
      '}'
    ].join('\n');
    var mk = function (type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    var v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
    if (v && f) {
      prog = gl.createProgram();
      gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) prog = null;
    }
    if (prog) {
      gl.useProgram(prog);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      uRes = gl.getUniformLocation(prog, 'res');
      uT = gl.getUniformLocation(prog, 't');
    } else {
      gl = null;
    }
  }
  if (!gl) root.classList.add('no-gl');

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    var fd = Math.min(DPR, 1.5); // the flag is soft; save fill-rate
    flagCanvas.width = Math.round(W * fd); flagCanvas.height = Math.round(H * fd);
    fx.width = Math.round(W * DPR); fx.height = Math.round(H * DPR);
    if (gl) gl.viewport(0, 0, flagCanvas.width, flagCanvas.height);
  }
  resize();
  window.addEventListener('resize', resize);

  /* ------------------------------------------------------------------ *
   * Plane (top-down racer, nose +x, about 40 units long)
   * ------------------------------------------------------------------ */
  var P = {
    tail: new Path2D('M-13,-1.2 L-16.5,-8 L-19.5,-8 L-18.5,-1.2 L-18.5,1.2 L-19.5,8 L-16.5,8 L-13,1.2 Z'),
    wing: new Path2D('M8,-2 L4.5,-19 L0.5,-19 L-1.5,-2 L-1.5,2 L0.5,19 L4.5,19 L8,2 Z'),
    tips: new Path2D('M3.4,-18.6 L4.5,-19 L0.5,-19 L0.9,-18.6 Z M3.4,18.6 L4.5,19 L0.5,19 L0.9,18.6 Z'),
    fuse: new Path2D('M19,0 C19,-2.6 14,-3.4 6,-3.4 L-18,-1.4 L-18,1.4 L6,3.4 C14,3.4 19,2.6 19,0 Z')
  };
  function grad(y0, y1, stops) {
    var gr = g2.createLinearGradient(0, y0, 0, y1);
    stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); });
    return gr;
  }
  function drawPlane(x, y, ang, scale, now) {
    // shadow on the flag
    g2.save();
    g2.translate(x + scale * 9, y + scale * 13); g2.rotate(ang); g2.scale(scale, scale);
    g2.fillStyle = 'rgba(0,0,0,.28)';
    g2.filter = 'blur(' + (scale * 2.5).toFixed(1) + 'px)';
    g2.fill(P.wing); g2.fill(P.tail); g2.fill(P.fuse);
    g2.restore();

    g2.save();
    g2.translate(x, y); g2.rotate(ang); g2.scale(scale, scale);
    g2.lineWidth = 0.5;
    var wingG = grad(-19, 19, [[0, '#ffe680'], [0.5, '#ffd23f'], [1, '#d99e00']]);
    g2.fillStyle = wingG; g2.strokeStyle = '#5a3d00';
    g2.fill(P.tail); g2.stroke(P.tail);
    g2.fill(P.wing); g2.stroke(P.wing);
    g2.fillStyle = '#e8382c'; g2.fill(P.tips);
    g2.fillStyle = grad(-3.4, 3.4, [[0, '#ff6b5e'], [0.5, '#e8382c'], [1, '#a8211a']]);
    g2.strokeStyle = '#5c120d';
    g2.fill(P.fuse); g2.stroke(P.fuse);
    g2.strokeStyle = 'rgba(255,255,255,.85)'; g2.lineWidth = 0.9;
    g2.beginPath(); g2.moveTo(-17, 0); g2.lineTo(9, 0); g2.stroke();
    var cg = g2.createRadialGradient(5.5, -0.8, 0.3, 6.5, 0, 4.2);
    cg.addColorStop(0, '#d8f0ff'); cg.addColorStop(0.35, '#3a6ea5'); cg.addColorStop(1, '#14243d');
    g2.fillStyle = cg;
    g2.beginPath(); g2.ellipse(6.5, 0, 4.2, 2.1, 0, 0, Math.PI * 2); g2.fill();
    g2.fillStyle = '#ddd'; g2.beginPath(); g2.arc(19.3, 0, 1.3, 0, Math.PI * 2); g2.fill();
    // spinning prop disc
    var ry = 2 + 6 * Math.abs(Math.sin(now / 14));
    g2.fillStyle = 'rgba(255,255,255,.45)';
    g2.beginPath(); g2.ellipse(20.2, 0, 0.9, ry, 0, 0, Math.PI * 2); g2.fill();
    g2.restore();
  }

  // Flight path: a cubic Bézier from off-screen bottom-left to off-screen top-right,
  // with a gentle S so it feels flown, not slid.
  function pathPoint(u) {
    var x0 = -0.15 * W, y0 = 1.12 * H, x3 = 1.18 * W, y3 = -0.16 * H;
    var x1 = 0.25 * W, y1 = 0.95 * H, x2 = 0.70 * W, y2 = 0.10 * H;
    var a = 1 - u;
    var x = a * a * a * x0 + 3 * a * a * u * x1 + 3 * a * u * u * x2 + u * u * u * x3;
    var y = a * a * a * y0 + 3 * a * a * u * y1 + 3 * a * u * u * y2 + u * u * u * y3;
    var dx = 3 * a * a * (x1 - x0) + 6 * a * u * (x2 - x1) + 3 * u * u * (x3 - x2);
    var dy = 3 * a * a * (y1 - y0) + 6 * a * u * (y2 - y1) + 3 * u * u * (y3 - y2);
    return { x: x, y: y, ang: Math.atan2(dy, dx) };
  }

  /* ------------------------------------------------------------------ *
   * Smoke
   * ------------------------------------------------------------------ */
  var puffs = [];
  var lastTail = null;
  function emit(x, y, now, size) {
    var diag = Math.hypot(W, H);
    puffs.push({
      x: x + (Math.random() - 0.5) * size * 0.6,
      y: y + (Math.random() - 0.5) * size * 0.6,
      r0: size * (0.35 + Math.random() * 0.3),
      r1: diag * (0.16 + Math.random() * 0.16),
      born: now,
      grow: 900 + Math.random() * 700,
      tint: 236 + Math.floor(Math.random() * 18),
      drift: (Math.random() - 0.5) * 0.04 * diag
    });
  }
  function drawSmoke(now) {
    for (var i = 0; i < puffs.length; i++) {
      var p = puffs[i];
      var k = Math.min(1, (now - p.born) / p.grow);
      var e = 1 - Math.pow(1 - k, 3);            // ease-out growth
      var r = p.r0 + (p.r1 - p.r0) * e;
      var x = p.x + p.drift * e, y = p.y - p.drift * 0.5 * e;
      var a = 0.85 - 0.25 * e;
      var c = p.tint;
      var gr = g2.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(' + c + ',' + c + ',' + (c + 3 > 255 ? 255 : c + 3) + ',' + a + ')');
      gr.addColorStop(0.55, 'rgba(' + c + ',' + c + ',' + c + ',' + (a * 0.7).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(' + c + ',' + c + ',' + c + ',0)');
      g2.fillStyle = gr;
      g2.beginPath(); g2.arc(x, y, r, 0, Math.PI * 2); g2.fill();
    }
  }

  /* ------------------------------------------------------------------ *
   * Main loop
   * ------------------------------------------------------------------ */
  var revealStarted = false;
  function frame(now) {
    if (finished) return;
    var t = (now - t0) / 1000;

    if (gl) {
      gl.uniform2f(uRes, flagCanvas.width, flagCanvas.height);
      gl.uniform1f(uT, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    if (goAt === null && ((ready && now - t0 >= MIN_FLAG) || now - t0 >= MAX_WAIT)) launch(now);

    g2.setTransform(DPR, 0, 0, DPR, 0, 0);
    g2.clearRect(0, 0, W, H);

    if (goAt !== null) {
      var el = now - goAt;
      var u = Math.min(1, el / FLY);
      var eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // ease in-out
      eased = 0.15 * u + 0.85 * eased;
      var pt = pathPoint(eased);
      var len = Math.max(110, Math.min(W, H) * 0.3);
      var scale = len / 40;

      // smoke from the tail, densely interpolated so the trail is continuous
      if (u < 1) {
        var tx = pt.x - Math.cos(pt.ang) * len * 0.45;
        var ty = pt.y - Math.sin(pt.ang) * len * 0.45;
        if (lastTail) {
          var dist = Math.hypot(tx - lastTail.x, ty - lastTail.y);
          var n = Math.max(1, Math.ceil(dist / (len * 0.12)));
          for (var i = 1; i <= n; i++) {
            emit(lastTail.x + (tx - lastTail.x) * i / n, lastTail.y + (ty - lastTail.y) * i / n, now, len * 0.35);
          }
        }
        lastTail = { x: tx, y: ty };
      }

      drawSmoke(now);

      // smoke closes up over everything after the plane passes
      var coverStart = goAt + FLY * 0.8;
      if (now > coverStart) {
        var ca = Math.min(1, (now - coverStart) / COVER);
        g2.fillStyle = 'rgba(244,245,248,' + (ca * ca).toFixed(3) + ')';
        g2.fillRect(0, 0, W, H);
        if (ca >= 1 && !revealStarted) reveal();
      }

      if (u < 1) drawPlane(pt.x, pt.y, pt.ang, scale, now);
    }

    requestAnimationFrame(frame);
  }

  function launch(now) {
    goAt = now;
    root.classList.add('flying');
    if (reduce) { // no flight: just fade the flag out
      reveal();
    }
  }

  function reveal() {
    revealStarted = true;
    root.classList.add('reveal');      // hides flag + badge under the smoke, then fades the smoke
    setTimeout(finish, FADE + 50);
  }

  function finish() {
    if (finished) return;
    finished = true;
    window.removeEventListener('resize', resize);
    root.remove();
    window.dispatchEvent(new Event('splashdone'));
  }

  // Tap to skip: jump straight to the reveal.
  root.addEventListener('click', function () {
    if (revealStarted) return;
    if (goAt === null) goAt = performance.now() - FLY;
    reveal();
  });

  window.SPLASH = {
    go: function () { ready = true; }
  };

  requestAnimationFrame(frame);
})();
