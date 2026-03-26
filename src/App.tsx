import {useEffect, useRef} from "react";
import WebCam, {WebcamHandle} from "./components/WebCam";
import {
  DrawingUtils,
  FilesetResolver,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

function App() {
  useEffect(() => {
    let poseLandmarker: any = undefined;
    let enableWebcamButton: HTMLButtonElement;
    let webcamRunning: Boolean = false;
    const videoHeight = "360px";
    const videoWidth = "480px";
    const createPoseLandmarker = async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm",
      );
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 2,
      });
    };
    createPoseLandmarker();

    /********************************************************************
// Demo 2: Continuously grab image from webcam stream and detect it.
********************************************************************/

    const webcamRef = useRef<WebcamHandle | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const video = webcamRef.current?.video;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");

    const drawingUtils = new DrawingUtils(ctx);

    // Check if webcam access is supported.
    const hasGetUserMedia = () => !!navigator.mediaDevices?.getUserMedia;

    // If webcam supported, add event listener to button for when user
    // wants to activate it.
    if (hasGetUserMedia()) {
      enableWebcamButton = document.getElementById("webcamButton");
      enableWebcamButton.addEventListener("click", enableCam);
    } else {
      console.warn("getUserMedia() is not supported by your browser");
    }

    // Enable the live webcam view and start detection.
    function enableCam(event) {
      if (!poseLandmarker) {
        console.log("Wait! poseLandmaker not loaded yet.");
        return;
      }

      if (webcamRunning === true) {
        webcamRunning = false;
        enableWebcamButton.innerText = "ENABLE PREDICTIONS";
      } else {
        webcamRunning = true;
        enableWebcamButton.innerText = "DISABLE PREDICTIONS";
      }

      // getUsermedia parameters.
      const constraints = {
        video: true,
      };

      // Activate the webcam stream.
      navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        video.srcObject = stream;
        video.addEventListener("loadeddata", predictWebcam);
      });
    }

    let lastVideoTime = -1;
    async function predictWebcam() {
      canvasElement.style.height = videoHeight;
      video.style.height = videoHeight;
      canvasElement.style.width = videoWidth;
      video.style.width = videoWidth;
      // Now let's start detecting the stream.
      if (runningMode === "IMAGE") {
        runningMode = "VIDEO";
        await poseLandmarker.setOptions({runningMode: "VIDEO"});
      }
      let startTimeMs = performance.now();
      if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;
        poseLandmarker.detectForVideo(video, startTimeMs, (result) => {
          canvasCtx.save();
          canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
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
          canvasCtx.restore();
        });
      }

      // Call this function again to keep predicting when the browser is ready.
      if (webcamRunning === true) {
        window.requestAnimationFrame(predictWebcam);
      }
    }
  }, []);
  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 p-6">
      <section className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 p-8 text-slate-100 shadow-2xl">
        <WebCam></WebCam>
      </section>
    </main>
  );
}

export default App;
