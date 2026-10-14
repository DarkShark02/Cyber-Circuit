# Cyber Circuit

**Speed is All.** A neon‑soaked 3D arcade racing game with online lobbies, a garage, a car shop and a friends system — built with Flask, Socket.IO and Three.js, and packaged as a desktop app with pywebview.

> ⚠️ This is a hobby project and still a work in progress (beta). Expect rough edges.

## Features

- **3D racing** in the browser engine, using Three.js for rendering and Cannon.js for physics
- **Multiplayer lobbies** with up to 3 drivers, each with a shareable 6‑character code, and real‑time position sync over Socket.IO
- **Bots** to fill empty grid slots
- **Three tracks** (Neon City Circuit, Cyber Canyon, The Abyss), each defined in JSON with its own laps, spawn points and prize money
- **Practice mode** on a free track, with no lobby and no rewards
- **Garage**: preview your cars in 3D and change their paint colour
- **Shop**: spend the credits you win on races to unlock faster cars
- **Friends**: search players, send and accept friend requests, invite friends to your lobby
- **Turbo boost and drifting**, plus a minimap and live race standings

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake / reverse |
| `A` `D` / `←` `→` | Steer |
| `Shift` | Drift |
| `Space` | Turbo (2.5 s boost, 15 s cooldown) |

## Getting started

Requires **Python 3.10+** on Windows (pywebview uses the system WebView2 runtime).

```bash
git clone https://github.com/DarkShark02/cyber-circuit.git
cd cyber-circuit

python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt

python server.py
```

The game opens in its own window. On first launch it creates `cyber_circuit.db` (SQLite) and fills in the car catalogue and the tracks. Register an account to start: you get 100 credits and a Fiat Punto GT.

> Multiplayer runs on `127.0.0.1:5000`, so all players have to be on the same machine for now.

### Building a standalone executable

```bash
pip install pyinstaller
pyinstaller server.spec
```

The executable is written to `dist/CyberCircuit.exe`. The database is saved next to it.

## Project structure

```
server.py            Flask app, routes, Socket.IO events, race logic, desktop window
models.py            SQLAlchemy models (users, cars, friendships, tracks, lobbies)
init_db.py           Creates tables and fills in the car catalogue and tracks
server.spec          PyInstaller build configuration
templates/           Jinja2 pages (login, garage, shop, social, lobby, race, results)
static/js/           Game client (race.js), garage viewer, track helpers
static/json/tracks/  Track definitions (laps, spawn points, checkpoints, rewards)
static/models/       Car models (.glb)
```

## Tech stack

- **Backend:** Python, Flask, Flask‑SocketIO, Flask‑SQLAlchemy (SQLite), Flask‑Login, Flask‑Bcrypt
- **Frontend:** Three.js, Cannon.js, Socket.IO client
- **Desktop:** pywebview, PyInstaller

## Credits

The 3D car models in `static/models/` are third‑party assets and belong to their original authors.
