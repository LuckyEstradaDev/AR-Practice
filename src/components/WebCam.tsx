import {forwardRef, useImperativeHandle, useRef} from "react";
import Webcam from "react-webcam";

export type WebcamHandle = {
  video?: HTMLVideoElement;
};

const WebCam = forwardRef<WebcamHandle>((_props, ref) => {
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
        screenshotFormat="image/jpeg"
        className="h-full w-full object-cover"
      />
    </div>
  );
});

export default WebCam;
