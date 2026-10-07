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
  sizeScaleFactor,
  type BodyMeasurements,
} from "./lib/bodyFit";

const modelUrl = new URL("./assets/3d-files/shirt.glb", import.meta.url).href;

import {
  DrawingUtils,
  FilesetResolver,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

const leftSleeveSrc = new URL("./assets/segment/left-s.png", import.meta.url)
  .href;
const rightSleeveSrc = new URL("./assets/segment/right-s.png", import.meta.url)
  .href;

/* ------------------------------------------------------------------ *
 * Fit / sizing tuning
 * ------------------------------------------------------------------ */

/** Depth plane (world units) the garment is anchored to, in front of camera. */
const ANCHOR_DEPTH = 1.5;

/** Garments are cut slightly wider than the body ("ease") so they sit ON you. */
const SHOULDER_EASE = 1.06;

/** Widens the rig's shoulders to keep the silhouette this model was tuned for. */
const SHOULDER_WIDEN = 1.2;

/** Used when the rig's shoulder joints cannot be measured at load time. */
const FALLBACK_MODEL_SHOULDER = 0.174;

/**
 * Typical torso-length : shoulder-width ratio for a human body.
 * A longer torso than this makes the shirt longer (and vice versa),
 * clamped so the mesh never distorts.
 */
const BASELINE_TORSO_RATIO = 1.3;
const MIN_LENGTH_FACTOR = 0.9;
const MAX_LENGTH_FACTOR = 1.1;

/** How strongly scale/position chase the body each frame. */
const SCALE_SMOOTHING = 0.15;

/**
 * Vertical nudge for the garment in world units (positive lifts it).
 * Leave at 0 unless the rig's shoulder joints sit away from the mesh's
 * shoulder seam — then nudge until the seam lands on the shoulder.
 */
const GARMENT_Y_OFFSET = 0;

/** A warning must hold this long before it shows, before it clears. */
const FIT_CONFIRM_MS = 600;
const FIT_CONFIRM_OK_MS = 400;

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
  amber:
    "border-amber-500/50 bg-amber-950/85 text-amber-100 [&_svg]:text-amber-400",
};

const sizePillClass = (active: boolean) =>
  `rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
    active
      ? "bg-white text-black"
      : "text-white/70 hover:bg-white/10 hover:text-white"
  }`;

export default function App({
  image,
  onClose,
}: {
  image?: string | File;
  onClose?: React.Dispatch<SetStateAction<boolean>>;
}) {
  const webcamRef = useRef<WebcamHandle | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const threeContainerRef = useRef<HTMLDivElement | null>(null);
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
    let leftShoulderBone: THREE.Object3D | null = null;
    let rightShoulderBone: THREE.Object3D | null = null;

    // Model dimensions measured once at load (local units).
    const modelShoulderWidthRef = {value: 0};

    // Scratch vectors reused every frame (avoids per-frame allocation).
    const targetScaleVec = new THREE.Vector3();
    const anchorA = new THREE.Vector3();
    const anchorB = new THREE.Vector3();
    const anchorMid = new THREE.Vector3();
    let scaleSeeded = false;

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
        body.size = sizeFromShoulderWidth(
          measurements.shoulderWidth,
          body.size,
        );
      }

      const pickedChanged =
        lastPickedSeen !== undefined && picked !== lastPickedSeen;
      lastPickedSeen = picked;

      const key = `${fit.kind}|${fit.size ?? ""}|${picked ?? "auto"}`;
      const now = performance.now();

      if (key !== candidateKey) {
        candidateKey = key;
        candidateSince = pickedChanged ? 0 : now;
      }

      const settleMs =
        fit.kind === "fits" || fit.kind === "unknown"
          ? FIT_CONFIRM_OK_MS
          : FIT_CONFIRM_MS;
      if (now - candidateSince < settleMs || key === acceptedKey) return;

      acceptedKey = key;

      // Handy when tuning the size chart: prints once per verdict change.
      console.debug("[fit]", key, measurements);

      const label = fitChipLabel(fit);
      setFitChip(label && fit.tone ? {label, tone: fit.tone} : null);
      setFitToast(
        fit.toast && fit.tone !== "green"
          ? {text: fit.toast, tone: fit.tone === "red" ? "red" : "amber"}
          : null,
      );
    };

    const clock = new THREE.Clock();

    const loader = new GLTFLoader();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );

    camera.position.set(0, 1.2, 4.5);
    camera.lookAt(0, 1.2, 0);
    const renderer = new THREE.WebGLRenderer({alpha: true});

    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.zIndex = "25";
    renderer.domElement.style.pointerEvents = "none";
    threeContainerRef.current?.appendChild(renderer.domElement);

    renderer.render(scene, camera);

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      renderer.render(scene, camera);

      // const t = clock.getElapsedTime();
      // if (shirt) {
      //   if (leftArm) {
      //     leftArm.rotation.y = Math.sin(t * 12) * 0.5;
      //   }
      //   if (rightArm) {
      //     rightArm.rotation.y = Math.sin(t * 12) * 0.5;
      //   }
      // }
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

      shirt.traverse((child: any) => {
        if (child.isBone) {
          if (child.name === "upperarm_l_014") {
            rightArm = child;
            rightShoulderBone = child;
          }

          if (child.name === "upperarm_r_0148") {
            leftArm = child;
            leftShoulderBone = child;
          }

          if (child.name === "lowerarm_l_015") {
            rightElbowBone = child;
          }

          if (child.name === "lowerarm_r_0149") {
            leftElbowBone = child;
          }

          if (child.name === "_rootJoint") {
            rootJoint = child;
          }
        }
      });
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

      // Measure the model's own shoulder width so the shirt can be scaled
      // to match the user's body instead of a hard-coded multiplier.
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
        console.warn(
          "Could not measure model shoulders, using fallback width",
          FALLBACK_MODEL_SHOULDER,
        );
        modelShoulderWidthRef.value = FALLBACK_MODEL_SHOULDER;
      }
    });

    animate();

    const setup = async () => {
      try {
        setStatus("Loading pose model...");
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm",
        );

        poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "/models/pose_landmarker_full.task",
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
        });
        setStatus("Tracking body pose...");
      } catch (error) {
        console.error("Pose setup failed", error);
        setStatus(
          "Pose setup failed. Please refresh and allow camera access.",
        );
        return;
      }

      const predict = async () => {
        if (!isMounted || !poseLandmarker) return;

        const video = webcamRef.current?.video;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");

        if (!video || !canvas || !ctx) {
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

        if (video.videoWidth && video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.style.width = "100%";
          canvas.style.height = "100%";
        }

        const drawingUtils = new DrawingUtils(ctx);

        poseLandmarker.detectForVideo(video, performance.now(), (result) => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);

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

            // Reusable helper: turns a MediaPipe landmark (x,y in 0-1) into a Three.js Vector3
            function landmarkToWorld(
              landmark: {x: number; y: number},
              camera: THREE.PerspectiveCamera,
              depth = 4.5,
            ) {
              // Convert 0-1 range to Three.js "NDC" range (-1 to 1)
              // Flip x because your video is mirrored (scaleX(-1) on the canvas)
              const ndcX = -(landmark.x * 2 - 1);
              const ndcY = -(landmark.y * 2 - 1); // y is also flipped: MediaPipe y grows downward, Three.js grows upward

              const vector = new THREE.Vector3(ndcX, ndcY, 0.5); // z=0.5 is just "somewhere between near/far plane"
              vector.unproject(camera);

              const dir = vector.sub(camera.position).normalize();
              const distance = (depth - camera.position.z) / dir.z;
              return camera.position.clone().add(dir.multiplyScalar(distance));
            }

            if (shirt) {
              const leftShoulderWorld = landmarkToWorld(
                leftShoulder,
                camera,
                ANCHOR_DEPTH,
              );

              const rightShoulderWorld = landmarkToWorld(
                rightShoulder,
                camera,
                ANCHOR_DEPTH,
              );

              const midPoint = new THREE.Vector3()
                .addVectors(leftShoulderWorld, rightShoulderWorld)
                .multiplyScalar(0.5);

              // Width is taken from the shoulders as they appear on screen, so
              // the shirt keeps matching the body at any distance from the
              // camera (metric world landmarks would not track distance).
              const projectedShoulderWidth =
                leftShoulderWorld.distanceTo(rightShoulderWorld);
              const modelShoulderWidth = modelShoulderWidthRef.value;

              if (projectedShoulderWidth > 0 && modelShoulderWidth > 0) {
                // A picked size renders the garment relative to what the body
                // actually measures (XL roomier, XS tighter). Auto = body fit.
                const sizeAdjust = sizeScaleFactor(
                  pickedSizeRef.current,
                  body.size,
                );
                const targetScale =
                  (projectedShoulderWidth * SHOULDER_EASE * sizeAdjust) /
                  modelShoulderWidth;

                // Length follows the user's own torso proportion, clamped so
                // the mesh can never be stretched into something unnatural.
                let lengthFactor = 1;
                if (body.shoulder !== null && body.shoulder > 0 && body.torso !== null) {
                  lengthFactor = THREE.MathUtils.clamp(
                    body.torso / body.shoulder / BASELINE_TORSO_RATIO,
                    MIN_LENGTH_FACTOR,
                    MAX_LENGTH_FACTOR,
                  );
                }

                targetScaleVec.set(
                  targetScale,
                  targetScale * lengthFactor,
                  targetScale,
                );
                if (scaleSeeded) {
                  shirt.scale.lerp(targetScaleVec, SCALE_SMOOTHING);
                } else {
                  // Snap on the first frame so it does not grow into place.
                  shirt.scale.copy(targetScaleVec);
                  scaleSeeded = true;
                }
              }

              //BODY ROTATION (ROTATE THE ROOJOINT BASED ON SHOULDER ANGLE)
              if (rootJoint) {
                const shoulderAngle = Math.atan2(
                  rightShoulderWorld.y - leftShoulderWorld.y,
                  rightShoulderWorld.x - leftShoulderWorld.x,
                );

                rootJoint.rotation.z = -shoulderAngle;
              }

              //ARM MOVEMENTS
              if (
                rightArm &&
                rightElbowBone &&
                leftArm &&
                leftElbowBone &&
                leftElbow &&
                leftWrist &&
                rightElbow &&
                rightWrist
              ) {
                const upperAngle = Math.atan2(
                  rightElbow.y - rightShoulder.y,
                  -(rightElbow.x - rightShoulder.x),
                );

                const foreAngle = Math.atan2(
                  rightWrist.y - rightElbow.y,
                  -(rightWrist.x - rightElbow.x),
                );

                rightArm.rotation.y = upperAngle;
                rightElbowBone.rotation.y = foreAngle - upperAngle;

                const leftUpperAngle = Math.atan2(
                  leftElbow.y - leftShoulder.y,
                  leftElbow.x - leftShoulder.x,
                );

                const leftForeAngle = Math.atan2(
                  leftWrist.y - leftElbow.y,
                  leftWrist.x - leftElbow.x,
                );

                leftArm.rotation.y = leftUpperAngle;
                leftElbowBone.rotation.y = leftForeAngle - leftUpperAngle;
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
                shirt.position.x += midPoint.x - anchorMid.x;
                shirt.position.y += midPoint.y - anchorMid.y + GARMENT_Y_OFFSET;
                shirt.position.z += midPoint.z - anchorMid.z;
              } else {
                shirt.position.copy(midPoint);
              }
            }

            setStatus("Pose detected");

            ctx.save();
            ctx.globalAlpha = 0.5;

            // drawingUtils.drawLandmarks(landmark, {
            //   radius: (data) =>
            //     DrawingUtils.lerp(data.from!.z, -0.15, 0.1, 5, 1),
            // });

            // drawingUtils.drawConnectors(
            //   landmark,
            //   PoseLandmarker.POSE_CONNECTIONS,
            // );
            // ctx.restore();
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

      // Remove Three.js renderer
      if (
        threeContainerRef.current &&
        threeContainerRef.current.contains(renderer.domElement)
      ) {
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
      </div>

      {/* Tracking status + fit chip */}
      <div className="pointer-events-none absolute left-4 top-4 z-40 flex flex-col items-start gap-2">
        <div className="rounded-full bg-black/70 px-3 py-1 text-sm text-white">
          {statusMessage}
        </div>

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

      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-30 -scale-x-100"
      />
    </div>
  );
}
