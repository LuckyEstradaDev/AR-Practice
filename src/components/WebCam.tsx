import {forwardRef, useImperativeHandle, useRef} from "react";
import Webcam from "react-webcam";

export type WebcamHandle = {
  video?: HTMLVideoElement;
};

type WebCamProps = {
  onStatusChange?: (message: string) => void;
};

const WebCam = forwardRef<WebcamHandle, WebCamProps>((props, ref) => {
  const {onStatusChange} = props;
  const webcamRef = useRef<Webcam>(null);

  useImperativeHandle(ref, () => ({
    get video() {
      return webcamRef.current?.video;
    },
  }));

  return (
    <div className="aspect-video w-[40%] bg-black">
      <Webcam
        mirrored={true}
        ref={webcamRef}
        audio={false}
        screenshotFormat="image/jpeg"
        videoConstraints={{facingMode: "user", width: 640, height: 480}}
        onUserMedia={() => onStatusChange?.("Camera ready")}
        onUserMediaError={() => onStatusChange?.("Camera access denied")}
        className="h-full w-full object-cover"
      />
    </div>
  );
});

export default WebCam;
