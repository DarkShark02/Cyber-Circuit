import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

function initViewer(container) {
    if (!container) return;

    const modelPath = container.getAttribute('data-model');
    if (!modelPath || modelPath.includes('None')) return;

    const modelFileName = modelPath.split('/').pop().toLowerCase();
    const isShop = container.closest('.shop-grid') !== null || container.clientHeight < 300;
    const isHovercar = modelFileName.includes('hovercar');

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

        const fullBbox = new THREE.Box3().setFromObject(carModel);
        const minY = fullBbox.min.y;
        const sizeY = fullBbox.max.y - fullBbox.min.y;

        carModel.traverse(node => {
            if (!node.isMesh) return;

            const name = node.name.toLowerCase();
            const matName = (node.material?.name || "").toLowerCase();
            const combined = (name + " " + matName).trim();

            // --- REMOVE FLOOR AND SHADOW MESHES ---
            const isFloorName = /floor|plane|ground|shadow|base|grid|box0|sh\.|_shadow/.test(combined);
            const worldPos = new THREE.Vector3();
            node.getWorldPosition(worldPos);
            const isAtBottom = (worldPos.y <= minY + (sizeY * 0.1)); 
            const isProtected = /body|paint|car|porsche|hover|chassis|wheel|rim|tire|glass|window/.test(combined);

            if ((isFloorName || isAtBottom) && !isProtected) {
                toRemove.push(node);
            } else {
                meshes.push(node);
            }
        });

        toRemove.forEach(f => f.parent?.remove(f));

        // --- SCALE + CENTER (kept small so the car never touches the edges) ---
        const bbox = new THREE.Box3().setFromObject(carModel);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        
        // 3.5 units in the shop cards, 5.0 in the garage
        const scale = (isShop ? 3.5 : 5.0) / Math.max(size.x, size.y, size.z);

        carModel.scale.set(scale, scale, scale);
        carModel.position.set(-center.x * scale, -(bbox.min.y * scale), -center.z * scale);

        // --- MATERIALS ---
        meshes.forEach(node => {
            const mat = node.material;
            if (!mat) return;

            const name = node.name.toLowerCase();
            const matName = (mat.name || "").toLowerCase();
            
            let isGlass = false;
            let isWheel = false;
            let isLight = false;
            let isBody = false;

            // Per-model material mapping
            if (modelFileName.includes('porsche_911_carrera')) {
                isGlass = /window|windshield/.test(name) || /window|glass/.test(matName);
                isWheel = /cylinder/.test(name) || /rubber|silver/.test(matName);
                isLight = /lights/.test(matName);
                isBody = /plane00|boot00[1258]/.test(name) || /paint|coat/.test(matName);
            }
            else if (modelFileName.includes('porsche_911_turbo')) {
                isGlass = /glass/.test(matName);
                isWheel = /rim|tire/.test(matName);
                isLight = /lights/.test(matName);
                isBody = /paint|coat/.test(matName); 
            }
            else if (isHovercar) {
                if (/wheel|rim|tire|rubber|cylinder/.test(name + " " + matName)) {
                    node.visible = false;
                    return;
                }
                isLight = /light|thruster/.test(matName);
                isBody = /body/.test(matName);
            }
            else if (modelFileName.includes('fiat_punto_gt')) {
                isGlass = /windows/.test(matName);
                isWheel = /tire|rim/.test(matName);
                isBody = /gt_body/.test(matName);
            }
            else if (modelFileName.includes('toyota_gt_86')) {
                isGlass = /glass/.test(matName);
                isWheel = /wheel/.test(matName);
                isLight = /lights/.test(matName);
                isBody = /body/.test(matName);
            }
            
            // Fallback
            if (!isGlass && !isWheel && !isLight && !isBody) {
                const combined = (name + " " + matName).toLowerCase();
                isGlass = /glass|window|cristal|vetro/.test(combined);
                isWheel = /wheel|rim|tire|rubber|gomma|ruota/.test(combined);
                isLight = /light|lamp|emissive|glow|faro/.test(combined);
                isBody = /body|paint|coat|carrozzeria|chassis/.test(combined);
            }

            // Toon materials
            if (isGlass) {
                node.material = new THREE.MeshToonMaterial({
                    color: 0x000000,
                    transparent: true,
                    opacity: 0.8,
                    side: THREE.DoubleSide
                });
            } 
            else if (isWheel) {
                node.material = new THREE.MeshToonMaterial({ color: 0x050505 });
            } 
            else if (isLight) {
                const fColor = mat.color || new THREE.Color(0xffffff);
                node.material = new THREE.MeshToonMaterial({
                    color: fColor,
                    emissive: fColor,
                    emissiveIntensity: 4
                });
            } 
            else if (isBody) {
                const newMat = new THREE.MeshToonMaterial({
                    color: 0xffffff,
                    map: mat.map
                });
                node.material = newMat;
                colorableParts.push(newMat);
            } 
            else {
                node.material = new THREE.MeshToonMaterial({ color: 0x181818 });
            }

            // Outline Cartoon
            if (!isGlass && node.visible) {
                const outline = new THREE.Mesh(
                    node.geometry,
                    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide })
                );
                outline.scale.multiplyScalar(1.02);
                node.add(outline);
            }
        });

        scene.add(carModel);
        camera.lookAt(0, sizeY * scale * 0.4, 0);

        const input = document.getElementById('selectedColor');
        if (input && !isShop) {
            applyColorToParts(input.value);
        }

        container.querySelector('.loading-text')?.remove();
    });

    function applyColorToParts(hexColor) {
        if (!hexColor || hexColor.includes('None')) return;
        colorableParts.forEach(mat => {
            try { mat.color.set(hexColor); } catch (e) {}
        });
    }
    
    function animate() {
        requestAnimationFrame(animate);
        if (carModel && !isShop && !isHovercar) {
            carModel.rotation.y += 0.004;
        }
        renderer.render(scene, camera);
    }
    animate();

    window.applyCarColor = (colorHex) => {
        applyColorToParts(colorHex);
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
