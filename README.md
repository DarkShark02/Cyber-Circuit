# Cyber Circuit

**Speed is All.** A neon‑soaked 3D arcade racing game with online lobbies, a garage, a car shop and a friends system — built with Flask, Socket.IO and Three.js, and packaged as a desktop app with pywebview.

> ⚠️ This is a hobby project and still a work in progress (beta). Expect rough edges.

## Features

- **3D racing** in the browser engine, using Three.js for rendering and Cannon.js for physics
- **Multiplayer lobbies** with up to 3 drivers, each with a shareable 6‑character code, and real‑time position sync over Socket.IO
- **Bots** that fill the empty grid slots and race for real (they can beat you)
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
git clone https://github.com/DarkShark02/Cyber-Circuit.git
cd Cyber-Circuit

python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt

python server.py
```

The game opens in its own window. On first launch it creates `cyber_circuit.db` (SQLite) and fills in the car catalogue and the tracks. Register an account to start: you get 100 credits and a Fiat Punto GT.

### Playing over a local network

By default the server only listens on `127.0.0.1`. To let friends on the same network join, start it on all interfaces:

```bash
set CC_HOST=0.0.0.0
python server.py
```

Your friends can then open `http://<your-local-ip>:5000` in their browser.

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CC_HOST` | `127.0.0.1` | Address the server listens on |
| `CC_PORT` | `5000` | Port the server listens on |
| `CC_DB_PATH` | `cyber_circuit.db` next to the app | SQLite database location |
| `CC_SECRET_KEY` | random at every launch | Session signing key (set it to stay logged in across restarts) |

### Developer helper

```bash
python add_money.py <username> [amount]   # give credits to a player
```

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

## License

The source code is released under the [MIT License](LICENSE) © 2026 Flavio Ruggiero.
The 3D car models are not covered by this license.
