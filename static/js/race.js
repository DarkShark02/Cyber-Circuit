// === VARIABILI GLOBALI ===
let scene, camera, renderer, world, carBody, carMesh;
let colorableParts = [];
let otherPlayers = {};
let socket;
let myUsername;
let myModelPath;
let lobbyCode = null;
let lobbyHostId = null; // Aggiungi questa variabile globale nel file

// TURBO
let turboActive = false;
let turboReady = true;
let turboTimer = 0;

// DRIFT
let drifting = false;

// PARTICELLE
let driftSmokeLeft = null;
let driftSmokeRight = null;
let turboFlames = null;

// GARA / PISTA
let trackData = null;
let checkpoints = [];
let finishLine = null;
let nextCheckpoint = 0;
let currentLap = 0;
let totalLaps = 0;
let trackLoaded = false;
let raceStarted = false;
let myUserId = null;
let totalLapsClient = 0;


// MINIMAP
let minimapCanvas = null;
let minimapCtx = null;
let minimapScale = 0.04;

const keys = { w: false, a: false, s: false, d: false };
let carStats = { speed: 1, accel: 1, handling: 1 };
let carColor = "#39ff14";

const ACCEL_STRENGTH = 1000;
const DRAG_COEFFICIENT = 0.96;
const BASE_FOV = 60;

// === INIZIALIZZAZIONE GIOCO ===
export function initGame(config) {
    socket = config.socket;
    myUsername = config.username;
    carStats = config.stats;
    carColor = config.carColor;
    myModelPath = config.modelPath;
    myUserId = config.userId;   
    myUserId = Number(myUserId);
    lobbyCode = config.lobbyCode;
    lobbyHostId = config.lobbyHostId;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000105);

    camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 5000);

    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.getElementById("canvas-container").appendChild(renderer.domElement);

    // MINIMAP
    minimapCanvas = document.getElementById("minimap-canvas");
    minimapCtx = minimapCanvas.getContext("2d");

    // === FISICA ===
    world = new CANNON.World();
    world.gravity.set(0, -35, 0);

    const groundMaterial = new CANNON.Material("groundMaterial");
    const wheelMaterial = new CANNON.Material("wheelMaterial");

    world.addContactMaterial(new CANNON.ContactMaterial(
        groundMaterial,
        wheelMaterial,
        { friction: 0.0, restitution: 0.05 }
    ));

    // LUCI
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(10, 50, 10);
    scene.add(sun);

    // SUOLO FISICO
    const groundBody = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Plane(),
        material: groundMaterial
    });
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    world.addBody(groundBody);

    setupSocketListeners();

    // === CARICAMENTO PISTA ===
    if (window.PRACTICE_MODE) {
        raceStarted = true;   // AVVIA SUBITO LA GARA

        // carica il JSON della pista di prova
        fetch("/static/json/tracks/freeTrack.json")
            .then(res => res.json())
            .then(data => {
                trackData = data;
                totalLaps = 0;
                totalLapsClient = 0;

                createTrack(); // crea terreno + muri + asfalto

                // NON creare checkpoint e finish
                trackLoaded = true;
            });
    }else {
        fetch(TRACK_JSON)
            .then(res => res.json())
            .then(data => {
                trackData = data;
                totalLaps = data.laps;
                totalLapsClient = data.laps;
                createTrack();
                createTrackObjects();
                trackLoaded = true;
            });
    }

    let spawned = false;
    socket.emit("request_spawn_point");

    socket.once("spawn_data", (data) => {
        if (spawned) return;
        spawned = true;

        const sp = data.spawnPos;

        // Altezza reale della strada
        const realY = getRoadHeightAt(sp.x, sp.z);
        sp.y = realY + 1;

        // Direzione reale della pista
        sp.rotY = getRoadDirectionAt(sp.x, sp.z);

        loadMyCar(myModelPath, wheelMaterial, sp);
    });


    setTimeout(() => {
        if (!spawned) {
            spawned = true;
            console.warn("Spawn point data not received in time, using default position.");
            loadMyCar(myModelPath, wheelMaterial, { x: 0, y: 1, z: 0 });
        }
    }, 3000);

    animate();
}

// === UTILS PER SPAWN ===
function getRoadHeightAt(x, z) {
    const pts = trackData.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.5);

    let bestT = 0;
    let bestDist = Infinity;
    const steps = 300;

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = curve.getPoint(t);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bestDist) {
            bestDist = d;
            bestT = t;
        }
    }

    return curve.getPoint(bestT).y;
}

function getRoadDirectionAt(x, z) {
    const pts = trackData.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.5);

    let bestT = 0;
    let bestDist = Infinity;
    const steps = 300;

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = curve.getPoint(t);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bestDist) {
            bestDist = d;
            bestT = t;
        }
    }

    const tangent = curve.getTangent(bestT).normalize();

    // Converti la tangente in angolo Y
    const angle = Math.atan2(tangent.x, tangent.z);

    return angle;
}

// === OGGETTI PISTA ===
function createTrackObjects() {
    if (!trackData) return;

    const f = trackData.finish;
    finishLine = createTrigger(f.x, f.y, f.z, 12);

    checkpoints = [];
    trackData.points.forEach((cp, i) => {
        const trigger = createTrigger(cp.x, cp.y, cp.z, 10);
        trigger.userData.index = i;
        checkpoints.push(trigger);
    });

    nextCheckpoint = 0;
    currentLap = 0;
    createFinishLineVisual(f.x, f.y, f.z);
}

function createTrigger(x, y, z, size) {
    // Trigger invisibile (fisico)
    const roadWidth = trackData.roadWidth || 30;
    // Creiamo un box largo quanto la strada, alto 10 e profondo 4
    const geo = new THREE.BoxGeometry(roadWidth, 10, 4);

    const mat = new THREE.MeshBasicMaterial({ visible: false });
    const trigger = new THREE.Mesh(geo, mat);
    trigger.position.set(x, y + 2.5, z);

    // === Calcolo direzione pista nel punto ===
    const pts = trackData.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.5);

    let bestT = 0;
    let bestDist = Infinity;
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = curve.getPoint(t);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bestDist) {
            bestDist = d;
            bestT = t;
        }
    }

    const tangent = curve.getTangent(bestT).normalize();
    const angle = Math.atan2(tangent.x, tangent.z);

    // Ruotiamo anche il trigger fisico per allinearlo alla pista
    trigger.rotation.y = angle;
    scene.add(trigger);

    // === Striscia gialla (Visuale) ===
    const stripeWidth = roadWidth;
    const stripeHeight = 3;

    const stripeGeo = new THREE.PlaneGeometry(stripeWidth, stripeHeight);
    const stripeMat = new THREE.MeshStandardMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 0.35,
        emissive: 0xffff00,
        emissiveIntensity: 0.6,
        side: THREE.DoubleSide
    });

    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
    stripe.position.set(x, y + 0.1, z);
    stripe.rotation.x = -Math.PI / 2;
    stripe.rotation.z = angle;

    scene.add(stripe);
    
    // Salviamo il riferimento alla striscia per cambiare colore dopo
    trigger.userData.visual = stripe;

    return trigger;
}

function createFinishLineVisual(x, y, z) {
    const width = trackData.roadWidth || 30;
    const height = 6; 

    const geo = new THREE.PlaneGeometry(width, height);
    const mat = new THREE.MeshStandardMaterial({
        transparent: true,
        opacity: 1,
        side: THREE.FrontSide
    });

    const mesh = new THREE.Mesh(geo, mat);

    // === Orientamento rispetto alla pista ===
    const pts = trackData.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.5);

    let bestT = 0;
    let bestDist = Infinity;
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = curve.getPoint(t);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bestDist) {
            bestDist = d;
            bestT = t;
        }
    }

    const tangent = curve.getTangent(bestT).normalize();
    const angle = Math.atan2(tangent.x, tangent.z);
    
    // POSIZIONAMENTO
    mesh.position.set(x, y + 0.15, z);

    // ROTAZIONE: Sdraia e poi ruota per seguire la strada
    mesh.rotation.x = -Math.PI / 2; 
    mesh.rotation.z = angle;

    // === Texture a scacchi ===
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256; 
    const ctx = canvas.getContext("2d");

    const cellSize = 64; 
    for (let i = 0; i < canvas.width / cellSize; i++) {
        for (let j = 0; j < canvas.height / cellSize; j++) {
            ctx.fillStyle = (i + j) % 2 === 0 ? "#000000" : "#ffffff";
            ctx.fillRect(i * cellSize, j * cellSize, cellSize, cellSize);
        }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1); 
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;

    mat.map = tex;
    mat.needsUpdate = true;

    scene.add(mesh);
    
    // Se non esiste già un finishLine fisico (trigger), usiamo questo mesh per worldToLocal
    if (!finishLine) {
        // Creiamo un contenitore invisibile ruotato per la collisione del traguardo
        const triggerGeo = new THREE.BoxGeometry(width, 10, 4);
        finishLine = new THREE.Mesh(triggerGeo, new THREE.MeshBasicMaterial({visible: false}));
        finishLine.position.set(x, y + 2.5, z);
        finishLine.rotation.y = angle;
        scene.add(finishLine);
    }
}

// === PISTA ===
function createTrack() {
    if (!trackData) return;

    // 1) Terreno → genera trackData.bounds
    createTerrain();

    // 2) Muri → usa i bounds generati
    const { minX, maxX, minZ, maxZ } = trackData.bounds;
    createBoundaryWalls(minX, maxX, minZ, maxZ);

    // 3) Asfalto → ora può essere disegnato
    createRoad();
}

// === TERRENO ===
function createTerrain() {
    const { minX, maxX, minZ, maxZ } = trackData.terrain;

    trackData.bounds = { minX, maxX, minZ, maxZ };

    const width = maxX - minX;
    const height = maxZ - minZ;

    const geo = new THREE.PlaneGeometry(width, height);
    const mat = new THREE.MeshStandardMaterial({
        color: 0x3b2a16,
        roughness: 1
    });

    const terrain = new THREE.Mesh(geo, mat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set(
        (minX + maxX) / 2,
        0,
        (minZ + maxZ) / 2
    );

    terrain.receiveShadow = true;
    scene.add(terrain);
}

// === MURI DI CONFINE ===
function createBoundaryWalls(minX, maxX, minZ, maxZ, height = 5, thickness = 2) {
    const wallMaterial = new THREE.MeshStandardMaterial({
        color: 0x111111,
        roughness: 1
    });

    function makeWall(x, y, z, w, h, d) {
        const geo = new THREE.BoxGeometry(w, h, d);
        const mesh = new THREE.Mesh(geo, wallMaterial);
        mesh.position.set(x, y + h / 2, z);
        mesh.castShadow = true;
        scene.add(mesh);

        const body = new CANNON.Body({
            mass: 0,
            shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)),
            position: new CANNON.Vec3(x, y + h / 2, z)
        });
        world.addBody(body);
    }

    const width = maxX - minX;
    const depth = maxZ - minZ;

    makeWall((minX + maxX) / 2, 0, maxZ, width, height, thickness);
    makeWall((minX + maxX) / 2, 0, minZ, width, height, thickness);
    makeWall(maxX, 0, (minZ + maxZ) / 2, thickness, height, depth);
    makeWall(minX, 0, (minZ + maxZ) / 2, thickness, height, depth);
}

// === ASFALTO ===
function createRoad() {
    if (!trackData || !trackData.points) return;

    const roadWidth = trackData.roadWidth || 12;

    const pts = trackData.points.map(p => new THREE.Vector3(p.x, p.y, p.z));

    // spline della pista
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.5);

    const segments = 400;
    const left = [];
    const right = [];

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = curve.getPoint(t);
        const tangent = curve.getTangent(t).normalize();
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

        left.push(p.clone().add(normal.clone().multiplyScalar(roadWidth / 2)));
        right.push(p.clone().add(normal.clone().multiplyScalar(-roadWidth / 2)));
    }

    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i < left.length; i++) {
        const L = left[i];
        const R = right[i];

        positions.push(L.x, 0.05, L.z);
        positions.push(R.x, 0.05, R.z);

        const v = i / (left.length - 1);
        uvs.push(0, v * 5);
        uvs.push(1, v * 5);
    }

    for (let i = 0; i < left.length - 1; i++) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;

        indices.push(a, b, c);
        indices.push(b, d, c);
    }

    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    roadGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    roadGeo.setIndex(indices);
    roadGeo.computeVertexNormals();

    const roadMat = new THREE.MeshStandardMaterial({
        color: 0x555555,
        roughness: 0.8,
        metalness: 0.1,
        side: THREE.DoubleSide   // per sicurezza
    });

    const roadMesh = new THREE.Mesh(roadGeo, roadMat);
    roadMesh.receiveShadow = true;
    scene.add(roadMesh);

    trackData._left = left;
    trackData._right = right;
}

// === GRIP ASFALTO / TERRA ===
function getSurfaceGrip() {
    if (!trackData || !trackData.points || !carMesh) return { grip: 0.6, penalty: 1 };

    const carPos = carMesh.position.clone();

    // spline della pista
    const pts = trackData.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.5);

    // Trova il punto della spline più vicino all’auto
    let bestT = 0;
    let bestDist = Infinity;
    const steps = 300;

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = curve.getPoint(t);
        const d = carPos.distanceTo(p);
        if (d < bestDist) {
            bestDist = d;
            bestT = t;
        }
    }

    // Punto centrale della pista più vicino
    const center = curve.getPoint(bestT);

    // Tangente e normale della pista
    const tangent = curve.getTangent(bestT).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

    // Distanza perpendicolare dal centro strada
    const relative = carPos.clone().sub(center);
    const distFromCenter = Math.abs(relative.dot(normal));

    const roadWidth = trackData.roadWidth || 14;

    // Dentro la strada → grip pieno
    if (distFromCenter <= roadWidth * 0.5) {
        return { grip: 1.0, penalty: 1.0 }; // nessuna penalità
    }

    // Fuori strada → grip ridotto + penalità velocità/accelerazione
    // Più sei lontano, più penalizza
    const overflow = distFromCenter - roadWidth * 0.5;
    const maxOverflow = roadWidth * 0.8;

    const t = Math.min(overflow / maxOverflow, 1);

    const grip = 1.0 - t * 0.7;       // grip scende fino a ~0.3
    const penalty = 1.0 - t * 0.5;    // accel e maxSpeed scendono fino al 50%

    return { grip, penalty };
}

// === NORMALIZZAZIONE MODELLO ===
function normalizeModel(mesh) {
    const toRemove = [];
    mesh.traverse(node => {
        if (node.isMesh) {
            const name = node.name.toLowerCase();
            const matName = node.material?.name?.toLowerCase() || "";
            if (/floor|plane|shadow|grid|underbody|license/.test(name) ||
                /shadow|grid|floor/.test(matName)) {
                toRemove.push(node);
            }
        }
    });
    toRemove.forEach(n => n.parent?.remove(n));

    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());

    mesh.position.x -= center.x;
    mesh.position.y -= box.min.y;
    mesh.position.z -= center.z;

    const wrapper = new THREE.Group();
    wrapper.add(mesh);

    const size = box.getSize(new THREE.Vector3());
    const scale = 5 / Math.max(size.x, size.y, size.z);
    wrapper.scale.set(scale, scale, scale);

    return wrapper;
}

// === ORIENTAMENTO AUTO (X o Z) ===
function getCarOrientation(mesh) {
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    return size.z > size.x ? "Z" : "X";
}

// === MATERIALI AUTO ===
function processCarMaterials(mesh, hexColor, isMain = false) {
    const targetColor = new THREE.Color(hexColor);

    mesh.traverse(node => {
        if (node.isMesh && !node.userData.isOutline) {
            const name = (node.name + " " + (node.material.name || "")).toLowerCase();

            if (/body|paint|carrozzeria|frame|metal/.test(name)) {
                node.material = new THREE.MeshToonMaterial({ color: targetColor });
                if (isMain) colorableParts.push(node.material);
            } else if (/glass|window|vetro/.test(name)) {
                node.material = new THREE.MeshToonMaterial({ color: 0x111111, transparent: true, opacity: 0.4 });
            } else {
                node.material = new THREE.MeshToonMaterial({ color: 0x222222 });
            }

            const outline = new THREE.Mesh(
                node.geometry,
                new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide })
            );
            outline.scale.multiplyScalar(1.03);
            outline.userData.isOutline = true;
            node.add(outline);
        }
    });
}

// === PARTICELLE DRIFT ===
function createDriftSmoke() {
    const smokeCount = 80;

    function makeSmoke() {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(smokeCount * 3);
        const alphas = new Float32Array(smokeCount);

        for (let i = 0; i < smokeCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 0.4;
            positions[i * 3 + 1] = 0;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
            alphas[i] = Math.random();
        }

        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geo.setAttribute("alpha", new THREE.BufferAttribute(alphas, 1));

        const mat = new THREE.PointsMaterial({
            color: 0x999999,
            size: 0.45,
            transparent: true,
            opacity: 0.85,
            depthWrite: false
        });

        return new THREE.Points(geo, mat);
    }

    driftSmokeLeft = makeSmoke();
    driftSmokeRight = makeSmoke();

    driftSmokeLeft.visible = false;
    driftSmokeRight.visible = false;

    scene.add(driftSmokeLeft);
    scene.add(driftSmokeRight);
}

// === AGGIORNAMENTO PARTICELLE DRIFT ===
function updateDriftSmoke() {
    if (!drifting || (!keys.a && !keys.d) || !carMesh) {
        if (driftSmokeLeft) driftSmokeLeft.visible = false;
        if (driftSmokeRight) driftSmokeRight.visible = false;
        return;
    }

    driftSmokeLeft.visible = true;
    driftSmokeRight.visible = true;

    const smokes = [driftSmokeLeft, driftSmokeRight];
    const offsets = [
        new THREE.Vector3(-1.1, 0.15, -1.45),
        new THREE.Vector3(1.1, 0.15, -1.45)
    ];

    smokes.forEach((smoke, i) => {
        const positions = smoke.geometry.attributes.position.array;
        const alphas = smoke.geometry.attributes.alpha.array;

        for (let j = 0; j < alphas.length; j++) {
            alphas[j] -= 0.02;
            if (alphas[j] <= 0) {
                alphas[j] = 1.0;
                positions[j * 3] = (Math.random() - 0.5) * 0.4;
                positions[j * 3 + 1] = 0;
                positions[j * 3 + 2] = (Math.random() - 0.5) * 0.4;
            }
            positions[j * 3 + 1] += 0.02;
        }

        const offset = offsets[i].clone().applyQuaternion(carMesh.quaternion);
        smoke.position.copy(carMesh.position.clone().add(offset));

        smoke.geometry.attributes.position.needsUpdate = true;
        smoke.geometry.attributes.alpha.needsUpdate = true;
    });
}

// === TURBO ===
function createTurboFlames() {
    const flameGeo = new THREE.BufferGeometry();
    const flameCount = 80;

    const positions = new Float32Array(flameCount * 3);
    const speeds = new Float32Array(flameCount);

    for (let i = 0; i < flameCount; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 0.3;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 0.3;
        positions[i * 3 + 2] = -Math.random() * 0.5;
        speeds[i] = 0.2 + Math.random() * 0.4;
    }

    flameGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    flameGeo.setAttribute("speed", new THREE.BufferAttribute(speeds, 1));

    const flameMat = new THREE.PointsMaterial({
        color: 0xff3300,
        size: 0.75,
        transparent: true,
        opacity: 1.0,
        depthWrite: false
    });

    turboFlames = new THREE.Points(flameGeo, flameMat);
    turboFlames.visible = false;
    scene.add(turboFlames);
}

// === AGGIORNAMENTO TURBO ===
function updateTurboFlames() {
    if (!turboFlames || !carMesh) return;

    turboFlames.visible = turboActive;
    if (!turboActive) return;

    const positions = turboFlames.geometry.attributes.position.array;
    const speeds = turboFlames.geometry.attributes.speed.array;

    for (let i = 0; i < speeds.length; i++) {
        positions[i * 3 + 2] -= speeds[i];
        positions[i * 3] += (Math.random() - 0.5) * 0.05;
        positions[i * 3 + 1] += (Math.random() - 0.5) * 0.05;

        if (positions[i * 3 + 2] < -3) {
            positions[i * 3] = (Math.random() - 0.5) * 0.3;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 0.3;
            positions[i * 3 + 2] = -Math.random() * 0.5;
        }
    }

    let offset;
    if (carMesh.userData.orientation === "Z") {
        offset = new THREE.Vector3(0, 0.25, -1.75);
    } else {
        offset = new THREE.Vector3(-1.75, 0.25, 0);
    }

    offset.applyQuaternion(carMesh.quaternion);
    turboFlames.position.copy(carMesh.position.clone().add(offset));

    turboFlames.geometry.attributes.position.needsUpdate = true;
}

// === PROGRESSO GARA ===
function updateRaceProgress() {
    if (!trackLoaded || !carMesh || !finishLine) return;

    const carPos = carMesh.position.clone();
    const roadWidth = trackData.roadWidth || 30;

    // 1. GESTIONE CHECKPOINT
    checkpoints.forEach((cp, index) => {
        if (!cp.userData.visual) return;

        if (index === nextCheckpoint) {
            // IL PROSSIMO: Coloriamolo di Ciano per evidenziarlo
            cp.userData.visual.material.color.set(0x00ffff);
            cp.userData.visual.material.emissive.set(0x00ffff);
            cp.userData.visual.material.opacity = 0.6;

            // Logica di collisione precisa (OBB)
            const localPos = cp.worldToLocal(carPos.clone());
            // Controlliamo se siamo dentro la larghezza (x) e vicini al piano (z)
            if (Math.abs(localPos.x) < roadWidth / 2 && Math.abs(localPos.z) < 6) {
                nextCheckpoint++;
                socket.emit("checkpoint_passed", nextCheckpoint);
                // Segnaliamo visivamente che è stato preso (Verde)
                cp.userData.visual.material.color.set(0x00ff00);
                cp.userData.visual.material.emissive.set(0x00ff00);
            }
        } else if (index < nextCheckpoint) {
            // GIA' PASSATI: Verde spento
            cp.userData.visual.material.color.set(0x00ff00);
            cp.userData.visual.material.opacity = 0.2;
        } else {
            // FUTURI: Giallo standard
            cp.userData.visual.material.color.set(0xffff00);
            cp.userData.visual.material.emissive.set(0xffff00);
            cp.userData.visual.material.opacity = 0.35;
        }
    });

    // 2. GESTIONE TRAGUARDO
    if (nextCheckpoint >= checkpoints.length) {
        const localPosFinish = finishLine.worldToLocal(carPos.clone());
        
        // Se passiamo il traguardo (entro la larghezza strada)
        if (Math.abs(localPosFinish.x) < roadWidth / 2 && Math.abs(localPosFinish.z) < 8) {
            currentLap++;
            nextCheckpoint = 0;
            socket.emit("lap_completed", currentLap);

            // Reset visivo di tutti i checkpoint per il nuovo giro
            checkpoints.forEach(cp => {
                if(cp.userData.visual) {
                    cp.userData.visual.material.color.set(0xffff00);
                    cp.userData.visual.material.opacity = 0.35;
                }
            });

            if (currentLap >= totalLaps) {
                socket.emit("race_finished");
            }
        }
    }
}

// === CARICAMENTO AUTO PRINCIPALE ===
function loadMyCar(path, material, spawnPos) {

    carBody = new CANNON.Body({
        mass: 500,
        shape: new CANNON.Box(new CANNON.Vec3(1, 1, 1)),
        position: new CANNON.Vec3(spawnPos.x, spawnPos.y, spawnPos.z),
        material: material
    });

    if (spawnPos.rotY !== undefined) {
        carBody.quaternion.setFromEuler(0, spawnPos.rotY, 0);
    }

    carBody.angularFactor = new CANNON.Vec3(0, 1, 0);
    carBody.angularDamping = 0.4;
    carBody.linearDamping = 0.05;

    world.addBody(carBody);

    carBody.addEventListener("collide", (e) => {
        const contact = e.contact;
        if (!contact) return;

        const normal = new CANNON.Vec3().copy(contact.ni);
        normal.normalize();
        normal.negate(normal);

        const relVel = contact.getImpactVelocityAlongNormal();

        if (relVel > 0.5) {
            const impulse = normal.scale(relVel * 140);
            carBody.applyImpulse(impulse, carBody.position);
        }
    });

    new THREE.GLTFLoader().load(path, (gltf) => {
        carMesh = normalizeModel(gltf.scene);
        carMesh.userData.orientation = getCarOrientation(carMesh);
        processCarMaterials(carMesh, carColor, true);
        scene.add(carMesh);

        document.getElementById("loading-overlay").style.display = "none";
        
        // 2. Se sono l'host, dico al server di far partire il countdown per tutti
        // (Aggiungiamo un piccolo delay di 1 secondo per far ambientare l'occhio del giocatore)
        if (CURRENT_USER_ID === lobbyHostId) { // Assicurati di passare l'ID host nel template
            setTimeout(() => {
                socket.emit("request_countdown", { lobbyCode: LOBBY_CODE });
            }, 1500);
        }

        const box = new THREE.Box3().setFromObject(carMesh);
        const size = box.getSize(new THREE.Vector3());

        const halfExtents = new CANNON.Vec3(
            size.x * 0.48,
            size.y * 0.25,
            size.z * 0.48
        );

        carBody.shapes = [];
        carBody.addShape(new CANNON.Box(halfExtents));

        createDriftSmoke();
        createTurboFlames();

        document.getElementById("loading-overlay").style.display = "none";
        setupControls();
    });

}

// === LOGICA DI GIOCO ===
let bots = []; 

function updateLogic() {
    world.step(1 / 60);
    if (!carBody || !carMesh) return;

    if (!raceStarted) {
        carMesh.position.copy(carBody.position);
        carMesh.quaternion.copy(carBody.quaternion);
        renderer.render(scene, camera);
        return;
    }

    // --- LOGICA GIOCATORE LOCALE ---
    let maxSpeed = (carStats.speed / 100) * 50 + 30;
    let accelForce = ((carStats.accel / 100) * 30 + 8) * ACCEL_STRENGTH;
    const steerStrength = (carStats.handling / 100) * 1.4 + 1.1;

    const q = carBody.quaternion;
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

    const forwardVel = carBody.velocity.dot(new CANNON.Vec3(forward.x, forward.y, forward.z));
    const sideVel = carBody.velocity.dot(new CANNON.Vec3(right.x, right.y, right.z));

    // Turbo e Superfici (Asfalto/Terra)
    if (turboActive) {
        accelForce *= 1.8;
        maxSpeed *= 1.4;
        turboTimer -= 1/60;
        if (turboTimer <= 0) {
            turboActive = false;
            // ... gestione UI turbo ...
        }
    }

    const surf = getSurfaceGrip();
    maxSpeed *= surf.penalty;
    accelForce *= surf.penalty;

    let lateralGrip = drifting ? surf.grip * 0.25 : surf.grip * 0.96;
    let steerBoost = drifting ? 1.6 : 1.0;

    carBody.velocity.x -= right.x * sideVel * lateralGrip;
    carBody.velocity.z -= right.z * sideVel * lateralGrip;

    // Input W/S
    if (keys.w && forwardVel < maxSpeed) {
        carBody.applyForce(new CANNON.Vec3(forward.x * accelForce, 0, forward.z * accelForce), carBody.position);
    } else if (keys.s && forwardVel > -maxSpeed / 2) {
        carBody.applyForce(new CANNON.Vec3(-forward.x * accelForce * 0.6, 0, -forward.z * accelForce * 0.6), carBody.position);
    } else {
        carBody.velocity.x *= DRAG_COEFFICIENT;
        carBody.velocity.z *= DRAG_COEFFICIENT;
    }

    // Sterzo
    if (Math.abs(forwardVel) > 1) {
        const speedFactor = Math.min(Math.max(1.3 - Math.abs(forwardVel) / maxSpeed, 0.6), 1.0);
        const dir = forwardVel > 0 ? 1 : -1;
        if (keys.a) carBody.angularVelocity.y = steerStrength * steerBoost * dir * speedFactor;
        else if (keys.d) carBody.angularVelocity.y = -steerStrength * steerBoost * dir * speedFactor;
        else carBody.angularVelocity.y *= 0.7;
    }

    // Sync Mesh Giocatore
    carBody.quaternion.x = 0;
    carBody.quaternion.z = 0;
    carMesh.position.copy(carBody.position);
    carMesh.quaternion.copy(carBody.quaternion);

    // --- LOGICA BOT (Solo per l'Host) ---
    if (myUserId === lobbyHostId) {
        bots.forEach(bot => updateBotAI(bot));
    }


    // Sync Altri Giocatori e Bot (Ricevuti dal server)
    Object.values(otherPlayers).forEach(p => {
        if (p.mesh) {
            // Se è un bot o un altro player, aggiorniamo la mesh con i dati ricevuti
            // (La logica di lerp/smooth va qui se necessario)
            if (p.body) {
                p.mesh.position.copy(p.body.position);
                p.mesh.quaternion.copy(p.body.quaternion);
            }
        }
    });

    // Effetti e UI
    updateDriftSmoke();
    updateTurboFlames();
    updateRaceProgress();
    updateMinimap();

    // Camera
    const camOffset = new THREE.Vector3(0, 4, -11).applyQuaternion(carMesh.quaternion);
    camera.position.lerp(carMesh.position.clone().add(camOffset), 0.12);
    camera.lookAt(carMesh.position);

    // Dynamic FOV e UI Speed
    const dynamicFOV = BASE_FOV + (Math.abs(forwardVel) / maxSpeed) * 15;
    camera.fov = THREE.MathUtils.lerp(camera.fov, dynamicFOV, 0.05);
    camera.updateProjectionMatrix();

    const speedEl = document.getElementById("speed-val");
    if (speedEl) speedEl.innerText = Math.abs(Math.round(forwardVel * 3.6));

    // Invio posizione locale
    socket.emit("update_position", {
        x: carBody.position.x,
        y: carBody.position.y,
        z: carBody.position.z,
        qx: carBody.quaternion.x,
        qy: carBody.quaternion.y,
        qz: carBody.quaternion.z,
        qw: carBody.quaternion.w,
        modelPath: myModelPath,
        color: carColor
    });
}

// === ANIMAZIONE ===
function animate() {
    requestAnimationFrame(animate);
    scene.traverse(obj => {
    if (obj.userData.pulse) {
            const t = performance.now() * 0.003;
            obj.material.opacity = 0.25 + Math.sin(t) * 0.15;
        }
    });

    updateLogic();
    renderer.render(scene, camera);
}

// === CONTROLLI ===
function setupControls() {
    const h = (e, v) => {
        const k = e.key.toLowerCase();

        if (!raceStarted) return;

        if (k === "w" || k === "arrowup") keys.w = v;
        if (k === "s" || k === "arrowdown") keys.s = v;
        if (k === "a" || k === "arrowleft") keys.a = v;
        if (k === "d" || k === "arrowright") keys.d = v;

        if (e.key === "Shift") drifting = v;

        if (e.code === "Space" && v === true && turboReady && !turboActive) {
            turboActive = true;
            turboReady = false;
            turboTimer = 2.5;

            const turboEl = document.getElementById("turbo-status");
            if (turboEl) turboEl.innerText = "TURBO ACTIVE";

            setTimeout(() => {
                turboReady = true;
                if (turboEl) turboEl.innerText = "TURBO READY";
            }, 15000);
        }
    };

    window.addEventListener("keydown", e => h(e, true));
    window.addEventListener("keyup", e => h(e, false));
}

// === MULTIPLAYER ===
function setupSocketListeners() {
    socket.on("player_moved", (data) => {
        if (data.user_id === myUserId) return;

        if (!otherPlayers[data.user_id]) {
            createOtherPlayer(data.user_id, data);
        } else {
            const p = otherPlayers[data.user_id];
            p.body.position.set(data.x, data.y, data.z);
            p.body.quaternion.set(data.qx, data.qy, data.qz, data.qw);

            if (p.mesh) {
                p.mesh.position.copy(p.body.position);
                p.mesh.quaternion.copy(p.body.quaternion);
            }
        }
    });

    // Riceve il comando di inizio countdown
    socket.on("race_countdown", data => {
        const cd = document.getElementById("countdown");
        if (!cd) return;

        cd.style.display = "block";
        let count = data.seconds || 3;
        cd.innerText = count;
        
        raceStarted = false; // Blocca i comandi durante il 3, 2, 1

        const timer = setInterval(() => {
            count--;
            if (count > 0) {
                cd.innerText = count;
            } else if (count === 0) {
                cd.innerText = "GO!";
                raceStarted = true; // SBLOCCA I COMANDI
            } else {
                clearInterval(timer);
                cd.style.display = "none";
            }
        }, 1000);
    });

    socket.on("bot_spawn", data => {
        console.log("🔥 BOT SPAWN EVENT RECEIVED:", data);
        spawnBotClientSide(data);
    });

    socket.on("race_start", () => {
        raceStarted = true;
    });

    socket.on("standings_update", (standings) => {
        const posLabel = document.getElementById("position-label");
        const lapLabel = document.getElementById("lap-label");
        if (!posLabel || !lapLabel || !myUserId) return;

        let myPos = null;
        let myLap = 0;

        standings.forEach((entry, index) => {
            const userId = entry[0];
            const data = entry[1];
            if (userId === myUserId) {
                myPos = index + 1;
                myLap = data.lap;
            }
        });

        if (myPos !== null) {
            posLabel.innerText = `${myPos}°`;
        } else {
            posLabel.innerText = "N/A";
        }

        lapLabel.innerText = `LAP ${Math.min(myLap + 1, totalLapsClient)} / ${totalLapsClient}`;
    });

    socket.on("race_results", data => {
        // redirect alla pagina podio
        window.location.href = `/race/results/${LOBBY_CODE}`;
    });

    socket.on("player_disconnected", (id) => {
        if (otherPlayers[id]) {
            if (otherPlayers[id].mesh) scene.remove(otherPlayers[id].mesh);
            if (otherPlayers[id].body) world.removeBody(otherPlayers[id].body);
            delete otherPlayers[id];
        }
    });
}

// === CREAZIONE ALTRI GIOCATORI ===
function createOtherPlayer(id, data) {
    if (otherPlayers[id]) return;

    const body = new CANNON.Body({
        mass: 500,
        shape: new CANNON.Box(new CANNON.Vec3(1, 1, 1)),
        position: new CANNON.Vec3(data.x, data.y, data.z)
    });

    body.angularFactor = new CANNON.Vec3(0, 1, 0);
    body.angularDamping = 0.4;
    body.linearDamping = 0.05;

    world.addBody(body);

    otherPlayers[id] = { mesh: null, body };

    const modelToLoad = data.modelPath || "/static/models/auto.glb";

    new THREE.GLTFLoader().load(modelToLoad, (gltf) => {
        const mesh = normalizeModel(gltf.scene);
        processCarMaterials(mesh, data.color || "#ffffff", false);
        scene.add(mesh);
        otherPlayers[id].mesh = mesh;

        const box = new THREE.Box3().setFromObject(mesh);
        const size = box.getSize(new THREE.Vector3());

        const halfExtents = new CANNON.Vec3(
            size.x * 0.48,
            size.y * 0.25,
            size.z * 0.48
        );

        body.shapes = [];
        body.addShape(new CANNON.Box(halfExtents));
    });
}

// === MINIMAP ===
function updateMinimap() {
    if (!minimapCtx || !carMesh || !trackData) return;

    const ctx = minimapCtx;
    const w = minimapCanvas.width;
    const h = minimapCanvas.height;

    ctx.clearRect(0, 0, w, h);

    // === SFONDO (terreno) ===
    ctx.fillStyle = "#3b2a16"; 
    ctx.fillRect(0, 0, w, h);

    const { minX, maxX, minZ, maxZ } = trackData.terrain;
    const worldW = maxX - minX;
    const worldH = maxZ - minZ;

    minimapScale = Math.min(w / worldW, h / worldH);

    function worldToMini(x, z) {
        return {
            x: (x - minX) * minimapScale,
            y: (z - minZ) * minimapScale
        };
    }

    const roadWidth = trackData.roadWidth || 14;
    const centerPoints = trackData.points.map(cp => new THREE.Vector3(cp.x, cp.y || 0, cp.z));
    const curve = new THREE.CatmullRomCurve3(centerPoints, true);
    const segments = Math.max(200, Math.floor(curve.getLength() / 1));

    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = curve.getPoint(t);
        const tangent = curve.getTangent(t).normalize();

        const left = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(roadWidth / 2);
        const right = left.clone().multiplyScalar(-1);

        leftPts.push(p.clone().add(left));
        rightPts.push(p.clone().add(right));
    }

    // === ASFALTO ===
    ctx.fillStyle = "#555555"; 
    ctx.beginPath();

    for (let i = 0; i < leftPts.length; i++) {
        const p = worldToMini(leftPts[i].x, leftPts[i].z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    }

    for (let i = rightPts.length - 1; i >= 0; i--) {
        const p = worldToMini(rightPts[i].x, rightPts[i].z);
        ctx.lineTo(p.x, p.y);
    }

    ctx.closePath();
    ctx.fill();

    // === BORDI STRADA ===
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 2;

    ctx.beginPath();
    leftPts.forEach((pt, i) => {
        const p = worldToMini(pt.x, pt.z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    ctx.beginPath();
    rightPts.forEach((pt, i) => {
        const p = worldToMini(pt.x, pt.z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // === CHECKPOINTS ===
    if (trackData.points && trackData.points.length > 0) {
        for (let i = 0; i < trackData.points.length; i++) {
            const cp = trackData.points[i];
            const p = worldToMini(cp.x, cp.z);
            ctx.fillStyle = (i === nextCheckpoint % trackData.points.length) ? "#ffff00" : "#ffcc33";
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // === FINISH ===
    if (trackData.finish) {
        const f = worldToMini(trackData.finish.x, trackData.finish.z);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(f.x, f.y, 5, 0, Math.PI * 2);
        ctx.fill();
    }

    // === ALTRI GIOCATORI ===
    Object.values(otherPlayers).forEach(p => {
        if (!p.mesh) return;
        const pos = worldToMini(p.mesh.position.x, p.mesh.position.z);
        drawCarIcon(ctx, pos.x, pos.y, getYawFromQuaternion(p.mesh.quaternion), "#00f2ff");
    });

    // === MIA AUTO ===
    const me = worldToMini(carMesh.position.x, carMesh.position.z);
    drawCarIcon(ctx, me.x, me.y, getYawFromQuaternion(carMesh.quaternion), "#ff0000");

    function drawCarIcon(ctx, x, y, angle, color) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(4, 6);
        ctx.lineTo(-4, 6);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }

    function getYawFromQuaternion(q) {
        const siny = 2 * (q.w * q.y + q.z * q.x);
        const cosy = 1 - 2 * (q.y * q.y + q.x * q.x);
        return Math.atan2(siny, cosy);
    }
}

// === BOT ===
function updateBotAI(bot) {
    if (!trackData || !trackData.points) return;

    const pts = trackData.points;
    const target = pts[bot.targetIndex];

    const botPos = bot.mesh.position;
    const dir = new THREE.Vector3(
        target.x - botPos.x,
        0,
        target.z - botPos.z
    );

    const dist = dir.length();

    dir.normalize();
    bot.mesh.position.add(dir.multiplyScalar(0.6));

    bot.mesh.lookAt(target.x, botPos.y, target.z);

    if (dist < 5) {
        bot.targetIndex = (bot.targetIndex + 1) % pts.length;
        console.log(`➡️ BOT ${bot.id} switching to waypoint ${bot.targetIndex}`);
    }

    // LOG DI MOVIMENTO
    console.log(`🏎️ BOT ${bot.id} moved to:`, {
        x: bot.mesh.position.x.toFixed(2),
        y: bot.mesh.position.y.toFixed(2),
        z: bot.mesh.position.z.toFixed(2)
    });

    socket.emit("update_position", {
        x: bot.mesh.position.x,
        y: bot.mesh.position.y,
        z: bot.mesh.position.z,
        rotY: bot.mesh.rotation.y,
        user_id: bot.id,
        username: bot.username
    });
}


function spawnBotClientSide(data) {
    console.log(`🚗 Spawning bot ${data.bot_id} (${data.username}) with model ${data.modelPath}`);

    const { bot_id, username, modelPath, color } = data;

    new THREE.GLTFLoader().load(modelPath, gltf => {
        const mesh = normalizeModel(gltf.scene);
        processCarMaterials(mesh, color, false);
        scene.add(mesh);

        const bot = {
            id: bot_id,
            username,
            mesh,
            targetIndex: 0,
            speed: 0,
        };

        bots.push(bot);

        console.log(`✅ BOT ${bot_id} spawned successfully`);
    });
}



