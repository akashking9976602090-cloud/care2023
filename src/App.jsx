import { useState, useRef, useEffect } from 'react';
import './App.css';
import referenceImage from './assets/image.jpeg';
import referenceVideo from './assets/video.mp4';

/* ══════════════════════════════════════════════════════════
   STRICT IMAGE MATCHER
   - Fine-grained colour histogram (24 bins per channel)
   - Pixel-level comparison
   - Edge/gradient structure comparison
   - Requires 3 consecutive matches (temporal stability)
   ══════════════════════════════════════════════════════════ */

const BINS = 24; // more bins = more specific matching

/* colour histogram */
const buildHist = (data, len) => {
  const h = new Float32Array(BINS * 3);
  for (let i = 0; i < len; i += 4) {
    h[Math.floor(data[i] * BINS / 256)]++;
    h[BINS + Math.floor(data[i + 1] * BINS / 256)]++;
    h[BINS * 2 + Math.floor(data[i + 2] * BINS / 256)]++;
  }
  // normalise
  const total = len / 4;
  for (let i = 0; i < h.length; i++) h[i] /= total;
  return h;
};

const histSim = (a, b) => {
  // Bhattacharyya coefficient — stricter than cosine
  let bc = 0;
  for (let i = 0; i < a.length; i++) bc += Math.sqrt(a[i] * b[i]);
  return bc;
};

/* pixel-level difference */
const pixelSim = (d1, d2, len) => {
  let diff = 0;
  for (let i = 0; i < len; i += 4) {
    diff += Math.abs(d1[i] - d2[i]);
    diff += Math.abs(d1[i + 1] - d2[i + 1]);
    diff += Math.abs(d1[i + 2] - d2[i + 2]);
  }
  return 1 - diff / ((len / 4) * 3 * 255);
};

/* edge structure — uses Sobel-like gradient magnitude */
const buildEdge = (data, w, h) => {
  const grey = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    grey[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  }
  const edge = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = -grey[(y - 1) * w + x - 1] + grey[(y - 1) * w + x + 1]
               - 2 * grey[y * w + x - 1] + 2 * grey[y * w + x + 1]
               - grey[(y + 1) * w + x - 1] + grey[(y + 1) * w + x + 1];
      const gy = -grey[(y - 1) * w + x - 1] - 2 * grey[(y - 1) * w + x] - grey[(y - 1) * w + x + 1]
               + grey[(y + 1) * w + x - 1] + 2 * grey[(y + 1) * w + x] + grey[(y + 1) * w + x + 1];
      edge[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return edge;
};

const edgeSim = (e1, e2) => {
  let dot = 0, m1 = 0, m2 = 0;
  for (let i = 0; i < e1.length; i++) {
    dot += e1[i] * e2[i];
    m1 += e1[i] * e1[i];
    m2 += e2[i] * e2[i];
  }
  return dot / (Math.sqrt(m1) * Math.sqrt(m2) + 1e-10);
};


function App() {
  const [stage, setStage] = useState('start');
  const [simScore, setSimScore] = useState(0);

  const camRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const refData = useRef(null);
  const refHist = useRef(null);
  const refEdge = useRef(null);
  const streamRef = useRef(null);
  const intervalRef = useRef(null);
  const matchStreak = useRef(0); // consecutive match counter

  const SZ = 100; // larger thumbnail = more accuracy
  const MATCH_THRESHOLD = 0.82; // strict threshold
  const REQUIRED_STREAK = 3;    // must match 3 times in a row

  /* preload reference image */
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = SZ;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, SZ, SZ);
      const d = x.getImageData(0, 0, SZ, SZ).data;
      refData.current = d;
      refHist.current = buildHist(d, d.length);
      refEdge.current = buildEdge(d, SZ, SZ);
    };
    img.src = referenceImage;
    return () => stopEverything();
  }, []);

  const stopEverything = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
  };

  /* ── Start Camera ───── */
  const openCamera = async () => {
    setStage('scanning');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setTimeout(() => {
        const vid = camRef.current;
        if (!vid) return;
        vid.setAttribute('autoplay', '');
        vid.setAttribute('playsinline', '');
        vid.setAttribute('muted', '');
        vid.muted = true;
        vid.srcObject = stream;
        vid.onloadedmetadata = () => {
          vid.play().then(() => startScan()).catch(() => {
            vid.play().then(() => startScan()).catch(e => console.warn(e));
          });
        };
      }, 100);
    } catch (err) {
      alert('Camera access denied. Allow camera and reload.\n' + err.message);
      setStage('start');
    }
  };

  /* ── Scan Loop ───── */
  const startScan = () => {
    matchStreak.current = 0;
    if (intervalRef.current) clearInterval(intervalRef.current);

    intervalRef.current = setInterval(() => {
      const v = camRef.current;
      const c = canvasRef.current;
      if (!v || !c || !refData.current) return;
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return;

      const ctx = c.getContext('2d');
      c.width = c.height = SZ;

      const crop = Math.min(vw, vh) * 0.55;
      const sx = (vw - crop) / 2, sy = (vh - crop) / 2;
      ctx.drawImage(v, sx, sy, crop, crop, 0, 0, SZ, SZ);
      const camData = ctx.getImageData(0, 0, SZ, SZ).data;

      // Three-way comparison
      const hScore = histSim(buildHist(camData, camData.length), refHist.current);
      const pScore = pixelSim(camData, refData.current, camData.length);
      const eScore = edgeSim(buildEdge(camData, SZ, SZ), refEdge.current);

      // Weighted combined — edge gets most weight (structural)
      const combined = hScore * 0.25 + pScore * 0.35 + eScore * 0.40;
      const pct = Math.round(combined * 100);
      setSimScore(pct);

      if (combined >= MATCH_THRESHOLD) {
        matchStreak.current++;
        if (matchStreak.current >= REQUIRED_STREAK) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
          setStage('matched');
          setTimeout(() => {
            if (overlayRef.current) overlayRef.current.play().catch(() => {});
          }, 400);
        }
      } else {
        matchStreak.current = 0;
      }
    }, 500);
  };

  const scanAgain = () => {
    if (overlayRef.current) overlayRef.current.pause();
    setSimScore(0);
    setStage('scanning');
    startScan();
  };

  /* ── RENDER ───── */
  return (
    <div className="app">
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

      {(stage === 'scanning' || stage === 'matched') && (
        <div className="cam-screen">
          <video
            ref={camRef}
            autoPlay playsInline muted
            style={{
              position: 'absolute', top: 0, left: 0,
              width: '100%', height: '100%',
              objectFit: 'cover', zIndex: 1, background: '#000',
            }}
          />
          <canvas ref={canvasRef} style={{ display: 'none' }} />

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

          {stage === 'matched' && (
            <div className="match-overlay">
              <video
                ref={overlayRef}
                src={referenceVideo}
                controls autoPlay playsInline
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
