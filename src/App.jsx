import { useState, useRef, useEffect } from 'react';
import './App.css';
import referenceImage from './assets/image.jpeg';
import referenceVideo from './assets/video.MOV';

/* ── colour-histogram matcher ─────────────────────────── */
const buildHist = (data, len) => {
  const B = 12;
  const h = new Float32Array(B * 3);
  for (let i = 0; i < len; i += 4) {
    h[Math.floor(data[i] / (256 / B))]++;
    h[B + Math.floor(data[i + 1] / (256 / B))]++;
    h[B * 2 + Math.floor(data[i + 2] / (256 / B))]++;
  }
  return h;
};

const histSim = (a, b) => {
  let dot = 0, m1 = 0, m2 = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    m1 += a[i] * a[i];
    m2 += b[i] * b[i];
  }
  return dot / (Math.sqrt(m1) * Math.sqrt(m2) + 1e-10);
};

/* ── pixel-level similarity ───────────────────────────── */
const pixelSim = (d1, d2, len) => {
  let diff = 0;
  for (let i = 0; i < len; i += 4) {
    diff += Math.abs(d1[i] - d2[i]);
    diff += Math.abs(d1[i + 1] - d2[i + 1]);
    diff += Math.abs(d1[i + 2] - d2[i + 2]);
  }
  return 1 - diff / ((len / 4) * 3 * 255);
};

function App() {
  const [stage, setStage] = useState('start'); // start | scanning | matched
  const [simScore, setSimScore] = useState(0);

  const camRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const refImg = useRef(null);
  const refData = useRef(null);
  const refHist = useRef(null);
  const streamRef = useRef(null);
  const intervalRef = useRef(null);

  const SZ = 80; // compare thumbnail size

  /* preload reference image data */
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      refImg.current = img;
      const c = document.createElement('canvas');
      c.width = c.height = SZ;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, SZ, SZ);
      const d = x.getImageData(0, 0, SZ, SZ).data;
      refData.current = d;
      refHist.current = buildHist(d, d.length);
    };
    img.src = referenceImage;
    return () => {
      stopEverything();
    };
  }, []);

  const stopEverything = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
  };

  /* ── Start Camera ─────────────────────────────────────── */
  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (camRef.current) {
        camRef.current.srcObject = stream;
        await camRef.current.play();
      }
      setStage('scanning');
      startScan();
    } catch {
      alert('Camera access denied — please allow camera permission and reload.');
    }
  };

  /* ── Scan Loop ────────────────────────────────────────── */
  const startScan = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    intervalRef.current = setInterval(() => {
      if (!camRef.current || !canvasRef.current || !refData.current) return;

      const v = camRef.current;
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return;

      const c = canvasRef.current;
      const ctx = c.getContext('2d');
      c.width = c.height = SZ;

      // centre crop of camera
      const crop = Math.min(vw, vh) * 0.55;
      const sx = (vw - crop) / 2, sy = (vh - crop) / 2;
      ctx.drawImage(v, sx, sy, crop, crop, 0, 0, SZ, SZ);
      const camData = ctx.getImageData(0, 0, SZ, SZ).data;

      const hScore = histSim(buildHist(camData, camData.length), refHist.current);
      const pScore = pixelSim(camData, refData.current, camData.length);
      const combined = hScore * 0.55 + pScore * 0.45;

      setSimScore(Math.round(combined * 100));

      if (combined >= 0.72) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        setStage('matched');
        setTimeout(() => {
          if (overlayRef.current) {
            overlayRef.current.play().catch(() => {});
          }
        }, 400);
      }
    }, 400);
  };

  const scanAgain = () => {
    if (overlayRef.current) overlayRef.current.pause();
    setSimScore(0);
    setStage('scanning');
    startScan();
  };

  /* ── RENDER ───────────────────────────────────────────── */
  return (
    <div className="app">

      {/* ─── START SCREEN ─────────────────────────────── */}
      {stage === 'start' && (
        <div className="start-screen">
          <div className="glow glow-1" />
          <div className="glow glow-2" />
          <div className="start-body">
            <div className="start-icon">📷</div>
            <h1 className="start-title">FaceVault</h1>
            <p className="start-sub">Point your camera at the printed image to unlock a secret video</p>
            <button className="cam-btn" onClick={openCamera}>
              <span className="cam-btn-icon">🔓</span>
              Open Camera
            </button>
          </div>
          <footer className="start-footer">🎓 CE College · Batch 2023–2027</footer>
        </div>
      )}

      {/* ─── CAMERA + OVERLAYS ────────────────────────── */}
      {stage !== 'start' && (
        <div className="cam-screen">
          {/* live camera feed */}
          <video ref={camRef} autoPlay playsInline muted className="cam-feed" />
          {/* hidden processing canvas */}
          <canvas ref={canvasRef} className="hide" />

          {/* scanning overlay */}
          {stage === 'scanning' && (
            <div className="scan-overlay">
              <div className="scan-frame">
                <span className="corner c-tl" />
                <span className="corner c-tr" />
                <span className="corner c-bl" />
                <span className="corner c-br" />
                <div className="scan-line" />
              </div>
              <div className="scan-info">
                <p className="scan-label">🔍 Scanning…</p>
                <p className="scan-hint">Hold the printed photo inside the frame</p>
                <div className="sim-bar-wrap">
                  <div className="sim-bar" style={{ width: `${simScore}%` }} />
                </div>
                <p className="sim-pct">{simScore}% match</p>
              </div>
            </div>
          )}

          {/* matched — video overlay */}
          {stage === 'matched' && (
            <div className="match-overlay">
              <video
                ref={overlayRef}
                src={referenceVideo}
                controls
                autoPlay
                playsInline
                className="overlay-video"
              />
              <div className="match-bar">
                <span className="match-badge">✅ Image Matched!</span>
                <button className="again-btn" onClick={scanAgain}>🔄 Scan Again</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
