/* eslint-disable @typescript-eslint/no-explicit-any */
import {SetStateAction, useEffect, useRef} from "react";
import WebCam, {WebcamHandle} from "./components/WebCam";
import {X} from "lucide-react";

import {
  DrawingUtils,
  FilesetResolver,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

const leftSleeveSrc = new URL("./assets/segment/left-s.png", import.meta.url)
  .href;
const rightSleeveSrc = new URL("./assets/segment/right-s.png", import.meta.url)
  .href;
const torsoImg = new Image();
torsoImg.src = new URL("./assets/segment/torso.png", import.meta.url).href;

const leftElbowToWristImg = new Image();
leftElbowToWristImg.src = new URL(
  "./assets/segment/left-elbow.png",
  import.meta.url,
).href;

const rightElbowToWristImg = new Image();
rightElbowToWristImg.src = new URL(
  "./assets/segment/right-elbow.png",
  import.meta.url,
).href;

export default function App({
  image,
  onClose,
}: {
  image: string | File | undefined;
  onClose: React.Dispatch<SetStateAction<boolean>>;
}) {
  const webcamRef = useRef<WebcamHandle | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const leftSleeveImgRef = useRef<HTMLImageElement>(new Image());
  const rightSleeveImgRef = useRef<HTMLImageElement>(new Image());
  const prevLandmarksRef = useRef<any>(null);
  const SMOOTHING = 0.6;

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
      leftSleeveImg.onload = () => undefined;
      rightSleeveImg.onload = () => undefined;
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

              drawLeftSleeve(ctx, landmark, canvas, leftSleeveImg);
              drawRightSleeve(ctx, landmark, canvas, rightSleeveImg);
              drawTorso(ctx, landmark, canvas, torsoImg);
              drawLeftElbowToWrist(ctx, landmark, canvas, leftElbowToWristImg);
              drawRightElbowToWrist(
                ctx,
                landmark,
                canvas,
                rightElbowToWristImg,
              );
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

  const drawLeftSleeve = (
    ctx: CanvasRenderingContext2D,
    landmark: any,
    canvas: HTMLCanvasElement,
    leftSleeveImg: HTMLImageElement,
  ) => {
    if (!leftSleeveImg.complete || !leftSleeveImg.naturalWidth) return;
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
    const scale = armLength / leftSleeveImg.height;

    // 7. Draw
    ctx.save();
    ctx.translate(shoulderX - 120, shoulderY - 60);
    ctx.rotate(angle + 300);
    ctx.scale(scale + 0.2, scale);
    ctx.drawImage(leftSleeveImg, 0, 0);
    ctx.restore();
  };

  const drawRightSleeve = (
    ctx: CanvasRenderingContext2D,
    landmark: any,
    canvas: HTMLCanvasElement,
    rightSleeveImg: HTMLImageElement,
  ) => {
    if (!rightSleeveImg.complete || !rightSleeveImg.naturalWidth) return;
    const shoulder = landmark[11];
    const elbow = landmark[13];

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
    const scale = armLength / rightSleeveImg.height;

    // 7. Draw
    ctx.save();
    ctx.translate(shoulderX - 60, shoulderY);
    ctx.rotate(angle + 300);
    ctx.scale(scale + 0.2, scale);
    ctx.drawImage(rightSleeveImg, 0, 0);
    ctx.restore();
  };

  const drawTorso = (
    ctx: CanvasRenderingContext2D,
    landmark: any,
    canvas: HTMLCanvasElement,
    torsoImg: HTMLImageElement,
  ) => {
    if (!torsoImg.complete || !torsoImg.naturalWidth) return;
    const leftShoulder = landmark[11];
    const rightShoulder = landmark[12];
    const leftHip = landmark[23];
    const rightHip = landmark[24];

    // Convert to pixels
    const leftShoulderX = leftShoulder.x * canvas.width;
    const leftShoulderY = leftShoulder.y * canvas.height;
    const rightShoulderX = rightShoulder.x * canvas.width;
    const rightShoulderY = rightShoulder.y * canvas.height;
    const leftHipX = leftHip.x * canvas.width;
    const leftHipY = leftHip.y * canvas.height;
    const rightHipX = rightHip.x * canvas.width;
    const rightHipY = rightHip.y * canvas.height;

    // Calculate center and size
    const centerX = (leftShoulderX + rightShoulderX + leftHipX + rightHipX) / 4;
    const centerY = (leftShoulderY + rightShoulderY + leftHipY + rightHipY) / 4;
    const width = Math.hypot(
      rightShoulderX - leftShoulderX,
      rightShoulderY - leftShoulderY,
    );
    const height = Math.hypot(
      leftHipY - leftShoulderY,
      leftHipX - leftShoulderX,
    );

    // Draw torso image
    ctx.save();
    ctx.translate(centerX, centerY - 40);
    ctx.drawImage(torsoImg, -width / 2, -height / 2, width, height);
    ctx.restore();
  };

  const drawLeftElbowToWrist = (
    ctx: CanvasRenderingContext2D,
    landmark: any,
    canvas: HTMLCanvasElement,
    image: HTMLImageElement,
  ) => {
    const elbow = landmark[14];
    const wrist = landmark[16];

    // Convert to pixels
    const elbowX = elbow.x * canvas.width;
    const elbowY = elbow.y * canvas.height;
    const wristX = wrist.x * canvas.width;
    const wristY = wrist.y * canvas.height;

    // Calculate direction
    const dx = wristX - elbowX;
    const dy = wristY - elbowY;

    // Calculate angle
    const angle = Math.atan2(dy, dx);

    // Calculate arm length
    const armLength = Math.sqrt(dx * dx + dy * dy);

    // Calculate scale
    const scale = armLength / image.height;

    // Draw
    ctx.save();
    ctx.translate(elbowX - 50, elbowY);
    ctx.rotate(angle + 300);
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);
    ctx.restore();
  };

  const drawRightElbowToWrist = (
    ctx: CanvasRenderingContext2D,
    landmark: any,
    canvas: HTMLCanvasElement,
    image: HTMLImageElement,
  ) => {
    const elbow = landmark[13];
    const wrist = landmark[15];

    // Convert to pixels
    const elbowX = elbow.x * canvas.width;
    const elbowY = elbow.y * canvas.height;
    const wristX = wrist.x * canvas.width;
    const wristY = wrist.y * canvas.height;

    // Calculate direction
    const dx = wristX - elbowX;
    const dy = wristY - elbowY;

    // Calculate angle
    const angle = Math.atan2(dy, dx);

    // Calculate arm length
    const armLength = Math.sqrt(dx * dx + dy * dy);

    // Calculate scale
    const scale = armLength / image.height;

    // Draw
    ctx.save();
    ctx.translate(elbowX - 50, elbowY);
    ctx.rotate(angle + 300);
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);
    ctx.restore();
  };

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
