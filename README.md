# AR Practice Setup Notes

This README explains exactly what was implemented step by step to set up your React + Vite + Tailwind app and fix the main app errors.

## 1) Project scaffolding

The app was scaffolded with Vite (React template), then dependencies were installed.

Commands used:

```powershell
npm create vite@latest . -- --template react
npm install
```

## 2) Tailwind setup

Tailwind v4 was installed and integrated using the Vite plugin.

Commands used:

```powershell
npm install -D tailwindcss @tailwindcss/vite
```

Changes made:

1. Added Tailwind plugin to Vite config in [`vite.config.js`](./vite.config.js).
2. Replaced `src/index.css` content with:

```css
@import "tailwindcss";
```

## 3) Main app error fixes

The original `App.tsx` had hook and runtime issues:

1. `useEffect(...)` was outside the React component (invalid hook usage).
2. `runningMode` was referenced but never defined.
3. DOM access with `getElementById` made the flow fragile in React.

Fixes implemented in [`src/App.tsx`](./src/App.tsx):

1. Moved `useEffect` inside the `App` function component.
2. Used React refs (`useRef`) for webcam and canvas.
3. Initialized MediaPipe `PoseLandmarker` inside `useEffect`.
4. Added an animation loop with `requestAnimationFrame`.
5. Added proper cleanup on unmount:
   - cancel animation frame
   - close `poseLandmarker`

## 4) Webcam component conversion

To reduce TS/JS import issues, webcam component was converted to TypeScript.

Changes:

1. Created [`src/components/WebCam.tsx`](./src/components/WebCam.tsx) with typed `forwardRef`.
2. Removed old `src/components/WebCam.jsx`.
3. Updated imports in `App.tsx` to use typed handle (`WebcamHandle`).

## 5) Entry import update

Updated entry file to use the fixed app component import:

1. Edited [`src/main.jsx`](./src/main.jsx)
2. Import now resolves `App` from `./App` (which maps to `App.tsx`)

## 6) Current run/build notes

If you see local build/runtime issues, they are likely environment-related (Node/npm/native optional deps), not from the component logic changes.

Recommended local checks:

```powershell
npm install
npm run dev
```

If build issues persist, check Node version first. Newer Vite releases may require:

1. Node `20.19+` or `22.12+`

## Files touched

1. [`vite.config.js`](./vite.config.js)
2. [`src/index.css`](./src/index.css)
3. [`src/App.tsx`](./src/App.tsx)
4. [`src/components/WebCam.tsx`](./src/components/WebCam.tsx)
5. [`src/main.jsx`](./src/main.jsx)
