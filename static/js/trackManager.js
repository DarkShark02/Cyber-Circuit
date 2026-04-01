import tracks from "./tracks.json";

export const trackManager = {
    currentTrack: null,
    checkpoints: [],
    finishLine: null,
    nextCheckpoint: 0,
    laps: 0,
    totalLaps: 0,

    loadTrack(name) {
        this.currentTrack = tracks[name];
        this.totalLaps = this.currentTrack.laps;
        this.nextCheckpoint = 0;
        this.laps = 0;

        this.createCheckpoints();
        this.createFinishLine();
    },

    createCheckpoints() {
        this.checkpoints = this.currentTrack.checkpoints.map((pos, index) => {
            const geo = new THREE.BoxGeometry(10, 5, 10);
            const mat = new THREE.MeshBasicMaterial({ visible: false });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(pos.x, pos.y, pos.z);
            mesh.userData.index = index;
            scene.add(mesh);
            return mesh;
        });
    },

    createFinishLine() {
        const pos = this.currentTrack.finishLine;
        const geo = new THREE.BoxGeometry(12, 5, 12);
        const mat = new THREE.MeshBasicMaterial({ visible: false });
        this.finishLine = new THREE.Mesh(geo, mat);
        this.finishLine.position.set(pos.x, pos.y, pos.z);
        scene.add(this.finishLine);
    },

    update(playerPos) {
        // Checkpoint
        const cp = this.checkpoints[this.nextCheckpoint];
        if (playerPos.distanceTo(cp.position) < 8) {
            this.nextCheckpoint++;
            socket.emit("checkpoint_passed", this.nextCheckpoint);
        }

        // Finish line
        if (this.nextCheckpoint === this.checkpoints.length &&
            playerPos.distanceTo(this.finishLine.position) < 10) {

            this.laps++;
            this.nextCheckpoint = 0;

            socket.emit("lap_completed", this.laps);

            if (this.laps >= this.totalLaps) {
                socket.emit("race_finished");
            }
        }
    }
};
