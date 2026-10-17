import { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';
import referenceImage from './assets/image.jpeg';
import referenceVideo from './assets/video.mp4';

/* ══════════════════════════════════════════════════════════
   PERCEPTUAL HASH + BLOCK FINGERPRINT IMAGE MATCHER
   Very strict — only triggers on THE specific image.
   ══════════════════════════════════════════════════════════ */

/* Average Hash (aHash): 8x8 grayscale → 64-bit binary hash */
const computeAHash = (imgData, w, h) => {
  // convert to 8x8 grayscale grid
  const grid = new Float32Array(64);
  const cellW = w / 8, cellH = h / 8;
  const data = imgData;

  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      let sum = 0, count = 0;
      const startX = Math.floor(gx * cellW);
      const startY = Math.floor(gy * cellH);
      const endX = Math.floor((gx + 1) * cellW);
      const endY = Math.floor((gy + 1) * cellH);
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const idx = (y * w + x) * 4;
          sum += data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
          count++;
        }
      }
      grid[gy * 8 + gx] = sum / (count || 1);
    }
  }

  // compute mean and binary hash
  let mean = 0;
  for (let i = 0; i < 64; i++) mean += grid[i];
  mean /= 64;
  const hash = new Uint8Array(64);
  for (let i = 0; i < 64; i++) hash[i] = grid[i] >= mean ? 1 : 0;
  return hash;
};

/* Hamming similarity between two hashes (0–1) */
const hashSimilarity = (h1, h2) => {
  let same = 0;
  for (let i = 0; i < 64; i++) if (h1[i] === h2[i]) same++;
  return same / 64;
};

/* Block colour fingerprint: 6x6 grid of avg RGB → 108 values */
const computeBlockFP = (imgData, w, h) => {
  const G = 6;
  const fp = new Float32Array(G * G * 3);
  const cellW = w / G, cellH = h / G;
  const data = imgData;

  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      let r = 0, g = 0, b = 0, count = 0;
      const sx = Math.floor(gx * cellW), sy = Math.floor(gy * cellH);
      const ex = Math.floor((gx + 1) * cellW), ey = Math.floor((gy + 1) * cellH);
      for (let y = sy; y < ey; y++) {
        for (let x = sx; x < ex; x++) {
          const idx = (y * w + x) * 4;
          r += data[idx]; g += data[idx + 1]; b += data[idx + 2];
          count++;
        }
      }
      const base = (gy * G + gx) * 3;
      fp[base] = r / count; fp[base + 1] = g / count; fp[base + 2] = b / count;
    }
  }
  // normalise
  let mag = 0;
  for (let i = 0; i < fp.length; i++) mag += fp[i] * fp[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < fp.length; i++) fp[i] /= mag;
  return fp;
};

const fpSimilarity = (a, b) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // already normalised → cosine sim
};

/* ── Get image data from canvas ── */
const getImageData = (ctx, source, size) => {
  ctx.drawImage(source, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
};


function App() {
  const [stage, setStage] = useState('start');
  const [simScore, setSimScore] = useState(0);
  const [passcode, setPasscode] = useState('');
  const [passcodeError, setPasscodeError] = useState(false);
  const [videoLoading, setVideoLoading] = useState(true);

  const camRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const streamRef = useRef(null);
  const intervalRef = useRef(null);
  const rafRef = useRef(null);

  // Reference fingerprints
  const refHash = useRef(null);
  const refFP = useRef(null);
  const matchStreak = useRef(0);

  const SZ = 120;
  const THRESHOLD = 0.78;
  const STREAK_NEEDED = 4;

  /* ── Precompute reference fingerprints ── */
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = SZ;
      const ctx = c.getContext('2d');
      const data = getImageData(ctx, img, SZ);
      refHash.current = computeAHash(data, SZ, SZ);
      refFP.current = computeBlockFP(data, SZ, SZ);
    };
    img.src = referenceImage;
    return () => stopAll();
  }, []);

  const stopAll = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
  };

  /* ── Open Camera ── */
  const openCamera = async () => {
    setStage('scanning');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setTimeout(() => {
        const v = camRef.current;
        if (!v) return;
        v.setAttribute('autoplay', '');
        v.setAttribute('playsinline', '');
        v.muted = true;
        v.srcObject = stream;
        v.onloadedmetadata = () => {
          v.play().then(() => startScan()).catch(() => {
            v.play().then(() => startScan()).catch(console.warn);
          });
        };
      }, 100);
    } catch (err) {
      alert('Camera denied — allow and reload.\n' + err.message);
      setStage('start');
    }
  };

  /* ── Scan Loop ── */
  const startScan = () => {
    matchStreak.current = 0;
    if (intervalRef.current) clearInterval(intervalRef.current);

    intervalRef.current = setInterval(() => {
      const v = camRef.current;
      const c = canvasRef.current;
      if (!v || !c || !refHash.current) return;
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return;

      const ctx = c.getContext('2d');
      c.width = c.height = SZ;

      // Try 3 crop sizes to handle different distances
      const crops = [0.45, 0.55, 0.65];
      let bestScore = 0;

      for (const cropFrac of crops) {
        const crop = Math.min(vw, vh) * cropFrac;
        const sx = (vw - crop) / 2, sy = (vh - crop) / 2;
        ctx.clearRect(0, 0, SZ, SZ);
        ctx.drawImage(v, sx, sy, crop, crop, 0, 0, SZ, SZ);
        const camData = ctx.getImageData(0, 0, SZ, SZ).data;

        // Check if frame has enough contrast (not blank/dark)
        let minL = 255, maxL = 0;
        for (let i = 0; i < camData.length; i += 16) {
          const l = camData[i] * 0.299 + camData[i + 1] * 0.587 + camData[i + 2] * 0.114;
          if (l < minL) minL = l;
          if (l > maxL) maxL = l;
        }
        if (maxL - minL < 30) continue; // skip low-contrast frames

        const camHash = computeAHash(camData, SZ, SZ);
        const camFP = computeBlockFP(camData, SZ, SZ);

        const hSim = hashSimilarity(camHash, refHash.current);
        const fSim = fpSimilarity(camFP, refFP.current);

        // Combined: hash is primary (very discriminative), FP is secondary
        const combined = hSim * 0.55 + fSim * 0.45;
        if (combined > bestScore) bestScore = combined;
      }

      const pct = Math.min(Math.round(bestScore * 100), 100);
      setSimScore(pct);

      if (bestScore >= THRESHOLD) {
        matchStreak.current++;
        if (matchStreak.current >= STREAK_NEEDED) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
          setStage('matched');
          setTimeout(() => {
            overlayRef.current?.play().catch(() => {});
          }, 300);
        }
      } else {
        matchStreak.current = Math.max(0, matchStreak.current - 1);
      }
    }, 500);
  };

  const scanAgain = () => {
    if (overlayRef.current) { overlayRef.current.pause(); overlayRef.current.currentTime = 0; }
    setSimScore(0);
    setPasscode('');
    setPasscodeError(false);
    setVideoLoading(true);
    setStage('start');
  };

  /* ── Passcode Entry ── */
  const handlePasscode = () => {
    const num = parseInt(passcode, 10);
    const MIN = 810723106001;
    const MAX = 810723106061;
    if (num >= MIN && num <= MAX) {
      setPasscode('');
      setPasscodeError(false);
      stopAll();
      setVideoLoading(true);
      setStage('matched');
      setTimeout(() => {
        overlayRef.current?.play().catch(() => {});
      }, 300);
    } else {
      setPasscodeError(true);
      setTimeout(() => setPasscodeError(false), 1500);
    }
  };

  return (
    <div className="app">

      {/* ─── START SCREEN ─── */}
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

            <div className="divider-row">
              <span className="divider-line" />
              <span className="divider-text">or enter passcode</span>
              <span className="divider-line" />
            </div>

            <div className={`passcode-wrap${passcodeError ? ' shake' : ''}`}>
              <input
                className="passcode-input"
                type="number"
                placeholder="Enter your number (e.g. 810723106003)"
                value={passcode}
                onChange={e => setPasscode(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handlePasscode()}
              />
              <button className="passcode-btn" onClick={handlePasscode}>
                <span>▶</span>
              </button>
            </div>
            {passcodeError && (
              <p className="passcode-error">❌ Invalid number. Try again!</p>
            )}
          </div>
          <footer className="start-footer">🎓 CE College · Batch 2023–2027</footer>
        </div>
      )}

      {/* ─── CAMERA VIEW ─── */}
      {(stage === 'scanning') && (
        <div className="cam-screen">
          {/* Live camera */}
          <video
            ref={camRef}
            autoPlay playsInline muted
            className="cam-feed"
          />
          <canvas ref={canvasRef} style={{ display: 'none' }} />

          {/* SCANNING — frame + bar */}
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
              <p className="sim-pct">{simScore}%</p>
            </div>
          </div>
        </div>
      )}

      {/* ─── FULLSCREEN VIDEO ─── */}
      {stage === 'matched' && (
        <div className="fullscreen-video-wrap">
          {videoLoading && (
            <div className="sweet-loading">
              <div className="sweet-spinner" />
              <p className="sweet-text">Sweet Memories Loading<span className="dots">...</span></p>
            </div>
          )}
          <video
            ref={overlayRef}
            src={referenceVideo}
            autoPlay playsInline
            className="fullscreen-video"
            onCanPlay={() => setVideoLoading(false)}
            style={{ opacity: videoLoading ? 0 : 1 }}
          />
          <button className="close-video-btn" onClick={scanAgain}>✕</button>
        </div>
      )}
    </div>
  );
}

export default App;
