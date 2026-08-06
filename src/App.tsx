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
    let rightArm: THREE.Bone | null = null; //inverted
    let leftArm: THREE.Bone | null = null;
    let rightElbowBone: THREE.Bone | null = null;
    let leftElbowBone: THREE.Bone | null = null;
    let rootJoint: THREE.Bone | null = null;
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
          }

          if (child.name === "upperarm_r_0148") {
            leftArm = child;
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

          if (
            !result.landmarks?.length ||
            result.worldLandmarks?.length === 0
          ) {
            setStatusMessage("Waiting for pose...");
            return;
          }

          for (const landmark of result.landmarks) {
            const world = result.worldLandmarks[0];

            const leftShoulderWorldMP = world[11];
            const rightShoulderWorldMP = world[12];

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
                1.5,
              );

              const rightShoulderWorld = landmarkToWorld(
                rightShoulder,
                camera,
                1.5,
              );

              const midPoint = new THREE.Vector3()
                .addVectors(leftShoulderWorld, rightShoulderWorld)
                .multiplyScalar(0.5);

              shirt.position.copy(midPoint);
              shirt.position.y -= 2.9; // Adjust the vertical position of the shirt

              //adjust shrt size based on distance between shoulders
              const shoulderDistance = Math.sqrt(
                Math.pow(leftShoulderWorldMP.x - rightShoulderWorldMP.x, 2) +
                  Math.pow(leftShoulderWorldMP.y - rightShoulderWorldMP.y, 2) +
                  Math.pow(leftShoulderWorldMP.z - rightShoulderWorldMP.z, 2),
              );

              const targetScale = shoulderDistance * 6.1;
              rootJoint!.scale.x = 1.2;

              shirt.scale.lerp(
                new THREE.Vector3(targetScale, targetScale, targetScale),
                0.15,
              );

              //BODY ROTATION (ROTATE THE ROOJOINT BASED ON SHOULDER ANGLE)
              if (rootJoint) {
                const shoulderAngle = Math.atan2(
                  rightShoulderWorld.y - leftShoulderWorld.y,
                  rightShoulderWorld.x - leftShoulderWorld.x,
                );

                rootJoint.rotation.z = -shoulderAngle;
              }

              //ARM MOVEMENTS

              const upperAngle = Math.atan2(
                rightElbow.y - rightShoulder.y,
                -(rightElbow.x - rightShoulder.x),
              );

              const foreAngle = Math.atan2(
                rightWrist.y - rightElbow.y,
                -(rightWrist.x - rightElbow.x),
              );

              rightArm!.rotation.y = upperAngle;
              rightElbowBone!.rotation.y = foreAngle - upperAngle;

              const leftUpperAngle = Math.atan2(
                leftElbow.y - leftShoulder.y,
                leftElbow.x - leftShoulder.x,
              );

              const leftForeAngle = Math.atan2(
                leftWrist.y - leftElbow.y,
                leftWrist.x - leftElbow.x,
              );

              leftArm!.rotation.y = leftUpperAngle;
              leftElbowBone!.rotation.y = leftForeAngle - leftUpperAngle;

              //ARM MOVEMENTS
            }

            setStatusMessage("Pose detected");

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
