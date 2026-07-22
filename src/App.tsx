/* eslint-disable @typescript-eslint/no-explicit-any */
import {SetStateAction, useEffect, useRef, useState} from "react";
import WebCam, {WebcamHandle} from "./components/WebCam";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {X} from "lucide-react";
import * as THREE from "three";

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
  const [statusMessage, setStatusMessage] = useState("Starting camera...");

  useEffect(() => {
    let poseLandmarker: PoseLandmarker | null = null;
    let animationFrameId = 0;
    let isMounted = true;

    //model
    let shirt: THREE.Object3D | null = null;
    let leftArm: THREE.Bone;
    let rightArm: THREE.Bone;
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
    renderer.domElement.style.transform = "scaleX(-1)";
    threeContainerRef.current?.appendChild(renderer.domElement);

    renderer.render(scene, camera);

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      renderer.render(scene, camera);

      // const t = clock.getElapsedTime();
      // if (shirt) {
      //   if (leftArm) {
      //     leftArm.rotation.z = Math.sin(t * 12) * 0.5;
      //   }
      //   if (rightArm) {
      //     rightArm.rotation.z = Math.sin(t * 12) * 0.5;
      //   }
      // }
    };

    loader.load(modelUrl, (gltf: {scene: any}) => {
      shirt = gltf.scene;
      shirt.traverse((child: any) => {
        if (child instanceof THREE.Bone) {
          if (child.name === "arm_left_shoulder_2_010") {
            leftArm = child;
          }
          if (child.name === "arm_right_shoulder_2_060") {
            rightArm = child;
          }
        }
      });
      shirt.position.set(0, 266.8, 0);
      shirt.scale.set(1, 1, 1);
      shirt.rotation.set(0, 0, 0);
      scene.add(shirt);
      scene.add(new THREE.AmbientLight(0xffffff, 2));
      const dir = new THREE.DirectionalLight(0xffffff, 2);
      dir.position.set(5, 5, 5);
      scene.add(dir);
    });

    animate();

    const setup = async () => {
      try {
        setStatusMessage("Loading pose model...");
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
        setStatusMessage("Tracking body pose...");
      } catch (error) {
        console.error("Pose setup failed", error);
        setStatusMessage(
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
              setStatusMessage("Allow autoplay to start the pose tracker");
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

          if (!result.landmarks?.length) {
            setStatusMessage("Waiting for pose...");
            return;
          }

          for (const landmark of result.landmarks) {
            const leftShoulder = landmark[11];
            const rightShoulder = landmark[12];

            if (!leftShoulder || !rightShoulder) {
              continue;
            }

            if (shirt) {
              const centerX = (leftShoulder.x + rightShoulder.x) / 2;
              const centerY = (leftShoulder.y + rightShoulder.y) / 2;
              const shoulderWidth = Math.hypot(
                leftShoulder.x - rightShoulder.x,
                leftShoulder.y - rightShoulder.y,
              );

              // landmark indices (MediaPipe Pose)
              const L_SH = 11,
                L_EL = 13,
                L_WR = 15;
              const R_SH = 12,
                R_EL = 14,
                R_WR = 16;

              // helper to map normalized landmark -> THREE world-like coords
              const mapLandmarkToWorld = (lm: {
                x: number;
                y: number;
                z: number;
              }) => {
                const mirrored = true; // set false if webcam not mirrored
                const x = ((mirrored ? 1 - lm.x : lm.x) - 0.5) * 3.5; // same horizontal scale you use for shirt
                const y = -(lm.y - 0.5) * 3.5 + 1.2; // same vertical mapping as shirt
                const z = -lm.z * 4.0; // tune depth scale (z sign may need flip)
                return new THREE.Vector3(x, y, z);
              };

              if (leftArm && rightArm) {
                const lShoulder = mapLandmarkToWorld(landmark[L_SH]);
                const lElbow = mapLandmarkToWorld(landmark[L_EL]);
                const rShoulder = mapLandmarkToWorld(landmark[R_SH]);
                const rElbow = mapLandmarkToWorld(landmark[R_EL]);

                // desired directions in world-like coords
                const lDir = new THREE.Vector3()
                  .subVectors(lElbow, lShoulder)
                  .normalize();
                const rDir = new THREE.Vector3()
                  .subVectors(rElbow, rShoulder)
                  .normalize();

                // convert world-like positions to the bone's parent-local space (important)
                const lParent = leftArm.parent!;
                const rParent = rightArm.parent!;

                const lDirLocal = lDir.clone();
                const rDirLocal = rDir.clone();

                // If you computed positions instead of directions, do:
                // lParent.worldToLocal(lShoulder); lParent.worldToLocal(lElbow); compute dirLocal from those.
                // Here we assume consistent mapping so converting direction by inverse rotation helps:
                lParent
                  .getWorldQuaternion(new THREE.Quaternion())
                  .invert()
                  .multiplyVector3?.(lDirLocal); // fallback explained below

                // safest approach: compute shoulder/elbow in parent-local then subtract:
                const lShoulderWorld = mapLandmarkToWorld(landmark[L_SH]);
                const lElbowWorld = mapLandmarkToWorld(landmark[L_EL]);
                lParent.worldToLocal(lShoulderWorld);
                lParent.worldToLocal(lElbowWorld);
                lDirLocal.copy(lElbowWorld).sub(lShoulderWorld).normalize();

                const rShoulderWorld = mapLandmarkToWorld(landmark[R_SH]);
                const rElbowWorld = mapLandmarkToWorld(landmark[R_EL]);
                rParent.worldToLocal(rShoulderWorld);
                rParent.worldToLocal(rElbowWorld);
                rDirLocal.copy(rElbowWorld).sub(rShoulderWorld).normalize();

                // assume bone's rest direction is +Y (0,1,0). If different, change restAxis
                const restAxis = new THREE.Vector3(0, 1, 0);

                const lQuat = new THREE.Quaternion().setFromUnitVectors(
                  restAxis,
                  lDirLocal,
                );
                const rQuat = new THREE.Quaternion().setFromUnitVectors(
                  restAxis,
                  rDirLocal,
                );

                // smooth the movement
                leftArm.quaternion.slerp(lQuat, 0.6);
                rightArm.quaternion.slerp(rQuat, 0.6);
              }

              shirt.position.set(
                (centerX - 0.5) * 3.5,
                -centerY * 3.5 + 1.2,
                0,
              );
              shirt.scale.setScalar(Math.max(0.8, shoulderWidth * 4.2));
              shirt.rotation.y = (leftShoulder.x - rightShoulder.x) * 0.3;
              shirt.rotation.z = (rightShoulder.y - leftShoulder.y) * 0.2;

              if (leftArm) {
                leftArm.position.x = (leftShoulder.x - rightShoulder.x) * 0.5;
              }
              if (rightArm) {
                rightArm.rotation.z = (rightShoulder.y - leftShoulder.y) * 0.5;
              }
            }

            setStatusMessage("Pose detected");

            ctx.save();
            ctx.globalAlpha = 0.5;

            drawingUtils.drawLandmarks(landmark, {
              radius: (data) =>
                DrawingUtils.lerp(data.from!.z, -0.15, 0.1, 5, 1),
            });

            drawingUtils.drawConnectors(
              landmark,
              PoseLandmarker.POSE_CONNECTIONS,
            );
            ctx.restore();
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
        onClick={() => onClose((prev) => !prev)}
        className="absolute right-4 top-4 z-10 flex size-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
      >
        <X className="size-5" />
      </button>

      <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
        {/* Webcam */}
        <div className="absolute inset-0">
          <WebCam ref={webcamRef} onStatusChange={setStatusMessage} />
        </div>

        {/* Three.js */}
        <div ref={threeContainerRef} className="absolute inset-0" />
      </div>

      <div className="pointer-events-none absolute left-4 top-4 z-40 rounded-full bg-black/70 px-3 py-1 text-sm text-white">
        {statusMessage}
      </div>

      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-30 -scale-x-100"
      />
    </div>
  );
}
