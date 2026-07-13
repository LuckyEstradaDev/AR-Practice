/* eslint-disable @typescript-eslint/no-explicit-any */
import {SetStateAction, useEffect, useRef} from "react";
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
  const drawingUtils = new DrawingUtils(
    canvasRef.current?.getContext("2d") as CanvasRenderingContext2D,
  );

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

    camera.position.set(0, 1.5, 5);
    camera.lookAt(0, 1, 0);
    const renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
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
        console.log(child.name);
        if (child instanceof THREE.Bone) {
          if (child.name === "arm_left_shoulder_2_010") {
            leftArm = child;
          }
          if (child.name === "arm_right_shoulder_2_060") {
            rightArm = child;
          }
        }
      });
      scene.add(shirt);
      scene.add(new THREE.AmbientLight(0xffffff, 2));
      const dir = new THREE.DirectionalLight(0xffffff, 2);
      dir.position.set(5, 5, 5);
      scene.add(dir);
      animate();
    });

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
      const predict = async () => {
        if (!isMounted || !poseLandmarker) return;

        const video = webcamRef.current?.video;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");

        if (!video || !canvas || !ctx || video.readyState < 2) {
          animationFrameId = requestAnimationFrame(predict);
          return;
        }

        // Sync canvas with video
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.style.width = "100%";
        canvas.style.height = "100%";

        const drawingUtils = new DrawingUtils(ctx);

        poseLandmarker.detectForVideo(video, performance.now(), (result) => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          for (const landmark of result.landmarks) {
            const leftShoulder = landmark[11];
            const rightShoulder = landmark[12];

            if (leftShoulder && rightShoulder) {
              const leftX = leftShoulder.x * canvas.width;
              const leftY = leftShoulder.y * canvas.height;
              const rightX = rightShoulder.x * canvas.width;
              const rightY = rightShoulder.y * canvas.height;

              if (shirt) {
                shirt.position.set(
                  (leftX + rightX) / 2 / canvas.width - 0.5,
                  (leftY + rightY) / 2 / canvas.height - 0.5,
                  0,
                );
                shirt.scale.set(
                  Math.abs(rightX - leftX) / canvas.width,
                  Math.abs(rightY - leftY) / canvas.height,
                  1,
                );
              }

              leftArm.rotation.z = Math.atan2(leftY - rightY, leftX - rightX);
              rightArm.rotation.z = Math.atan2(rightY - leftY, rightX - leftX);
            }

            drawingUtils.drawLandmarks(landmark, {
              radius: (data) =>
                DrawingUtils.lerp(data.from!.z, -0.15, 0.1, 5, 1),
            });

            drawingUtils.drawConnectors(
              landmark,
              PoseLandmarker.POSE_CONNECTIONS,
            );
            ctx.restore();

            // OPTIONAL: skeleton
            drawingUtils.drawLandmarks(landmark);
            drawingUtils.drawConnectors(
              landmark,
              PoseLandmarker.POSE_CONNECTIONS,
            );
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

      <div className="pointer-events-none flex absolute inset-0 z-20 overflow-hidden">
        <WebCam ref={webcamRef} />
        <div ref={threeContainerRef} className="h-full w-[80%]" />
      </div>

      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-30"
      />
    </div>
  );
}
