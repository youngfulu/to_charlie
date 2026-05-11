Charlie RNBO — web UI integration
===================================
Folder: rnbo_to_charlie/web/

Comments read from your RNBO source (to_charlie.rnbopat)
--------------------------------------------------------
  Knob "gain input"     ↔ comments "Gain charlie", "CHARLIE audio input"
  Knob "Dry / Wet"      ↔ "D/W"
  Knob "gain noise"     ↔ "3 step noise"
  Btn Hard / Soft       ↔ (add [inport] — see charlie-map.json)
  Btn A / Ɐ             ↔ "mode normal / inverse …"
  Btn Step / Flow       ↔ step / noise behaviour (see charlie-map.json)

What the exported patch exposes TODAY (charlie.testme.json)
-----------------------------------------------------------
  • Parameters: only **whichbuffer** (0–3).
  • Signal inlets: **in1 … in4** (audio — not driven by this HTML UI).
  • Message **outports**: **dump**, inverse_dump, rythm, end_cycle, state,
    glitch_phasor_lock, glitch_phasor_lock2, final_bang.

So the HTML knobs cannot reach gain/DW/noise until you add matching
**[param]** or **[inport]** objects in RNBO and re-export.

Dev fallback (app.js)
---------------------
  **DEV_WHICHBUFFER_ON_KNOB0 = true** → first knob maps to **whichbuffer**
  when dedicated gain params are missing.

Run locally
-----------
  cd .../rnbo_to_charlie
  python3 -m http.server 8090

  Open: http://localhost:8090/web/index.html

Visuals
-------
  • Top-left **white circle**: opacity / glow from normalized **dump** stream.
  • Below it: **canvas scope** (live.scope-style rolling trace of dump values).

Next RNBO patch steps (recommended)
-----------------------------------
  Add params with stable ids, e.g.:
    gain_charlie  dry_wet  gain_noise
  Add inports with tags:
    btn_hard_soft  btn_normal_inverse  btn_step_flow
  Re-export → refresh browser; console should report “All mapped targets resolved.”
