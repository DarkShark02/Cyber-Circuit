import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let scene, camera, renderer, car, carBodyMaterial;
let speed = 0;
const keys = { w: false, s: false, a: false, d: false };

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('game-container').appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.position.set(10, 20, 10);
    scene.add(sun);

    const roadGeo = new THREE.PlaneGeometry(50, 5000);
    const roadMat = new THREE.MeshToonMaterial({ color: 0x222222 });
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.rotation.x = -Math.PI / 2;
    scene.add(road);

    const loader = new GLTFLoader();
    loader.load('/static/models/auto.glb', (gltf) => {
        car = gltf.scene;
        car.scale.set(1, 1, 1);
        
        const savedColor = document.body.getAttribute('data-car-color') || '#ff2e2e';
        const meshes = [];
        car.traverse(n => { if(n.isMesh) meshes.push(n); });

        meshes.forEach(node => {
            node.material = new THREE.MeshToonMaterial({ color: node.material.color.clone() });
            
            if (node.name.toLowerCase().includes('body') || node.material.name.toLowerCase().includes('body')) {
                node.material.color.set(savedColor);
            }

            const outline = new THREE.Mesh(node.geometry, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }));
            outline.scale.multiplyScalar(1.04);
            node.add(outline);
        });
        scene.add(car);
    });

    window.addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; });
    window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

    animate();
}

function updatePhysics() {
    if (!car) return;
    if (keys.w) speed += 0.008;
    if (keys.s) speed -= 0.005;
    speed *= 0.97;
    if (Math.abs(speed) > 0.01) {
        if (keys.a) car.rotation.y += 0.04;
        if (keys.d) car.rotation.y -= 0.04;
    }
    car.position.x -= Math.sin(car.rotation.y) * speed;
    car.position.z -= Math.cos(car.rotation.y) * speed;

    const camOffset = new THREE.Vector3(0, 3, 8).applyQuaternion(car.quaternion);
    camera.position.copy(car.position).add(camOffset);
    camera.lookAt(car.position.x, car.position.y + 1, car.position.z);
    document.getElementById('speedometer').innerText = Math.round(Math.abs(speed) * 1200) + " KM/H";
}

function animate() {
    requestAnimationFrame(animate);
    updatePhysics();
    renderer.render(scene, camera);
}

init();