import { useEffect, useRef, useState } from "react";
import { analyzePage } from "../omr/geometry.ts";

type Look = "starting" | "none" | "far" | "good" | "denied";

/**
 * Full-screen camera with a page frame. Twice a second Fermata's page reader looks at the
 * live view: the frame's corners light up when it can see staves, with a hint if not.
 */
export function Camera({ onCapture, onLibrary, onClose }: { onCapture: (photo: File) => void; onLibrary: () => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [look, setLook] = useState<Look>("starting");
  const [flash, setFlash] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // 4:3 is the whole sensor; asking for 16:9 makes phones crop (it looks zoomed in).
          video: { facingMode: { ideal: "environment" }, width: { ideal: 4032 }, height: { ideal: 3024 }, aspectRatio: { ideal: 4 / 3 } },
          audio: false,
        });
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        const v = video.current!;
        v.srcObject = stream;
        await v.play().catch(() => undefined);
        setLook("none");
      } catch {
        if (alive) setLook("denied");
      }
    })();
    return () => {
      alive = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Live check: a small frame through the page reader.
  useEffect(() => {
    if (look === "starting" || look === "denied") return;
    const canvas = document.createElement("canvas");
    const id = setInterval(() => {
      const v = video.current;
      if (!v || !v.videoWidth) return;
      const scale = Math.min(1, 1100 / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * scale);
      const h = Math.round(v.videoHeight * scale);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
      const g = analyzePage(gray, w, h);
      const staves = g.systems.reduce((n, s) => n + s.staves.length, 0);
      // Staff spacing under ~6 px at this size means the music is too small to read well.
      setLook(staves === 0 ? "none" : g.space < 6 ? "far" : "good");
    }, 550);
    return () => clearInterval(id);
  }, [look === "starting" || look === "denied"]); // eslint-disable-line react-hooks/exhaustive-deps

  const shoot = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setFlash(true);
    navigator.vibrate?.(12);
    setTimeout(() => setFlash(false), 260);
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    if (blob) onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }));
  };

  const hint =
    look === "starting"
      ? "Starting the camera…"
      : look === "denied"
        ? "Camera access is off. Allow it in Settings, or pick a photo instead."
        : look === "none"
          ? "Point at a page of music"
          : look === "far"
            ? "Move a little closer"
            : "Looks good · hold steady";

  return (
    <div className={`camera ${look === "good" ? "is-good" : ""}`}>
      <video ref={video} playsInline muted autoPlay />
      <div className="camera-shade" aria-hidden />
      <svg className="camera-frame" viewBox="0 0 100 141" preserveAspectRatio="xMidYMid meet" aria-hidden>
        {/* Four rounded corner brackets around a page-shaped window. */}
        <path d="M2 18 V10 Q2 2 10 2 H18" />
        <path d="M82 2 H90 Q98 2 98 10 V18" />
        <path d="M98 123 V131 Q98 139 90 139 H82" />
        <path d="M18 139 H10 Q2 139 2 131 V123" />
      </svg>
      <header className="camera-top">
        <button className="round-btn glass" onClick={onClose} aria-label="Close camera">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <span className="camera-title">Snap a page</span>
        <span className="top-spacer" />
      </header>
      <p className="camera-hint" aria-live="polite">
        {hint}
      </p>
      <footer className="camera-bar">
        <button className="round-btn glass" onClick={onLibrary} aria-label="Choose from your photos or files">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
            <rect x="3.5" y="5" width="17" height="14" rx="3" />
            <path d="M3.5 15l4.5-4 4 3.5 3-2.5 5.5 4.5" />
            <circle cx="15.5" cy="9.5" r="1.4" />
          </svg>
        </button>
        <button className="shutter" onClick={() => void shoot()} disabled={look === "starting" || look === "denied"} aria-label="Take photo">
          <i aria-hidden />
        </button>
        <span className="round-btn ghost" aria-hidden />
      </footer>
      {flash ? <div className="camera-flash" aria-hidden /> : null}
    </div>
  );
}
