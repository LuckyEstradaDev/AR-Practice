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

        numPoses: 2,
      });

      const predict = async () => {
        if (!isMounted || !poseLandmarker) return;

        const video = webcamRef.current?.video;

        const canvas = canvasRef.current;

        const ctx = canvas?.getContext("2d");

        if (!video || !canvas || !ctx || video.readyState < 2) {
          animationFrameId = window.requestAnimationFrame(predict);

          return;
        }

        canvas.width = video.videoWidth || 480;

        canvas.height = video.videoHeight || 360;

        canvas.style.width = "100%";

        canvas.style.height = "100%";

        const drawingUtils = new DrawingUtils(ctx);

        poseLandmarker.detectForVideo(video, performance.now(), (result) => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          for (const landmark of result.landmarks) {
            drawingUtils.drawLandmarks(landmark, {
              radius: (data) =>
                DrawingUtils.lerp(data.from!.z, -0.15, 0.1, 5, 1),
            });

            drawingUtils.drawConnectors(
              landmark,

              PoseLandmarker.POSE_CONNECTIONS,
            );
          }
        });

        animationFrameId = window.requestAnimationFrame(predict);
      };

      predict();
    };

    setup();

    return () => {
      isMounted = false;

      window.cancelAnimationFrame(animationFrameId);

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
