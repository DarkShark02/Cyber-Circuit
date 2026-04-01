export const raceManager = {
    players: {},
    winner: null,

    updatePlayer(id, lap, checkpoint, distance) {
        this.players[id] = { lap, checkpoint, distance };
        this.updateStandings();
    },

    updateStandings() {
        const list = Object.entries(this.players);

        list.sort((a, b) => {
            const A = a[1], B = b[1];

            if (A.lap !== B.lap) return B.lap - A.lap;
            if (A.checkpoint !== B.checkpoint) return B.checkpoint - A.checkpoint;
            return A.distance - B.distance;
        });

        const standings = list.map(([id]) => id);
        socket.emit("standings_update", standings);
    },

    finishRace(id) {
        if (!this.winner) {
            this.winner = id;
            socket.emit("race_results", {
                winner: id,
                standings: Object.keys(this.players)
            });
        }
    }
};
