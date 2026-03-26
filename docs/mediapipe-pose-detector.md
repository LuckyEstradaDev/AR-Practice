# MediaPipe Pose Detector Implementation Guide

This document explains how pose detection is implemented in this project so new developers can maintain and extend it safely.

## Overview

The app uses:

1. `react-webcam` to render a live webcam stream.
2. `@mediapipe/tasks-vision` `PoseLandmarker` to infer body landmarks from video frames.
3. A `<canvas>` overlay to draw landmarks and connectors on top of the webcam video.

Core files:

1. `src/App.tsx` (or `src/sample.tsx` as reference)
2. `src/components/WebCam.tsx`

## Architecture

### `WebCam.tsx` (video source)

`WebCam` is a `forwardRef` component that exposes the underlying HTML video element from `react-webcam`.

Key idea:

1. Parent component needs access to raw video frames.
2. `useImperativeHandle` exposes `video` so parent can call MediaPipe with it.

Type contract:

```ts
export type WebcamHandle = {
  video?: HTMLVideoElement;
};
```

### `App.tsx` (detector + render loop)

`App` owns:

1. `webcamRef` for video input.
2. `canvasRef` for drawing overlay.
3. A `useEffect` lifecycle that initializes and runs MediaPipe.

## Detection lifecycle (step by step)

### 1) Initialize refs

In component scope:

1. `const webcamRef = useRef<WebcamHandle | null>(null);`
2. `const canvasRef = useRef<HTMLCanvasElement | null>(null);`

### 2) Initialize MediaPipe inside `useEffect`

Inside `useEffect`:

1. Resolve MediaPipe wasm files with `FilesetResolver.forVisionTasks(...)`.
2. Create landmarker with `PoseLandmarker.createFromOptions(...)`.
3. Set options:
   - `runningMode: "VIDEO"`
   - `numPoses: 2`
   - `delegate: "GPU"`
   - `modelAssetPath: pose_landmarker_lite.task`

Why inside `useEffect`:

1. Runs once on mount.
2. Avoids invalid hook usage and repeated detector creation.

### 3) Start frame prediction loop

After setup, define and call `predict()`:

1. Read current `video`, `canvas`, and canvas context.
2. If resources are not ready (`video.readyState < 2`), schedule next frame and return.
3. Sync canvas dimensions to current video dimensions.
4. Run `poseLandmarker.detectForVideo(video, performance.now(), callback)`.
5. In callback:
   - `clearRect(...)`
   - draw landmarks with `DrawingUtils.drawLandmarks(...)`
   - draw skeleton edges with `DrawingUtils.drawConnectors(...)`
6. Schedule next frame with `requestAnimationFrame(predict)`.

### 4) Cleanup on unmount

`useEffect` return cleanup:

1. Stop loop with `cancelAnimationFrame(animationFrameId)`.
2. Release detector resources with `poseLandmarker?.close()`.
3. Guard async work with `isMounted = false`.

This prevents memory leaks and background execution after navigation/unmount.

## Visual layering model

UI layout in `App.tsx`:

1. Wrapper `div` is `relative`.
2. `<WebCam />` renders the base video.
3. `<canvas className="absolute inset-0 pointer-events-none" />` overlays detections.

This keeps the camera feed interactive while canvas remains non-blocking.

## Common pitfalls

1. Calling hooks outside React components.
2. Using `document.getElementById` instead of refs in React flow.
3. Forgetting cleanup for animation frame and MediaPipe instance.
4. Running detection before `video.readyState` is sufficient.
5. Mismatched canvas and video dimensions (causes stretched overlay).

## How to extend

### Add angle/rep counting logic

1. Use `result.landmarks` in `detectForVideo` callback.
2. Compute joint angles (e.g., hip-knee-ankle).
3. Store state with `useRef` or `useState`.
4. Draw text/indicators on the same canvas context.

### Switch model quality

Change `modelAssetPath` to full/heavy variants from MediaPipe model storage if you need higher accuracy.

### Improve performance

1. Reduce `numPoses` if only single user is needed.
2. Throttle inference (e.g., every n frames) on weaker hardware.
3. Keep drawing minimal per frame.

## Local verification checklist

1. `npm install`
2. `npm run dev`
3. Allow webcam permission in browser
4. Confirm:
   - webcam video is visible
   - landmarks appear when a person is in frame
   - no console errors after page reload/unmount

## Notes for contributors

1. Keep detector lifecycle in one place (`App.tsx`) unless intentionally refactoring to a hook.
2. If refactoring, consider extracting into `usePoseDetector(webcamRef, canvasRef)` hook.
3. Keep `WebCam` component focused on media capture only (single responsibility).
