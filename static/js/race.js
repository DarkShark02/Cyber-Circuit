// === VARIABILI GLOBALI ===
let scene, camera, renderer, world, carBody, carMesh;
let colorableParts = [];
let otherPlayers = {};
let socket;
let myUsername;
let myModelPath;

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
    fetch(TRACK_JSON)
        .then(res => res.json())
        .then(data => {
            trackData = data;
            totalLaps = data.laps;
            createTrackObjects();
            createTerrain();
            createRoadWithBorders();
            trackLoaded = true;
        });

    let spawned = false;
    socket.emit("request_spawn_point");

    socket.once("spawn_data", (data) => {
        if (!spawned) {
            spawned = true;
            loadMyCar(myModelPath, wheelMaterial, data.spawnPos);
            socket.emit("get_active_players");
        }
    });

    setTimeout(() => {
        if (!spawned) {
            spawned = true;
            loadMyCar(myModelPath, wheelMaterial, { x: 0, y: 1, z: 0 });
        }
    }, 1500);

    animate();
}

// === OGGETTI PISTA ===
function createTrackObjects() {
    if (!trackData) return;

    const f = trackData.finish;
    finishLine = createTrigger(f.x, f.y, f.z, 12);

    checkpoints = [];
    trackData.checkpoints.forEach((cp, i) => {
        const trigger = createTrigger(cp.x, cp.y, cp.z, 10);
        trigger.userData.index = i;
        checkpoints.push(trigger);
    });

    nextCheckpoint = 0;
    currentLap = 0;
}

function createTrigger(x, y, z, size) {
    const geo = new THREE.BoxGeometry(size, 5, size);
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y + 2.5, z);
    scene.add(mesh);
    return mesh;
}

// === TERRENO (SOLO SFONDO) ===
function createTerrain() {
    const geo = new THREE.PlaneGeometry(5000, 5000);
    const mat = new THREE.MeshStandardMaterial({
        color: 0x3b2a16,   // marrone terra
        roughness: 1,
        metalness: 0
    });

    const terrain = new THREE.Mesh(geo, mat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = 0;      // terra a y = 0
    terrain.receiveShadow = true;
    scene.add(terrain);
}


// === STRADA SEMPLICE ===
// === BLOCCO A: PISTA 3D CON BORDI FISICI ===
function createRoadWithBorders() {
    if (!trackData || !trackData.checkpoints || trackData.checkpoints.length < 2) return;

    const roadWidth = trackData.roadWidth || 14;
    const wallHeight = 2.2;
    const wallThickness = 1.0;
    const terrainWidth = trackData.terrainWidth || 40;

    const centerPoints = trackData.checkpoints.map(cp =>
        new THREE.Vector3(cp.x, (cp.y || 0) + 0.05, cp.z)
    );

    const curve = new THREE.CatmullRomCurve3(centerPoints, true);
    const segments = Math.max(100, Math.floor(curve.getLength() / 1));

    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = curve.getPoint(t);
        const tangent = curve.getTangent(t).normalize();
        const left = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(roadWidth / 2);
        const right = left.clone().multiplyScalar(-1);

        leftPts.push(new THREE.Vector3().copy(p).add(left));
        rightPts.push(new THREE.Vector3().copy(p).add(right));
    }

    // Road mesh
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i < leftPts.length; i++) {
        const l = leftPts[i];
        const r = rightPts[i];
        positions.push(l.x, l.y, l.z);
        positions.push(r.x, r.y, r.z);
        const v = i / (leftPts.length - 1);
        uvs.push(0, v * 10);
        uvs.push(1, v * 10);
    }

    for (let i = 0; i < leftPts.length - 1; i++) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, b, c);
        indices.push(b, d, c);
    }

    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roadGeo.setIndex(indices);
    roadGeo.computeVertexNormals();

    const roadMat = new THREE.MeshStandardMaterial({
        color: 0x111111,
        roughness: 0.7,
        metalness: 0.05
    });

    const roadMesh = new THREE.Mesh(roadGeo, roadMat);
    roadMesh.receiveShadow = true;
    scene.add(roadMesh);

    // Side terrain strips
    const leftTerrainGeo = createStripGeometry(leftPts, roadWidth / 2, terrainWidth / 2, true);
    const rightTerrainGeo = createStripGeometry(rightPts, roadWidth / 2, terrainWidth / 2, false);

    const terrainMat = new THREE.MeshStandardMaterial({ color: 0x3b2a16, roughness: 1, metalness: 0 });
    const leftTerrain = new THREE.Mesh(leftTerrainGeo, terrainMat);
    const rightTerrain = new THREE.Mesh(rightTerrainGeo, terrainMat);
    leftTerrain.receiveShadow = true;
    rightTerrain.receiveShadow = true;
    scene.add(leftTerrain);
    scene.add(rightTerrain);

    // Walls with physics
    createWallsAlongEdge(leftPts, -1, roadWidth / 2, wallHeight, wallThickness);
    createWallsAlongEdge(rightPts, 1, roadWidth / 2, wallHeight, wallThickness);

    // Helpers
    function createStripGeometry(edgePts, innerOffset, outerOffset, flip) {
        const pos = [];
        const uvs = [];
        const idx = [];

        for (let i = 0; i < edgePts.length; i++) {
            const p = edgePts[i];
            const next = edgePts[(i + 1) % edgePts.length];
            const dir = new THREE.Vector3().subVectors(next, p).normalize();
            const out = new THREE.Vector3(-dir.z, 0, dir.x).normalize();

            const inner = new THREE.Vector3().copy(p).add(out.clone().multiplyScalar(innerOffset));
            const outer = new THREE.Vector3().copy(p).add(out.clone().multiplyScalar(outerOffset + innerOffset));

            pos.push(inner.x, inner.y - 0.01, inner.z);
            pos.push(outer.x, outer.y - 0.01, outer.z);

            const v = i / (edgePts.length - 1);
            uvs.push(0, v * 5);
            uvs.push(1, v * 5);
        }

        for (let i = 0; i < edgePts.length - 1; i++) {
            const a = i * 2;
            const b = a + 1;
            const c = a + 2;
            const d = a + 3;
            if (!flip) {
                idx.push(a, b, c);
                idx.push(b, d, c);
            } else {
                idx.push(a, c, b);
                idx.push(b, c, d);
            }
        }

        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        g.setIndex(idx);
        g.computeVertexNormals();
        return g;
    }

    function createWallsAlongEdge(edgePts, sideSign, halfRoad, wallHeight, wallThickness) {
        const wallMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.9, metalness: 0.1 });
        for (let i = 0; i < edgePts.length - 1; i++) {
            const p0 = edgePts[i];
            const p1 = edgePts[i + 1];

            const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
            const segDir = new THREE.Vector3().subVectors(p1, p0);
            const segLen = segDir.length();
            segDir.normalize();

            const out = new THREE.Vector3(-segDir.z, 0, segDir.x).normalize().multiplyScalar(sideSign * (halfRoad + wallThickness / 2));
            const wallCenter = mid.clone().add(out);
            wallCenter.y = wallHeight / 2;

            const wallGeo = new THREE.BoxGeometry(segLen + 0.1, wallHeight, wallThickness);
            const wallMesh = new THREE.Mesh(wallGeo, wallMat);
            wallMesh.position.copy(wallCenter);
            const angle = Math.atan2(segDir.x, segDir.z);
            wallMesh.rotation.y = angle;
            wallMesh.receiveShadow = true;
            wallMesh.castShadow = true;
            scene.add(wallMesh);

            // Physics body
            const halfExtents = new CANNON.Vec3((segLen + 0.1) / 2, wallHeight / 2, wallThickness / 2);
            const wallBody = new CANNON.Body({ mass: 0 });
            const quat = new CANNON.Quaternion();
            quat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), wallMesh.rotation.y);
            wallBody.addShape(new CANNON.Box(halfExtents), new CANNON.Vec3(0, 0, 0), quat);
            wallBody.position.set(wallMesh.position.x, wallMesh.position.y, wallMesh.position.z);
            world.addBody(wallBody);
        }
    }
}


// === GRIP ASFALTO / TERRA ===
function getSurfaceGrip() {
    if (!trackData || !trackData.checkpoints) return 0.6;

    const pos = carMesh.position;

    let minDist = Infinity;
    trackData.checkpoints.forEach(cp => {
        const d = pos.distanceTo(new THREE.Vector3(cp.x, 0, cp.z));
        if (d < minDist) minDist = d;
    });

    const roadWidth = trackData.roadWidth || 14;

    if (minDist < roadWidth * 0.6) {
        return 1.0; // asfalto
    } else {
        return 0.4; // terra
    }
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
    if (!trackLoaded || !carMesh) return;
    if (!finishLine || checkpoints.length === 0) return;

    const pos = carMesh.position;

    const cp = checkpoints[nextCheckpoint];
    if (cp && pos.distanceTo(cp.position) < 8) {
        nextCheckpoint++;
        socket.emit("checkpoint_passed", nextCheckpoint);
    }

    if (nextCheckpoint === checkpoints.length &&
        pos.distanceTo(finishLine.position) < 10) {

        currentLap++;
        nextCheckpoint = 0;

        socket.emit("lap_completed", currentLap);

        if (currentLap >= totalLaps) {
            socket.emit("race_finished");
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
function updateLogic() {
    world.step(1 / 60);
    if (!carBody || !carMesh) return;

    let maxSpeed = (carStats.speed / 100) * 35 + 30;
    let accelForce = ((carStats.accel / 100) * 12 + 8) * ACCEL_STRENGTH;
    const steerStrength = (carStats.handling / 100) * 1.4 + 1.1;

    const q = carBody.quaternion;
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

    const forwardVel = carBody.velocity.dot(new CANNON.Vec3(forward.x, forward.y, forward.z));
    const sideVel = carBody.velocity.dot(new CANNON.Vec3(right.x, right.y, right.z));

    // === TURBO ===
    if (turboActive) {
        accelForce *= 1.8;
        maxSpeed *= 1.4;

        turboTimer -= 1/60;
        if (turboTimer <= 0) {
            turboActive = false;

            const turboEl = document.getElementById("turbo-status");
            if (turboEl) turboEl.innerText = "TURBO NOT READY";

            setTimeout(() => {
                turboReady = true;
                if (turboEl) turboEl.innerText = "TURBO READY";
            }, 15000);
        }
    }

    // === DRIFT + GRIP ASFALTO/TERRA ===
    let surfaceGrip = getSurfaceGrip();
    let lateralGrip = drifting ? surfaceGrip * 0.25 : surfaceGrip * 0.96;
    let steerBoost = drifting ? 1.6 : 1.0;

    carBody.velocity.x -= right.x * sideVel * lateralGrip;
    carBody.velocity.z -= right.z * sideVel * lateralGrip;

    // ACCELERAZIONE
    if (keys.w && forwardVel < maxSpeed) {
        carBody.applyForce(new CANNON.Vec3(forward.x * accelForce, 0, forward.z * accelForce), carBody.position);
    } else if (keys.s && forwardVel > -maxSpeed / 2) {
        carBody.applyForce(new CANNON.Vec3(-forward.x * accelForce * 0.6, 0, -forward.z * accelForce * 0.6), carBody.position);
    } else {
        carBody.velocity.x *= DRAG_COEFFICIENT;
        carBody.velocity.z *= DRAG_COEFFICIENT;
    }

    // STERZO
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

    // Aggiorna altri giocatori
    Object.values(otherPlayers).forEach(p => {
        if (p.mesh && p.body) {
            p.mesh.position.copy(p.body.position);
            p.mesh.quaternion.copy(p.body.quaternion);
        }
    });

    updateDriftSmoke();
    updateTurboFlames();
    updateRaceProgress();
    updateMinimap();

    // CAMERA FOLLOW
    const camOffset = new THREE.Vector3(0, 4, -11).applyQuaternion(carMesh.quaternion);
    camera.position.lerp(carMesh.position.clone().add(camOffset), 0.12);
    camera.lookAt(carMesh.position);

    const dynamicFOV = BASE_FOV + (Math.abs(forwardVel) / maxSpeed) * 15;
    camera.fov = THREE.MathUtils.lerp(camera.fov, dynamicFOV, 0.05);
    camera.updateProjectionMatrix();

    const speedEl = document.getElementById("speed-val");
    if (speedEl) speedEl.innerText = Math.abs(Math.round(forwardVel * 3.6));

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
    updateLogic();
    renderer.render(scene, camera);
}

// === CONTROLLI ===
function setupControls() {
    const h = (e, v) => {
        const k = e.key.toLowerCase();

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
        if (data.user_id === socket.id) return;

        if (!otherPlayers[data.user_id]) {
            createOtherPlayer(data.user_id, data);
        } else {
            const p = otherPlayers[data.user_id];
            p.body.position.set(data.x, data.y, data.z);
            p.body.quaternion.set(data.qx, data.qy, data.qz, data.qw);
        }
    });

    socket.on("race_results", data => {
        showPodium(data);
    });

    socket.on("player_disconnected", (id) => {
        if (otherPlayers[id]) {
            scene.remove(otherPlayers[id].mesh);
            world.removeBody(otherPlayers[id].body);
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
// === BLOCCO B: MINIMAP DALL'ALTO COMPLETA ===
function updateMinimap() {
    if (!minimapCtx || !carMesh || !trackData) return;

    const ctx = minimapCtx;
    const w = minimapCanvas.width;
    const h = minimapCanvas.height;

    ctx.clearRect(0, 0, w, h);

    // background
    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, w, h);

    const cx = carMesh.position.x;
    const cz = carMesh.position.z;

    function worldToMini(x, z) {
        return {
            x: w / 2 + (x - cx) * minimapScale,
            y: h / 2 + (z - cz) * minimapScale
        };
    }

    const roadWidth = trackData.roadWidth || 14;
    const centerPoints = trackData.checkpoints.map(cp => new THREE.Vector3(cp.x, cp.y || 0, cp.z));
    const curve = new THREE.CatmullRomCurve3(centerPoints, true);
    const segments = Math.max(80, Math.floor(curve.getLength() / 1));

    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = curve.getPoint(t);
        const tangent = curve.getTangent(t).normalize();
        const left = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(roadWidth / 2);
        const right = left.clone().multiplyScalar(-1);

        leftPts.push(new THREE.Vector3().copy(p).add(left));
        rightPts.push(new THREE.Vector3().copy(p).add(right));
    }

    // Terrain band
    ctx.fillStyle = "#2f1f12";
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

    // Road polygon
    ctx.fillStyle = "#111111";
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

    // Road edges (walls)
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < leftPts.length; i++) {
        const p = worldToMini(leftPts[i].x, leftPts[i].z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    ctx.beginPath();
    for (let i = 0; i < rightPts.length; i++) {
        const p = worldToMini(rightPts[i].x, rightPts[i].z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // Center dashed line
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = curve.getPoint(t);
        const m = worldToMini(p.x, p.z);
        if (i === 0) ctx.moveTo(m.x, m.y);
        else ctx.lineTo(m.x, m.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Checkpoints
    if (trackData.checkpoints && trackData.checkpoints.length > 0) {
        for (let i = 0; i < trackData.checkpoints.length; i++) {
            const cp = trackData.checkpoints[i];
            const p = worldToMini(cp.x, cp.z);
            ctx.fillStyle = (i === nextCheckpoint % trackData.checkpoints.length) ? "#ffff00" : "#ffcc33";
            ctx.beginPath();
            ctx.arc(p.x, p.y, (i === nextCheckpoint) ? 5 : 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Finish
    if (trackData.finish) {
        const f = worldToMini(trackData.finish.x, trackData.finish.z);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(f.x, f.y, 5, 0, Math.PI * 2);
        ctx.fill();
    }

    // Other players
    Object.values(otherPlayers).forEach(p => {
        if (!p.mesh) return;
        const pos = worldToMini(p.mesh.position.x, p.mesh.position.z);
        drawCarIcon(ctx, pos.x, pos.y, p.mesh.quaternion ? getYawFromQuaternion(p.mesh.quaternion) : 0, "#00f2ff");
    });

    // My car (centered)
    const me = worldToMini(carMesh.position.x, carMesh.position.z);
    drawCarIcon(ctx, me.x, me.y, getYawFromQuaternion(carMesh.quaternion), "#39ff14", true);

    // Helpers
    function drawCarIcon(ctx, x, y, yaw, color, bold = false) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-yaw);
        ctx.fillStyle = color;
        ctx.beginPath();
        const size = bold ? 6 : 4;
        ctx.moveTo(0, -size);
        ctx.lineTo(size * 0.6, size);
        ctx.lineTo(-size * 0.6, size);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    function getYawFromQuaternion(q) {
        const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
        const siny = 2 * (qw * qy + qz * qx);
        const cosy = 1 - 2 * (qy * qy + qx * qx);
        return Math.atan2(siny, cosy);
    }
}

