// === GLOBALS ===
let scene, camera, renderer, world, carBody, carMesh;
let wheelMaterial;
let colorableParts = [];
let otherPlayers = {};   // user_id -> { mesh, body }
let bots = {};           // bot_id -> { mesh, body, username, halfY, ai }
let socket;
let myModelPath;
let lobbyCode = null;
let lobbyHostId = null;
let myUserId = null;
let isHost = false;
let practiceMode = false;

// TURBO
let turboActive = false;
let turboReady = true;
let turboTimer = 0;

// DRIFT
let drifting = false;

// PARTICLES
let driftSmokeLeft = null;
let driftSmokeRight = null;
let turboFlames = null;

// RACE / TRACK
let trackData = null;
let trackCurve = null;
let trackLength = 0;
let trackSamples = [];   // pre-sampled centreline points used for fast nearest-point lookups
let checkpoints = [];
let finishLine = null;
let nextCheckpoint = 0;
let currentLap = 0;
let totalLaps = 0;
let trackLoaded = false;
let raceStarted = false;
let myFinished = false;

// SPECTATOR CAMERA (after you cross the line)
let spectateIndex = 0;
let spectateTimer = null;

// MINIMAP
let minimapCanvas = null;
let minimapCtx = null;
let minimapBackground = null;
let minimapScale = 0.04;

let frameCount = 0;

const keys = { w: false, a: false, s: false, d: false };
let carStats = { speed: 1, accel: 1, handling: 1 };
let carColor = "#39ff14";

const ACCEL_STRENGTH = 1000;
const DRAG_COEFFICIENT = 0.96;
const BASE_FOV = 60;
const PHYSICS_DT = 1 / 60;

// === GAME SETUP ===
export function initGame(config) {
    socket = config.socket;
    carStats = config.stats;
    carColor = config.carColor;
    myModelPath = config.modelPath;
    myUserId = Number(config.userId);
    lobbyCode = config.lobbyCode;
    lobbyHostId = Number(config.lobbyHostId);
    practiceMode = !!config.practiceMode;
    isHost = !practiceMode && myUserId === lobbyHostId;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000105);

    camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 5000);

    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.getElementById("canvas-container").appendChild(renderer.domElement);

    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // MINIMAP
    minimapCanvas = document.getElementById("minimap-canvas");
    minimapCtx = minimapCanvas.getContext("2d");

    // === PHYSICS ===
    world = new CANNON.World();
    world.gravity.set(0, -35, 0);

    const groundMaterial = new CANNON.Material("groundMaterial");
    wheelMaterial = new CANNON.Material("wheelMaterial");

    world.addContactMaterial(new CANNON.ContactMaterial(
        groundMaterial,
        wheelMaterial,
        { friction: 0.0, restitution: 0.05 }
    ));

    // LIGHTS
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(10, 50, 10);
    scene.add(sun);

    // GROUND
    const groundBody = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Plane(),
        material: groundMaterial
    });
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    world.addBody(groundBody);

    setupSocketListeners();

    // === TRACK LOADING ===
    // The car is spawned only once the track is ready, because the spawn
    // height and direction are read from the track spline.
    const trackUrl = practiceMode ? "/static/json/tracks/freeTrack.json" : TRACK_JSON;

    fetch(trackUrl)
        .then(res => res.json())
        .then(data => {
            trackData = data;
            totalLaps = practiceMode ? 0 : data.laps;

            createTrack();
            buildMinimapBackground();

            if (practiceMode) {
                raceStarted = true;
                trackLoaded = true;
                updateLapLabel();
                spawnMyCar((data.spawnPoints && data.spawnPoints[0]) || { x: 0, y: 0, z: 0 });
                return;
            }

            createTrackObjects();
            trackLoaded = true;
            updateLapLabel();
            requestSpawn();
            socket.emit("request_bots", { code: lobbyCode });
        })
        .catch(err => {
            console.error("Failed to load track:", err);
            document.getElementById("loading-overlay").innerText = "FAILED TO LOAD TRACK";
        });

    animate();
}

function requestSpawn() {
    let spawned = false;

    socket.once("spawn_data", (data) => {
        if (spawned) return;
        spawned = true;
        spawnMyCar(data.spawnPos);
    });
    socket.emit("request_spawn_point");

    setTimeout(() => {
        if (!spawned) {
            spawned = true;
            console.warn("Spawn point not received in time, using the first spawn point.");
            spawnMyCar((trackData.spawnPoints && trackData.spawnPoints[0]) || { x: 0, y: 0, z: 0 });
        }
    }, 3000);
}

function spawnMyCar(spawnPos) {
    const sp = { ...spawnPos };
    sp.y = getRoadHeightAt(sp.x, sp.z) + 1;
    sp.rotY = getRoadDirectionAt(sp.x, sp.z);
    loadMyCar(myModelPath, wheelMaterial, sp);
}

// === TRACK SPLINE HELPERS ===
function getTrackCurve() {
    if (!trackCurve) {
        const pts = trackData.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
        trackCurve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.5);
        trackLength = trackCurve.getLength();

        const steps = 400;
        trackSamples = [];
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            trackSamples.push({ t, p: trackCurve.getPoint(t) });
        }
    }
    return trackCurve;
}

// Spline parameter (0..1) of the centreline point closest to (x, z)
function findNearestT(x, z) {
    getTrackCurve();

    let bestT = 0;
    let bestDist = Infinity;
    for (const s of trackSamples) {
        const d = (s.p.x - x) ** 2 + (s.p.z - z) ** 2;
        if (d < bestDist) {
            bestDist = d;
            bestT = s.t;
        }
    }
    return bestT;
}

function getRoadHeightAt(x, z) {
    return getTrackCurve().getPoint(findNearestT(x, z)).y;
}

function getRoadDirectionAt(x, z) {
    const tangent = getTrackCurve().getTangent(findNearestT(x, z)).normalize();
    return Math.atan2(tangent.x, tangent.z);
}

// === TRACK OBJECTS ===
function createTrackObjects() {
    if (!trackData) return;

    const f = trackData.finish;
    finishLine = createTrigger(f.x, f.y, f.z);

    checkpoints = [];
    trackData.points.forEach((cp, i) => {
        const trigger = createTrigger(cp.x, cp.y, cp.z);
        trigger.userData.index = i;
        checkpoints.push(trigger);
    });

    nextCheckpoint = 0;
    currentLap = 0;
    createFinishLineVisual(f.x, f.y, f.z);
}

function createTrigger(x, y, z) {
    // Invisible box as wide as the road, aligned with the track direction
    const roadWidth = trackData.roadWidth || 30;
    const geo = new THREE.BoxGeometry(roadWidth, 10, 4);

    const mat = new THREE.MeshBasicMaterial({ visible: false });
    const trigger = new THREE.Mesh(geo, mat);
    trigger.position.set(x, y + 2.5, z);

    const angle = getRoadDirectionAt(x, z);
    trigger.rotation.y = angle;
    scene.add(trigger);

    // Coloured stripe on the asphalt
    const stripeGeo = new THREE.PlaneGeometry(roadWidth, 3);
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
    const angle = getRoadDirectionAt(x, z);

    mesh.position.set(x, y + 0.15, z);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = angle;

    // Chequered texture
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
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;

    mat.map = tex;
    mat.needsUpdate = true;

    scene.add(mesh);
}

// === TRACK ===
function createTrack() {
    if (!trackData) return;

    createTerrain();

    const { minX, maxX, minZ, maxZ } = trackData.terrain;
    createBoundaryWalls(minX, maxX, minZ, maxZ);

    createRoad();
}

function createTerrain() {
    const { minX, maxX, minZ, maxZ } = trackData.terrain;

    const geo = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ);
    const mat = new THREE.MeshStandardMaterial({
        color: 0x3b2a16,
        roughness: 1
    });

    const terrain = new THREE.Mesh(geo, mat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    terrain.receiveShadow = true;
    scene.add(terrain);
}

function createBoundaryWalls(minX, maxX, minZ, maxZ, height = 5, thickness = 2) {
    const wallMaterial = new THREE.MeshStandardMaterial({
        color: 0x111111,
        roughness: 1
    });

    function makeWall(x, y, z, w, h, d) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMaterial);
        mesh.position.set(x, y + h / 2, z);
        mesh.castShadow = true;
        scene.add(mesh);

        world.addBody(new CANNON.Body({
            mass: 0,
            shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)),
            position: new CANNON.Vec3(x, y + h / 2, z)
        }));
    }

    const width = maxX - minX;
    const depth = maxZ - minZ;

    makeWall((minX + maxX) / 2, 0, maxZ, width, height, thickness);
    makeWall((minX + maxX) / 2, 0, minZ, width, height, thickness);
    makeWall(maxX, 0, (minZ + maxZ) / 2, thickness, height, depth);
    makeWall(minX, 0, (minZ + maxZ) / 2, thickness, height, depth);
}

function createRoad() {
    if (!trackData || !trackData.points) return;

    const roadWidth = trackData.roadWidth || 12;
    const curve = getTrackCurve();

    const segments = 400;
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = curve.getPoint(t);
        const tangent = curve.getTangent(t).normalize();
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

        const L = p.clone().add(normal.clone().multiplyScalar(roadWidth / 2));
        const R = p.clone().add(normal.clone().multiplyScalar(-roadWidth / 2));

        positions.push(L.x, 0.05, L.z);
        positions.push(R.x, 0.05, R.z);

        uvs.push(0, t * 5);
        uvs.push(1, t * 5);
    }

    for (let i = 0; i < segments; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2);
        indices.push(a + 1, a + 3, a + 2);
    }

    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    roadGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    roadGeo.setIndex(indices);
    roadGeo.computeVertexNormals();

    const roadMesh = new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({
        color: 0x555555,
        roughness: 0.8,
        metalness: 0.1,
        side: THREE.DoubleSide
    }));
    roadMesh.receiveShadow = true;
    scene.add(roadMesh);
}

// === ASPHALT / DIRT GRIP ===
function getSurfaceGrip() {
    if (!trackData || !trackData.points || !carMesh) return { grip: 0.6, penalty: 1 };

    const curve = getTrackCurve();
    const carPos = carMesh.position;
    const t = findNearestT(carPos.x, carPos.z);

    const center = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

    // Perpendicular distance from the centre of the road
    const distFromCenter = Math.abs(carPos.clone().sub(center).dot(normal));
    const roadWidth = trackData.roadWidth || 14;

    if (distFromCenter <= roadWidth * 0.5) {
        return { grip: 1.0, penalty: 1.0 };
    }

    // Off-road: less grip and lower speed, the further out the worse
    const overflow = distFromCenter - roadWidth * 0.5;
    const k = Math.min(overflow / (roadWidth * 0.8), 1);

    return {
        grip: 1.0 - k * 0.7,
        penalty: 1.0 - k * 0.5
    };
}

// === MODEL NORMALISATION ===
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

function getCarOrientation(mesh) {
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    return size.z > size.x ? "Z" : "X";
}

function processCarMaterials(mesh, hexColor, isMain = false) {
    const targetColor = new THREE.Color(hexColor);

    mesh.traverse(node => {
        if (node.isMesh && !node.userData.isOutline) {
            const name = (node.name + " " + (node.material.name || "")).toLowerCase();

            if (/body|paint|frame|metal/.test(name)) {
                node.material = new THREE.MeshToonMaterial({ color: targetColor });
                if (isMain) colorableParts.push(node.material);
            } else if (/glass|window/.test(name)) {
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

// Loads a car model and resizes its physics box to match. Returns the half height.
function loadCarModel(path, color, body, onLoaded) {
    new THREE.GLTFLoader().load(path, (gltf) => {
        const mesh = normalizeModel(gltf.scene);
        processCarMaterials(mesh, color || "#ffffff", false);
        scene.add(mesh);

        const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
        body.shapes = [];
        body.shapeOffsets = [];
        body.shapeOrientations = [];
        body.addShape(new CANNON.Box(new CANNON.Vec3(size.x * 0.48, size.y * 0.25, size.z * 0.48)));

        onLoaded(mesh, size.y * 0.25);
    });
}

// === DRIFT SMOKE ===
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

        return new THREE.Points(geo, new THREE.PointsMaterial({
            color: 0x999999,
            size: 0.45,
            transparent: true,
            opacity: 0.85,
            depthWrite: false
        }));
    }

    driftSmokeLeft = makeSmoke();
    driftSmokeRight = makeSmoke();

    driftSmokeLeft.visible = false;
    driftSmokeRight.visible = false;

    scene.add(driftSmokeLeft);
    scene.add(driftSmokeRight);
}

function updateDriftSmoke() {
    if (!driftSmokeLeft || !driftSmokeRight) return;

    if (!drifting || (!keys.a && !keys.d) || !carMesh) {
        driftSmokeLeft.visible = false;
        driftSmokeRight.visible = false;
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

// === TURBO FLAMES ===
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

    turboFlames = new THREE.Points(flameGeo, new THREE.PointsMaterial({
        color: 0xff3300,
        size: 0.75,
        transparent: true,
        opacity: 1.0,
        depthWrite: false
    }));
    turboFlames.visible = false;
    scene.add(turboFlames);
}

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

    const offset = carMesh.userData.orientation === "Z"
        ? new THREE.Vector3(0, 0.25, -1.75)
        : new THREE.Vector3(-1.75, 0.25, 0);

    offset.applyQuaternion(carMesh.quaternion);
    turboFlames.position.copy(carMesh.position.clone().add(offset));

    turboFlames.geometry.attributes.position.needsUpdate = true;
}

// === RACE PROGRESS ===
function updateRaceProgress() {
    if (practiceMode || myFinished || !trackLoaded || !carMesh || !finishLine) return;

    const carPos = carMesh.position.clone();
    const roadWidth = trackData.roadWidth || 30;

    // 1. Checkpoints
    checkpoints.forEach((cp, index) => {
        const mat = cp.userData.visual.material;

        if (index === nextCheckpoint) {
            // Next one: highlighted in cyan
            mat.color.set(0x00ffff);
            mat.emissive.set(0x00ffff);
            mat.opacity = 0.6;

            const localPos = cp.worldToLocal(carPos.clone());
            if (Math.abs(localPos.x) < roadWidth / 2 && Math.abs(localPos.z) < 6) {
                nextCheckpoint++;
                socket.emit("checkpoint_passed", nextCheckpoint);
            }
        } else if (index < nextCheckpoint) {
            // Already passed: dim green
            mat.color.set(0x00ff00);
            mat.emissive.set(0x00ff00);
            mat.opacity = 0.2;
        } else {
            // Still to come: yellow
            mat.color.set(0xffff00);
            mat.emissive.set(0xffff00);
            mat.opacity = 0.35;
        }
    });

    // 2. Finish line
    if (nextCheckpoint >= checkpoints.length) {
        const localPosFinish = finishLine.worldToLocal(carPos.clone());

        if (Math.abs(localPosFinish.x) < roadWidth / 2 && Math.abs(localPosFinish.z) < 8) {
            currentLap++;
            nextCheckpoint = 0;
            socket.emit("lap_completed", currentLap);

            if (currentLap >= totalLaps) {
                finishMyRace();
            }
            updateLapLabel();
        }
    }
}

function finishMyRace() {
    myFinished = true;
    turboActive = false;
    drifting = false;
    Object.keys(keys).forEach(k => keys[k] = false);

    socket.emit("race_finished");
    showBanner("FINISH!", 2500);
    startSpectating();
}

function updateLapLabel() {
    const lapLabel = document.getElementById("lap-label");
    if (!lapLabel) return;

    if (practiceMode) lapLabel.innerText = "PRACTICE";
    else if (myFinished) lapLabel.innerText = "FINISHED - WAITING FOR OTHERS";
    else lapLabel.innerText = `LAP ${Math.min(currentLap + 1, totalLaps)} / ${totalLaps}`;
}

function showBanner(text, durationMs) {
    const el = document.getElementById("countdown");
    if (!el) return;
    el.innerText = text;
    el.style.display = "block";
    if (durationMs) setTimeout(() => { el.style.display = "none"; }, durationMs);
}

// === PLAYER CAR ===
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
            carBody.applyImpulse(normal.scale(relVel * 140), carBody.position);
        }
    });

    new THREE.GLTFLoader().load(path, (gltf) => {
        carMesh = normalizeModel(gltf.scene);
        carMesh.userData.orientation = getCarOrientation(carMesh);
        processCarMaterials(carMesh, carColor, true);
        scene.add(carMesh);

        const size = new THREE.Box3().setFromObject(carMesh).getSize(new THREE.Vector3());
        carBody.shapes = [];
        carBody.shapeOffsets = [];
        carBody.shapeOrientations = [];
        carBody.addShape(new CANNON.Box(new CANNON.Vec3(size.x * 0.48, size.y * 0.25, size.z * 0.48)));

        createDriftSmoke();
        createTurboFlames();
        setupControls();

        document.getElementById("loading-overlay").style.display = "none";

        // The host starts the countdown for everyone once its car is on the grid
        if (isHost) {
            setTimeout(() => {
                socket.emit("request_countdown", { lobbyCode: lobbyCode });
            }, 1500);
        }
    });
}

// === GAME LOOP ===
function updateLogic() {
    world.step(PHYSICS_DT);
    updateBotsAI(PHYSICS_DT);
    syncRemoteMeshes();

    if (!carBody || !carMesh) return;

    if (!raceStarted || myFinished) {
        // Waiting for the start, or coasting after the finish line
        if (myFinished) {
            carBody.velocity.x *= 0.97;
            carBody.velocity.z *= 0.97;
        }
        carBody.quaternion.x = 0;
        carBody.quaternion.z = 0;
        carMesh.position.copy(carBody.position);
        carMesh.quaternion.copy(carBody.quaternion);
        sendMyPosition();
        updateMinimap();
        updateCamera(0);
        return;
    }

    // --- LOCAL PLAYER ---
    let maxSpeed = (carStats.speed / 100) * 50 + 30;
    let accelForce = ((carStats.accel / 100) * 30 + 8) * ACCEL_STRENGTH;
    const steerStrength = (carStats.handling / 100) * 1.4 + 1.1;

    const q = carBody.quaternion;
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

    const forwardVel = carBody.velocity.dot(new CANNON.Vec3(forward.x, forward.y, forward.z));
    const sideVel = carBody.velocity.dot(new CANNON.Vec3(right.x, right.y, right.z));

    if (turboActive) {
        accelForce *= 1.8;
        maxSpeed *= 1.4;
        turboTimer -= PHYSICS_DT;
        if (turboTimer <= 0) {
            turboActive = false;
            setTurboStatus("TURBO RECHARGING");
        }
    }

    const surf = getSurfaceGrip();
    maxSpeed *= surf.penalty;
    accelForce *= surf.penalty;

    const lateralGrip = drifting ? surf.grip * 0.25 : surf.grip * 0.96;
    const steerBoost = drifting ? 1.6 : 1.0;

    carBody.velocity.x -= right.x * sideVel * lateralGrip;
    carBody.velocity.z -= right.z * sideVel * lateralGrip;

    // Throttle / brake
    if (keys.w && forwardVel < maxSpeed) {
        carBody.applyForce(new CANNON.Vec3(forward.x * accelForce, 0, forward.z * accelForce), carBody.position);
    } else if (keys.s && forwardVel > -maxSpeed / 2) {
        carBody.applyForce(new CANNON.Vec3(-forward.x * accelForce * 0.6, 0, -forward.z * accelForce * 0.6), carBody.position);
    } else {
        carBody.velocity.x *= DRAG_COEFFICIENT;
        carBody.velocity.z *= DRAG_COEFFICIENT;
    }

    // Steering
    if (Math.abs(forwardVel) > 1) {
        const speedFactor = Math.min(Math.max(1.3 - Math.abs(forwardVel) / maxSpeed, 0.6), 1.0);
        const dir = forwardVel > 0 ? 1 : -1;
        if (keys.a) carBody.angularVelocity.y = steerStrength * steerBoost * dir * speedFactor;
        else if (keys.d) carBody.angularVelocity.y = -steerStrength * steerBoost * dir * speedFactor;
        else carBody.angularVelocity.y *= 0.7;
    }

    carBody.quaternion.x = 0;
    carBody.quaternion.z = 0;
    carMesh.position.copy(carBody.position);
    carMesh.quaternion.copy(carBody.quaternion);

    updateDriftSmoke();
    updateTurboFlames();
    updateRaceProgress();
    updateMinimap();
    updateCamera(Math.abs(forwardVel) / maxSpeed);

    const speedEl = document.getElementById("speed-val");
    if (speedEl) speedEl.innerText = Math.abs(Math.round(forwardVel * 3.6));

    sendMyPosition();
}

function updateCamera(speedRatio) {
    // After finishing, follow the other cars still racing
    let target = carMesh;
    if (myFinished) {
        const others = getSpectateTargets();
        if (others.length > 0) target = others[spectateIndex % others.length];
    }

    const camOffset = new THREE.Vector3(0, 4, -11).applyQuaternion(target.quaternion);
    camera.position.lerp(target.position.clone().add(camOffset), 0.12);
    camera.lookAt(target.position);

    const dynamicFOV = BASE_FOV + speedRatio * 15;
    camera.fov = THREE.MathUtils.lerp(camera.fov, dynamicFOV, 0.05);
    camera.updateProjectionMatrix();
}

function getSpectateTargets() {
    return [...Object.values(otherPlayers), ...Object.values(bots)]
        .filter(p => p.mesh)
        .map(p => p.mesh);
}

function startSpectating() {
    if (spectateTimer) return;
    spectateIndex = 0;
    spectateTimer = setInterval(() => { spectateIndex++; }, 5000);
    updateLapLabel();
}

function sendMyPosition() {
    // 30 updates per second are plenty and halve the network traffic
    if (practiceMode || frameCount % 2 !== 0) return;

    socket.emit("update_position", {
        code: lobbyCode,
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

function syncRemoteMeshes() {
    for (const p of [...Object.values(otherPlayers), ...Object.values(bots)]) {
        if (p.mesh) {
            p.mesh.position.copy(p.body.position);
            p.mesh.quaternion.copy(p.body.quaternion);
        }
    }
}

function animate() {
    requestAnimationFrame(animate);
    frameCount++;
    updateLogic();
    renderer.render(scene, camera);
}

// === CONTROLS ===
function setTurboStatus(text) {
    const el = document.getElementById("turbo-status");
    if (el) el.innerText = text;
}

function setupControls() {
    const h = (e, pressed) => {
        // Releasing a key is always allowed, pressing only while racing
        if (pressed && (!raceStarted || myFinished)) return;

        const k = e.key.toLowerCase();
        if (k === "w" || k === "arrowup") keys.w = pressed;
        if (k === "s" || k === "arrowdown") keys.s = pressed;
        if (k === "a" || k === "arrowleft") keys.a = pressed;
        if (k === "d" || k === "arrowright") keys.d = pressed;

        if (e.key === "Shift") drifting = pressed;

        if (e.code === "Space" && pressed && turboReady && !turboActive) {
            turboActive = true;
            turboReady = false;
            turboTimer = 2.5;
            setTurboStatus("TURBO ACTIVE");

            setTimeout(() => {
                turboReady = true;
                setTurboStatus("TURBO READY");
            }, 15000);
        }
    };

    window.addEventListener("keydown", e => h(e, true));
    window.addEventListener("keyup", e => h(e, false));
}

// === MULTIPLAYER ===
function setupSocketListeners() {
    socket.on("player_moved", (data) => {
        if (Number(data.user_id) === myUserId) return;

        if (!otherPlayers[data.user_id]) {
            createOtherPlayer(data.user_id, data);
        }

        const p = otherPlayers[data.user_id];
        p.body.position.set(data.x, data.y, data.z);
        p.body.quaternion.set(data.qx ?? 0, data.qy ?? 0, data.qz ?? 0, data.qw ?? 1);
    });

    socket.on("race_countdown", data => {
        let count = data.seconds || 3;
        showBanner(count);
        raceStarted = false; // inputs are locked during 3, 2, 1

        const timer = setInterval(() => {
            count--;
            if (count > 0) {
                showBanner(count);
            } else if (count === 0) {
                showBanner("GO!");
                raceStarted = true;
            } else {
                clearInterval(timer);
                document.getElementById("countdown").style.display = "none";
            }
        }, 1000);
    });

    socket.on("bot_spawn_list", (list) => {
        list.forEach(spawnBot);
    });

    socket.on("bots_moved", (data) => {
        (data.bots || []).forEach(b => {
            const bot = bots[b.id];
            if (!bot) return;
            bot.body.position.set(b.x, b.y, b.z);
            bot.body.quaternion.set(b.qx, b.qy, b.qz, b.qw);
        });
    });

    socket.on("standings_update", (standings) => {
        const posLabel = document.getElementById("position-label");
        if (!posLabel) return;

        const index = standings.findIndex(entry => Number(entry.id) === myUserId);
        posLabel.innerText = index >= 0 ? `${index + 1} / ${standings.length}` : "-";
    });

    socket.on("race_results", () => {
        window.location.href = `/race/results/${lobbyCode}`;
    });

    socket.on("player_disconnected", (id) => {
        const p = otherPlayers[id];
        if (p) {
            if (p.mesh) scene.remove(p.mesh);
            world.removeBody(p.body);
            delete otherPlayers[id];
        }
    });
}

function createOtherPlayer(id, data) {
    // Remote cars are moved by the network, so they are kinematic: we can bump into
    // them, but our physics never pushes them around.
    const body = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        shape: new CANNON.Box(new CANNON.Vec3(1, 1, 1)),
        position: new CANNON.Vec3(data.x, data.y, data.z)
    });
    world.addBody(body);

    otherPlayers[id] = { mesh: null, body };

    if (!data.modelPath) return;
    loadCarModel(data.modelPath, data.color, body, (mesh) => {
        if (otherPlayers[id]) otherPlayers[id].mesh = mesh;
        else scene.remove(mesh);
    });
}

// === BOTS ===
// The host drives every bot along the track spline and broadcasts their
// positions and progress; the other clients only display them.
function spawnBot(data) {
    if (bots[data.bot_id] || !trackData) return;

    const curve = getTrackCurve();
    const sp = data.spawnPos;
    const startT = findNearestT(sp.x, sp.z);
    const center = curve.getPoint(startT);
    const tangent = curve.getTangent(startT).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const lateral = (sp.x - center.x) * normal.x + (sp.z - center.z) * normal.z;

    const body = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        shape: new CANNON.Box(new CANNON.Vec3(1, 1, 1)),
        position: new CANNON.Vec3(sp.x, center.y + 1, sp.z)
    });
    body.quaternion.setFromEuler(0, Math.atan2(tangent.x, tangent.z), 0);
    world.addBody(body);

    const laneIndex = Object.keys(bots).length;
    const roadWidth = trackData.roadWidth || 30;
    const stats = data.stats || { speed: 50 };
    const botMaxSpeed = (stats.speed / 100) * 50 + 30;

    const bot = {
        username: data.username,
        body,
        mesh: null,
        halfY: 1,
        ai: {
            startT,
            progress: 0,
            lateral,
            targetLateral: ((laneIndex % 3) - 1) * roadWidth * 0.22,
            speed: botMaxSpeed * (0.62 + Math.random() * 0.12),
            finished: false
        }
    };
    bots[data.bot_id] = bot;

    loadCarModel(data.modelPath, data.color, body, (mesh, halfY) => {
        bot.mesh = mesh;
        bot.halfY = halfY;
        if (isHost) placeBot(bot);
    });
}

function placeBot(bot) {
    const curve = getTrackCurve();
    const t = (bot.ai.startT + bot.ai.progress) % 1;
    const p = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);

    bot.body.position.set(
        p.x + normal.x * bot.ai.lateral,
        p.y + bot.halfY,
        p.z + normal.z * bot.ai.lateral
    );
    bot.body.quaternion.setFromEuler(0, Math.atan2(tangent.x, tangent.z), 0);
}

function updateBotsAI(dt) {
    if (!isHost || !raceStarted || !trackData || trackLength === 0) return;

    const ids = Object.keys(bots);
    if (ids.length === 0) return;

    const numCheckpoints = checkpoints.length || trackData.points.length;
    const payload = [];

    for (const id of ids) {
        const bot = bots[id];
        const ai = bot.ai;

        if (!ai.finished) {
            ai.progress += (ai.speed * dt) / trackLength;
            ai.lateral += (ai.targetLateral - ai.lateral) * 0.01;
            if (ai.progress >= totalLaps) {
                ai.progress = totalLaps;
                ai.finished = true;
            }
        }
        placeBot(bot);

        const lap = Math.floor(ai.progress);
        const q = bot.body.quaternion;
        payload.push({
            id,
            x: bot.body.position.x,
            y: bot.body.position.y,
            z: bot.body.position.z,
            qx: q.x, qy: q.y, qz: q.z, qw: q.w,
            lap,
            checkpoint: Math.floor((ai.progress - lap) * numCheckpoints)
        });
    }

    if (frameCount % 2 === 0) socket.emit("bot_update", { bots: payload });
}

// === MINIMAP ===
// The track never changes, so it is drawn once to an off-screen canvas and
// copied each frame; only the cars are redrawn.
function buildMinimapBackground() {
    if (!minimapCanvas || !trackData) return;

    const w = minimapCanvas.width;
    const h = minimapCanvas.height;
    const { minX, maxX, minZ, maxZ } = trackData.terrain;
    minimapScale = Math.min(w / (maxX - minX), h / (maxZ - minZ));

    minimapBackground = document.createElement("canvas");
    minimapBackground.width = w;
    minimapBackground.height = h;
    const ctx = minimapBackground.getContext("2d");

    ctx.fillStyle = "#3b2a16";
    ctx.fillRect(0, 0, w, h);

    const curve = getTrackCurve();
    const roadWidth = trackData.roadWidth || 14;
    const segments = 300;
    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = curve.getPoint(t);
        const tangent = curve.getTangent(t).normalize();
        const side = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(roadWidth / 2);

        leftPts.push(worldToMini(p.x + side.x, p.z + side.z));
        rightPts.push(worldToMini(p.x - side.x, p.z - side.z));
    }

    ctx.fillStyle = "#555555";
    ctx.beginPath();
    leftPts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    for (let i = rightPts.length - 1; i >= 0; i--) ctx.lineTo(rightPts[i].x, rightPts[i].y);
    ctx.closePath();
    ctx.fill();

    if (trackData.finish) {
        const f = worldToMini(trackData.finish.x, trackData.finish.z);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(f.x, f.y, 3, 0, Math.PI * 2);
        ctx.fill();
    }
}

function worldToMini(x, z) {
    const { minX, minZ } = trackData.terrain;
    return {
        x: (x - minX) * minimapScale,
        y: (z - minZ) * minimapScale
    };
}

function updateMinimap() {
    if (!minimapCtx || !minimapBackground || !carMesh) return;

    const ctx = minimapCtx;
    ctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
    ctx.drawImage(minimapBackground, 0, 0);

    // Next checkpoint
    if (!practiceMode && !myFinished && trackData.points.length > 0) {
        const cp = trackData.points[nextCheckpoint % trackData.points.length];
        const p = worldToMini(cp.x, cp.z);
        ctx.fillStyle = "#ffff00";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    Object.values(otherPlayers).forEach(p => {
        if (!p.mesh) return;
        const pos = worldToMini(p.mesh.position.x, p.mesh.position.z);
        drawCarIcon(ctx, pos.x, pos.y, getYawFromQuaternion(p.mesh.quaternion), "#00f2ff");
    });

    Object.values(bots).forEach(b => {
        if (!b.mesh) return;
        const pos = worldToMini(b.mesh.position.x, b.mesh.position.z);
        drawCarIcon(ctx, pos.x, pos.y, getYawFromQuaternion(b.mesh.quaternion), "#ff00ff");
    });

    const me = worldToMini(carMesh.position.x, carMesh.position.z);
    drawCarIcon(ctx, me.x, me.y, getYawFromQuaternion(carMesh.quaternion), "#ff0000");
}

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
