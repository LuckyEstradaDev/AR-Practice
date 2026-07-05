/* eslint-disable @typescript-eslint/no-explicit-any */
import {SetStateAction, useEffect, useRef} from "react";
import WebCam, {WebcamHandle} from "./components/WebCam";
import {X} from "lucide-react";

const sleeveImagePath = "./assets/sleeve.png";

import {
  DrawingUtils,
  FilesetResolver,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

export function AR({
  image,
  onClose,
}: {
  image: string | File | undefined;
  onClose: React.Dispatch<SetStateAction<boolean>>;
}) {
  const webcamRef = useRef<WebcamHandle | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevLandmarksRef = useRef<any>(null);
  const SMOOTHING = 0.3;

  useEffect(() => {
    let poseLandmarker: PoseLandmarker | null = null;
    let animationFrameId = 0;
    let isMounted = true;

    const shirtImg = new Image();
    shirtImg.src = image!.toString();
    const SleeveImg = new Image();

    const setup = async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm",
      );

      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
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

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.style.width = "100%";
        canvas.style.height = "100%";

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

              if (!ls || !rs || !lh || !rh) continue;

              const toPixel = (p: any) => ({
                x: p.x * canvas.width,
                y: p.y * canvas.height,
              });

              // const leftS = toPixel(ls);

              // const rightS = toPixel(rs);
              // const leftH = toPixel(lh);
              // const rightH = toPixel(rh);

              // const chestY = (leftS.y + rightS.y) / 2;
              // const hipY = (leftH.y + rightH.y) / 2;

              // const centerX = (leftS.x + rightS.x) / 2;
              // const centerY = (chestY + hipY) / 2;

              // const shoulderWidth = Math.hypot(
              //   rightS.x - leftS.x,
              //   rightS.y - leftS.y,
              // );

              // const torsoHeight =
              //   (Math.hypot(leftH.y - leftS.y, leftH.x - leftS.x) +
              //     Math.hypot(rightH.y - rightS.y, rightH.x - rightS.x)) /
              //   2;

              // const width = shoulderWidth * 0.2;
              // const height = torsoHeight * 0.2;
              // let angle = Math.atan2(rightS.y - leftS.y, rightS.x - leftS.x);
              // if (angle > Math.PI / 2 || angle < -Math.PI / 2) {
              //   angle += Math.PI;
              // }

              // ctx.save();
              // ctx.translate(centerX, centerY);
              // ctx.rotate(angle);
              // ctx.drawImage(
              //   shirtImg,
              //   -width / 2,
              //   -height * 0.27,
              //   width,
              //   height,
              // );

              //left shoulder to left elbow
              //the cam is inverted so the left shoulder is actually the right shoulder
              // 1. Get landmarks
              const shoulder = landmark[12];
              const elbow = landmark[14];

              // 2. Convert to pixels
              const shoulderX = shoulder.x * canvas.width;
              const shoulderY = shoulder.y * canvas.height;
              const elbowX = elbow.x * canvas.width;
              const elbowY = elbow.y * canvas.height;

              // 3. Calculate direction
              const dx = elbowX - shoulderX;
              const dy = elbowY - shoulderY;

              // 4. Calculate angle
              const angle = Math.atan2(dy, dx);

              // 5. Calculate arm length
              const armLength = Math.sqrt(dx * dx + dy * dy);

              // 6. Calculate scale
              const scale = armLength / SleeveImg.height;

              // 7. Draw
              ctx.save();
              ctx.translate(shoulderX - 60, shoulderY);
              ctx.rotate(angle + 300);
              ctx.scale(scale + 0.2, scale);
              ctx.drawImage(SleeveImg, 0, 0);
              ctx.restore();

              const drawingUtils = new DrawingUtils(ctx);
              drawingUtils.drawLandmarks(landmark, {radius: 5, color: "red"});
              drawingUtils.drawConnectors(
                landmark,
                PoseLandmarker.POSE_CONNECTIONS,
                {
                  color: "green",
                },
              );
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

      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0"
      />
    </div>
  );
}
