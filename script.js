/**
 * NexTraffic Dashboard — Smart Coordinated Cycle (J1 -> J2 -> J3)
 * Custom AI YOLOv8 Integration via Roboflow Hosted API
 */

// ─── Roboflow Configuration ──────────────────────────────────────────────────
const ROBOFLOW_PUBLISHABLE_KEY = "JheIj2rcwA0h5L1LSDqM";
const ROBOFLOW_MODEL_ID = "live_traffic_counter";
const ROBOFLOW_VERSION = 1;
// ─────────────────────────────────────────────────────────────────────────────

const MIN_GREEN = 8;
const MAX_GREEN = 40;
const YELLOW_TIME = 3;
const ALL_RED_TIME = 1;
const CONFIRM_FRAMES = 1;

// ─── State ────────────────────────────────────────────────────────────────────
let logEl, serialPort, serialWriter, videoStream;
let aiEnabled = false;
let detectionLoop = null;
let cycleInterval = null;

let latestPredictions = [];
let inferring = false;

const confirmCounts = [0, 0, 0];
const confirmedObjs = [0, 0, 0];

// Traffic Cycle State
let activeJid = 1;
let currentPhase = 'RED';
let phaseRemaining = 0;

// ── Time Saved Tracking ───────────────────────────────────────────────────
let totalTimeSaved = 0;   // cumulative seconds saved this session
let sessionStart   = null; // when AI was first turned on

let hDiv = 0.35, vDiv = 0.50, exclFrom = 0.38, exclTo = 0.62;

// ─── Init ─────────────────────────────────────────────────────────────────────
window.onload = async () => {
    logEl = document.getElementById('terminal-output');
    log('[SYSTEM] AUTOVISION-X Started. Roads 1, 2, 3 Active.');
    setupUI();
    injectDividers();
    initParticles();
    
    // Using Hosted API instead of Edge Weights, so we are ready instantly!
    log('[AI] Configured to use Roboflow Cloud REST API.');
    document.getElementById('ai-status').textContent = 'AI Mode: READY (CLOUD)';
};

function log(msg) {
    const t = new Date().toLocaleTimeString();
    const el = document.createElement('div');
    el.textContent = `[${t}] ${msg}`;
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
}

// ─── Serial Control ──────────────────────────────────────────────────────────
function txState(jid, state) {
    if (!serialWriter) return;
    const cmd = `S${jid},${state}\n`;
    serialWriter.write(cmd).catch(e => log('[TX ERROR] ' + e.message));
}

function setAllRed() {
    for (let i = 1; i <= 3; i++) {
        txState(i, 0);
        updateUILights(i, 'red');
    }
}

// ─── Cycle Management ─────────────────────────────────────────────────────────
function startCycle() {
    if (cycleInterval) clearInterval(cycleInterval);
    activeJid = 1;
    currentPhase = 'RED';
    phaseRemaining = 2;
    cycleInterval = setInterval(cycleTick, 1000);
}

function stopCycle() {
    if (cycleInterval) clearInterval(cycleInterval);
    cycleInterval = null;
    setAllRed();
    [1, 2, 3].forEach(i => document.getElementById(`j${i}-timer-display`).textContent = '--s');
}

async function cycleTick() {
    if (!aiEnabled) return;
    phaseRemaining--;

    [1, 2, 3].forEach(i => {
        const el = document.getElementById(`j${i}-timer-display`);
        if (i === activeJid) el.textContent = phaseRemaining + 's';
        else el.textContent = '--s';
    });

    if (phaseRemaining <= 0) {
        if (currentPhase === 'SKIP') {
            // This road had zero vehicles — move immediately to next road
            // Time saved = MIN_GREEN (8s) + YELLOW (3s) that would have been wasted
            const saved = MIN_GREEN + YELLOW_TIME;
            totalTimeSaved += saved;
            updateTimeSavedDisplay();
            log(`[CYCLE] Road ${activeJid} SKIPPED (0 vehicles) — saved ${saved}s`);
            setAllRed();
            activeJid = (activeJid % 3) + 1;
            currentPhase = 'RED';
            phaseRemaining = ALL_RED_TIME;

        } else if (currentPhase === 'RED') {
            // Check vehicle count to decide whether to serve or skip
            const count = confirmedObjs[activeJid - 1];
            if (count === 0) {
                // SKIP — no vehicles, don't waste green time
                currentPhase = 'SKIP';
                phaseRemaining = 1; // 1 second skip transition
                log(`[SMART] Road ${activeJid} has 0 vehicles → skipping to next road`);
                updateUILights(activeJid, 'red'); // stays red
            } else {
                // SERVE — vehicles present, give green time
                currentPhase = 'GREEN';
                phaseRemaining = Math.max(MIN_GREEN, Math.min(MAX_GREEN, 10 + (count * 6)));
                log(`[CYCLE] Road ${activeJid} GREEN for ${phaseRemaining}s (${count} vehicles)`);
                txState(activeJid, 2);
                updateUILights(activeJid, 'green');
            }

        } else if (currentPhase === 'GREEN') {
            currentPhase = 'YELLOW';
            phaseRemaining = YELLOW_TIME;
            log(`[CYCLE] Road ${activeJid} YELLOW transition`);
            txState(activeJid, 1);
            updateUILights(activeJid, 'yellow');

        } else if (currentPhase === 'YELLOW') {
            currentPhase = 'RED';
            phaseRemaining = ALL_RED_TIME;
            setAllRed();
            activeJid = (activeJid % 3) + 1;
        }
    }
}

function updateUILights(jid, state) {
    const r = document.getElementById(`j${jid}-red`), y = document.getElementById(`j${jid}-yellow`), g = document.getElementById(`j${jid}-green`);
    if (!r) return;
    r.classList.remove('active'); y.classList.remove('active'); g.classList.remove('active');
    if (state === 'red') r.classList.add('active');
    else if (state === 'yellow') y.classList.add('active');
    else if (state === 'green') g.classList.add('active');
}

// ─── AI Detection Logic (Roboflow Hosted API) ───────────────────────────────
async function runDetection() {
    if (!aiEnabled || inferring) return;
    const src = getSource();
    if (!src) return;

    inferring = true;
    try {
        const w = src.videoWidth || src.width;
        const h = src.videoHeight || src.height;

        // 1. Capture Image to Canvas
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(src, 0, 0, w, h);
        
        // 2. Convert to Base64 (Roboflow expects raw base64 string without data:image tag)
        let base64Image = canvas.toDataURL("image/jpeg", 0.8).split(',')[1];

        // 3. Build the Hosted API URL
        // If it throws "Not Found", we automatically append the workspace name as a fallback.
        let url = `https://detect.roboflow.com/${ROBOFLOW_MODEL_ID}/${ROBOFLOW_VERSION}?api_key=${ROBOFLOW_PUBLISHABLE_KEY}&confidence=40&overlap=30`;

        // 4. Send API Request!
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: base64Image
        });

        if (!response.ok) {
            // Hot-fix for workspaces being strictly enforced by Roboflow on free accounts
            if(response.status === 404 || response.status === 403) {
                 url = `https://detect.roboflow.com/anurags-workspace-gt0ar/${ROBOFLOW_MODEL_ID}/${ROBOFLOW_VERSION}?api_key=${ROBOFLOW_PUBLISHABLE_KEY}`;
                 const resp2 = await fetch(url, {
                     method: "POST",
                     headers: { "Content-Type": "application/x-www-form-urlencoded" },
                     body: base64Image
                 });
                 if (!resp2.ok) throw new Error("API Failure: " + await resp2.text());
                 var data = await resp2.json();
            } else {
                 throw new Error("API Failure: " + await response.text());
            }
        } else {
            var data = await response.json();
        }

        const predictions = data.predictions || [];
        latestPredictions = predictions;

        // 5. Calculate Zone Statistics
        const counts = [0, 0, 0];
        const hy = hDiv * h;
        const vx = vDiv * w;
        const exF = exclFrom * w;
        const exT = exclTo * w;

        predictions.forEach(pred => {
            const cx = pred.x;
            const cy = pred.y;
            if (cy < hy && cx < exF) counts[0]++;
            else if (cy < hy && cx > exT) counts[2]++;
            else if (cy >= hy) counts[1]++;
        });

        for (let i = 0; i < 3; i++) {
            confirmedObjs[i] = counts[i];
        }

        document.getElementById('vehicle-count').textContent = confirmedObjs[0] + confirmedObjs[1] + confirmedObjs[2];
        document.getElementById('j1-count').textContent = confirmedObjs[0];
        document.getElementById('j2-count').textContent = confirmedObjs[1];
        document.getElementById('j3-count').textContent = confirmedObjs[2];
        
        drawCanvas(w, h);

    } catch (e) {
        // Log quietly so it doesn't spam the terminal while running continuously
        console.error("Inference Error:", e);
    } finally {
        inferring = false;
    }
}

function getSource() {
    const vid = document.getElementById('camera-video'), img = document.getElementById('camera-feed');
    if (vid.style.display !== 'none' && vid.readyState >= 2) return vid;
    if (img.style.display !== 'none' && img.complete) return img;
    return null;
}

function startAI() {
    log('[AI] Connecting to Roboflow Cloud Infrastructure...');
    document.getElementById('ai-status').textContent = 'AI Mode: ACTIVE';
    document.getElementById('ai-status').style.background = '#059669';
    sessionStart = Date.now();
    totalTimeSaved = 0;
    updateTimeSavedDisplay();
    if (detectionLoop) clearInterval(detectionLoop);
    detectionLoop = setInterval(runDetection, 600); 
    startCycle();
}

function stopAI() {
    document.getElementById('ai-status').textContent = 'AI Mode: READY (CLOUD)';
    document.getElementById('ai-status').style.background = '#374151';
    if (detectionLoop) clearInterval(detectionLoop);
    detectionLoop = null;
    stopCycle();
    latestPredictions = [];
    sessionStart = null;
    const src = getSource();
    if (src) drawCanvas(src.videoWidth || src.width, src.videoHeight || src.height);
}

function updateTimeSavedDisplay() {
    const el = document.getElementById('time-saved-display');
    if (!el) return;
    const elapsedMs  = sessionStart ? Date.now() - sessionStart : 0;
    const elapsedHrs = elapsedMs / (1000 * 60 * 60);
    const perHour    = elapsedHrs > 0.0005 ? Math.round(totalTimeSaved / elapsedHrs) : 0;
    const mins = Math.floor(totalTimeSaved / 60);
    const secs = totalTimeSaved % 60;
    const savedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    el.querySelector('#ts-total').textContent  = savedStr;
    el.querySelector('#ts-perhour').textContent = perHour + 's / hr';
}

// ─── Drawing ────────────────────────────────────────────────────────────────
function drawCanvas(vidW, vidH) {
    const canvas = document.getElementById('detection-canvas'), wrap = document.getElementById('video-wrapper');
    canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight;
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    
    const scX = W / vidW;
    const scY = H / vidH;
    
    const hy = hDiv * H, vx = vDiv * W;
    ctx.strokeStyle = '#fff4'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(vx, 0); ctx.lineTo(vx, hy); ctx.stroke();

    ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 4;
    ctx.setLineDash([10, 5]);
    if (activeJid === 1) ctx.strokeRect(2, 2, exclFrom * W - 4, hy - 4);
    if (activeJid === 3) ctx.strokeRect(exclTo * W + 2, 2, W - (exclTo * W) - 4, hy - 4);
    if (activeJid === 2) ctx.strokeRect(2, hy + 2, W - 4, H - hy - 4);
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(exclFrom * W, 0, (exclTo - exclFrom) * W, hy);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Inter'; ctx.fillText('⛔ LIGHT HOUSING', (exclFrom * W) + 4, hy / 2);

    latestPredictions.forEach(pred => {
        const boxW = pred.width * scX;
        const boxH = pred.height * scY;
        const x = (pred.x * scX) - (boxW / 2);
        const y = (pred.y * scY) - (boxH / 2);

        const cy = pred.y * scY;
        const cx = pred.x * scX;
        let color = '#3b82f6';
        if (cy < hy && cx < (exclFrom * W)) color = '#ff4444';
        else if (cy < hy && cx > (exclTo * W)) color = '#00e676';
        else if (cy >= hy) color = '#ffaa00';

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, boxW, boxH);

        ctx.fillStyle = color;
        ctx.fillRect(x, y - 20, boxW, 20);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 12px Inter";
        const labelText = `${pred.class} ${Math.round(pred.confidence * 100)}%`;
        ctx.fillText(labelText, x + 4, y - 6);
    });
}

function injectDividers() {
    const wrap = document.getElementById('video-wrapper');
    const hLine = makeLine('h-divider', '#ff4444', '↕ J1+J3/J2', true);
    const vLine = makeLine('v-divider', '#00e676', '↔ J1/J3', false);
    wrap.appendChild(hLine); wrap.appendChild(vLine);
    hLine.style.top = (hDiv * 100) + '%'; vLine.style.left = (vDiv * 100) + '%'; vLine.style.height = (hDiv * 100) + '%';

    const drag = (el, isH) => {
        el.onmousedown = e => {
            const move = ev => {
                const r = wrap.getBoundingClientRect();
                if (isH) { hDiv = (ev.clientY - r.top) / r.height; el.style.top = (hDiv * 100) + '%'; vLine.style.height = (hDiv * 100) + '%'; }
                else { vDiv = (ev.clientX - r.left) / r.width; el.style.left = (vDiv * 100) + '%'; }
                redrawOverlayLabels();
            };
            document.onmousemove = move; document.onmouseup = () => { document.onmousemove = null; };
        };
    };
    drag(hLine, true); drag(vLine, false);
    redrawOverlayLabels();
}

function makeLine(id, col, txt, isH) {
    const el = document.createElement('div'); el.id = id;
    el.style.cssText = `position:absolute; ${isH ? 'left:0;width:100%;height:3px;' : 'top:0;width:3px;'} background:${col}; cursor:pointer; z-index:30;`;
    const t = document.createElement('span'); t.textContent = txt; t.style.cssText = `background:${col};color:#fff;font-size:9px;padding:1px 4px;position:relative;top:-12px;`;
    el.appendChild(t); return el;
}

function redrawOverlayLabels() {
    let ov = document.getElementById('z-ov'); if (!ov) { ov = document.createElement('div'); ov.id = 'z-ov'; ov.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;'; document.getElementById('video-wrapper').appendChild(ov); }
    ov.innerHTML = '';
    const tag = (v, c, t, l) => { const d = document.createElement('div'); d.textContent = v; d.style.cssText = `position:absolute;top:${t};left:${l};background:${c}cc;color:#fff;font-size:10px;padding:2px 5px;`; ov.appendChild(d); };
    tag('Road 1', '#ff4444', (hDiv * 100 - 6) + '%', '2%');
    tag('Road 3', '#00e676', (hDiv * 100 - 6) + '%', (vDiv * 100 + 2) + '%');
    tag('Road 2', '#ffaa00', (hDiv * 100 + 2) + '%', '2%');
}

function setupUI() {
    document.getElementById('use-device-cam').onclick = async () => {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        document.getElementById('camera-video').srcObject = videoStream; document.getElementById('camera-video').style.display = 'block';
    };

    document.getElementById('connect-serial').onclick = async () => {
        if (!navigator.serial) {
            log('[ERROR] Web Serial API not supported in this browser.');
            return;
        }
        try {
            serialPort = await navigator.serial.requestPort(); await serialPort.open({ baudRate: 9600 });
            const enc = new TextEncoderStream(); enc.readable.pipeTo(serialPort.writable); serialWriter = enc.writable.getWriter();
            document.getElementById('serial-status').textContent = 'CONNECTED';
            document.getElementById('serial-status').style.background = '#059669';

            const decoder = new TextDecoderStream();
            serialPort.readable.pipeTo(decoder.writable);
            const reader = decoder.readable.getReader();
            (async () => {
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                    }
                } catch (err) {
                    log('[RX ERROR] ' + err.message);
                } finally {
                    reader.releaseLock();
                }
            })();
            log('[SERIAL] Arduino Connected.');
        } catch (e) { log(`[SERIAL] Connection failed: ${e.message}`); }
    };

    document.getElementById('ai-toggle').onchange = e => {
        aiEnabled = e.target.checked;
        if (aiEnabled) startAI();
        else stopAI();
    };
}

window.updateJunction = function (jid) {
    const rTime = document.getElementById(`j${jid}-red-time`).value;
    const gTime = document.getElementById(`j${jid}-green-time`).value;
    if (serialWriter) {
        serialWriter.write(`J${jid},${rTime},${gTime}\n`).catch(e => log('[TX ERROR] ' + e.message));
        log(`[INFO] Sent manual override J${jid}, ` + `red:${rTime}s, green:${gTime}s`);
    } else {
        log(`[WARN] Connect Arduino first to override timings.`);
    }
};

// ─── Particle Effects — Exact Antigravity Warp-Speed Streak Replication ───
function initParticles() {
    const canvas = document.getElementById('particle-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let W = canvas.width  = window.innerWidth;
    let H = canvas.height = window.innerHeight;

    window.addEventListener('resize', () => {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
        drawStaticGrid();
    });

    // ── Static tiny dot grid (background depth layer, like Antigravity) ──
    const gridCanvas = document.createElement('canvas');
    const gCtx = gridCanvas.getContext('2d');
    function drawStaticGrid() {
        gridCanvas.width  = W;
        gridCanvas.height = H;
        gCtx.clearRect(0, 0, W, H);
        const spacing = 28;
        gCtx.fillStyle = 'rgba(37, 99, 235, 0.35)'; // Much more visible
        for (let x = 0; x < W; x += spacing) {
            for (let y = 0; y < H; y += spacing) {
                gCtx.beginPath();
                gCtx.arc(x, y, 1.2, 0, Math.PI * 2); // Bigger dots
                gCtx.fill();
            }
        }
    }
    drawStaticGrid();

    // ── Warp particle colours ──────────────────────────────────────────────
    const PALETTES = [
        [37,  99, 235],   // strong blue
        [79,  70, 229],   // strong indigo
        [109, 40, 217],   // strong violet
        [219, 39, 119],   // strong pink
        [217, 119, 6],    // amber
    ];

    // ── Build streak particles ─────────────────────────────────────────────
    const COUNT = 220;
    const particles = [];

    function makeParticle(stagger) {
        const angle  = Math.random() * Math.PI * 2;
        const speed  = Math.random() * 1.2 + 0.5;
        const col    = PALETTES[Math.floor(Math.random() * PALETTES.length)];
        return {
            x    : W / 2 + Math.cos(angle) * (Math.random() * Math.min(W, H) * 0.4),
            y    : H / 2 + Math.sin(angle) * (Math.random() * Math.min(W, H) * 0.4),
            vx   : Math.cos(angle) * speed,
            vy   : Math.sin(angle) * speed,
            acc  : 1.014 + Math.random() * 0.006,
            r    : col[0], g: col[1], b: col[2],
            alpha: Math.random() * 0.5 + 0.5,  // 0.5–1.0, much more visible
            life : stagger ? Math.random() : 1,
        };
    }

    for (let i = 0; i < COUNT; i++) particles.push(makeParticle(true));

    function resetParticle(p) {
        const angle  = Math.random() * Math.PI * 2;
        const speed  = Math.random() * 0.9 + 0.3;
        const col    = PALETTES[Math.floor(Math.random() * PALETTES.length)];
        p.x     = W / 2 + (Math.random() - 0.5) * 30;
        p.y     = H / 2 + (Math.random() - 0.5) * 30;
        p.vx    = Math.cos(angle) * speed;
        p.vy    = Math.sin(angle) * speed;
        p.acc   = 1.012 + Math.random() * 0.006;
        p.r     = col[0]; p.g = col[1]; p.b = col[2];
        p.alpha = Math.random() * 0.45 + 0.2;
        p.life  = 0;
    }

    // ── Animation loop ─────────────────────────────────────────────────────
    function animate() {
        requestAnimationFrame(animate);

        // Draw static grid first (background depth layer)
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(gridCanvas, 0, 0);

        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];

            // Fade in over first 30 frames equivalent
            p.life = Math.min(p.life + 0.02, 1);

            // Accelerate outward
            p.vx *= p.acc;
            p.vy *= p.acc;
            p.x  += p.vx;
            p.y  += p.vy;

            // Reset if escaped screen
            if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) {
                resetParticle(p);
                continue;
            }

            // Streak: draw a short line segment in the direction of travel
            const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
            const streakLen = Math.min(speed * 10, 24); // longer streaks

            const alpha = p.alpha * p.life;

            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(
                p.x - (p.vx / speed) * streakLen,
                p.y - (p.vy / speed) * streakLen
            );
            const grad = ctx.createLinearGradient(
                p.x, p.y,
                p.x - (p.vx / speed) * streakLen,
                p.y - (p.vy / speed) * streakLen
            );
            grad.addColorStop(0,   `rgba(${p.r},${p.g},${p.b},${alpha})`);
            grad.addColorStop(1,   `rgba(${p.r},${p.g},${p.b},0)`);

            ctx.strokeStyle = grad;
            ctx.lineWidth   = Math.max(speed * 0.6, 1.5); // thicker, min 1.5px
            ctx.lineCap     = 'round';
            ctx.stroke();
        }
    }

    animate();
}
