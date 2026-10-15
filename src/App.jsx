import { useState, useRef } from 'react';
import './App.css';
import referenceImage from './assets/image.jpeg';
import referenceVideo from './assets/video.MOV';

// Canvas-based pixel comparison
const compareImages = (uploadedFile, refSrc) => {
  return new Promise((resolve) => {
    const SIZE = 150;
    const c1 = document.createElement('canvas');
    const c2 = document.createElement('canvas');
    c1.width = c2.width = SIZE;
    c1.height = c2.height = SIZE;
    const x1 = c1.getContext('2d');
    const x2 = c2.getContext('2d');

    const img1 = new Image();
    const img2 = new Image();
    img2.crossOrigin = 'anonymous';

    img1.onload = () => {
      x1.drawImage(img1, 0, 0, SIZE, SIZE);
      img2.onload = () => {
        x2.drawImage(img2, 0, 0, SIZE, SIZE);
        const d1 = x1.getImageData(0, 0, SIZE, SIZE).data;
        const d2 = x2.getImageData(0, 0, SIZE, SIZE).data;
        let diff = 0;
        for (let i = 0; i < d1.length; i += 4) {
          diff += Math.abs(d1[i] - d2[i]);
          diff += Math.abs(d1[i + 1] - d2[i + 1]);
          diff += Math.abs(d1[i + 2] - d2[i + 2]);
        }
        const maxDiff = SIZE * SIZE * 3 * 255;
        const similarity = 1 - diff / maxDiff;
        resolve(similarity);
      };
      img2.src = refSrc;
    };
    img1.src = URL.createObjectURL(uploadedFile);
  });
};

function App() {
  const [uploadedImage, setUploadedImage] = useState(null);
  const [uploadedImageName, setUploadedImageName] = useState('');
  const [comparing, setComparing] = useState(false);
  const [matchResult, setMatchResult] = useState(null); // null | 'match' | 'no-match'
  const [similarity, setSimilarity] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const imageInputRef = useRef(null);
  const videoRef = useRef(null);

  const handleImageUpload = async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    setUploadedImage(url);
    setUploadedImageName(file.name);
    setMatchResult(null);
    setSimilarity(0);

    // Compare
    setComparing(true);
    try {
      const sim = await compareImages(file, referenceImage);
      setSimilarity(Math.round(sim * 100));
      if (sim >= 0.80) {
        setMatchResult('match');
        setTimeout(() => videoRef.current?.play(), 300);
      } else {
        setMatchResult('no-match');
      }
    } catch (e) {
      setMatchResult('no-match');
    }
    setComparing(false);
  };

  const handleDragOver = (e) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    handleImageUpload(e.dataTransfer.files[0]);
  };

  const reset = () => {
    setUploadedImage(null);
    setUploadedImageName('');
    setMatchResult(null);
    setSimilarity(0);
    if (videoRef.current) videoRef.current.pause();
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-glow" />
        <div className="header-content">
          <div className="logo">
            <span className="logo-icon">🔐</span>
            <span className="logo-text">FaceVault</span>
          </div>
          <p className="header-subtitle">Upload your image — unlock your video</p>
        </div>
      </header>

      <main className="main">
        <div className="two-col">

          {/* LEFT — Upload */}
          <section className="panel upload-panel">
            <h2 className="panel-title"><span>📤</span> Upload Image</h2>

            <div
              className={`drop-zone ${isDragging ? 'dragging' : ''} ${uploadedImage ? 'has-file' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => !uploadedImage && imageInputRef.current.click()}
            >
              {uploadedImage ? (
                <div className="uploaded-preview">
                  <img src={uploadedImage} alt="Uploaded" className="preview-img" />
                  <button className="remove-btn" onClick={(e) => { e.stopPropagation(); reset(); }}>✕</button>
                </div>
              ) : (
                <div className="drop-content">
                  <div className="drop-icon">🖼️</div>
                  <p className="drop-text">Drag & Drop image here</p>
                  <p className="drop-sub">or click to browse</p>
                  <span className="fmt-badge">PNG • JPG • WEBP • GIF</span>
                </div>
              )}
            </div>

            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden-input"
              onChange={(e) => handleImageUpload(e.target.files[0])}
            />

            {!uploadedImage && (
              <button className="upload-btn" onClick={() => imageInputRef.current.click()}>
                Choose Image <span>🖼️</span>
              </button>
            )}

            {/* Status */}
            {comparing && (
              <div className="status comparing">
                <div className="spinner" />
                <span>Comparing images...</span>
              </div>
            )}

            {!comparing && matchResult === 'match' && (
              <div className="status match">
                <span className="status-icon">✅</span>
                <div>
                  <strong>Image Matched!</strong>
                  <p>{similarity}% similarity — Playing your video 🎬</p>
                </div>
              </div>
            )}

            {!comparing && matchResult === 'no-match' && (
              <div className="status no-match">
                <span className="status-icon">❌</span>
                <div>
                  <strong>No Match</strong>
                  <p>{similarity}% similarity — Try the correct image</p>
                </div>
              </div>
            )}

            {!uploadedImage && !comparing && (
              <div className="hint-box">
                <span>💡</span>
                <p>Upload the reference image to unlock and play the secret video!</p>
              </div>
            )}
          </section>

          {/* RIGHT — Reference + Video */}
          <section className="panel video-panel">
            <h2 className="panel-title"><span>🖼️</span> Reference Image</h2>
            <div className="ref-img-wrap">
              <img src={referenceImage} alt="Reference" className="ref-img" />
              <div className="ref-label">This is the key image</div>
            </div>

            <h2 className="panel-title video-title">
              <span>🎬</span> Secret Video
              {matchResult === 'match' && <span className="unlocked-badge">🔓 UNLOCKED</span>}
              {matchResult !== 'match' && <span className="locked-badge">🔒 LOCKED</span>}
            </h2>

            <div className={`video-wrap ${matchResult === 'match' ? 'video-active' : 'video-locked'}`}>
              {matchResult === 'match' ? (
                <video
                  ref={videoRef}
                  src={referenceVideo}
                  controls
                  autoPlay
                  className="video-player"
                >
                  Your browser does not support video.
                </video>
              ) : (
                <div className="video-placeholder">
                  <div className="lock-icon">🔒</div>
                  <p>Upload the matching image to unlock this video</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="footer">
        <p>🎓 FaceVault — CE College Engineering · Batch 2023–2027</p>
      </footer>
    </div>
  );
}

export default App;
