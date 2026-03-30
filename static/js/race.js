let scene, camera, renderer, world, carBody, carMesh;
let colorableParts = [];
let otherPlayers = {}; 
let socket;
let myUsername;

const keys = { w: false, a: false, s: false, d: false };
let carStats = { speed: 1, accel: 1, handling: 1 };
let carColor = "#39ff14";

export function initGame(config) {
    socket = config.socket;
    myUsername = config.username;
    carStats = config.stats;
    carColor = config.carColor;

    // --- SETUP SCENA ---
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000105);
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 3000);
    
    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // --- FISICA ---
    world = new CANNON.World();
    world.gravity.set(0, -25, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(10, 50, 10);
    scene.add(sun);

    const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    world.addBody(groundBody);

    createTrack();
    loadMyCar(config.modelPath);
    setupControls();
    setupSocketListeners(); 
    animate();
}

function setupSocketListeners() {
    socket.on('update_players', (data) => {
        for (let id in data) {
            if (id === socket.id) continue; 

            const pData = data[id];
            if (!otherPlayers[id]) {
                createOtherPlayer(id, pData);
            } else if (otherPlayers[id].mesh) {
                otherPlayers[id].mesh.position.lerp(new THREE.Vector3(pData.x, pData.y, pData.z), 0.2);
                otherPlayers[id].mesh.quaternion.slerp(new THREE.Quaternion(pData.qx, pData.qy, pData.qz, pData.qw), 0.2);
            }
        }
        
        for (let id in otherPlayers) {
            if (!data[id]) {
                scene.remove(otherPlayers[id].mesh);
                delete otherPlayers[id];
            }
        }
    });
}

function createOtherPlayer(id, data) {
    // Evitiamo caricamenti doppi mentre il modello sta ancora caricando
    otherPlayers[id] = { mesh: null }; 

    const loader = new THREE.GLTFLoader();
    loader.load(data.modelPath, (gltf) => {
        const mesh = gltf.scene;
        processCarMaterials(mesh, data.color);
        scene.add(mesh);
        otherPlayers[id].mesh = mesh;
    });
}

function processCarMaterials(mesh, hexColor) {
    const targetColor = new THREE.Color(hexColor);
    const nodesToProcess = [];
    
    // Snapshot dei nodi per evitare loop infiniti con gli outline
    mesh.traverse(node => { if (node.isMesh) nodesToProcess.push(node); });

    nodesToProcess.forEach(node => {
        const name = node.name.toLowerCase();
        const matName = (node.material?.name || "").toLowerCase();
        const combined = (name + " " + matName).trim();

        const isBody = /body|paint|carrozzeria|gt_body|metal|frame/.test(combined);
        const isGlass = /glass|window|vetro/.test(combined);
        const isWheel = /wheel|tire|rim|gomma|ruota/.test(combined);

        if (isBody) {
            node.material = new THREE.MeshToonMaterial({ 
                color: targetColor,
                map: null, // Fondamentale per resettare colori sporchi
                emissive: new THREE.Color(0x000000)
            });
            // Se è la nostra auto, salviamo il materiale per cambi dinamici
            if (mesh === carMesh) colorableParts.push(node.material);
        } else if (isGlass) {
            node.material = new THREE.MeshToonMaterial({ color: 0x111111, transparent: true, opacity: 0.4 });
        } else if (isWheel) {
            node.material = new THREE.MeshToonMaterial({ color: 0x050505 });
        } else {
            node.material = new THREE.MeshToonMaterial({ color: 0x222222 });
        }

        const outline = new THREE.Mesh(node.geometry, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }));
        outline.scale.multiplyScalar(1.02);
        node.add(outline);
    });
}

function loadMyCar(path) {
    const shape = new CANNON.Box(new CANNON.Vec3(1.2, 0.5, 2.2));
    carBody = new CANNON.Body({ mass: 800, shape: shape, position: new CANNON.Vec3(0, 1, 0) });
    
    // --- FIX ERRORE 'set' ---
    if (!carBody.angularFactor) carBody.angularFactor = new CANNON.Vec3(0, 1, 0);
    else carBody.angularFactor.set(0, 1, 0); 
    
    carBody.angularDamping = 0.95;
    world.addBody(carBody);

    const loader = new THREE.GLTFLoader();
    loader.load(path, (gltf) => {
        carMesh = gltf.scene;
        processCarMaterials(carMesh, carColor);
        scene.add(carMesh);
        document.getElementById('loading-overlay').style.display = 'none';
    });
}

function updateLogic() {
    world.step(1 / 60);
    if (!carBody || !carMesh) return;

    const maxSpeed = (carStats.speed / 50) * 115; 
    const accel = (carStats.accel / 50) * 4.5;    
    const steerSpeed = (carStats.handling / 50) * 4.0;

    let carQuat = new THREE.Quaternion(carBody.quaternion.x, carBody.quaternion.y, carBody.quaternion.z, carBody.quaternion.w);
    let forward = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
    let speedMagnitude = carBody.velocity.dot(new CANNON.Vec3(forward.x, forward.y, forward.z));

    if (keys.w) {
        if (speedMagnitude < maxSpeed) {
            carBody.velocity.x += forward.x * accel;
            carBody.velocity.z += forward.z * accel;
        }
    } else if (keys.s) {
        if (speedMagnitude > -maxSpeed/3) {
            carBody.velocity.x -= forward.x * accel * 0.8;
            carBody.velocity.z -= forward.z * accel * 0.8;
        }
    }

    carBody.velocity.x *= 0.985;
    carBody.velocity.z *= 0.985;

    if (Math.abs(speedMagnitude) > 0.5) {
        const f = speedMagnitude > 0 ? 1 : -1;
        if (keys.a) carBody.angularVelocity.y = steerSpeed * f;
        else if (keys.d) carBody.angularVelocity.y = -steerSpeed * f;
        else carBody.angularVelocity.y *= 0.7;
    }

    carBody.quaternion.x = 0;
    carBody.quaternion.z = 0;

    carMesh.position.copy(carBody.position);
    carMesh.quaternion.copy(carBody.quaternion);

    let camOffset = new THREE.Vector3(0, 5, -14).applyQuaternion(carMesh.quaternion);
    camera.position.lerp(carMesh.position.clone().add(camOffset), 0.12);
    camera.lookAt(carMesh.position);

    document.getElementById('speed-val').innerText = Math.abs(Math.round(speedMagnitude * 3.6));

    // SINCRONIZZAZIONE MULTIPLAYER
    socket.emit('player_move', {
        x: carBody.position.x, y: carBody.position.y, z: carBody.position.z,
        qx: carBody.quaternion.x, qy: carBody.quaternion.y, qz: carBody.quaternion.z, qw: carBody.quaternion.w,
        modelPath: carMesh.userData.modelPath || "", // Assicurati di passare info utili se serve
        color: carColor
    });
}

function animate() {
    requestAnimationFrame(animate);
    updateLogic();
    renderer.render(scene, camera);
}

function createTrack() {
    scene.add(new THREE.GridHelper(2000, 100, 0x39ff14, 0x222222));
}

function setupControls() {
    const h = (e, v) => {
        const k = e.key.toLowerCase();
        if (k === 'w' || k === 'arrowup') keys.w = v;
        if (k === 's' || k === 'arrowdown') keys.s = v;
        if (k === 'a' || k === 'arrowleft') keys.a = v;
        if (k === 'd' || k === 'arrowright') keys.d = v;
    };
    window.addEventListener('keydown', e => h(e, true));
    window.addEventListener('keyup', e => h(e, false));
}