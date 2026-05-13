/**
 * Charlie RNBO web host — maps min-rnbo-ui → params/inports from charlie-map.json
 * Patch: ../charlie.testme.json — buffers: ../dependencies.json → media/*.mp3
 */

(function () {
  var PATCH_URL = "../charlie.testme.json";
  var MAP_URL = "./charlie-map.json";

  /** Legacy: if patch exposes whichbuffer param and knob 0 has no target */
  var DEV_WHICHBUFFER_ON_KNOB0 = false;

  var statusEl = document.getElementById("status");
  var led = null;
  var videoLampEl = null;
  var canvas = null;
  var ctx = null;

  function getLedEl() {
    if (led) return led;
    var f = getUiFrame();
    if (f && f.contentDocument) led = f.contentDocument.getElementById("dump-led");
    return led;
  }
  function getVideoLampEl() {
    if (videoLampEl) return videoLampEl;
    var f = getUiFrame();
    if (f && f.contentDocument) videoLampEl = f.contentDocument.getElementById("video-lamp");
    return videoLampEl;
  }
  function initScope() {
    if (ctx) return true;
    var f = getUiFrame();
    if (!f || !f.contentDocument) return false;
    var c = f.contentDocument.getElementById("scope");
    if (!c) return false;
    canvas = c;
    ctx = c.getContext("2d");
    return true;
  }
  function getScopeWrap() {
    var f = getUiFrame();
    if (!f || !f.contentDocument) return null;
    return f.contentDocument.getElementById("scope-wrap");
  }

  var SCOPE_LEN = 682;
  var scopeBuf = new Float32Array(SCOPE_LEN);
  var scopeW = 0;
  var scopeH = 0;

  var lastNorm = 0;
  /** Last time RNBO sent `end_cycle` (ms); iframe uses for bang-style flash. */
  var endCycleBangAt = 0;
  var finalBangAt = 0;
  var glitchCountBangAt = 0;

  /** Dump stream → HUD lamp in iframe (0…1); `dumpRawTarget` updated on each dump message */
  var dumpRawTarget = 0;
  var dumpSmoothed = 0;
  var dumpSmoothSlider = 35;
  var gpl2Raw = 0;
  var videoMode = true;
  var vidBrightness = 2.25;
  var vidSaturation = 1.5;
  var vidContrast = 2.55;

  var uiFrameEl = null;
  var fpsAcc = 0;
  var fpsLastT = 0;
  var lastFpsShown = 0;
  var TELE_TAGS = ["glitch_phasor_lock", "glitch_phasor_lock2", "end_cycle", "state", "final_bang", "glitch_count"];
  var teleSnapshot = {};
  for (var tsi = 0; tsi < TELE_TAGS.length; tsi++) {
    teleSnapshot[TELE_TAGS[tsi]] = "—";
  }

  /** One-pole low-pass on scope line input (per animation frame) */
  var scopeSampleLp = 0;
  var SCOPE_SAMPLE_ALPHA = 0.22;
  /** Slow auto-range for scope Y so the trace does not jitter vertically */
  var scopeDispMin = 0;
  var scopeDispMax = 0;
  var scopeRangeInit = false;
  var SCOPE_RANGE_CONTRACT = 0.07;

  /** Main LED: follow level 0=min … 1=max (no extra gain). */

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
  }

  function getUiFrame() {
    if (!uiFrameEl) uiFrameEl = document.getElementById("ui-frame");
    return uiFrameEl;
  }

  /** Push HUD updates into embedded min-rnbo-ui (second panel). */
  function postHudToIframe(payload) {
    var f = getUiFrame();
    if (!f || !f.contentWindow) return;
    try {
      f.contentWindow.postMessage(
        {
          source: "charlie-hud",
          dumpGlow: payload.dumpGlow,
          telemetry: payload.telemetry,
          fps: payload.fps,
          endCycleBangAt: payload.endCycleBangAt
        },
        "*"
      );
    } catch (eP) {}
  }

  function loadRNBOScript(version) {
    return new Promise(function (resolve, reject) {
      if (/^\d+\.\d+\.\d+-dev$/.test(version)) {
        reject(new Error("RNBO debug export not supported in loader."));
        return;
      }
      var el = document.createElement("script");
      el.src =
        "https://c74-public.nyc3.digitaloceanspaces.com/rnbo/" +
        encodeURIComponent(version) +
        "/rnbo.min.js";
      el.onload = resolve;
      el.onerror = function () {
        reject(new Error("Failed to load rnbo.min.js"));
      };
      document.head.appendChild(el);
    });
  }

  function payloadNumbers(ev) {
    var p = ev.payload;
    if (p == null) return [];
    if (typeof p === "number") return isFinite(p) ? [p] : [];
    if (Array.isArray(p)) {
      var out = [];
      for (var i = 0; i < p.length; i++) {
        var x = p[i];
        if (typeof x === "number" && isFinite(x)) out.push(x);
      }
      return out;
    }
    return [];
  }

  function pushScopeSample(v) {
    scopeBuf.copyWithin(0, 1);
    scopeBuf[SCOPE_LEN - 1] = v;
  }

  function resizeScope() {
    if (!initScope()) return;
    var wrap = getScopeWrap();
    if (!wrap || !canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    scopeW = w;
    scopeH = h;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawScope() {
    if (!initScope()) return;
    var w = scopeW;
    var h = scopeH;
    if (w < 2 || h < 2) return;

    ctx.fillStyle = "rgba(12,14,16,0.92)";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.stroke();

    var min = -1;
    var max = 1;
    var span = 2;

    ctx.strokeStyle = "rgba(180, 255, 200, 0.95)";
    ctx.lineWidth = Math.max(0.65, Math.min(1.1, h * 0.018));
    ctx.shadowColor = "rgba(120, 255, 160, 0.35)";
    ctx.shadowBlur = Math.max(1, h * 0.045);
    ctx.beginPath();
    for (var j = 0; j < SCOPE_LEN; j++) {
      var x = (j / (SCOPE_LEN - 1)) * w;
      var y = h - ((scopeBuf[j] - min) / span) * (h * 0.88) - h * 0.06;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function updateLedFromDump(vals, opts) {
    opts = opts || {};
    var pushScope = opts.pushScope !== false;
    if (!vals.length) return;
    var v = vals[0];
    if (vals.length > 1) {
      var sum = 0;
      for (var i = 0; i < vals.length; i++) sum += vals[i];
      v = sum / vals.length;
    }
    /* Literal 0…1 brightness range (patch should send normalized values). */
    lastNorm = Math.max(0, Math.min(1, v));
    if (pushScope) pushScopeSample(v);
  }

  /** Map 0…1 level to a circular lamp element. */
  function applyGlow(el, n) {
    n = Math.max(0, Math.min(1, n));
    if (!el) return;
    var g = Math.round(255 * n);
    el.style.background = "rgb(" + g + "," + g + "," + g + ")";
    el.style.opacity = "1";
    if (n < 0.004) {
      el.style.boxShadow = "none";
    } else {
      var spread = 10 + 52 * n;
      var blur = 22 + 94 * n;
      var a0 = Math.min(1, 0.28 + 0.92 * n);
      var a1 = Math.min(1, 0.12 + 0.55 * n);
      el.style.boxShadow =
        "0 0 " +
        spread +
        "px " +
        blur +
        "px rgba(255,255,255," +
        a0 +
        "), 0 0 " +
        spread * 1.85 +
        "px " +
        blur * 1.35 +
        "px rgba(255,245,255," +
        a1 +
        ")";
    }
  }

  function applyLedVisual(n) {
    applyGlow(getLedEl(), n);
  }

  function findParam(device, tryIds) {
    var map = device.parametersById;
    if (map && typeof map.get === "function") {
      for (var ti = 0; ti < tryIds.length; ti++) {
        var tid = tryIds[ti];
        var byId = map.get(tid);
        if (byId) return byId;
      }
    }
    var params = device.parameters || [];
    for (var t = 0; t < tryIds.length; t++) {
      var id = tryIds[t];
      for (var i = 0; i < params.length; i++) {
        var p = params[i];
        if (p.id === id || p.paramId === id || p.name === id || p.displayName === id) return p;
      }
    }
    return null;
  }

  function findOutletChannelIndex(patcher, tag) {
    var outs = (patcher.desc && patcher.desc.outlets) || [];
    for (var i = 0; i < outs.length; i++) {
      if (outs[i].tag === tag) {
        var idx = outs[i].index;
        if (typeof idx === "number" && idx >= 1) return idx - 1;
        return i;
      }
    }
    return 0;
  }

  function findInportTag(device, tryTags) {
    var RNBO = window.RNBO;
    var msgs =
      device.inports && device.inports.length ? device.inports : device.messages || [];
    var mp = RNBO.MessagePortType;
    var want =
      mp && Object.prototype.hasOwnProperty.call(mp, "Inport") ? mp.Inport : null;
    for (var t = 0; t < tryTags.length; t++) {
      var tag = tryTags[t];
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        /* RNBO sometimes omits port type; don't reject undefined === Inport */
        if (want != null && m.type != null && m.type !== want) continue;
        if (m.tag === tag) return tag;
      }
    }
    return null;
  }

  function midiToNorm127(v) {
    return (Math.max(1, Math.min(127, v)) - 1) / 126;
  }

  function applyInportFloat(device, tag, value) {
    if (!tag) return;
    var RNBO = window.RNBO;
    try {
      var ev = new RNBO.MessageEvent(rnbTimeNow(RNBO), tag, [value]);
      device.scheduleEvent(ev);
    } catch (err) {
      console.warn("[charlie-web] scheduleEvent float failed for inport", tag, err);
    }
  }

  function applyKnob(device, mapEntry, midiVal, resolved, whichbufferParam) {
    var norm = midiToNorm127(midiVal);
    var t = resolved.knobs[mapEntry.uiIndex];
    if (t && t.param) {
      var p = t.param;
      var nv = p.min + norm * (p.max - p.min);
      if (p.steps != null && p.steps > 1) {
        var step = (p.max - p.min) / (p.steps - 1);
        nv = p.min + Math.round((nv - p.min) / step) * step;
      }
      p.value = nv;
      return;
    }
    if (t && t.tag) {
      var imn = mapEntry.inMin != null ? mapEntry.inMin : 0;
      var imx = mapEntry.inMax != null ? mapEntry.inMax : 1;
      var inv = imn + norm * (imx - imn);
      applyInportFloat(device, t.tag, inv);
      return;
    }
    if (mapEntry.uiIndex === 0 && DEV_WHICHBUFFER_ON_KNOB0 && whichbufferParam) {
      var steps = 4;
      var mn = whichbufferParam.min != null ? whichbufferParam.min : 0;
      var mx = whichbufferParam.max != null ? whichbufferParam.max : 3;
      var nSteps = Math.max(2, Math.round(mx - mn + 1));
      if (whichbufferParam.steps != null) nSteps = whichbufferParam.steps;
      var idx = Math.min(nSteps - 1, Math.floor(norm * nSteps));
      whichbufferParam.value = mn + idx * ((mx - mn) / Math.max(1, nSteps - 1));
      return;
    }
  }

  function rnbTimeNow(RNBO) {
    if (RNBO.TimeNow !== undefined && RNBO.TimeNow !== null) return RNBO.TimeNow;
    if (RNBO.Utils && RNBO.Utils.TimeNow !== undefined && RNBO.Utils.TimeNow !== null) {
      return RNBO.Utils.TimeNow;
    }
    return -1;
  }

  function applyInportBang(device, tag, on01) {
    if (!tag) return;
    var RNBO = window.RNBO;
    try {
      var ev = new RNBO.MessageEvent(rnbTimeNow(RNBO), tag, [on01]);
      device.scheduleEvent(ev);
    } catch (err) {
      console.warn("[charlie-web] scheduleEvent failed for inport", tag, err);
    }
  }

  /** Max-style bang: empty payload (gogogo etc.). */
  function scheduleInportPayload(device, RNBO, tag, payload) {
    if (!tag) return;
    try {
      var pl = payload != null ? payload : [];
      device.scheduleEvent(new RNBO.MessageEvent(rnbTimeNow(RNBO), tag, pl));
    } catch (err) {
      console.warn("[charlie-web] scheduleEvent payload failed for inport", tag, err);
    }
  }

  function startPatchPlayback(device, RNBO) {
    if (!device) return;
    if (device.__charliePlaybackPrimed) return;
    device.__charliePlaybackPrimed = true;
    try {
      var tr = device.transport;
      if (tr) {
        if (typeof tr.play === "function") tr.play();
        else if (typeof tr.start === "function") tr.start();
        else if (typeof tr.requestStart === "function") tr.requestStart();
      }
    } catch (eTr) {
      console.warn("[charlie-web] transport start:", eTr);
    }
  }

  /**
   * dependencies.json uses paths like "media/foo.mp3" (relative to export root).
   * This page lives in /web/index.html, so resolve against / (parent of web/), not /web/.
   */
  function rewriteDepsForWebHost(deps) {
    if (!deps || !deps.length) return [];
    var base = new URL("../", window.location.href);
    var out = [];
    for (var i = 0; i < deps.length; i++) {
      var d = deps[i];
      if (!d || !d.id) continue;
      if (d.url) {
        out.push({ id: d.id, url: d.url });
        continue;
      }
      var f = d.file || "";
      if (!f) {
        out.push(d);
        continue;
      }
      if (/^https?:\/\//i.test(f)) {
        out.push({ id: d.id, file: f });
        continue;
      }
      try {
        var rel = f.replace(/^\.\//, "");
        var abs = new URL(rel, base).href;
        out.push({ id: d.id, file: abs });
        console.info("[charlie-web] buffer file URL:", d.id, "→", abs);
      } catch (eU) {
        console.warn("[charlie-web] buffer path resolve failed:", d.id, f, eU);
        out.push(d);
      }
    }
    return out;
  }

  function loadBufferDependencies(device, RNBO) {
    return fetch("../dependencies.json")
      .then(function (r) {
        return r && r.ok ? r.json() : [];
      })
      .catch(function () {
        return [];
      })
      .then(function (deps) {
        var fixed = rewriteDepsForWebHost(deps);
        if (!fixed.length) return [];
        if (typeof device.loadDataBufferDependencies !== "function") {
          console.warn("[charlie-web] loadDataBufferDependencies not available on this RNBO.js build.");
          return [];
        }
        return device.loadDataBufferDependencies(fixed);
      })
      .then(function (results) {
        if (Array.isArray(results)) {
          var anyOk = false;
          for (var ri = 0; ri < results.length; ri++) {
            var rr = results[ri];
            if (rr && rr.type === "success") {
              anyOk = true;
              console.info("[charlie-web] DataBuffer OK:", rr.id);
            } else if (rr) console.warn("[charlie-web] DataBuffer FAIL:", rr.id, rr.error || rr);
          }
          if (results.length && !anyOk) {
            console.warn(
              "[charlie-web] No buffers decoded — samples will not play. Check dependencies.json and media/*.mp3 next to this export."
            );
          }
        }
        return results;
      });
  }

  function formatTelemetryPayload(ev) {
    var nums = payloadNumbers(ev);
    if (nums.length) return String(nums[0]);
    var p = ev.payload;
    if (p == null) return "—";
    if (typeof p === "boolean") return p ? "1" : "0";
    if (typeof p === "string") return p.length > 14 ? p.slice(0, 14) + "…" : p;
    try {
      var s = JSON.stringify(p);
      return s.length > 16 ? s.slice(0, 16) + "…" : s;
    } catch (eJ) {
      return String(p);
    }
  }

  function collectMappedInportTags(charlieMap) {
    var set = {};
    function add(list) {
      if (!list) return;
      for (var i = 0; i < list.length; i++) set[list[i]] = 1;
    }
    var mr = charlieMap.mouseRnd || {};
    add(mr.tryInportTags);
    (charlieMap.knobs || []).forEach(function (k) {
      add(k.tryInportTags);
    });
    (charlieMap.buttons || []).forEach(function (b) {
      add(b.tryInportTags);
    });
    return set;
  }

  /** Toggle / float param from UI button (0/1); falls back to inport message if tag set */
  function applyButtonTarget(device, target, on01) {
    if (!target) return;
    var p = target.param;
    if (p) {
      var mn = p.min != null ? p.min : 0;
      var mx = p.max != null ? p.max : 1;
      var hi = mx > mn ? mx : mn;
      var lo = mx > mn ? mn : mx;
      var onVal = hi;
      var offVal = lo;
      if (p.steps === 2 || (mx <= 1 && mn >= 0 && mx >= 0 && mn <= 1)) {
        onVal = mx >= 1 ? 1 : mx;
        offVal = mn <= 0 ? 0 : mn;
      }
      p.value = on01 ? onVal : offVal;
      return;
    }
    if (target.tag) applyInportBang(device, target.tag, on01);
  }

  /** Push default UI levels into RNBO (matches min-rnbo-ui defaults). */
  function applyCharlieBootstrap(device, charlieMap, resolved, whichbufferParam) {
    var klist = charlieMap.knobs || [];
    var defaultsMidi = [51, 127, 30];
    for (var ui = 0; ui < defaultsMidi.length; ui++) {
      var entry = null;
      for (var q = 0; q < klist.length; q++) {
        if (klist[q].uiIndex === ui) {
          entry = klist[q];
          break;
        }
      }
      if (entry) applyKnob(device, entry, defaultsMidi[ui], resolved, whichbufferParam);
    }
    var b0 = resolved.buttons[0];
    if (b0) applyButtonTarget(device, b0, 1);
    var gain3tag = findInportTag(device, ["gain3"]);
    if (gain3tag) applyInportFloat(device, gain3tag, 1);
  }


  function main() {
    resizeScope();
    fpsLastT = typeof performance !== "undefined" ? performance.now() : Date.now();

    window.addEventListener("resize", function () {
      resizeScope();
    });

    Promise.all([fetch(MAP_URL).then(function (r) {
      return r.json();
    }), fetch(PATCH_URL).then(function (r) {
      if (!r.ok) throw new Error("Missing " + PATCH_URL);
      return r.json();
    })])
      .then(function (both) {
        var charlieMap = both[0];
        var patcher = both[1];

        return loadRNBOScript(patcher.desc.meta.rnboversion).then(function () {
          return { charlieMap: charlieMap, patcher: patcher };
        });
      })
      .then(function (_ref) {
        var charlieMap = _ref.charlieMap;
        var patcher = _ref.patcher;
        var RNBO = window.RNBO;
        var WAContext = window.AudioContext || window.webkitAudioContext;
        if (!WAContext) {
          throw new Error("Web Audio API (AudioContext) is not available in this browser.");
        }
        var context = new WAContext();
        var outputNode = context.createGain();
        outputNode.connect(context.destination);

        /* Expose resume for direct call from start button (iOS requires in-gesture call) */
        window.charlieResumeAudio = function () {
          try { context.resume(); } catch (e) {}
        };

        return RNBO.createDevice({ context: context, patcher: patcher }).then(function (device) {
          window.rnboDevice = device;
          window.rnboAudioContext = context;
          /* Buffers: load after AudioContext.resume() (see body click) — decodeAudioData + correct /media/ URLs */
          return device;
        })
          .then(function (device) {
          device.node.connect(outputNode);

          var vizCfg = charlieMap.visualization || {};
          var vizSource = vizCfg.source || "signalOutlet";
          var vizAnalyser = null;
          var vizTimeBuf = null;

          var resolved = {
            knobs: [],
            buttons: []
          };
          var missing = [];

          if (vizSource === "signalOutlet") {
            var vTag = vizCfg.outletTag || "out3";
            var nch =
              (patcher.desc && patcher.desc.numOutputChannels) ||
              device.numOutputChannels ||
              1;
            var chIdx =
              vizCfg.channelIndex != null ? vizCfg.channelIndex : findOutletChannelIndex(patcher, vTag);
            if (chIdx < 0 || chIdx >= nch) {
              missing.push("viz: channelIndex " + chIdx + " out of range for " + nch + " outputs");
            } else {
              try {
                var splitter = context.createChannelSplitter(nch);
                vizAnalyser = context.createAnalyser();
                vizAnalyser.fftSize = 1024;
                vizAnalyser.smoothingTimeConstant = 0.22;
                device.node.connect(splitter);
                splitter.connect(vizAnalyser, chIdx, 0);
                vizTimeBuf = new Float32Array(vizAnalyser.fftSize);
              } catch (vizErr) {
                console.warn("[charlie-web] signal viz tap failed:", vizErr);
                missing.push("viz: could not tap signal " + vTag + " (" + String(vizErr.message || vizErr) + ")");
              }
            }
          }

          (charlieMap.knobs || []).forEach(function (k) {
            var p = findParam(device, k.tryParamIds || []);
            var ktag = findInportTag(device, k.tryInportTags || []);
            if (p) resolved.knobs[k.uiIndex] = { param: p, tag: null };
            else if (ktag) resolved.knobs[k.uiIndex] = { param: null, tag: ktag };
            else resolved.knobs[k.uiIndex] = null;
            if (!p && !ktag) {
              var ktry = (k.tryParamIds || []).length ? k.tryParamIds.join(" or ") : "";
              var kit = (k.tryInportTags || []).length ? k.tryInportTags.join(" or ") : "";
              missing.push(
                "knob " +
                  k.uiLabel +
                  " → " +
                  (ktry || "(no tryParamIds)") +
                  " / " +
                  (kit || "(no tryInportTags)")
              );
            }
          });

          (charlieMap.buttons || []).forEach(function (b) {
            var btnParam = findParam(device, b.tryParamIds || []);
            var tag = findInportTag(device, b.tryInportTags || []);
            resolved.buttons[b.uiIndex] = { param: btnParam, tag: tag };
            if (!btnParam && !tag && !b.optional) {
              var bpt = (b.tryParamIds || []).length ? b.tryParamIds.join(" or ") : "(param TBD)";
              var bit = (b.tryInportTags || []).length ? b.tryInportTags.join(" or ") : "(inport TBD)";
              missing.push("btn idx " + b.uiIndex + " → " + bpt + " or [inport] " + bit);
            }
          });

          var mappedInSet = collectMappedInportTags(charlieMap);
          var allIn = device.inports || [];
          var unmappedIn = [];
          for (var ui = 0; ui < allIn.length; ui++) {
            var tg = allIn[ui].tag;
            if (tg && !mappedInSet[tg]) unmappedIn.push(tg);
          }
          var docUnmapped = charlieMap.unmappedPatchInports || [];
          console.info(
            "[charlie-web] Patch inports not mapped to this UI: " +
              (unmappedIn.length ? unmappedIn.join(", ") : "(none)") +
              (docUnmapped.length ? "  |  charlie-map notes: " + docUnmapped.join(", ") : "")
          );

          var whichbufferParam = findParam(device, ["whichbuffer"]);

          var outports = device.outports || [];
          var vizMsgTags = vizCfg.messageTags || ["dump"];
          if (vizSource === "messageOutport") {
            var missingAny = true;
            for (var vt = 0; vt < vizMsgTags.length; vt++) {
              if (outports.some(function (o) { return o.tag === vizMsgTags[vt]; })) {
                missingAny = false;
                break;
              }
            }
            if (missingAny) {
              missing.push("viz message outport not found: " + vizMsgTags.join(" or "));
            }
          }

          var paramsList = device.parameters || [];
          var paramLines = [];
          for (var pi = 0; pi < paramsList.length; pi++) {
            var pr = paramsList[pi];
            var pid = pr.paramId != null ? pr.paramId : pr.id;
            var nm = pr.name != null ? pr.name : "";
            var pmin = pr.min != null ? pr.min : pr.minimum;
            var pmax = pr.max != null ? pr.max : pr.maximum;
            paramLines.push(
              (pid || "?") +
                "  (name: " +
                nm +
                ", min " +
                pmin +
                ", max " +
                pmax +
                (pr.steps != null ? ", steps " + pr.steps : "") +
                ")"
            );
          }
          console.info(
            "[charlie-web] RNBO scripting/param ids (check vs charlie-map tryParamIds):\n- " +
              (paramLines.length ? paramLines.join("\n- ") : "(none)")
          );

          device.messageEvent.subscribe(function (ev) {
            var tag = ev.tag;
            if (vizSource === "messageOutport" && vizMsgTags.indexOf(tag) >= 0) {
              var numsViz = payloadNumbers(ev);
              if (numsViz.length) {
                for (var ni = 0; ni < numsViz.length; ni++) updateLedFromDump([numsViz[ni]]);
              }
            }
            if (tag === "dump") {
              var dnums = payloadNumbers(ev);
              if (dnums.length) dumpRawTarget = Math.max(0, Math.min(1, dnums[0]));
              else if (typeof ev.payload === "number" && isFinite(ev.payload)) {
                dumpRawTarget = Math.max(0, Math.min(1, ev.payload));
              }
            }
            if (tag === "glitch_phasor_lock2") {
              var gpl2nums = payloadNumbers(ev);
              if (gpl2nums.length) gpl2Raw = gpl2nums[0];
            }
            if (tag === "end_cycle") {
              endCycleBangAt = typeof performance !== "undefined" ? performance.now() : Date.now();
            }
            if (tag === "final_bang") {
              finalBangAt = typeof performance !== "undefined" ? performance.now() : Date.now();
            }
            if (tag === "glitch_count") {
              glitchCountBangAt = typeof performance !== "undefined" ? performance.now() : Date.now();
            }
            if (TELE_TAGS.indexOf(tag) >= 0) {
              teleSnapshot[tag] = formatTelemetryPayload(ev);
            }
          });

          var rndCfg = charlieMap.mouseRnd || {};
          var rndTryIn = rndCfg.tryInportTags || [];
          var rndTag = rndTryIn.length ? findInportTag(device, rndTryIn) : null;
          var rndImn = rndCfg.inMin != null ? rndCfg.inMin : 0;
          var rndImx = rndCfg.inMax != null ? rndCfg.inMax : 1;
          var rndPxFull = rndCfg.pixelsForFullRange != null ? rndCfg.pixelsForFullRange : 320;
          var rndFloatState = (rndImn + rndImx) * 0.5;
          if (rndTryIn.length && !rndTag) {
            missing.push("mouse rnd → inport " + rndTryIn.join(" or "));
          }
          function applyRndDelta(dx, dy) {
            if (!rndTag) return;
            if (Math.abs(rndPxFull) < 1e-6) return;
            var span = rndImx - rndImn;
            var deltaPx = dx - dy;
            var dv = (deltaPx / rndPxFull) * span;
            rndFloatState = Math.max(rndImn, Math.min(rndImx, rndFloatState + dv));
            applyInportFloat(device, rndTag, rndFloatState);
          }

          window.addEventListener("message", function (ev) {
            var d = ev.data;
            if (d && d.source === "charlie-vid-filter" && typeof d.value === "number") {
              var pct = d.value / 100;
              if (d.id === "vid-brightness") vidBrightness = pct;
              else if (d.id === "vid-saturation") vidSaturation = pct;
              else if (d.id === "vid-contrast") vidContrast = pct;
              return;
            }
            if (d && d.source === "charlie-dump-smooth" && typeof d.value === "number") {
              dumpSmoothSlider = d.value;
              return;
            }
            if (d && d.source === "charlie-inport" && typeof d.value === "number") {
              var inpTag = findInportTag(device, [d.tag]);
              if (inpTag) applyInportFloat(device, inpTag, d.value);
              return;
            }
            if (d && d.source === "charlie-video-toggle") {
              videoMode = d.mode === "video";
              var vEl = getVideoLampEl();
              if (vEl) vEl.style.display = videoMode ? "block" : "none";
              var ledEl2 = getLedEl();
              if (ledEl2) ledEl2.style.display = videoMode ? "none" : "block";
              return;
            }
            if (d && d.source === "charlie-rnd") {
              if (typeof d.dx !== "number" || typeof d.dy !== "number") return;
              if (!d.pressed) return;
              applyRndDelta(d.dx, d.dy);
              return;
            }
            if (!d || d.source !== "min-rnbo-ui" || !Array.isArray(d.args)) return;
            var args = d.args;
            var verb = args[0];
            if (verb === "knob") {
              var ki = +args[1];
              var kv = +args[2];
              var entry = null;
              var klist = charlieMap.knobs || [];
              for (var q = 0; q < klist.length; q++) {
                if (klist[q].uiIndex === ki) {
                  entry = klist[q];
                  break;
                }
              }
              if (entry) applyKnob(device, entry, kv, resolved, whichbufferParam);
              return;
            }
            if (verb === "btn") {
              var bi = +args[1];
              var bv = +args[2];
              var bt = resolved.buttons[bi];
              applyButtonTarget(device, bt, bv);
              if (bi === 2 && bv) {
                var gt = findInportTag(device, ["gogogo"]);
                if (gt) {
                  try { scheduleInportPayload(device, window.RNBO, gt, []); } catch (e) {}
                  applyInportBang(device, gt, 1);
                }
              }
              return;
            }
            if (verb === "buff_index") {
              var bit = findInportTag(device, ["buff index"]);
              if (bit) applyInportFloat(device, bit, +args[1]);
              return;
            }
            if (verb === "hold") {
              var ht = findInportTag(device, ["hold"]);
              if (ht) applyInportFloat(device, ht, +args[1] ? 1 : 0);
              return;
            }
            if (verb === "gogogo") {
              var gt = findInportTag(device, ["gogogo"]);
              if (gt) {
                try { scheduleInportPayload(device, window.RNBO, gt, []); } catch (e) {}
                applyInportBang(device, gt, 1);
              }
              return;
            }
            /* Any other iframe interaction (bang, panel_open, first_interact, etc.) → prime audio */
            onUserAudioGesture();
          });

          applyCharlieBootstrap(device, charlieMap, resolved, whichbufferParam);

          var deviceBuffersReady = false;

          function onUserAudioGesture() {
            var vElGesture = getVideoLampEl();
            if (vElGesture && vElGesture.paused) {
              vElGesture.play().catch(function () {});
            }
            var resumeP;
            try {
              var r = context.resume();
              resumeP = r && typeof r.then === "function" ? r : Promise.resolve();
            } catch (eR) {
              resumeP = Promise.resolve();
            }
            return resumeP.then(function () {
              if (!device.__charlieBufPromise) {
                device.__charlieBufPromise = loadBufferDependencies(device, RNBO)
                  .catch(function (eL) {
                    console.warn("[charlie-web] buffer load error:", eL);
                  })
                  .then(function () {
                    deviceBuffersReady = true;
                  });
              }
              return device.__charlieBufPromise;
            })
              .then(function () {
                window.setTimeout(function () {
                  startPatchPlayback(device, RNBO);
                }, 120);
              });
          }

          /* First pointerdown anywhere (including iframe) hits parent capture → user gesture for resume + buffers. */
          window.addEventListener("pointerdown", onUserAudioGesture, { once: true, capture: true });

          var msg =
            "Charlie RNBO — audio ready (tap anywhere). ";
          if (missing.length) {
            msg += "Setup: " + missing.length + " missing target(s). Open console or README_CHARLIE_WEB.txt.";
            console.warn("[charlie-web] Map gaps (add params/inports in RNBO & re-export):\n- " + missing.join("\n- "));
          } else msg += "All mapped targets resolved.";
          setStatus(msg);

          requestAnimationFrame(function loop() {
            if (vizAnalyser && vizTimeBuf) {
              vizAnalyser.getFloatTimeDomainData(vizTimeBuf);
              var n = vizTimeBuf.length;
              var pick = vizTimeBuf[n - 1];
              scopeSampleLp =
                SCOPE_SAMPLE_ALPHA * pick + (1 - SCOPE_SAMPLE_ALPHA) * scopeSampleLp;
              pushScopeSample(scopeSampleLp);
            }
            /* Dump → center “video” lamp: slider 0 = no smoothing, 100 = heavy smoothing */
            var sm = dumpSmoothSlider;
            if (sm <= 0) {
              dumpSmoothed = dumpRawTarget;
            } else {
              var sNorm = sm / 100;
              var step = 0.0028 + Math.pow(1 - sNorm, 2.25) * 0.62;
              dumpSmoothed += (dumpRawTarget - dumpSmoothed) * step;
            }
            dumpSmoothed = Math.max(0, Math.min(1, dumpSmoothed));
            lastNorm = dumpSmoothed;
            applyLedVisual(dumpSmoothed);
            var vElRaf = getVideoLampEl();
            if (videoMode && vElRaf) {
              vElRaf.style.filter =
                "brightness(" + Math.max(0.05, dumpSmoothed * 1.5 * vidBrightness) + ") " +
                "saturate(" + vidSaturation + ") " +
                "contrast(" + vidContrast + ") " +
                "invert(" + Math.max(0, Math.min(1, gpl2Raw * 0.5)) + ")";
            }
            var nowT = typeof performance !== "undefined" ? performance.now() : Date.now();
            fpsAcc += 1;
            if (nowT - fpsLastT >= 500) {
              lastFpsShown = Math.round((fpsAcc * 1000) / (nowT - fpsLastT));
              fpsAcc = 0;
              fpsLastT = nowT;
            }
            postHudToIframe({
              dumpGlow: dumpSmoothed,
              telemetry: teleSnapshot,
              fps: lastFpsShown,
              endCycleBangAt: endCycleBangAt,
              finalBangAt: finalBangAt,
              glitchCountBangAt: glitchCountBangAt
            });
            drawScope();
            requestAnimationFrame(loop);
          });
        });
      })
      .catch(function (e) {
        console.error(e);
        setStatus(String(e.message || e));
      });
  }

  main();
})();
