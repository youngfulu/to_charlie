Charlie RNBO — web UI integration
===================================
Folder: rnbo_to_charlie/web/

What the exported patch exposes (charlie.testme.json) — current export
-----------------------------------------------------------------------
  • Parameters (6): speed, start, length, speed2, start2, length2
    (0–5000 for speed/speed2; 0–1 for start/length/start2/length2).
    Not driven by min-rnbo-ui; set in RNBO or extend charlie-map + app if needed.

  • Message inports: gain1, gain3, gain2, invertion, rnd, hardsoft, dw, hold,
    gogogo, flow.

  • Message outports: dump, inverse_dump, rythm, end_cycle, state,
    glitch_phasor_lock, glitch_phasor_lock2, final_bang.

  • Signal: in1; audio outlets out1, out2, out3 (viz tap uses out3 by default).

  • Sample buffers (externalDataRefs): mid, low, charlie → files under media/

min-rnbo-ui ↔ charlie-map.json
------------------------------
  Knob "gain input"     → inport gain1
  Knob "Dry / Wet"      → inport dw
  Knob "gain noise"     → inport gain2
  Btn Hard / Soft       → inport hardsoft
  Btn A / Ɐ             → inport invertion
  Btn Step / Flow       → inport flow
  Click-drag background → inport rnd (embed mode)

Web host (app.js)
-----------------
  • Loads ../charlie.testme.json and ../dependencies.json, then
    device.loadDataBufferDependencies(...) so MP3s fill buffers (same origin
    as when you run: python3 -m http.server from rnbo_to_charlie).

  • **Samples:** on first pointer/click, the host **resumes AudioContext**, loads
    `dependencies.json` with file paths rewritten to `…/media/*.mp3` (page is in `/web/`,
    files live next to it), then runs **transport** + **hold** + **gogogo**. If your patch
    uses **hold = 0** to play, change that in RNBO or we can flip it in `charlie-map` later.

  • Main **dump-led** follows **out3** (0…1). Telemetry / dump smooth / fps live in the
    **second bang** panel inside **min-rnbo-ui** (iframe); parent posts `charlie-hud` updates.

  • LED + scope use signal outlet out3 unless you switch charlie-map
    visualization to messageOutport + messageTags.

Run locally
-----------
  cd .../rnbo_to_charlie
  python3 -m http.server 8090

  Open: http://localhost:8090/web/index.html

After changing the RNBO patch
-----------------------------
  Re-export charlie.testme.json + dependencies.json into this folder, then
  refresh charlie-map.json if inport/param tags change.
