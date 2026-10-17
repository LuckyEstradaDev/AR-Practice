/* eslint-disable @typescript-eslint/no-explicit-any */
import {SetStateAction, useEffect, useRef, useState} from "react";
import WebCam, {WebcamHandle} from "./components/WebCam";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {Shirt, TriangleAlert, X} from "lucide-react";
import * as THREE from "three";
import {
  ema,
  evaluateFit,
  fitChipLabel,
  measureBody,
  measureShoulders,
  SIZE_ORDER,
  sizeFromShoulderWidth,
  sizeRenderFactor,
  type BodyMeasurements,
} from "./lib/bodyFit";

const modelUrl = new URL("./assets/3d-files/Barong.glb", import.meta.url).href;

import {FilesetResolver, PoseLandmarker} from "@mediapipe/tasks-vision";

/* ------------------------------------------------------------------ *
 * Fit / sizing tuning
 * ------------------------------------------------------------------ */

/** Depth plane (world units) the garment is anchored to, in front of camera. */
const ANCHOR_DEPTH = 1.5;

/**
 * The rig is authored 1:1 in metres (Blender default), so one model unit is one
 * real metre. This is the single calibration knob: if the overlay renders too
 * large/small, set it to (true garment length) / (rendered length).
 */
const METERS_PER_MODEL_UNIT = 1.0;

/**
 * Real garment size the model represents. Picking another size scales the mesh
 * by the size-chart ratio from here — a real L is physically bigger than M.
 */
const BASE_GARMENT_SIZE = "M";

/**
 * Lateral stretch applied to the rig's root spine bone. It does NOT change the
 * on-screen shoulder width (the fit maths measures the model after widening and
 * normalises it away) — it only reshapes the mesh, so keep it at 1 for a
 * well-rigged garment like Barong.glb. Raise it only for models whose shoulders
 * read too narrow for their torso.
 */
const SHOULDER_WIDEN = 1;

/** Used when the rig's shoulder joints cannot be measured at load time. */
const FALLBACK_MODEL_SHOULDER = 0.174;

/** How strongly scale/position chase the body each frame. */
const SCALE_SMOOTHING = 0.15;

/**
 * How strongly the garment turns to follow the body's facing each frame. The
 * root eases toward a zero or half turn, so a back-turn swings the garment
 * around instead of snapping.
 */
const YAW_SMOOTHING = 0.15;

/**
 * Flip to -1 if the garment turns the wrong way when the body faces sideways.
 * Front/back are unaffected — only the left/right sense of a turn depends on
 * MediaPipe's depth-axis convention.
 */
const YAW_SIGN = -1;

/**
 * Softening for the arm solver's yaw compensation. On screen an arm's angle
 * foreshortens by cos(yaw), so the solver divides that back out — but a
 * side-on body would divide by ~0. This keeps the gain finite and smoothly
 * lets the arms rest when the body is edge-on.
 */
const ARM_YAW_EPS = 0.08;

/**
 * Diagnostic switch. While true, the arm/elbow/spine bones play a looping sine
 * "idle" animation and the pose-driven rotations are skipped, so you can verify
 * the rig deforms on its own. Set to false to let body tracking drive the bones.
 */
const ENABLE_IDLE_TEST = false;

/**
 * Vertical nudge for the garment in world units (positive lifts it).
 * Leave at 0 unless the rig's shoulder joints sit away from the mesh's
 * shoulder seam — then nudge until the seam lands on the shoulder.
 */
const GARMENT_Y_OFFSET = 0;

/**
 * Horizontal nudge for the garment in world units (positive moves it to the
 * screen's right). Leave at 0 unless the rig's shoulder joints are not centred
 * on the mesh — the debug overlay (`?debug=1`) makes any sideways gap obvious.
 */
const GARMENT_X_OFFSET = 0;

/** `?debug=1` draws the tracked landmarks and the overlay's reference frame. */
const DEBUG_OVERLAY =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");

/** A warning must hold this long before it shows, before it clears. */
const FIT_CONFIRM_MS = 600;
const FIT_CONFIRM_OK_MS = 400;

/** Wraps an angle to (-pi, pi] so pose deltas take the short way round. */
const shortestAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * One arm bone's rest-pose reference. Captured once at load so the per-frame
 * pose maths is measured relative to how the rig was modelled instead of
 * assuming the arms start laid out flat. `zSign` records whether the bone's
 * local Z points the same way as world Z, since the two sides are mirrored.
 */
type ArmCalibration = {
  /** screen-plane angle (rad) of the upper arm at rest */
  upAngle: number;
  /** +1 when the bone's local Z aligns with world Z, else -1 */
  upZSign: number;
  /** the bone's rest local Z rotation */
  upLocalZ: number;
  /** screen-plane angle (rad) of the forearm at rest */
  foreAngle: number;
  foreZSign: number;
  elbowLocalZ: number;
};

type FitTone = "red" | "amber" | "green";

type FitChipState = {label: string; tone: FitTone};
type FitToastState = {text: string; tone: "red" | "amber"};

const CHIP_TONES: Record<FitTone, string> = {
  green: "bg-emerald-600/85",
  amber: "bg-amber-600/85",
  red: "bg-red-600/85",
};

const TOAST_TONES = {
  red: "border-red-500/50 bg-red-950/85 text-red-100 [&_svg]:text-red-400",
  amber: "border-amber-500/50 bg-amber-950/85 text-amber-100 [&_svg]:text-amber-400",
};

const sizePillClass = (active: boolean) =>
  `rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
    active ? "bg-white text-black" : "text-white/70 hover:bg-white/10 hover:text-white"
  }`;

export default function App({
  image,
  onClose,
}: {
  image?: string | File;
  onClose?: React.Dispatch<SetStateAction<boolean>>;
}) {
  const webcamRef = useRef<WebcamHandle | null>(null);
  const threeContainerRef = useRef<HTMLDivElement | null>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [statusMessage, setStatusMessage] = useState("Starting camera...");

  // Fit feedback: only re-renders when the verdict actually changes.
  const [fitChip, setFitChip] = useState<FitChipState | null>(null);
  const [fitToast, setFitToast] = useState<FitToastState | null>(null);

  // Size the user picked. `null` = Auto (estimate it from the body).
  const [pickedSize, setPickedSize] = useState<string | null>(null);
  const pickedSizeRef = useRef<string | null>(null);

  useEffect(() => {
    pickedSizeRef.current = pickedSize;
  }, [pickedSize]);

  // Single writer for the status line: repeated identical messages (this runs
  // every frame) never trigger a re-render.
  const statusRef = useRef("");
  const setStatus = (message: string) => {
    if (message !== statusRef.current) {
      statusRef.current = message;
      setStatusMessage(message);
    }
  };

  useEffect(() => {
    let poseLandmarker: PoseLandmarker | null = null;
    let animationFrameId = 0;
    let isMounted = true;

    //model
    let shirt: THREE.Object3D | null = null;
    let rightArm: THREE.Bone | null = null; //inverted
    let leftArm: THREE.Bone | null = null;
    let rightElbowBone: THREE.Bone | null = null;
    let leftElbowBone: THREE.Bone | null = null;
    let rootJoint: THREE.Bone | null = null;
    let hasArmRig = false;
    let leftShoulderBone: THREE.Object3D | null = null;
    let rightShoulderBone: THREE.Object3D | null = null;

    // Rest-pose reference for the arms, captured once after binding.
    let armRest: {right: ArmCalibration; left: ArmCalibration} | null = null;

    // Model dimensions measured once at load (local units).
    const modelShoulderWidthRef = {value: 0};

    // Scratch vectors reused every frame (avoids per-frame allocation).
    const targetScaleVec = new THREE.Vector3();
    const anchorA = new THREE.Vector3();
    const anchorB = new THREE.Vector3();
    const anchorMid = new THREE.Vector3();
    const leftShoulderWorld = new THREE.Vector3();
    const rightShoulderWorld = new THREE.Vector3();
    const leftHipWorld = new THREE.Vector3();
    const rightHipWorld = new THREE.Vector3();
    const midPoint = new THREE.Vector3();
    const debugAnchorScratch = new THREE.Vector3();
    let scaleSeeded = false;

    // Smoothed facing of the body, radians about the vertical: 0 = chest to
    // camera, +-PI/2 = side-on, +-PI = back to camera. The garment root eases
    // toward it so turns swing around instead of snapping.
    let garmentYaw = 0;

    // Cached video-fit rect (object-fit aware) used to map landmarks onto the
    // canvas. Recomputed on resize / orientation change and once the stream's
    // dimensions become known.
    let videoRect: {
      offsetX: number;
      offsetY: number;
      drawW: number;
      drawH: number;
      w: number;
      h: number;
      fit: "cover" | "contain";
    } | null = null;
    let lastVideoW = 0;
    let lastVideoH = 0;

    // Maps a point in container-normalized (0-1) coordinates onto the anchor
    // plane, writing into `out` so no vectors are allocated per frame. x is
    // flipped to match the mirrored video; y is flipped because MediaPipe y
    // grows downward.
    const screenToWorld = (
      nx: number,
      ny: number,
      cam: THREE.PerspectiveCamera,
      depth: number,
      out: THREE.Vector3,
    ) => {
      out.set(-(nx * 2 - 1), -(ny * 2 - 1), 0.5);
      out.unproject(cam);
      out.sub(cam.position).normalize();
      out.multiplyScalar((depth - cam.position.z) / out.z);
      return out.add(cam.position);
    };

    // Maps a MediaPipe landmark (x,y in 0-1 of the camera stream) onto the
    // anchor plane. The landmark is first placed into the canvas's normalized
    // space through the video's on-screen (object-fit) rect, so the overlay
    // stays locked to the body no matter how the window size letterboxes or
    // crops the video.
    const landmarkToWorld = (
      landmark: {x: number; y: number},
      cam: THREE.PerspectiveCamera,
      depth: number,
      out: THREE.Vector3,
    ) => {
      let nx = landmark.x;
      let ny = landmark.y;
      if (videoRect) {
        nx = (videoRect.offsetX + landmark.x * videoRect.drawW) / videoRect.w;
        ny = (videoRect.offsetY + landmark.y * videoRect.drawH) / videoRect.h;
      }
      return screenToWorld(nx, ny, cam, depth, out);
    };

    // Detection runs at most this often. The render loop still runs at the
    // display refresh rate; pose inference (the expensive part) is throttled so
    // it does not run more than ~30x a second.
    const DETECT_INTERVAL_MS = 1000 / 30;
    let lastDetectAt = 0;

    // Body measurements, smoothed over time (metres).
    const body = {
      shoulder: null as number | null,
      torso: null as number | null,
      hip: null as number | null,
      /** last measured size letter, used for the deadband + garment scaling */
      size: null as string | null,
    };

    // Fit verdict debounce.
    let candidateKey = "";
    let candidateSince = 0;
    let acceptedKey = "";
    let lastPickedSeen: string | null | undefined;

    /**
     * Turns smoothed body measurements into the chip + toast. A verdict only
     * lands after it has been stable for a moment, so nothing flickers — except
     * when the user picks a size, which is judged immediately.
     */
    const updateFit = (measurements: BodyMeasurements | null) => {
      const picked = pickedSizeRef.current;
      const fit = evaluateFit(measurements, body.size, picked);

      // Keep the measured size: it feeds the size deadband and the scaling of
      // the garment to the size that was picked.
      if (measurements && measurements.shoulderWidth > 0) {
        body.size = sizeFromShoulderWidth(measurements.shoulderWidth, body.size);
      }

      const pickedChanged = lastPickedSeen !== undefined && picked !== lastPickedSeen;
      lastPickedSeen = picked;

      const key = `${fit.kind}|${fit.size ?? ""}|${picked ?? "auto"}`;
      const now = performance.now();

      if (key !== candidateKey) {
        candidateKey = key;
        candidateSince = pickedChanged ? 0 : now;
      }

      const settleMs = fit.kind === "fits" || fit.kind === "unknown" ? FIT_CONFIRM_OK_MS : FIT_CONFIRM_MS;
      if (now - candidateSince < settleMs || key === acceptedKey) return;

      acceptedKey = key;

      // Handy when tuning the size chart: prints once per verdict change.
      console.debug("[fit]", key, measurements);

      const label = fitChipLabel(fit);
      setFitChip(label && fit.tone ? {label, tone: fit.tone} : null);
      setFitToast(
        fit.toast && fit.tone !== "green" ? {text: fit.toast, tone: fit.tone === "red" ? "red" : "amber"} : null,
      );
    };

    const clock = new THREE.Clock();

    const loader = new GLTFLoader();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);

    camera.position.set(0, 1.2, 4.5);
    camera.lookAt(0, 1.2, 0);
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      powerPreference: "high-performance",
    });

    // The canvas and the webcam video share this full-viewport container; its
    // box is the reference frame for the camera and for mapping landmarks.
    const container = threeContainerRef.current;

    // Optional landmark overlay (?debug=1); a plain 2D canvas in screen space.
    const debugCanvas = DEBUG_OVERLAY ? debugCanvasRef.current : null;
    const debugCtx = debugCanvas?.getContext("2d") ?? null;

    // Recompute the video's on-screen rect (object-fit aware). Keeping this in
    // lockstep with the mapping means the garment lands on the body whether the
    // video is cropped (cover) or letterboxed (contain).
    const updateVideoRect = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const video = webcamRef.current?.video;
      const vw = video?.videoWidth ?? 0;
      const vh = video?.videoHeight ?? 0;
      if (!w || !h || !vw || !vh) {
        videoRect = null;
        return;
      }
      // Adaptive fit: letterbox (contain) when the viewport is portrait so the
      // whole body stays visible, otherwise fill-and-crop (cover).
      const fit: "cover" | "contain" = h > w ? "contain" : "cover";
      const scale = fit === "cover" ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
      const drawW = vw * scale;
      const drawH = vh * scale;
      videoRect = {
        offsetX: (w - drawW) / 2,
        offsetY: (h - drawH) / 2,
        drawW,
        drawH,
        w,
        h,
        fit,
      };
      if (video) video.style.objectFit = fit;
    };

    // Keep the renderer buffer, camera frustum and video rect matched to the
    // container across window resizes, orientation changes and mobile URL-bar
    // shows/hides.
    const resize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(ratio);
      // `setSize` (with its default style update) MUST set an explicit CSS
      // size. A <canvas> is a replaced element, so with only `inset: 0` and no
      // CSS width/height its box would fall back to the intrinsic size — the
      // buffer (w x devicePixelRatio) — and the whole 3D layer would paint
      // scaled up from the top-left on any display that isn't 100% scaling.
      renderer.setSize(w, h);
      if (debugCanvas) {
        debugCanvas.width = Math.round(w * ratio);
        debugCanvas.height = Math.round(h * ratio);
      }
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      updateVideoRect();
      // Snap (rather than lerp) the garment onto the new framing.
      scaleSeeded = false;
    };

    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.zIndex = "25";
    renderer.domElement.style.pointerEvents = "none";
    threeContainerRef.current?.appendChild(renderer.domElement);

    resize();

    const resizeObserver = new ResizeObserver(resize);
    if (container) resizeObserver.observe(container);
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    window.visualViewport?.addEventListener("resize", resize);

    renderer.render(scene, camera);

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      // Idle test animation: swings the bound arm/elbow/spine bones with sine
      // waves, independent of the pose tracker, so you can confirm the rig
      // deforms at all. Set ENABLE_IDLE_TEST to false to hand the bones back to
      // the pose tracker.
      if (ENABLE_IDLE_TEST && shirt) {
        const t = clock.getElapsedTime();
        const swing = Math.sin(t * 2);
        const bend = Math.max(0, Math.sin(t * 3));

        if (rightArm) rightArm.rotation.z = swing * 0.6;
        if (leftArm) leftArm.rotation.z = -swing * 0.6;
        if (rightElbowBone) rightElbowBone.rotation.z = bend * 1.1;
        if (leftElbowBone) leftElbowBone.rotation.z = -bend * 1.1;
        if (rootJoint) rootJoint.rotation.z = Math.sin(t) * 0.3;
      }

      renderer.render(scene, camera);
    };

    loader.load(modelUrl, (gltf: {scene: any}) => {
      shirt = gltf.scene;
      if (!shirt) {
        console.error("Failed to load shirt model");
        return;
      }

      // // Show the skeleton
      // const skeletonHelper = new THREE.SkeletonHelper(shirt);
      // scene.add(skeletonHelper);

      // const axesHelper = new THREE.AxesHelper(1);
      // shirt.add(axesHelper);

      //print all the skeleton bones console

      // Bone names are normalized before matching: three.js strips reserved
      // characters ('.', '/', ':', '[]') from glTF node names, so the Barong
      // bone "arm.l" arrives as "arml" and "forearm.r" as "forearmr". Matching
      // on the normalized key binds both the Blender names (arm.l / forearm.r /
      // shoulder.l) and the old shirt names (upperarm_l_014 / lowerarm_r_0149 /
      // _rootJoint). If the model has no skeleton (a static mesh), all bones
      // stay null and the rig block below is skipped instead of crashing.
      shirt.traverse((child: any) => {
        if (!child.isBone) return;

        const key = (child.name as string).toLowerCase().replace(/[^a-z0-9]/g, "");

        if (!rightArm && (key === "arml" || key.startsWith("upperarml"))) {
          rightArm = child;
        }

        if (!leftArm && (key === "armr" || key.startsWith("upperarmr"))) {
          leftArm = child;
        }

        if (!rightElbowBone && (key === "forearml" || key.startsWith("lowerarml"))) {
          rightElbowBone = child;
        }

        if (!leftElbowBone && (key === "forearmr" || key.startsWith("lowerarmr"))) {
          leftElbowBone = child;
        }

        if (!rightShoulderBone && key === "shoulderl") {
          rightShoulderBone = child;
        }

        if (!leftShoulderBone && key === "shoulderr") {
          leftShoulderBone = child;
        }

        if (!rootJoint && (key.includes("rootjoint") || key.endsWith("spine3") || key === "neutralbone")) {
          rootJoint = child;
        }
      });

      // Rigs without dedicated shoulder bones (e.g. the old shirt) fall back to
      // the upper-arm joints for measuring / anchoring the shoulder line.
      if (!rightShoulderBone) rightShoulderBone = rightArm;
      if (!leftShoulderBone) leftShoulderBone = leftArm;

      hasArmRig = Boolean(rightArm && rightElbowBone && leftArm && leftElbowBone);
      console.log("[bones] resolved", {
        rightArm: rightArm?.name,
        leftArm: leftArm?.name,
        rightElbowBone: rightElbowBone?.name,
        leftElbowBone: leftElbowBone?.name,
        rightShoulderBone: rightShoulderBone?.name,
        leftShoulderBone: leftShoulderBone?.name,
        rootJoint: rootJoint?.name,
        hasArmRig,
      });
      if (!rootJoint && !hasArmRig) {
        console.warn(
          `"${modelUrl}" has no skeleton - rendering it as a static overlay. ` +
            "Re-export with an armature/skin to enable pose-driven rigging.",
        );
      }
      shirt.position.set(0, 0, 0);
      shirt.scale.set(1, 1, 1);
      shirt.rotation.set(0, 0, 0);
      scene.add(shirt);
      scene.add(new THREE.AmbientLight(0xffffff, 2));
      const dir = new THREE.DirectionalLight(0xffffff, 2);
      dir.position.set(5, 5, 5);
      scene.add(dir);

      // Shoulder width is applied once here (not every frame) so the fit
      // maths below owns the width from now on.
      if (rootJoint) {
        rootJoint.scale.x = SHOULDER_WIDEN;
      }

      // Measure the model's own shoulder span (in model units = metres) purely
      // as a calibration aid: log it so METERS_PER_MODEL_UNIT can be tuned if
      // the real-size overlay looks off. It does not drive the fit maths.
      shirt.updateMatrixWorld(true);
      if (leftShoulderBone && rightShoulderBone) {
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        leftShoulderBone.getWorldPosition(a);
        rightShoulderBone.getWorldPosition(b);
        const width = a.distanceTo(b);
        if (width > 0.02 && width < 5) {
          modelShoulderWidthRef.value = width;
        }
      }
      if (!modelShoulderWidthRef.value) {
        console.warn("Could not measure model shoulders, using fallback width", FALLBACK_MODEL_SHOULDER);
        modelShoulderWidthRef.value = FALLBACK_MODEL_SHOULDER;
      }
      console.log("[model] shoulder span (model units / metres):", modelShoulderWidthRef.value.toFixed(3));

      // Diagnostic: where the shoulder line sits within the mesh. A lateral gap
      // between the two means anchoring on the bones (rather than the mesh
      // centre) renders the garment off to one side — tune GARMENT_X_OFFSET.
      const bboxCentre = new THREE.Box3().setFromObject(shirt).getCenter(new THREE.Vector3());
      const shoulderMid = new THREE.Vector3();
      if (leftShoulderBone && rightShoulderBone) {
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        leftShoulderBone.getWorldPosition(a);
        rightShoulderBone.getWorldPosition(b);
        shoulderMid.addVectors(a, b).multiplyScalar(0.5);
      }
      console.log(
        "[model] bbox centre",
        bboxCentre.toArray().map((n) => n.toFixed(3)).join(", "),
        "| shoulder mid",
        shoulderMid.toArray().map((n) => n.toFixed(3)).join(", "),
      );

      // Capture the arms' rest pose so per-frame posing is applied as a delta
      // from how the rig was modelled. Driving the bones with an absolute
      // screen angle assumes the arms start flat and ignores the y-flip, which
      // is what made lowering the arms raise the model.
      if (hasArmRig && rightArm && leftArm && rightElbowBone && leftElbowBone) {
        const measureArm = (arm: THREE.Bone, elbow: THREE.Bone): ArmCalibration => {
          const shoulderPos = new THREE.Vector3();
          const elbowPos = new THREE.Vector3();
          arm.getWorldPosition(shoulderPos);
          elbow.getWorldPosition(elbowPos);

          const upAngle = Math.atan2(elbowPos.y - shoulderPos.y, elbowPos.x - shoulderPos.x);

          const q = new THREE.Quaternion();
          arm.getWorldQuaternion(q);
          const upZSign = new THREE.Vector3(0, 0, 1).applyQuaternion(q).z >= 0 ? 1 : -1;

          elbow.getWorldQuaternion(q);
          const fore = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
          const foreAngle = Math.atan2(fore.y, fore.x);
          const foreZSign = new THREE.Vector3(0, 0, 1).applyQuaternion(q).z >= 0 ? 1 : -1;

          return {
            upAngle,
            upZSign,
            upLocalZ: arm.rotation.z,
            foreAngle,
            foreZSign,
            elbowLocalZ: elbow.rotation.z,
          };
        };

        armRest = {
          right: measureArm(rightArm, rightElbowBone),
          left: measureArm(leftArm, leftElbowBone),
        };
        console.log("[arms] rest calibration", armRest);
      }
    });

    animate();

    const setup = async () => {
      try {
        setStatus("Loading pose model...");
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm",
        );

        const createLandmarker = (delegate: "GPU" | "CPU") =>
          PoseLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: "/models/pose_landmarker_full.task",
              delegate,
            },
            runningMode: "VIDEO",
            numPoses: 1,
          });

        // The GPU delegate is several times faster when the browser supports it;
        // fall back to CPU so headless/older environments still work.
        try {
          poseLandmarker = await createLandmarker("GPU");
          console.log("[pose] using GPU delegate");
        } catch (gpuError) {
          console.warn("[pose] GPU delegate unavailable, using CPU", gpuError);
          poseLandmarker = await createLandmarker("CPU");
        }
        setStatus("Tracking body pose...");
      } catch (error) {
        console.error("Pose setup failed", error);
        setStatus("Pose setup failed. Please refresh and allow camera access.");
        return;
      }

      const predict = async () => {
        if (!isMounted || !poseLandmarker) return;

        const video = webcamRef.current?.video;

        if (!video) {
          animationFrameId = requestAnimationFrame(predict);
          return;
        }

        if (video.readyState < 2) {
          if (video.paused) {
            void video.play().catch(() => {
              setStatus("Allow autoplay to start the pose tracker");
            });
          }
          animationFrameId = requestAnimationFrame(predict);
          return;
        }

        // Keep the video-fit rect in sync if the stream dimensions change (e.g.
        // camera switches resolution, orientation flips).
        if (video.videoWidth !== lastVideoW || video.videoHeight !== lastVideoH) {
          lastVideoW = video.videoWidth;
          lastVideoH = video.videoHeight;
          updateVideoRect();
        }

        // Throttle the expensive pose inference; the render loop keeps running
        // at the display rate independently.
        const now = performance.now();
        if (now - lastDetectAt < DETECT_INTERVAL_MS) {
          animationFrameId = requestAnimationFrame(predict);
          return;
        }
        lastDetectAt = now;

        poseLandmarker.detectForVideo(video, now, (result) => {
          if (!result.landmarks?.length || !result.worldLandmarks?.length) {
            setStatus("Waiting for pose...");
            return;
          }

          // Body measurements in metres → clothing size + fit verdict.
          // Shoulders alone are enough for the size estimate, so an upper-body
          // framing (hips cropped out) still produces a fit chip.
          const worldLandmarks = result.worldLandmarks[0];
          const measured = measureBody(worldLandmarks);
          if (measured) {
            body.shoulder = ema(body.shoulder, measured.shoulderWidth);
            if (measured.torsoLength !== null) {
              body.torso = ema(body.torso, measured.torsoLength);
            }
            if (measured.hipWidth !== null) {
              body.hip = ema(body.hip, measured.hipWidth);
            }
          } else {
            const shoulders = measureShoulders(worldLandmarks);
            if (shoulders !== null) {
              body.shoulder = ema(body.shoulder, shoulders);
            }
          }

          updateFit(
            body.shoulder !== null
              ? {
                  shoulderWidth: body.shoulder,
                  torsoLength: body.torso,
                  hipWidth: body.hip,
                }
              : null,
          );

          for (const landmark of result.landmarks) {
            const leftShoulder = landmark[11];
            const leftElbow = landmark[13];
            const leftWrist = landmark[15];

            const rightShoulder = landmark[12];
            const rightElbow = landmark[14]; //invered
            const rightWrist = landmark[16];

            if (!leftShoulder || !rightShoulder) {
              continue;
            }

            if (shirt) {
              landmarkToWorld(leftShoulder, camera, ANCHOR_DEPTH, leftShoulderWorld);
              landmarkToWorld(rightShoulder, camera, ANCHOR_DEPTH, rightShoulderWorld);
              const leftHip = landmark[23];
              const rightHip = landmark[24];
              if (leftHip) landmarkToWorld(leftHip, camera, ANCHOR_DEPTH, leftHipWorld);
              if (rightHip) landmarkToWorld(rightHip, camera, ANCHOR_DEPTH, rightHipWorld);

              midPoint.addVectors(leftShoulderWorld, rightShoulderWorld).multiplyScalar(0.5);

              // Real-size overlay: map real metres onto screen world units so
              // the garment keeps the dimensions it was modelled at, instead of
              // being resized to the body. `unitsPerMetre` comes from the body's
              // shoulders as they appear on screen (world units) divided by the
              // same span in metres, so it also tracks camera distance.
              const projectedShoulderWidth = leftShoulderWorld.distanceTo(rightShoulderWorld);

              if (projectedShoulderWidth > 0 && body.shoulder) {
                // Screen world-units per real metre at the body's depth. Yaw
                // foreshortens the shoulder line toward nothing when the body
                // turns side-on, which used to shrink the whole garment. A
                // vertical span (shoulder-mid to hip-mid) does not foreshorten
                // with yaw, so prefer it when the hips are in frame; otherwise
                // fall back to the shoulder line folded by cos(yaw).
                const cosYaw = Math.max(Math.abs(Math.cos(garmentYaw)), 0.35);
                let unitsPerMetre = projectedShoulderWidth / (body.shoulder * cosYaw);
                if (leftHip && rightHip && body.torso) {
                  const hipMid = anchorA
                    .addVectors(leftHipWorld, rightHipWorld)
                    .multiplyScalar(0.5);
                  const projectedTorso = midPoint.distanceTo(hipMid);
                  if (projectedTorso > 0.01) {
                    unitsPerMetre = projectedTorso / body.torso;
                  }
                }

                // A picked size renders the garment at that size's real
                // dimensions, relative to the size the model was authored at.
                const sizeRatio = sizeRenderFactor(pickedSizeRef.current, BASE_GARMENT_SIZE);

                const targetScale = unitsPerMetre * METERS_PER_MODEL_UNIT * sizeRatio;

                // Uniform scale: the mesh keeps its modelled length, so the
                // top-to-bottom size is whatever the garment really is.
                targetScaleVec.set(targetScale, targetScale, targetScale);
                if (scaleSeeded) {
                  shirt.scale.lerp(targetScaleVec, SCALE_SMOOTHING);
                } else {
                  // Snap on the first frame so it does not grow into place.
                  shirt.scale.copy(targetScaleVec);
                  scaleSeeded = true;
                }
              }

              //BODY ROTATION (FACING + SHOULDER TILT)
              // Skipped while the idle test owns the bones.
              if (rootJoint && !ENABLE_IDLE_TEST) {
                rootJoint.scale.x = SHOULDER_WIDEN;

                const dx = rightShoulderWorld.x - leftShoulderWorld.x;
                const dy = rightShoulderWorld.y - leftShoulderWorld.y;

                // Continuous yaw from the real (metre) shoulder line: its depth
                // difference says how far the body has turned and its lateral
                // difference keeps front and back apart. Zero faces the camera,
                // +-PI/2 is side-on, +-PI is back-to-camera.
                const shoulderL = worldLandmarks[11];
                const shoulderR = worldLandmarks[12];
                const targetYaw = shoulderL && shoulderR
                  ? YAW_SIGN *
                    Math.atan2(
                      -(shoulderR.z - shoulderL.z),
                      -(shoulderR.x - shoulderL.x),
                    )
                  : garmentYaw;
                garmentYaw += shortestAngle(targetYaw - garmentYaw) * YAW_SMOOTHING;

                // Shoulder-line tilt, measured in 3D so it stays stable when the
                // body is side-on: the on-screen line collapses to a point there
                // and would otherwise roll the garment onto its side. Magnitude
                // comes from the real shoulder vector; the sign comes from the
                // on-screen height difference, matching the front-facing case.
                const roll = shoulderL && shoulderR
                  ? Math.sign(dy) *
                    Math.atan2(
                      Math.abs(shoulderR.y - shoulderL.y),
                      Math.hypot(
                        shoulderR.x - shoulderL.x,
                        shoulderR.z - shoulderL.z,
                      ),
                    )
                  : Math.atan2(dy, Math.abs(dx));

                rootJoint.rotation.set(0, garmentYaw, roll);
              }

              //ARM MOVEMENTS (only when the model actually has an arm rig)
              // Skipped while the idle test owns the bones.
              if (hasArmRig && armRest && !ENABLE_IDLE_TEST) {
                // The landmark -> world mapping flips BOTH axes (mirrored x,
                // y-up screen), so the limb's on-screen direction in model
                // space is (-dx, -dy). Measure each limb as a screen angle and
                // apply it as a delta from the captured rest pose. The same
                // maths serves both arms; the per-arm rest offsets and zSign
                // (calibrated from each bone's mirrored rest) handle the sides.
                // The solver reads arm angles off the screen, which a body yaw
                // foreshortens by cos(yaw). Divide that back out (keeping its
                // sign) so the same physical swing tracks through front, side
                // and back; the softened divisor keeps the gain finite edge-on.
                const cosYaw = Math.cos(garmentYaw);
                const stretch =
                  (cosYaw * (1 + ARM_YAW_EPS)) / (cosYaw * cosYaw + ARM_YAW_EPS);
                const solveArm = (rest: ArmCalibration, upTarget: number, foreTarget: number) => {
                  // The rest pose was captured facing the camera, so a turned
                  // body projects it mirrored (lateral scaled by cos(yaw)).
                  // Apply that same projection to the rest reference; otherwise
                  // an arm that is simply still reads as a big delta and flares.
                  const restUp = Math.atan2(
                    Math.sin(rest.upAngle),
                    Math.cos(rest.upAngle) * cosYaw,
                  );
                  const restFore = Math.atan2(
                    Math.sin(rest.foreAngle),
                    Math.cos(rest.foreAngle) * cosYaw,
                  );
                  // Both terms use the same yaw factor: the upper arm drives its
                  // own bone and the elbow is measured relative to it, so if the
                  // factor is applied to only one the forearm inverts as the
                  // body turns. `stretch` carries the sign of cos(yaw), which
                  // cancels the arm bone's local-Z axis flipping at the back.
                  const dUp = shortestAngle(upTarget - restUp) * stretch;
                  const armZ = rest.upLocalZ + rest.upZSign * dUp;
                  const dForeWorld = shortestAngle(foreTarget - restFore) * stretch - dUp;
                  const elbowZ = rest.elbowLocalZ + rest.foreZSign * dForeWorld;
                  return {armZ, elbowZ};
                };

                const rightUp = Math.atan2(-(rightElbow.y - rightShoulder.y), -(rightElbow.x - rightShoulder.x));
                const rightFore = Math.atan2(-(rightWrist.y - rightElbow.y), -(rightWrist.x - rightElbow.x));
                const rightSolved = solveArm(armRest.right, rightUp, rightFore);
                rightArm!.rotation.z = rightSolved.armZ;
                rightElbowBone!.rotation.z = rightSolved.elbowZ;

                const leftUp = Math.atan2(-(leftElbow.y - leftShoulder.y), -(leftElbow.x - leftShoulder.x));
                const leftFore = Math.atan2(-(leftWrist.y - leftElbow.y), -(leftWrist.x - leftElbow.x));
                const leftSolved = solveArm(armRest.left, leftUp, leftFore);
                leftArm!.rotation.z = leftSolved.armZ;
                leftElbowBone!.rotation.z = leftSolved.elbowZ;
              }

              //ARM MOVEMENTS

              // ANCHOR: measure where the shirt's shoulder line ended up
              // (after roll + scale) and nudge the model onto the detected
              // shoulder line. Replaces the old hard-coded "-2.9" offset.
              shirt.updateMatrixWorld(true);
              if (leftShoulderBone && rightShoulderBone) {
                leftShoulderBone.getWorldPosition(anchorA);
                rightShoulderBone.getWorldPosition(anchorB);
                anchorMid.addVectors(anchorA, anchorB).multiplyScalar(0.5);
                shirt.position.x += midPoint.x - anchorMid.x + GARMENT_X_OFFSET;
                shirt.position.y += midPoint.y - anchorMid.y + GARMENT_Y_OFFSET;
                shirt.position.z += midPoint.z - anchorMid.z;
              } else {
                shirt.position.copy(midPoint);
              }
            }

            setStatus("Pose detected");
          }

          // Debug overlay (?debug=1): the tracked landmarks (mirrored to match
          // what the user sees), the visible video-fit rectangle, and the
          // garment's shoulder anchor projected back to screen space. Confirms
          // the overlay is locked to the body at any window size / display.
          if (debugCtx && debugCanvas) {
            const w = debugCanvas.clientWidth;
            const h = debugCanvas.clientHeight;
            const dpr = w ? debugCanvas.width / w : 1;
            debugCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            debugCtx.clearRect(0, 0, w, h);

            if (videoRect) {
              debugCtx.strokeStyle = "rgba(255,214,0,0.9)";
              debugCtx.lineWidth = 1.5;
              debugCtx.strokeRect(videoRect.offsetX, videoRect.offsetY, videoRect.drawW, videoRect.drawH);
            }

            debugCtx.fillStyle = "rgba(0,255,140,0.9)";
            for (const lm of result.landmarks[0]) {
              const nx = videoRect ? (videoRect.offsetX + lm.x * videoRect.drawW) / videoRect.w : lm.x;
              const ny = videoRect ? (videoRect.offsetY + lm.y * videoRect.drawH) / videoRect.h : lm.y;
              debugCtx.beginPath();
              debugCtx.arc((1 - nx) * w, ny * h, 3, 0, Math.PI * 2);
              debugCtx.fill();
            }

            if (shirt) {
              const p = debugAnchorScratch.copy(midPoint).project(camera);
              debugCtx.fillStyle = "rgba(255,60,90,0.95)";
              debugCtx.beginPath();
              debugCtx.arc((p.x * 0.5 + 0.5) * w, (-p.y * 0.5 + 0.5) * h, 5, 0, Math.PI * 2);
              debugCtx.fill();
            }
          }
        });

        animationFrameId = requestAnimationFrame(predict);
      };

      predict();
    };

    setup();

    return () => {
      isMounted = false;
      cancelAnimationFrame(animationFrameId);
      poseLandmarker?.close();

      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      window.visualViewport?.removeEventListener("resize", resize);

      // Remove Three.js renderer
      if (threeContainerRef.current && threeContainerRef.current.contains(renderer.domElement)) {
        threeContainerRef.current.removeChild(renderer.domElement);
      }

      // Dispose Three.js renderer
      renderer.dispose();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      {/* Close button */}
      <button
        onClick={() => onClose?.((prev) => !prev)}
        className="absolute right-4 top-4 z-10 flex size-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
      >
        <X className="size-5" />
      </button>

      <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
        {/* Webcam */}
        <div className="absolute inset-0">
          <WebCam ref={webcamRef} onStatusChange={setStatus} />
        </div>

        {/* Three.js */}
        <div ref={threeContainerRef} className="absolute inset-0" />

        {/* Debug landmark overlay (?debug=1) */}
        {DEBUG_OVERLAY && (
          <canvas ref={debugCanvasRef} className="absolute inset-0 z-30 h-full w-full" />
        )}
      </div>

      {/* Tracking status + fit chip */}
      <div className="pointer-events-none absolute left-4 top-4 z-40 flex flex-col items-start gap-2">
        <div className="rounded-full bg-black/70 px-3 py-1 text-sm text-white">{statusMessage}</div>

        {fitChip && (
          <div
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-white backdrop-blur-sm ${CHIP_TONES[fitChip.tone]}`}
          >
            <Shirt className="size-3.5" />
            {fitChip.label}
          </div>
        )}
      </div>

      {/* Size picker — Auto estimates the size, picking one is judged instead */}
      <div className="pointer-events-auto absolute bottom-4 left-4 z-40 flex items-center gap-1 rounded-full bg-black/60 p-1 backdrop-blur-sm">
        <button
          onClick={() => setPickedSize(null)}
          aria-pressed={pickedSize === null}
          className={sizePillClass(pickedSize === null)}
        >
          Auto
        </button>
        {SIZE_ORDER.map((size) => (
          <button
            key={size}
            onClick={() => setPickedSize(size)}
            aria-pressed={pickedSize === size}
            className={sizePillClass(pickedSize === size)}
          >
            {size}
          </button>
        ))}
      </div>

      {/* Fit warning */}
      {fitToast && (
        <div
          className={`animate-[toast-in_0.18s_ease-out] pointer-events-auto absolute bottom-16 left-1/2 z-40 w-[min(92vw,26rem)] -translate-x-1/2 rounded-xl border px-4 py-3 shadow-lg backdrop-blur-md ${TOAST_TONES[fitToast.tone]}`}
        >
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 size-5 shrink-0" />
            <p className="flex-1 text-sm leading-5">{fitToast.text}</p>
            <button
              onClick={() => setFitToast(null)}
              aria-label="Dismiss fit warning"
              className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
