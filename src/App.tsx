import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { Check, Download, ImageUp, LoaderCircle, RotateCcw, Sparkles, Upload, WandSparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

type BeautySettings = { smoothing: number; brightness: number; vLine: number; lipstick: number; lipColor: string; photoFilter: string }
type FacePoint = { x: number; y: number }
type TrackedImage = HTMLImageElement & { face?: FacePoint[] }

const DEFAULT_SETTINGS: BeautySettings = { smoothing: 32, brightness: 12, vLine: 9, lipstick: 28, lipColor: '#bc4967', photoFilter: 'original' }
const PRESETS = [
  { name: 'Tự nhiên', settings: { smoothing: 22, brightness: 8, vLine: 4, lipstick: 18, lipColor: '#b76b78', photoFilter: 'original' } },
  { name: 'Glow nhẹ', settings: { smoothing: 38, brightness: 16, vLine: 8, lipstick: 32, lipColor: '#c34b6c', photoFilter: 'warm' } },
  { name: 'V-line', settings: { smoothing: 28, brightness: 10, vLine: 18, lipstick: 25, lipColor: '#aa3f61', photoFilter: 'vintage' } },
]
const FILTERS = [
  { id: 'original', label: 'Gốc', css: 'none' }, { id: 'bw', label: 'Đen trắng', css: 'grayscale(1) contrast(1.08)' }, { id: 'sepia', label: 'Sepia', css: 'sepia(.72) contrast(1.03)' }, { id: 'warm', label: 'Ấm', css: 'sepia(.18) saturate(1.14) brightness(1.03)' },
  { id: 'cool', label: 'Lạnh', css: 'saturate(.88) hue-rotate(8deg) brightness(1.04)' }, { id: 'vintage', label: 'Vintage', css: 'sepia(.34) saturate(.8) contrast(1.08) brightness(.96)' }, { id: 'bright', label: 'Sáng', css: 'brightness(1.12) contrast(1.04) saturate(1.06)' }, { id: 'noir', label: 'Noir', css: 'grayscale(1) contrast(1.32) brightness(.92)' },
]

function getFaceBounds(points: FacePoint[]) {
  const xs = points.map((point) => point.x); const ys = points.map((point) => point.y)
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}

const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
const LEFT_EYE = [33, 160, 158, 133, 153, 144]
const RIGHT_EYE = [263, 387, 385, 362, 380, 373]
const LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]
const INNER_LIPS = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 42, 183]

function traceLandmarkPath(context: CanvasRenderingContext2D, points: FacePoint[], indices: number[], width: number, height: number) {
  const first = points[indices[0]]
  if (!first) return
  context.moveTo(first.x * width, first.y * height)
  for (const index of indices.slice(1)) { const point = points[index]; if (point) context.lineTo(point.x * width, point.y * height) }
  context.closePath()
}

function clipSkinMask(context: CanvasRenderingContext2D, points: FacePoint[], width: number, height: number) {
  context.beginPath(); traceLandmarkPath(context, points, FACE_OVAL, width, height); traceLandmarkPath(context, points, LEFT_EYE, width, height); traceLandmarkPath(context, points, RIGHT_EYE, width, height); traceLandmarkPath(context, points, LIPS, width, height); context.clip('evenodd')
}

function paintLipColor(context: CanvasRenderingContext2D, points: FacePoint[], width: number, height: number, color: string, intensity: number) {
  context.save(); context.beginPath(); traceLandmarkPath(context, points, LIPS, width, height); traceLandmarkPath(context, points, INNER_LIPS, width, height); context.clip('evenodd')
  context.globalCompositeOperation = 'multiply'; context.globalAlpha = Math.min(intensity / 100, .68); context.fillStyle = color; context.fillRect(0, 0, width, height); context.restore()
}

let vLineGpu: { canvas: HTMLCanvasElement; gl: WebGLRenderingContext; program: WebGLProgram; texture: WebGLTexture; position: WebGLBuffer } | null = null

function applyVLineWarp(context: CanvasRenderingContext2D, centerX: number, centerY: number, faceWidth: number, faceHeight: number, amount: number) {
  try {
    if (!vLineGpu) {
      const canvas = document.createElement('canvas'); const gl = canvas.getContext('webgl', { premultipliedAlpha: false })
      if (!gl) return
      const vertex = gl.createShader(gl.VERTEX_SHADER)!; gl.shaderSource(vertex, 'attribute vec2 a; varying vec2 uv; void main(){ uv=(a+1.0)*.5; gl_Position=vec4(a,0.,1.); }'); gl.compileShader(vertex)
      const fragment = gl.createShader(gl.FRAGMENT_SHADER)!; gl.shaderSource(fragment, `precision highp float; varying vec2 uv; uniform sampler2D image; uniform vec2 center; uniform vec2 halfSize; uniform float strength;
        void main(){ vec2 p=(uv-center)/halfSize; float ax=abs(p.x); float down=smoothstep(.04,.93,-p.y); float inner=smoothstep(.10,.82,ax); float outer=1.0-smoothstep(.83,1.42,ax); float displacement=strength*down*inner*outer; vec2 source=uv; source.x+=sign(p.x)*displacement*halfSize.x; gl_FragColor=texture2D(image,source); }`); gl.compileShader(fragment)
      const program = gl.createProgram()!; gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program)
      const texture = gl.createTexture()!; const position = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, position); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW)
      vLineGpu = { canvas, gl, program, texture, position }
    }
    const { canvas, gl, program, texture, position } = vLineGpu
    const copy = document.createElement('canvas'); copy.width = context.canvas.width; copy.height = context.canvas.height; copy.getContext('2d')!.drawImage(context.canvas, 0, 0)
    canvas.width = copy.width; canvas.height = copy.height; gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, position); const location = gl.getAttribLocation(program, 'a'); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, copy)
    gl.uniform1i(gl.getUniformLocation(program, 'image'), 0); gl.uniform2f(gl.getUniformLocation(program, 'center'), centerX / canvas.width, 1 - centerY / canvas.height); gl.uniform2f(gl.getUniformLocation(program, 'halfSize'), faceWidth * .5 / canvas.width, faceHeight * .52 / canvas.height); gl.uniform1f(gl.getUniformLocation(program, 'strength'), amount)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); context.clearRect(0, 0, context.canvas.width, context.canvas.height); context.drawImage(canvas, 0, 0)
  } catch { /* The rest of the beauty pipeline still renders when GPU is unavailable. */ }
}

function drawBeautyImage(context: CanvasRenderingContext2D, image: TrackedImage, settings: BeautySettings) {
  const { width, height } = context.canvas
  const filter = FILTERS.find((item) => item.id === settings.photoFilter) ?? FILTERS[0]
  context.clearRect(0, 0, width, height); context.filter = filter.css; context.drawImage(image, 0, 0, width, height); context.filter = 'none'
  if (!image.face?.length) return
  const bounds = getFaceBounds(image.face)
  const centerX = ((bounds.left + bounds.right) / 2) * width; const centerY = ((bounds.top + bounds.bottom) / 2) * height
  const faceWidth = (bounds.right - bounds.left) * width; const faceHeight = (bounds.bottom - bounds.top) * height

  if (settings.smoothing > 0) {
    context.save(); context.beginPath(); context.ellipse(centerX, centerY, faceWidth * .46, faceHeight * .49, 0, 0, Math.PI * 2); context.clip()
    context.filter = `${filter.css === 'none' ? '' : `${filter.css} `}blur(${Math.max(.5, settings.smoothing / 20)}px)`; context.globalAlpha = settings.smoothing / 170
    context.drawImage(image, -2, -2, width + 4, height + 4); context.restore()
  }
  if (settings.brightness > 0) {
    // Landmark-shaped skin mask with eye and lip holes: no more circular light halo.
    context.save(); clipSkinMask(context, image.face, width, height); context.globalCompositeOperation = 'soft-light'; context.fillStyle = `rgba(255,238,222,${Math.min(settings.brightness / 260, .32)})`; context.fillRect(0, 0, width, height); context.restore()
  }
  if (settings.lipstick > 0) paintLipColor(context, image.face, width, height, settings.lipColor, settings.lipstick)
  if (settings.vLine > 0 && faceWidth > 20) {
    // Demo mesh substitute: per-pixel lower-face warp, constrained at its seam and center.
    applyVLineWarp(context, centerX, centerY, faceWidth, faceHeight, Math.min(settings.vLine / 100, .45))
    const intensity = Math.min(settings.vLine / 100, .55) * .10
    context.save(); context.beginPath(); context.ellipse(centerX, centerY + faceHeight * .08, faceWidth * .48, faceHeight * .5, 0, 0, Math.PI * 2); context.clip(); context.globalCompositeOperation = 'multiply'
    for (const direction of [-1, 1]) {
      const shade = context.createRadialGradient(centerX + direction * faceWidth * .36, centerY + faceHeight * .23, faceWidth * .025, centerX + direction * faceWidth * .31, centerY + faceHeight * .3, faceWidth * .33)
      shade.addColorStop(0, `rgba(112,70,78,${intensity})`); shade.addColorStop(.52, `rgba(112,70,78,${intensity * .35})`); shade.addColorStop(1, 'rgba(112,70,78,0)')
      context.fillStyle = shade; context.fillRect(0, 0, width, height)
    }
    context.restore()
  }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null); const inputRef = useRef<HTMLInputElement>(null); const landmarkerRef = useRef<FaceLandmarker | null>(null); const imageRef = useRef<TrackedImage | null>(null)
  const [settings, setSettings] = useState<BeautySettings>(DEFAULT_SETTINGS); const [editorState, setEditorState] = useState<'empty' | 'loading' | 'ready' | 'error'>('empty'); const [tracking, setTracking] = useState<'loading' | 'ready' | 'unavailable'>('loading'); const [notice, setNotice] = useState('Tải lên một bức ảnh chân dung để bắt đầu.'); const [filename, setFilename] = useState('')

  const renderImage = useCallback((override = settings) => {
    const image = imageRef.current; const canvas = canvasRef.current; if (!image || !canvas) return
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight)); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale)
    const context = canvas.getContext('2d'); if (context) drawBeautyImage(context, image, override)
  }, [settings])
  useEffect(() => { renderImage() }, [settings, renderImage])

  async function getLandmarker() {
    if (landmarkerRef.current) return landmarkerRef.current
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm')
    landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task' }, runningMode: 'IMAGE', numFaces: 1 })
    return landmarkerRef.current
  }
  const openUpload = () => inputRef.current?.click()
  const onFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
    if (!file.type.startsWith('image/')) { setEditorState('error'); setNotice('Vui lòng chọn file ảnh JPG, PNG hoặc WebP.'); return }
    setEditorState('loading'); setTracking('loading'); setFilename(file.name); setNotice('Đang nhận diện khuôn mặt và chuẩn bị ảnh…')
    try {
      const image = new Image() as TrackedImage; const objectUrl = URL.createObjectURL(file); image.src = objectUrl; await image.decode(); imageRef.current = image
      const landmarker = await getLandmarker(); const result = landmarker.detect(image); image.face = result.faceLandmarks[0]?.map(({ x, y }) => ({ x, y }))
      setTracking(image.face ? 'ready' : 'unavailable'); setNotice(image.face ? 'Kéo thanh điều chỉnh để thấy thay đổi ngay trên ảnh.' : 'Không nhận diện được khuôn mặt. Hãy thử một ảnh khác rõ hơn.'); renderImage(settings); setEditorState('ready'); URL.revokeObjectURL(objectUrl)
    } catch { setEditorState('error'); setTracking('unavailable'); setNotice('Không thể xử lý ảnh này. Hãy thử một ảnh khác rõ khuôn mặt hơn.') }
  }
  const updateSetting = (key: keyof BeautySettings, value: number) => setSettings((previous) => ({ ...previous, [key]: value }))
  const downloadPhoto = () => { const canvas = canvasRef.current; if (!canvas || editorState !== 'ready') return; const link = document.createElement('a'); link.href = canvas.toDataURL('image/jpeg', .94); link.download = `glowbox-${filename.replace(/\.[^/.]+$/, '') || 'portrait'}.jpg`; link.click() }
  const beautyEnabled = editorState === 'ready' && tracking === 'ready'

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><Sparkles size={17} /></span><span>glowbox</span></div><div className="session-chip"><span className="pulse" /> BEAUTY BOOTH</div><button className="operator-button"><span className="operator-dot" /> Chế độ vận hành</button></header>
    <section className="hero-copy"><p className="eyebrow">PHOTO BOOTH EXPERIENCE</p><h1>Rạng rỡ theo <em>cách của bạn.</em></h1><p>Tải ảnh lên và tinh chỉnh vẻ đẹp tự nhiên theo ý bạn.</p></section>
    <section className="booth-layout">
      <aside className="control-panel"><div className="panel-heading"><div><p className="micro-label">BEAUTY STUDIO</p><h2>Chỉnh nhẹ thôi nhé</h2></div><WandSparkles size={20} /></div><div className="preset-row">{PRESETS.map((preset) => <button key={preset.name} className="preset" onClick={() => setSettings(preset.settings)}>{preset.name}</button>)}</div><div className={`sliders ${beautyEnabled ? '' : 'is-disabled'}`}><BeautySlider label="Làm mịn da" value={settings.smoothing} onChange={(value) => updateSetting('smoothing', value)} accent="#fb81a7" /><BeautySlider label="Sáng da" value={settings.brightness} onChange={(value) => updateSetting('brightness', value)} accent="#f4bf70" /><BeautySlider label="Cằm V-line" value={settings.vLine} onChange={(value) => updateSetting('vLine', value)} accent="#a894ff" /><BeautySlider label="Màu môi" value={settings.lipstick} onChange={(value) => updateSetting('lipstick', value)} accent="#d85d80" /><LipColorPicker value={settings.lipColor} onChange={(lipColor) => setSettings((current) => ({ ...current, lipColor }))} /><FilterPicker value={settings.photoFilter} onChange={(photoFilter) => setSettings((current) => ({ ...current, photoFilter }))} /></div><button className="reset-button" onClick={() => setSettings(DEFAULT_SETTINGS)}><RotateCcw size={15} /> Đặt lại hiệu ứng</button><div className="privacy-note"><Check size={15} /> Ảnh được xử lý ngay trên máy này</div></aside>
      <div className="camera-stage"><div className="stage-topline"><span>{editorState === 'ready' ? 'YOUR PORTRAIT' : 'PHOTO EDITOR'}</span><span className={tracking === 'ready' ? 'tracking-ready' : ''}>{tracking === 'loading' ? 'Đang tải AI' : tracking === 'ready' ? 'Face tracking on' : 'Chờ ảnh'}</span></div><div className="camera-frame upload-frame"><canvas ref={canvasRef} className={`beauty-canvas uploaded-canvas ${editorState === 'ready' ? 'is-visible' : ''}`} />{editorState !== 'ready' && <div className="camera-empty"><div className="empty-icon">{editorState === 'loading' ? <LoaderCircle className="spin" size={28} /> : <ImageUp size={30} />}</div><strong>{editorState === 'error' ? 'Chưa thể mở ảnh' : 'Chọn một ảnh thật xinh'}</strong><span>{notice}</span>{editorState !== 'loading' && <button onClick={openUpload}><Upload size={17} /> Upload ảnh</button>}</div>}{editorState === 'ready' && <button className="change-photo" onClick={openUpload}><Upload size={14} /> Đổi ảnh</button>}<div className="face-guide"><span className="guide-corner top-left" /><span className="guide-corner top-right" /><span className="guide-corner bottom-left" /><span className="guide-corner bottom-right" /></div></div><p className="stage-message">{editorState === 'ready' ? filename : notice}</p><button className="shutter upload-action" disabled={editorState !== 'ready'} onClick={downloadPhoto}><Download size={20} /> Tải ảnh đã chỉnh</button><input ref={inputRef} className="file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={onFileSelected} /></div>
      <aside className="steps-panel"><p className="micro-label">YOUR SESSION</p><div className="steps"><Step index="01" label="Tải ảnh lên" done={editorState === 'ready'} active={editorState === 'empty'} /><Step index="02" label="Chỉnh vẻ đẹp" active={beautyEnabled} /><Step index="03" label="Tải ảnh xuống" /></div><div className="tip-card"><Sparkles size={18} /><div><strong>Mẹo nhỏ</strong><span>Ảnh nhìn thẳng, ánh sáng đều sẽ cho hiệu ứng đẹp nhất.</span></div></div></aside>
    </section><footer><span>© 2026 GLOWBOX</span><span>MADE FOR BEAUTIFUL MOMENTS</span></footer>
  </main>
}

function BeautySlider({ label, value, onChange, accent }: { label: string; value: number; onChange: (value: number) => void; accent: string }) { return <label className="beauty-slider"><div><span>{label}</span><b>{value}</b></div><input type="range" min="0" max="100" value={value} onChange={(event) => onChange(Number(event.target.value))} style={{ '--accent': accent } as React.CSSProperties} /></label> }
function LipColorPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) { const colors = ['#b76b78', '#c34b6c', '#a53455', '#a95f43', '#8d355f']; return <div className="lip-picker"><span>Màu son</span><div>{colors.map((color) => <button key={color} aria-label={`Chọn màu ${color}`} className={value === color ? 'selected' : ''} style={{ backgroundColor: color }} onClick={() => onChange(color)} />)}</div></div> }
function FilterPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <div className="filter-picker"><span>Bộ lọc</span><div>{FILTERS.map((filter) => <button key={filter.id} className={value === filter.id ? 'selected' : ''} onClick={() => onChange(filter.id)}>{filter.label}</button>)}</div></div> }
function Step({ index, label, done, active }: { index: string; label: string; done?: boolean; active?: boolean }) { return <div className={`step ${active ? 'active' : ''}`}><span>{done ? <Check size={14} /> : index}</span><p>{label}</p></div> }
