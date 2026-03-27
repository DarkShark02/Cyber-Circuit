import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

function initViewer(container) {
    if (!container) return;

    const modelPath = container.getAttribute('data-model');
    if (!modelPath || modelPath.includes('None')) return;

    const isShop = container.closest('.shop-grid') !== null || container.clientHeight < 300;
    const isHovercar = modelPath.toLowerCase().includes('hovercar');

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(4, 2, 4);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 3));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(5, 10, 7);
    scene.add(sun);

    const loader = new GLTFLoader();
    let carModel;
    let colorableParts = [];

    loader.load(modelPath, (gltf) => {
        carModel = gltf.scene;

        const toRemove = [];
        const meshes = [];

        // 1. CALCOLO BOX INIZIALE PER FILTRO GEOMETRICO
        const fullBbox = new THREE.Box3().setFromObject(carModel);
        const minY = fullBbox.min.y;

        carModel.traverse(node => {
            if (!node.isMesh) return;

            const name = node.name.toLowerCase();
            const matName = (node.material?.name || "").toLowerCase();
            const combined = name + " " + matName;

            // --- RIMOZIONE PAVIMENTO (PIÙ AGGRESSIVA) ---
            // Rimuove se il nome contiene parole chiave OR se è una mesh piatta posizionata sul fondo
            const isFloorName = /floor|plane|ground|shadow|base|grid|box0/.test(combined);
            const isVeryFlat = (node.scale.y < 0.01);
            const isAtBottom = (node.position.y <= minY + 0.05);

            if (isFloorName || (isVeryFlat && isAtBottom)) {
                // Protezione: non rimuovere se è chiaramente carrozzeria
                if (!/body|paint|car|porsche|hover|chassis/.test(combined)) {
                    toRemove.push(node);
                    return;
                }
            }

            // --- FIX HOVERCAR: RIMOZIONE RUOTE SE È HOVER ---
            if (isHovercar && /wheel|rim|tire|rubber|gomma|ruota|cylinder/.test(combined)) {
                toRemove.push(node);
                return;
            }

            meshes.push(node);
        });

        // Esegui rimozione effettiva
        toRemove.forEach(f => f.parent?.remove(f));

        // 2. SCALE + CENTER (Ricalcolato dopo la rimozione)
        const bbox = new THREE.Box3().setFromObject(carModel);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        const scale = (isShop ? 4.2 : 5.8) / Math.max(size.x, size.y, size.z);

        carModel.scale.set(scale, scale, scale);
        carModel.position.set(-center.x * scale, -(bbox.min.y * scale), -center.z * scale);

        // 3. APPLICAZIONE MATERIALI
        meshes.forEach(node => {
            const mat = node.material;
            if (!mat) return;

            const name = (node.name + " " + (mat.name || "")).toLowerCase();

            const isGlass = /glass|window|cristal|vetro/.test(name);
            const isWheel = /wheel|rim|tire|rubber|gomma|ruota/.test(name);
            const isLight = /light|lamp|emissive|glow|lan|faro/.test(name);
            const isBody = /body|paint|carrozzeria|porsche|metal|chassis/.test(name);

            // LOGICA MATERIALI
            if (isGlass) {
                // VETRI NERI SEMI-TRASPARENTI
                node.material = new THREE.MeshToonMaterial({
                    color: 0x000000,
                    transparent: true,
                    opacity: 0.7,
                    side: THREE.DoubleSide
                });
            } 
            else if (isWheel) {
                // RUOTE NERE OPACHE
                node.material = new THREE.MeshToonMaterial({ color: 0x000000 });
            } 
            else if (isLight) {
                // LUCI EMISSIVE
                node.material = new THREE.MeshToonMaterial({
                    color: mat.color,
                    emissive: mat.color,
                    emissiveIntensity: 3
                });
            } 
            else if (isBody || (isHovercar && !isLight)) {
                // CARROZZERIA (Colorabile)
                const newMat = new THREE.MeshToonMaterial({
                    color: 0xffffff,
                    map: mat.map // Mantiene le decalcomanie originali se esistono
                });
                node.material = newMat;
                colorableParts.push(newMat);
            } 
            else {
                // DETTAGLI MECCANICI (Grigio scuro)
                node.material = new THREE.MeshToonMaterial({ color: 0x151515 });
            }

            // 4. OUTLINE (Solo pezzi non trasparenti)
            if (!isGlass) {
                const outline = new THREE.Mesh(
                    node.geometry,
                    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide })
                );
                outline.scale.multiplyScalar(1.02);
                node.add(outline);
            }
        });

        scene.add(carModel);
        camera.lookAt(0, 0.5, 0);

        // Applica colore salvato/iniziale
        const input = document.getElementById('selectedColor');
        if (input && !isShop) {
            colorableParts.forEach(m => m.color.set(input.value));
        }

        container.querySelector('.loading-text')?.remove();
    });

    function animate() {
        requestAnimationFrame(animate);
        if (carModel && !isShop && !isHovercar) {
            carModel.rotation.y += 0.005;
        }
        renderer.render(scene, camera);
    }
    animate();

    window.applyCarColor = (colorHex) => {
        colorableParts.forEach(mat => mat.color.set(colorHex));
        const input = document.getElementById('selectedColor');
        if (input) input.value = colorHex;
    };
}

function startApp() {
    document.querySelectorAll('.car-viewer').forEach(v => {
        if (!v.querySelector('canvas')) initViewer(v);
    });
}

if (document.readyState === 'complete') startApp();
else window.addEventListener('load', startApp);