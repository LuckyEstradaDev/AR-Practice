import {useEffect, useRef} from "react";
import WebCam, {type WebcamHandle} from "./components/WebCam";

import {
  DrawingUtils,
  FilesetResolver,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

function App() {
  const webcamRef = useRef<WebcamHandle | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let poseLandmarker: PoseLandmarker | null = null;
    let animationFrameId = 0;
    let isMounted = true;

    // 👕 Load shirt image
    const shirtImg = new Image();
    shirtImg.src = "/shirt.png";

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

        // Sync canvas with video
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.style.width = "100%";
        canvas.style.height = "100%";

        const drawingUtils = new DrawingUtils(ctx);

        poseLandmarker.detectForVideo(video, performance.now(), (result) => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          for (const landmark of result.landmarks) {
            const ls = landmark[11];
            const rs = landmark[12];
            const lh = landmark[23];
            const rh = landmark[24];

            if (!ls || !rs || !lh || !rh) continue;

            const toPixel = (p: any) => ({
              x: p.x * canvas.width,
              y: p.y * canvas.height,
            });

            const leftS = toPixel(ls);
            const rightS = toPixel(rs);
            const leftH = toPixel(lh);
            const rightH = toPixel(rh);

            // 🔥 BETTER CENTER (between chest and hips)
            const chestY = (leftS.y + rightS.y) / 2;
            const hipY = (leftH.y + rightH.y) / 2;

            const centerX = (leftS.x + rightS.x) / 2;
            const centerY = (chestY + hipY) / 2;

            // 🔥 SIZE IMPROVEMENTS
            const shoulderWidth = Math.hypot(
              rightS.x - leftS.x,
              rightS.y - leftS.y,
            );

            const torsoHeight =
              (Math.hypot(leftH.y - leftS.y, leftH.x - leftS.x) +
                Math.hypot(rightH.y - rightS.y, rightH.x - rightS.x)) /
              2;

            const width = shoulderWidth * 1.4;
            const height = torsoHeight * 2.2;

            // 🔥 BETTER ROTATION (no upside down)
            let angle = Math.atan2(rightS.y - leftS.y, rightS.x - leftS.x);

            if (angle > Math.PI / 2 || angle < -Math.PI / 2) {
              angle += Math.PI;
            }

            // 👕 DRAW SHIRT
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate(angle);

            ctx.drawImage(
              shirtImg,
              -width / 2,
              -height * 0.35, // 🔥 vertical adjustment
              width,
              height,
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
    <main className="grid min-h-screen place-items-center bg-slate-950 p-6">
      <section className="w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-900 p-4 text-slate-100 shadow-2xl">
        <div className="relative mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-slate-700">
          <WebCam ref={webcamRef} />

          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0"
          />
        </div>
      </section>
    </main>
  );
}

export default App;
