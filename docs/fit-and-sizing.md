# Body Fit, Sizing & Size Picker

Documentation for the AR outfit improvements: the garment now follows the user's
body, the app reports when the outfit does not match real-life proportions, and
the user can pick a size themselves.

- **Status:** implemented and building cleanly (`npm run build`, `tsc --strict`)
- **Scope:** solo-developer simple — no body segmentation, no cloth simulation.

---

## Contents

1. [What changed](#1-what-changed)
2. [Files](#2-files)
3. [Sizing: making the outfit follow the body](#3-sizing-making-the-outfit-follow-the-body)
4. [Fit verdict: is this outfit my size?](#4-fit-verdict-is-this-outfit-my-size)
5. [Size picker](#5-size-picker)
6. [UI map](#6-ui-map)
7. [Frame-by-frame data flow](#7-frame-by-frame-data-flow)
8. [Flicker & responsiveness rules](#8-flicker--responsiveness-rules)
9. [Tuning reference](#9-tuning-reference)
10. [Edge cases handled](#10-edge-cases-handled)
11. [Verification checklist](#11-verification-checklist)
12. [Known limitations](#12-known-limitations)

---

## 1. What changed

| # | Before | After |
|---|---|---|
| 1 | Scale used metric world landmarks (`shoulderDistance * 6.1`) while position used screen-projected landmarks at a fixed depth — the two disagreed, so the shirt drifted off the shoulders as you moved | Scale and position both come from the **same projected plane**, so the garment's shoulders land on yours at any distance |
| 2 | `shirt.position.y -= 2.9` hard-coded offset | The model's **shoulder joints are measured every frame** and the garment is nudged onto your detected shoulder line |
| 3 | `rootJoint.scale.x = 1.2` re-applied every frame | Applied **once at load** as `SHOULDER_WIDEN` |
| 4 | Uniform scale only — torso length never followed the body | `scaleY` follows the torso:shoulder ratio, clamped ±10 % |
| 5 | No fit feedback | **Size estimate + fit chip + colour-coded warning** |
| 6 | No way to choose a size | **`Auto · XS S M L XL` picker** that rescales the garment and re-judges the fit |

Also fixed while in there:

- `<App />` is rendered with no props but `onClose` was required → clicking the
  close button threw. Props are optional with a guard.
- Missing elbow/wrist landmarks could throw and kill the render loop → guarded.
- `result.worldLandmarks` could be `undefined` → guarded.
- Status was written every frame → now deduped through `setStatus`.
- Pre-existing type error in `WebCam.tsx` (`video` handle) → fixed.

## 2. Files

| File | Role |
|---|---|
| [`src/App.tsx`](../src/App.tsx) | Three.js sizing/anchoring, fit state + debounce, all UI (chip, toast, size picker) |
| [`src/lib/bodyFit.ts`](../src/lib/bodyFit.ts) | Pure logic: measurements, size chart, outfit spec, verdicts. No React, no three.js |
| [`src/index.css`](../src/index.css) | `toast-in` keyframes for the warning banner |
| [`src/components/WebCam.tsx`](../src/components/WebCam.tsx) | Video source (typed `video` handle) |
| `docs/fit-and-sizing.md` | This document |

## 3. Sizing: making the outfit follow the body

### 3.1 Width follows the shoulders *on screen*

```js
targetScale = projectedShoulderWidth × SHOULDER_EASE × sizeAdjust / modelShoulderWidth
```

| Term | Meaning |
|---|---|
| `projectedShoulderWidth` | Distance between shoulder landmarks (11 ↔ 12) after unprojecting both onto `ANCHOR_DEPTH`, the same plane the garment lives on. Same plane ⇒ correct alignment **at any distance from the camera** |
| `modelShoulderWidth` | Measured **once at load** from the rig's upper-arm bones (`upperarm_l_014`, `upperarm_r_0148`) after `SHOULDER_WIDEN` is applied. Falls back to `FALLBACK_MODEL_SHOULDER` if the bones are missing |
| `SHOULDER_EASE` | `1.06` — garments are cut a little wider than the body ("ease") so they sit *on* you rather than skin-tight |
| `sizeAdjust` | `1` in Auto mode; otherwise the picked-size ratio (see [§5](#5-size-picker)) |

Why the old `× 6.1` was wrong: it used **metric** shoulder width while the
anchor used **projected** width. Step closer and your shoulders spread apart on
screen but the shirt stayed the same size.

### 3.2 Length follows the torso proportion

```js
lengthFactor = clamp( (torsoLength / shoulderWidth) / BASELINE_TORSO_RATIO,
                      0.9 , 1.1 )
scaleY = targetScale × lengthFactor
```

Both measurements are metric, so the ratio is distance-independent. A
longer-than-average torso lengthens the shirt slightly, a shorter one shortens
it — **clamped so the mesh can never distort.**

> **Calibrate `BASELINE_TORSO_RATIO`:** if shirts always look too long or too
> short, change it until `lengthFactor` is near `1.0` for a typical body.

### 3.3 Placement anchors onto your shoulder line

Every frame, after roll and scale are applied:

1. `shirt.updateMatrixWorld(true)`
2. read where the model's shoulder joints ended up in world space
3. `shirt.position += detectedShoulderMidpoint − measuredShoulderMidpoint`

This is an exact one-step correction (no drift, no oscillation) and it replaces
the magic `-2.9`. `GARMENT_Y_OFFSET` is a manual nudge for rigs whose shoulder
joints do not sit on the mesh's shoulder seam.

### 3.4 Smoothing

- Measurements: EMA, α `0.15`
- Scale: `shirt.scale.lerp(target, SCALE_SMOOTHING = 0.15)`
- First frame snaps instead of growing into place (`scaleSeeded`)

## 4. Fit verdict: is this outfit my size?

All logic in `src/lib/bodyFit.ts`.

### 4.1 Measurements (MediaPipe world landmarks, metres)

| Measurement | Landmarks | Used for |
|---|---|---|
| shoulder width | 11 ↔ 12 | size estimate — **works even if the hips are cropped** |
| torso length | mid-shoulder ↔ mid-hip | length warning + shirt length |
| hip width | 23 ↔ 24 | sanity check (and a hook for future shape logic) |

Sanity checks reject collapsed/extrapolated skeletons (plausible metre ranges,
torso never shorter than 0.4 × shoulders, shoulders and hips clearly separated
vertically — compared as magnitudes because image and world landmarks use
different y-axis directions).

If the full body is not usable, `measureShoulders()` is used on its own so the
size chip still appears; only the length comment is skipped.

### 4.2 Size chart

Body shoulder width → clothing size:

| XS | S | M | L | XL |
|---|---|---|---|---|
| < 0.37 m | 0.37 – 0.41 | 0.41 – 0.45 | 0.45 – 0.49 | ≥ 0.49 |

`SIZE_HYSTERESIS` = 6 mm deadband so a measurement sitting on a boundary does
not flip the letter back and forth.

### 4.3 Verdict priority

1. 🔴 **too tight**
2. 🟠 **too loose**
3. 🟠 **length mismatch** (torso outside `OUTFIT.torsoLengthRange`)
4. 🟢 **fits**

Which rule fills slots 1–2 depends on the mode:

| Mode | Rule |
|---|---|
| **Auto** | estimated size compared against `OUTFIT.sizes` (what the model is cut in, default `S–L`) |
| **Picked size** | estimated size compared against **the size the user chose** |

Example messages:

- Auto: `Size XL — this outfit is cut S-L. Your shoulders are wider than its fit range, so it may be too tight.`
- Picked: `Size S — your shoulders measure closer to L, so this size may be too tight.`
- Length: `Size L — your torso is longer than this outfit's cut, so it may ride up.`

The chip label comes from `fitChipLabel()`:
`Size M · fits` / `Size XL · too tight` / `Size XS · too loose` / `Size L · length mismatch`.

## 5. Size picker

Bottom-left pill row: **`Auto | XS | S | M | L | XL`**.

| Mode | Garment scale | Verdict |
|---|---|---|
| **Auto** (default) | pure body fit (`sizeAdjust = 1`) | estimated size vs the outfit's cut range |
| **Picked** | `sizeAdjust = SIZE_MIDPOINT[picked] ÷ SIZE_MIDPOINT[measured]` — XL renders roomier than your body, XS tighter | *that size* judged against your body |

`SIZE_MIDPOINT` (metres): `XS 0.335 · S 0.39 · M 0.43 · L 0.47 · XL 0.53` —
each size's shoulder band midpoint, so one size step ≈ 4 cm ≈ 9 % bigger.

Behaviour details:

- The garment **lerps** to the new size, so changing size animates smoothly.
- Picking is judged **immediately** (debounce bypassed for that change only) so
  the button feels instant.
- The picked size is part of the verdict key → dismissing a warning for `S` does
  not hide it if you then switch to `XL`.
- The chip shows **the picked size** in manual mode, not the estimated one.

## 6. UI map

```
┌──────────────────────────────────────────────────────────────┐
│ [Status: Pose detected]                          [ ✕ close ] │
│ [Size M · fits]  ← green/amber/red fit chip                  │
│                                                              │
│                       (camera + 3D outfit)                   │
│                                                              │
│                                                              │
│   ┌──────────────────────────────────────────┐               │
│   │ ⚠ Size S — you measure closer to L…  ✕  │  ← toast      │
│   └──────────────────────────────────────────┘               │
│   ( Auto  XS  S  M  L  XL )  ← size picker                   │
└──────────────────────────────────────────────────────────────┘
```

- **Status chip** — tracking state (deduped, no per-frame re-render).
- **Fit chip** — top-left under the status, always shows the last accepted verdict.
- **Toast** — bottom-centre at `bottom-16` (clears the size bar on narrow
  screens), colour-coded (`TOAST_TONES`), dismiss button.
- **Size picker** — bottom-left, active pill is white-on-black, `aria-pressed`
  on every button.
- Animation: `@keyframes toast-in` in `src/index.css`, used via
  `animate-[toast-in_0.18s_ease-out]`.

## 7. Frame-by-frame data flow

```
webcam frame
  └─ PoseLandmarker.detectForVideo()
       ├─ result.worldLandmarks[0]
       │    ├─ measureBody()      → shoulder/torso/hip (metres)
       │    │     └─ fallback: measureShoulders() when hips are unusable
       │    └─ EMA → body.shoulder / .torso / .hip
       │         └─ sizeFromShoulderWidth() → body.size (deadbanded)
       │
       ├─ updateFit(measurements)
       │    ├─ evaluateFit(measurements, body.size, pickedSize)
       │    ├─ debounce: 600 ms warning / 400 ms fits / 0 ms size pick
       │    └─ only on change → setFitChip() + setFitToast()   ← the only re-render
       │
       └─ result.landmarks[0]  (0-1 image coordinates)
            ├─ landmarkToWorld(shoulders, ANCHOR_DEPTH)  → anchor points
            ├─ targetScale  (width × ease × sizeAdjust ÷ model width)
            ├─ lengthFactor (torso ratio, clamped)
            ├─ rootJoint.rotation.z  ← shoulder roll
            ├─ arm bone rotations    (guarded — missing landmarks can't crash)
            └─ anchor correction: shirt.position += shoulder delta
```

Rendering runs independently in `requestAnimationFrame`; React state changes
only when a verdict is accepted.

## 8. Flicker & responsiveness rules

| Situation | Behaviour |
|---|---|
| Measurement jitter | EMA (α 0.15) + 6 mm size deadband |
| Verdict wobbling between states | must hold **600 ms** before showing, **400 ms** before returning to "fits" |
| User clicks a size | judged **instantly** (`candidateSince = 0`) |
| Toast dismissed | stays hidden until the verdict *key* itself changes |
| React renders | only when the accepted verdict changes — never per frame |

## 9. Tuning reference

Open the browser console and watch the `[fit]` lines (one per accepted verdict,
with the raw metres).

| Constant | File | What it does |
|---|---|---|
| `ANCHOR_DEPTH` (1.5) | `App.tsx` | depth plane the garment is anchored to |
| `SHOULDER_EASE` (1.06) | `App.tsx` | overall looseness — garment vs body width |
| `SHOULDER_WIDEN` (1.2) | `App.tsx` | rig shoulder widening, applied once at load |
| `FALLBACK_MODEL_SHOULDER` (0.174) | `App.tsx` | used only if the rig's shoulder bones can't be measured |
| `BASELINE_TORSO_RATIO` (1.3) | `App.tsx` | reference torso:shoulder ratio — raise if shirts look long, lower if short |
| `MIN/MAX_LENGTH_FACTOR` (0.9 / 1.1) | `App.tsx` | hard clamp on how much the length may adapt |
| `SCALE_SMOOTHING` (0.15) | `App.tsx` | how fast the garment chases the body |
| `GARMENT_Y_OFFSET` (0) | `App.tsx` | nudge the garment up/down if the rig's joints aren't on the seam |
| `FIT_CONFIRM_MS` / `FIT_CONFIRM_OK_MS` (600 / 400) | `App.tsx` | warning hysteresis |
| `OUTFIT.sizes` (`["S","M","L"]`) | `bodyFit.ts` | which sizes the model is cut in — Auto mode warns outside this |
| `OUTFIT.torsoLengthRange` (0.4 – 0.8) | `bodyFit.ts` | torso lengths the cut covers |
| `SIZE_CHART` | `bodyFit.ts` | shoulder width → size letter thresholds |
| `SIZE_MIDPOINT` | `bodyFit.ts` | per-size midpoint — drives how much bigger/smaller a picked size renders |
| `SIZE_HYSTERESIS` (0.006) | `bodyFit.ts` | size-letter deadband |

**Typical tuning session:** shoulders should read ~0.36–0.50 m for adults and
torso ~0.40–0.65 m. If they don't, fix `SIZE_CHART` / `OUTFIT.torsoLengthRange`
before touching anything else.

## 10. Edge cases handled

| Case | Handling |
|---|---|
| Hips out of frame (upper-body framing) | size estimate still runs from shoulders; length check skipped |
| Collapsed / extrapolated skeleton | rejected by metre-range sanity checks |
| Elbow or wrist not detected | arm posing skipped; anchoring and fit keep working |
| `worldLandmarks` missing | guarded, shows "Waiting for pose…" |
| Rig shoulder bones missing | `FALLBACK_MODEL_SHOULDER` + console warning |
| No pose at all | last verdict is kept; status shows "Waiting for pose…" |
| Measurement on a size boundary | 6 mm deadband keeps the letter stable |
| Close button with no `onClose` prop | optional prop, no crash |
| Repeated identical status messages | deduped — no wasted renders |

## 11. Verification checklist

1. `npm run dev`
2. Allow webcam permission; stand so **shoulders and hips** are in frame.
3. Confirm in order:
   - [ ] status reads `Pose detected`
   - [ ] the shirt's shoulders sit on your shoulders, and stay there when you
         step forward/back
   - [ ] a green chip appears: `Size M · fits` (or your size)
   - [ ] clicking `XS` rescales the garment tighter **and** shows the red
         warning immediately
   - [ ] clicking `Auto` returns to body fit
   - [ ] the toast's ✕ dismisses it, and it only returns for a *different* verdict
   - [ ] no console errors; close button does not throw
4. Optional: check the console `[fit]` lines while tuning constants.

## 12. Known limitations

- **No yaw tracking** — turning sideways foreshortens the projected shoulders,
  so the garment narrows with you instead of rotating in 3D.
- **World landmarks are estimates** — MediaPipe's metric scale is approximate
  (roughly ±10 %); thresholds are tuned with that in mind.
- **Size chart is a convention**, not a brand spec — replace `SIZE_CHART` /
  `SIZE_MIDPOINT` with real garment measurements when you have them.
- **Picked size is not persisted** — it resets to Auto on reload.
- **The `dist/` bundle is one >500 kB chunk** (three.js + MediaPipe). Code
  splitting is a possible future improvement, unrelated to these changes.
