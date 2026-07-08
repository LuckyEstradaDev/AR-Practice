/* eslint-disable @typescript-eslint/no-explicit-any */
import {SetStateAction, useEffect, useRef} from "react";
import WebCam, {WebcamHandle} from "./components/WebCam";
import {X} from "lucide-react";
import {
  AmbientLight,
  Box3,
  DirectionalLight,
  Euler,
  Group,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";

const modelUrl = new URL("./assets/3d-files/shirt.glb", import.meta.url).href;

import {FilesetResolver, PoseLandmarker} from "@mediapipe/tasks-vision";

const leftSleeveSrc = new URL("./assets/segment/left-s.png", import.meta.url)
  .href;
const rightSleeveSrc = new URL("./assets/segment/right-s.png", import.meta.url)
  .href;

// ---------------------------------------------------------------------------
// MIRROR_VIDEO: set this to match how <WebCam /> actually displays the feed.
// Most front-camera "selfie view" UIs mirror the video with CSS
// (transform: scaleX(-1)) so it behaves like a mirror, but the raw frames fed
// into MediaPipe are NOT mirrored. If that's the case here, leave this true.
// If your WebCam component does NOT mirror the displayed video, set this to
// false, or the shirt will track as a left/right mirror image of the body.
// ---------------------------------------------------------------------------
const MIRROR_VIDEO = false;

// Depth (in Three.js world units, on the camera's local Z=0 plane through the
// scene origin) at which the shirt model is anchored. This must match the
// plane the model was centered on when its bounding box was normalized
// (see `model.position.sub(center)` below) so that "flat" screen-space
// tracking lines up with the model's own origin.
const ANCHOR_Z = 0;

export default function App({
  image,
  onClose,
}: {
  image: string | File | undefined;
  onClose: React.Dispatch<SetStateAction<boolean>>;
}) {
  const webcamRef = useRef<WebcamHandle | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const threeContainerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const cameraRef = useRef<PerspectiveCamera | null>(null);
  const loadedModelRef = useRef<Group | null>(null);
  const rigBonesRef = useRef<Record<string, any>>({});
  const poseActiveRef = useRef(false);
  const leftSleeveImgRef = useRef<HTMLImageElement>(new Image());
  const rightSleeveImgRef = useRef<HTMLImageElement>(new Image());
  const prevLandmarksRef = useRef<any>(null);
  const SMOOTHING = 0.6;

  // Real-world (Three.js unit) shoulder width of the loaded model, measured
  // once from its rig at load time. This is the ground truth we scale
  // against, instead of an arbitrary pixel-based fudge factor.
  const modelReferenceShoulderWidthRef = useRef<number | null>(null);
  const modelReferenceScaleRef = useRef(1.15);

  const resetRigPose = () => {
    Object.values(rigBonesRef.current).forEach((bone: any) => {
      if (!bone?.userData?.baseQuaternion) return;
      bone.quaternion.copy(bone.userData.baseQuaternion);
      if (bone.userData.basePosition) {
        bone.position.copy(bone.userData.basePosition);
      }
    });
  };

  // Mirrors a normalized [0,1] landmark x-coordinate to match the displayed
  // (possibly mirrored) video, so every downstream calculation — position,
  // scale, and rotation — agrees with what the user actually sees.
  const mirrorNormX = (xNorm: number) => (MIRROR_VIDEO ? 1 - xNorm : xNorm);

  // Projects a normalized landmark point through the *actual* Three.js
  // camera onto the world-space plane z = targetZ. This replaces the old
  // "divide by canvas.width/4" approximation with the real camera math
  // (fov, aspect, position), so the model lands exactly where the body is
  // on screen regardless of camera distance or window size.
  const unprojectToWorld = (
    xNorm: number,
    yNorm: number,
    targetZ: number,
    camera: PerspectiveCamera,
  ) => {
    const ndcX = mirrorNormX(xNorm) * 2 - 1;
    const ndcY = -(yNorm * 2 - 1);

    const nearPoint = new Vector3(ndcX, ndcY, -1).unproject(camera);
    const farPoint = new Vector3(ndcX, ndcY, 1).unproject(camera);
    const direction = farPoint.sub(nearPoint).normalize();

    // Guard against a near-zero direction.z (camera looking edge-on to the
    // anchor plane), which would blow up the division.
    if (Math.abs(direction.z) < 1e-6) return nearPoint;

    const t = (targetZ - nearPoint.z) / direction.z;
    return nearPoint.addScaledVector(direction, t);
  };

  const applyRigPose = (landmark: any, canvas: HTMLCanvasElement) => {
    const bones = rigBonesRef.current;
    const model = loadedModelRef.current;
    const camera = cameraRef.current;
    if (!bones || !model || !camera) return;

    // Pixel-space helper kept for rotation/orientation math, which only
    // cares about relative angles (aspect-consistent), not absolute scale.
    const toPixel = (point: any) => ({
      x: mirrorNormX(point.x) * canvas.width,
      y: point.y * canvas.height,
    });

    const leftShoulderPx = toPixel(landmark[12]);
    const leftElbowPx = toPixel(landmark[14]);
    const leftWristPx = toPixel(landmark[16]);
    const rightShoulderPx = toPixel(landmark[11]);
    const rightElbowPx = toPixel(landmark[13]);
    const rightWristPx = toPixel(landmark[15]);
    const leftHipPx = toPixel(landmark[23]);
    const rightHipPx = toPixel(landmark[24]);

    const applyBoneRotation = (bone: any, x: number, y: number, z: number) => {
      if (!bone) return;
      const baseQuaternion = bone.userData.baseQuaternion?.clone();
      const nextQuaternion = new Quaternion().setFromEuler(
        new Euler(x, y, z, "XYZ"),
      );
      bone.quaternion.copy(baseQuaternion ?? bone.quaternion);
      bone.quaternion.multiply(nextQuaternion);
    };

    const leftArmAngle = Math.atan2(
      leftElbowPx.y - leftShoulderPx.y,
      leftElbowPx.x - leftShoulderPx.x,
    );
    const leftElbowAngle = Math.atan2(
      leftWristPx.y - leftElbowPx.y,
      leftWristPx.x - leftElbowPx.x,
    );
    const leftPitch = Math.max(
      -0.4,
      Math.min(0.4, ((leftShoulderPx.y - leftElbowPx.y) / canvas.height) * 0.6),
    );

    const rightArmAngle = Math.atan2(
      rightElbowPx.y - rightShoulderPx.y,
      rightElbowPx.x - rightShoulderPx.x,
    );
    const rightElbowAngle = Math.atan2(
      rightWristPx.y - rightElbowPx.y,
      rightWristPx.x - rightElbowPx.x,
    );
    const rightPitch = Math.max(
      -0.4,
      Math.min(
        0.4,
        ((rightShoulderPx.y - rightElbowPx.y) / canvas.height) * 0.6,
      ),
    );

    const torsoLean = Math.atan2(
      rightShoulderPx.y - leftShoulderPx.y,
      rightShoulderPx.x - leftShoulderPx.x,
    );
    const torsoPitch =
      ((leftShoulderPx.y + rightShoulderPx.y - leftHipPx.y - rightHipPx.y) /
        canvas.height) *
      0.35;

    // --- Real anchoring: project shoulders/hips into world space on the
    // model's anchor plane, then measure and position using actual world
    // units instead of pixel heuristics. ---
    const leftShoulderWorld = unprojectToWorld(
      landmark[12].x,
      landmark[12].y,
      ANCHOR_Z,
      camera,
    );
    const rightShoulderWorld = unprojectToWorld(
      landmark[11].x,
      landmark[11].y,
      ANCHOR_Z,
      camera,
    );
    const leftHipWorld = unprojectToWorld(
      landmark[23].x,
      landmark[23].y,
      ANCHOR_Z,
      camera,
    );
    const rightHipWorld = unprojectToWorld(
      landmark[24].x,
      landmark[24].y,
      ANCHOR_Z,
      camera,
    );

    const shoulderWidthWorld = leftShoulderWorld.distanceTo(rightShoulderWorld);

    const torsoCenterWorld = new Vector3()
      .add(leftShoulderWorld)
      .add(rightShoulderWorld)
      .add(leftHipWorld)
      .add(rightHipWorld)
      .multiplyScalar(0.25);

    model.position.set(torsoCenterWorld.x, torsoCenterWorld.y, ANCHOR_Z);

    // Scale so the model's real shoulder width (measured from its rig at
    // load time) matches the body's shoulder width at the anchor depth.
    const referenceWidth = modelReferenceShoulderWidthRef.current;
    if (referenceWidth && referenceWidth > 0) {
      const referenceScale = modelReferenceScaleRef.current;
      const targetScale =
        referenceScale * (shoulderWidthWorld / referenceWidth);
      const clampedScale = Math.max(0.3, Math.min(2.5, targetScale));
      model.scale.setScalar(clampedScale);
    }

    applyBoneRotation(
      bones.leftShoulder,
      leftPitch,
      0,
      leftArmAngle - Math.PI / 2,
    );
    applyBoneRotation(
      bones.leftElbow,
      0,
      0,
      leftElbowAngle - Math.PI / 2 + 0.15,
    );
    applyBoneRotation(
      bones.rightShoulder,
      rightPitch,
      0,
      rightArmAngle - Math.PI / 2,
    );
    applyBoneRotation(
      bones.rightElbow,
      0,
      0,
      rightElbowAngle - Math.PI / 2 - 0.15,
    );
    applyBoneRotation(bones.spineLower, torsoPitch * 0.6, 0, torsoLean * 0.3);
    applyBoneRotation(bones.spineMiddleA, torsoPitch * 0.4, 0, torsoLean * 0.2);
    applyBoneRotation(bones.spineUpper, torsoPitch * 0.2, 0, torsoLean * 0.1);
    applyBoneRotation(bones.head, 0, 0, torsoLean * 0.05);
  };

  useEffect(() => {
    if (!threeContainerRef.current) return;

    const container = threeContainerRef.current;
    const renderer = new WebGLRenderer({antialias: true, alpha: true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(
      container.clientWidth || 320,
      container.clientHeight || 320,
    );

    container.innerHTML = "";
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new Scene();
    const camera = new PerspectiveCamera(
      35,
      (container.clientWidth || 320) / (container.clientHeight || 320),
      0.1,
      100,
    );
    camera.position.set(0, 0.1, 3.2);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    cameraRef.current = camera;

    const ambientLight = new AmbientLight(0xffffff, 0.95);
    const directionalLight = new DirectionalLight(0xffffff, 1.1);
    directionalLight.position.set(2, 3, 4);
    scene.add(ambientLight, directionalLight);

    const loader = new GLTFLoader();
    loader.load(
      modelUrl,
      (gltf: {scene: any}) => {
        const model = gltf.scene;
        const baseScale = 1.15;
        model.scale.set(baseScale, baseScale, baseScale);
        modelReferenceScaleRef.current = baseScale;

        const box = new Box3().setFromObject(model);
        const center = box.getCenter(new Vector3());
        model.position.sub(center);

        const normalizeBoneName = (value: string) =>
          value
            .toLowerCase()
            .replace(/_\d+$/g, "")
            .replace(/[^a-z0-9]+/g, " ")
            .trim();

        const findBone = (name: string) => {
          const targetName = normalizeBoneName(name);
          let found: any = null;
          model.traverse((object: any) => {
            if (found || !object.isBone) return;
            if (normalizeBoneName(object.name) === targetName) found = object;
          });
          return found;
        };

        rigBonesRef.current = {
          leftShoulder: findBone("arm left shoulder 1"),
          leftElbow: findBone("arm left elbow"),
          rightShoulder: findBone("arm right shoulder 1"),
          rightElbow: findBone("arm right elbow"),
          spineLower: findBone("spine lower"),
          spineMiddleA: findBone("spine middle a"),
          spineMiddleB: findBone("spine middle b"),
          spineUpper: findBone("spine upper"),
          head: findBone("head neck lower"),
        };

        Object.values(rigBonesRef.current).forEach((bone: any) => {
          if (!bone) return;
          bone.userData.baseQuaternion = bone.quaternion.clone();
          bone.userData.basePosition = bone.position.clone();
        });
        resetRigPose();

        scene.add(model);
        loadedModelRef.current = model;

        // Measure the model's real shoulder width in world units, at the
        // scale/position it's actually rendered at. This becomes the
        // ground truth that live pose tracking scales against, instead of
        // a canvas-pixel-derived guess.
        model.updateMatrixWorld(true);
        const {leftShoulder, rightShoulder} = rigBonesRef.current;
        if (leftShoulder && rightShoulder) {
          const l = new Vector3();
          const r = new Vector3();
          leftShoulder.getWorldPosition(l);
          rightShoulder.getWorldPosition(r);
          modelReferenceShoulderWidthRef.current = l.distanceTo(r);
        } else {
          // Fallback: use the model's overall bounding-box width so scaling
          // still works even if the rig's shoulder bones weren't found.
          const size = box.getSize(new Vector3());
          modelReferenceShoulderWidthRef.current = size.x * baseScale;
        }

        const size = box.getSize(new Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = (camera.fov * Math.PI) / 180;
        const distance = (maxDim / (2 * Math.tan(fov / 2))) * 1.35;
        camera.position.set(0, 0.9, distance);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld(true);
      },
      undefined,
      (error: any) => console.error("Failed to load GLB model", error),
    );

    let frameId = 0;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      if (loadedModelRef.current) {
        if (!poseActiveRef.current) {
          loadedModelRef.current.rotation.y += 0.007;
        } else {
          loadedModelRef.current.rotation.y = 0;
        }
      }
      renderer.render(scene, camera);
    };
    frameId = requestAnimationFrame(animate);

    const handleResize = () => {
      const width = container.clientWidth || 320;
      const height = container.clientHeight || 320;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(frameId);
      renderer.dispose();
      container.innerHTML = "";
    };
  }, []);

  useEffect(() => {
    let poseLandmarker: PoseLandmarker | null = null;
    let animationFrameId = 0;
    let isMounted = true;

    const setup = async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm",
      );

      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "../public/models/pose_landmarker_full.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });

      const leftSleeveImg = leftSleeveImgRef.current;
      const rightSleeveImg = rightSleeveImgRef.current;
      leftSleeveImg.onerror = () =>
        console.error("Failed to load left sleeve image", leftSleeveSrc);
      rightSleeveImg.onerror = () =>
        console.error("Failed to load right sleeve image", rightSleeveSrc);
      leftSleeveImg.src = leftSleeveSrc;
      rightSleeveImg.src = rightSleeveSrc;

      await Promise.all([
        new Promise<void>((resolve, reject) => {
          leftSleeveImg.onload = () => resolve();
          leftSleeveImg.onerror = () =>
            reject(new Error("Failed to load left sleeve image"));
        }),
        new Promise<void>((resolve, reject) => {
          rightSleeveImg.onload = () => resolve();
          rightSleeveImg.onerror = () =>
            reject(new Error("Failed to load right sleeve image"));
        }),
      ]);

      const predict = async () => {
        if (!isMounted || !poseLandmarker) return;

        const video = webcamRef.current?.video;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        const renderer = rendererRef.current;
        const camera = cameraRef.current;

        if (!video || !canvas || !ctx || video.readyState < 2) {
          animationFrameId = requestAnimationFrame(predict);
          return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.style.width = "100%";
        canvas.style.height = "100%";

        if (renderer && camera) {
          renderer.setSize(canvas.width, canvas.height);
          camera.aspect = canvas.width / canvas.height;
          camera.updateProjectionMatrix();
        }

        poseLandmarker.detectForVideo(
          video,
          performance.now(),
          (result: {landmarks: any}) => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            for (let i = 0; i < result.landmarks.length; i++) {
              const landmark = result.landmarks[i];

              if (!prevLandmarksRef.current)
                prevLandmarksRef.current = landmark;
              const prev = prevLandmarksRef.current;

              for (let j = 0; j < landmark.length; j++) {
                landmark[j].x =
                  landmark[j].x * SMOOTHING + prev[j].x * (1 - SMOOTHING);
                landmark[j].y =
                  landmark[j].y * SMOOTHING + prev[j].y * (1 - SMOOTHING);
              }
              prevLandmarksRef.current = landmark;

              const ls = landmark[11];
              const rs = landmark[12];
              const lh = landmark[23];
              const rh = landmark[24];

              if (!ls || !rs || !lh || !rh) {
                poseActiveRef.current = false;
                resetRigPose();
                continue;
              }

              poseActiveRef.current = true;
              applyRigPose(landmark, canvas);
            }
          },
        );

        animationFrameId = requestAnimationFrame(predict);
      };

      predict();
    };

    setup();

    return () => {
      isMounted = false;
      cancelAnimationFrame(animationFrameId);
      poseLandmarker?.close();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      {/* Close button */}
      <button
        onClick={() => onClose((prev) => !prev)}
        className="absolute right-4 top-4 z-10 flex size-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
      >
        <X className="size-5" />
      </button>

      <WebCam ref={webcamRef} />

      <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
        <div ref={threeContainerRef} className="h-full w-full" />
      </div>

      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-10"
      />
    </div>
  );
}
