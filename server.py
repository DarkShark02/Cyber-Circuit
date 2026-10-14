import os
import re
import sys
import json
import time
import uuid
import secrets
import threading
import urllib.request

from flask import (
    Flask, render_template, request, redirect,
    url_for, flash, jsonify
)
from sqlalchemy import or_
from flask_bcrypt import Bcrypt
from flask_login import (
    LoginManager, login_user, logout_user,
    login_required, current_user
)
from flask_socketio import SocketIO, emit, join_room, rooms

from models import db, User, CarCatalog, UserCar, Friendship, Track, Lobby
from init_db import setup_db

SOURCE_DIR = os.path.abspath(os.path.dirname(__file__))


def resource_path(relative_path):
    """Path to a bundled resource (templates, static files), also inside a PyInstaller build."""
    base = getattr(sys, '_MEIPASS', SOURCE_DIR)
    return os.path.join(base, relative_path)


app = Flask(
    __name__,
    template_folder=resource_path("templates"),
    static_folder=resource_path("static")
)
app.config['SECRET_KEY'] = os.environ.get('CC_SECRET_KEY') or secrets.token_hex(32)

# When frozen with PyInstaller, __file__ lives in a temp folder that is wiped on exit,
# so keep the database next to the executable instead.
if getattr(sys, 'frozen', False):
    basedir = os.path.dirname(sys.executable)
else:
    basedir = SOURCE_DIR
db_path = os.environ.get("CC_DB_PATH") or os.path.join(basedir, "cyber_circuit.db")

app.config['SQLALCHEMY_DATABASE_URI'] = f"sqlite:///{db_path}"

db.init_app(app)
setup_db(app)
bcrypt = Bcrypt(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

login_manager = LoginManager(app)
login_manager.login_view = 'login'

MAX_PLAYERS = 3
FINISH_TIMEOUT = 60  # seconds the others get after the first driver crosses the line
USERNAME_RE = re.compile(r'^[A-Za-z0-9_]{3,20}$')
COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')

# In-memory race data, keyed by lobby id. It is reset whenever a race starts.
# race_state[lobby_id] = { participant_id: {username, lap, checkpoint, finished, finish_time, is_bot},
#                          "_final": {standings, rewards} }
race_state = {}
# race_meta[lobby_id] = {code, host_id, laps, rewards, timer_started, finalized}
race_meta = {}
# lobby_bots[lobby_id] = [bot spawn payloads sent to clients]
lobby_bots = {}
lobby_spawn_counters = {}
# open socket connections per user, to tell a page reload from a real exit
user_connections = {}
finalize_lock = threading.Lock()


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


def load_track_json(track):
    with open(resource_path(track.model_path.lstrip("/")), "r") as f:
        return json.load(f)


def reset_lobby_state(lobby_id):
    for store in (race_state, race_meta, lobby_bots, lobby_spawn_counters):
        store.pop(lobby_id, None)


def get_friends(user):
    friendships = Friendship.query.filter(
        or_(Friendship.user_id == user.id, Friendship.friend_id == user.id),
        Friendship.status == 'accepted'
    ).all()
    return [
        db.session.get(User, f.friend_id if f.user_id == user.id else f.user_id)
        for f in friendships
    ]


# ================== AUTH & GARAGE ==================

@app.route('/')
def home():
    return redirect(url_for('login'))


@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = (request.form.get('username') or '').strip()
        pwd = request.form.get('password') or ''

        if not USERNAME_RE.match(username):
            flash('Username must be 3-20 characters: letters, numbers or underscores.', 'error')
            return redirect(url_for('register'))
        if len(pwd) < 4:
            flash('Password must be at least 4 characters long.', 'error')
            return redirect(url_for('register'))
        if User.query.filter_by(username=username).first():
            flash('Username already taken!', 'error')
            return redirect(url_for('register'))

        hashed_pwd = bcrypt.generate_password_hash(pwd).decode('utf-8')
        new_user = User(username=username, password=hashed_pwd, credits=100)
        db.session.add(new_user)
        db.session.commit()

        # Starter car
        car = UserCar(user_id=new_user.id, catalog_id=1, color="#00f2ff")
        db.session.add(car)
        db.session.commit()
        new_user.active_car_id = car.id
        db.session.commit()

        flash('Registration complete! Welcome, driver.', 'success')
        return redirect(url_for('login'))

    return render_template('register.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        user = User.query.filter_by(username=request.form.get('username')).first()
        if user and bcrypt.check_password_hash(user.password, request.form.get('password') or ''):
            login_user(user)
            return redirect(url_for('garage'))
        flash('Wrong username or password!', 'error')
    return render_template('login.html')


@app.route('/logout')
def logout():
    logout_user()
    return redirect(url_for('login'))


@app.route('/garage')
@login_required
def garage():
    # Leave any previous lobby
    if current_user.lobby_id:
        current_user.lobby_id = None
        db.session.commit()

    # Make sure the user always has at least one car
    if not UserCar.query.filter_by(user_id=current_user.id).first():
        db.session.add(UserCar(user_id=current_user.id, catalog_id=1, color="#00f2ff"))
        db.session.commit()

    # Select the active car
    car_id = request.args.get('select_car', type=int)
    if car_id:
        owned = UserCar.query.filter_by(id=car_id, user_id=current_user.id).first()
        if owned:
            current_user.active_car_id = owned.id
            db.session.commit()

    user_cars = (
        db.session.query(UserCar, CarCatalog)
        .join(CarCatalog)
        .filter(UserCar.user_id == current_user.id)
        .all()
    )

    active_pair = next(
        (p for p in user_cars if p.UserCar.id == current_user.active_car_id),
        user_cars[0]
    )
    if current_user.active_car_id != active_pair.UserCar.id:
        current_user.active_car_id = active_pair.UserCar.id
        db.session.commit()

    return render_template(
        'garage.html',
        user_car=active_pair.UserCar,
        car_info=active_pair.CarCatalog,
        all_cars=user_cars,
        model_file=active_pair.CarCatalog.model_path
    )


# ================== SHOP ==================

@app.route('/shop')
@login_required
def shop():
    owned_ids = [
        c.catalog_id for c in UserCar.query.filter_by(user_id=current_user.id).all()
    ]
    available_cars = CarCatalog.query.filter(~CarCatalog.id.in_(owned_ids)).all()
    return render_template('shop.html', cars=available_cars)


@app.route('/buy_car/<int:car_id>', methods=['POST'])
@login_required
def buy_car(car_id):
    car_to_buy = db.get_or_404(CarCatalog, car_id)
    if UserCar.query.filter_by(user_id=current_user.id, catalog_id=car_id).first():
        flash("You already own this car.", "error")
    elif current_user.credits >= car_to_buy.price:
        new_car = UserCar(user_id=current_user.id, catalog_id=car_to_buy.id)
        current_user.credits -= car_to_buy.price
        db.session.add(new_car)
        db.session.commit()
        flash(f"{car_to_buy.name} unlocked!", "success")
    else:
        flash("Not enough credits.", "error")
    return redirect(url_for('shop'))


@app.route('/save_car_config', methods=['POST'])
@login_required
def save_car_config():
    data = request.get_json(silent=True) or {}
    color = data.get('color') or ''
    if not COLOR_RE.match(color):
        return jsonify({'success': False}), 400

    user_car = UserCar.query.filter_by(
        id=data.get('car_id'),
        user_id=current_user.id
    ).first()

    if user_car:
        user_car.color = color
        current_user.active_car_id = user_car.id
        db.session.commit()
        return jsonify({'success': True})

    return jsonify({'success': False}), 400


# ================== SOCIAL ==================

@app.route('/social')
@login_required
def social_page():
    pending = (
        User.query
        .join(Friendship, Friendship.user_id == User.id)
        .filter(
            Friendship.friend_id == current_user.id,
            Friendship.status == 'pending'
        )
        .all()
    )

    return render_template(
        'social.html',
        friends=get_friends(current_user),
        pending=pending
    )


@app.route('/search_players')
@login_required
def search_players():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])

    users = (
        User.query
        .filter(
            User.username.ilike(f"%{query}%"),
            User.id != current_user.id
        )
        .limit(10)
        .all()
    )

    return jsonify([
        {"id": u.id, "username": u.username}
        for u in users
    ])


@app.route('/send_friend_request/<int:friend_id>', methods=['POST'])
@login_required
def send_request(friend_id):
    if friend_id == current_user.id:
        return jsonify({"success": False, "message": "You can't add yourself."})
    if not db.session.get(User, friend_id):
        return jsonify({"success": False, "message": "Player not found."})

    existing = Friendship.query.filter(
        or_(
            (Friendship.user_id == current_user.id) &
            (Friendship.friend_id == friend_id),
            (Friendship.user_id == friend_id) &
            (Friendship.friend_id == current_user.id)
        )
    ).first()

    if not existing:
        db.session.add(Friendship(user_id=current_user.id, friend_id=friend_id))
        db.session.commit()
        return jsonify({"success": True, "message": "Friend request sent."})

    return jsonify({"success": False, "message": "Request already sent or already friends."})


@app.route('/accept_friend/<int:user_id>', methods=['POST'])
@login_required
def accept_friend(user_id):
    f = Friendship.query.filter_by(
        user_id=user_id,
        friend_id=current_user.id,
        status='pending'
    ).first()

    if f:
        f.status = 'accepted'
        db.session.commit()
        flash('New friend added to your crew!', 'success')

    return redirect(url_for('social_page'))


# ================== LOBBY SYSTEM ==================

@app.route('/create_lobby')
@login_required
def create_lobby():
    # One lobby per host
    for old in Lobby.query.filter_by(host_id=current_user.id).all():
        reset_lobby_state(old.id)
        db.session.delete(old)
    db.session.commit()

    code = str(uuid.uuid4())[:6].upper()
    new_lobby = Lobby(code=code, host_id=current_user.id)
    db.session.add(new_lobby)
    db.session.commit()

    # SQLite can reuse ids of deleted lobbies: never inherit stale race data
    reset_lobby_state(new_lobby.id)

    current_user.lobby_id = new_lobby.id
    db.session.commit()

    return redirect(url_for('view_lobby', code=code))


@app.route('/lobby/<code>')
@login_required
def view_lobby(code):
    lobby = Lobby.query.filter_by(code=code).first_or_404()

    if current_user.lobby_id != lobby.id:
        if lobby.is_started:
            flash('This race has already started.', 'error')
            return redirect(url_for('garage'))
        if len(lobby.players) >= MAX_PLAYERS:
            flash('This lobby is full.', 'error')
            return redirect(url_for('garage'))
        current_user.lobby_id = lobby.id
        db.session.commit()

    return render_template(
        'lobby.html',
        lobby=lobby,
        tracks=Track.query.all(),
        friends=get_friends(current_user),
        max_players=MAX_PLAYERS
    )


@app.route('/select_track/<int:lobby_id>/<int:track_id>', methods=['POST'])
@login_required
def select_track(lobby_id, track_id):
    lobby = db.session.get(Lobby, lobby_id)
    if lobby and lobby.host_id == current_user.id and db.session.get(Track, track_id):
        lobby.track_id = track_id
        db.session.commit()
        return jsonify({"status": "success"})
    return jsonify({"status": "error"}), 403


# ================== SOCKET.IO BASE ==================

@socketio.on('connect')
def handle_connect():
    if current_user.is_authenticated:
        user_connections[current_user.id] = user_connections.get(current_user.id, 0) + 1
        join_room(f"user_{current_user.id}")


@socketio.on('join_lobby')
def handle_join(data):
    if not current_user.is_authenticated:
        return

    lobby = Lobby.query.filter_by(code=(data or {}).get('code')).first()
    if not lobby or current_user.lobby_id != lobby.id:
        emit('error', {'message': 'You are not in this lobby.'})
        return

    join_room(lobby.code)

    # During a race, register the driver (keeping progress if they reconnect)
    if lobby.is_started and lobby.id in race_state:
        race_state[lobby.id].setdefault(current_user.id, {
            "username": current_user.username,
            "is_bot": False,
            "lap": 0,
            "checkpoint": 0,
            "finished": False,
            "finish_time": None
        })

    emit('player_joined', {
        'username': current_user.username,
        'user_id': current_user.id
    }, room=lobby.code)


@socketio.on('disconnect')
def handle_disconnect(*args):
    if not current_user.is_authenticated:
        return
    host_id = current_user.id
    user_connections[host_id] = max(user_connections.get(host_id, 1) - 1, 0)

    lobby = db.session.get(Lobby, current_user.lobby_id) if current_user.lobby_id else None
    if lobby:
        emit('player_left', {'user_id': current_user.id}, room=lobby.code)
        emit('player_disconnected', current_user.id, room=lobby.code)

    # If the host leaves a lobby that hasn't started, close it after a short grace period
    hosted = Lobby.query.filter_by(host_id=current_user.id).first()
    if hosted and not hosted.is_started:
        def delayed_cleanup(lobby_id):
            time.sleep(5)
            with app.app_context():
                lobby = db.session.get(Lobby, lobby_id)
                host = db.session.get(User, host_id)
                host_still_here = user_connections.get(host_id, 0) > 0 and host and host.lobby_id == lobby_id
                if lobby and not lobby.is_started and not host_still_here:
                    for player in lobby.players:
                        player.lobby_id = None
                    socketio.emit('lobby_closed', {'message': 'The host closed the lobby.'}, room=lobby.code)
                    db.session.delete(lobby)
                    db.session.commit()
                    reset_lobby_state(lobby_id)

        threading.Thread(target=delayed_cleanup, args=(hosted.id,), daemon=True).start()


@socketio.on('send_lobby_invite')
def handle_invite(data):
    if not current_user.is_authenticated:
        return
    emit(
        'receive_invite',
        {
            'host_name': current_user.username,
            'lobby_code': data['lobby_code']
        },
        room=f"user_{data['friend_id']}"
    )


@socketio.on('change_track')
def handle_track(data):
    emit(
        'track_updated',
        {'track_id': data['track_id']},
        room=data['code']
    )


@socketio.on('update_position')
def handle_position(data):
    code = data.get('code')
    if not current_user.is_authenticated or code not in rooms():
        return
    data.update({
        'user_id': current_user.id,
        'username': current_user.username
    })
    emit('player_moved', data, room=code, include_self=False)


# ================== RACE SYSTEM ==================

def get_standings(lobby_id):
    players = [
        (pid, p) for pid, p in race_state.get(lobby_id, {}).items()
        if pid != "_final"
    ]
    return sorted(
        players,
        key=lambda item: (
            not item[1]["finished"],
            item[1]["finish_time"] or 0,
            -item[1]["lap"],
            -item[1]["checkpoint"]
        )
    )


def update_standings_for_lobby(lobby_id):
    meta = race_meta.get(lobby_id)
    if not meta:
        return

    socketio.emit("standings_update", [
        {
            "id": pid,
            "username": p["username"],
            "lap": p["lap"],
            "finished": p["finished"]
        }
        for pid, p in get_standings(lobby_id)
    ], room=meta["code"])


@app.route('/race')
@login_required
def quick_race():
    # Practice mode: no lobby, no rewards, free track loaded client-side
    user_car = db.session.get(UserCar, current_user.active_car_id) if current_user.active_car_id else None
    if not user_car:
        return redirect(url_for('garage'))

    return render_template(
        'race.html',
        lobby=None,
        lobby_host_id=None,
        track_json_path="",
        track_data={},
        user_car=user_car,
        practice_mode=True
    )


def build_bots(lobby, track_json):
    """Fill the empty grid slots with bots that drive a copy of the host's car."""
    host = db.session.get(User, lobby.host_id)
    host_pair = (
        db.session.query(UserCar, CarCatalog)
        .join(CarCatalog, CarCatalog.id == UserCar.catalog_id)
        .filter(UserCar.id == host.active_car_id)
        .first()
    )
    if not host_pair:
        return []

    spawn_points = track_json.get("spawnPoints", [])
    num_players = len(lobby.players)
    bots = []

    for i in range(MAX_PLAYERS - num_players):
        if spawn_points:
            sp = spawn_points[(num_players + i) % len(spawn_points)]
        else:
            sp = {"x": 0, "y": 1, "z": 0, "rotY": 0}

        bots.append({
            "bot_id": f"bot_{uuid.uuid4().hex[:6]}",
            "username": f"CC_BOT_{i + 1}",
            "modelPath": f"/static/models/{host_pair.CarCatalog.model_path}",
            "color": host_pair.UserCar.color,
            "stats": {
                "speed": host_pair.CarCatalog.speed,
                "accel": host_pair.CarCatalog.accel,
                "handling": host_pair.CarCatalog.handling
            },
            "spawnPos": sp
        })

    return bots


@app.route('/race/start/<int:lobby_id>')
@login_required
def start_race_logic(lobby_id):
    lobby = db.session.get(Lobby, lobby_id)
    if not lobby or current_user.id != lobby.host_id:
        return "Not authorized", 403

    track = db.session.get(Track, lobby.track_id) if lobby.track_id else None
    if not track:
        flash("Select a track first.", "error")
        return redirect(url_for('view_lobby', code=lobby.code))

    track_json = load_track_json(track)
    use_bots = request.args.get('use_bots') == 'true'

    # Fresh race data for this lobby
    reset_lobby_state(lobby.id)
    race_state[lobby.id] = {}
    race_meta[lobby.id] = {
        "code": lobby.code,
        "host_id": lobby.host_id,
        "laps": track_json.get("laps", 3),
        "rewards": track_json.get("reward", {}),
        "timer_started": False,
        "finalized": False
    }
    lobby_bots[lobby.id] = build_bots(lobby, track_json) if use_bots else []

    for bot in lobby_bots[lobby.id]:
        race_state[lobby.id][bot["bot_id"]] = {
            "username": bot["username"],
            "is_bot": True,
            "lap": 0,
            "checkpoint": 0,
            "finished": False,
            "finish_time": None
        }

    lobby.is_started = True
    db.session.commit()

    # Move every client in the lobby to the race page
    socketio.emit('redirect_to_race', {'url': url_for('race_screen', code=lobby.code)}, room=lobby.code)
    return redirect(url_for('race_screen', code=lobby.code))


@socketio.on('request_countdown')
def handle_countdown(data):
    lobby = Lobby.query.filter_by(code=data.get('lobbyCode')).first()
    if lobby and current_user.is_authenticated and current_user.id == lobby.host_id:
        socketio.emit('race_countdown', {'seconds': 3}, room=lobby.code)


@app.route('/race/<code>')
@login_required
def race_screen(code):
    lobby = Lobby.query.filter_by(code=code).first_or_404()
    if current_user.lobby_id != lobby.id:
        flash("You are not in this lobby.", "error")
        return redirect(url_for('garage'))

    user_car = db.session.get(UserCar, current_user.active_car_id) if current_user.active_car_id else None
    track = db.session.get(Track, lobby.track_id) if lobby.track_id else None
    if not track or not user_car:
        flash("No track selected.", "error")
        return redirect(url_for('garage'))

    return render_template(
        'race.html',
        lobby=lobby,
        lobby_host_id=lobby.host_id,
        track_json_path=track.model_path,
        track_data=load_track_json(track),
        user_car=user_car,
        practice_mode=False
    )


@socketio.on('request_spawn_point')
def handle_spawn_request():
    lobby = db.session.get(Lobby, current_user.lobby_id) if current_user.lobby_id else None

    if not lobby or not lobby.track_id:
        emit('spawn_data', {'spawnPos': {'x': 0, 'y': 1, 'z': 0, 'rotY': 0}})
        return

    spawn_points = load_track_json(db.session.get(Track, lobby.track_id)).get("spawnPoints", [])

    if not spawn_points:
        sp = {'x': 0, 'y': 1, 'z': 0, 'rotY': 0}
    else:
        index = lobby_spawn_counters.get(lobby.id, 0)
        lobby_spawn_counters[lobby.id] = index + 1
        sp = spawn_points[index % len(spawn_points)]

    emit('spawn_data', {'spawnPos': sp})


@socketio.on("request_bots")
def handle_request_bots(data):
    # Every client asks once its track is loaded, so late joiners also get the bots
    lobby = Lobby.query.filter_by(code=(data or {}).get("code")).first()
    if lobby:
        emit("bot_spawn_list", lobby_bots.get(lobby.id, []))


@socketio.on("bot_update")
def handle_bot_update(data):
    """The host simulates the bots and reports their positions and race progress."""
    lobby_id = current_user.lobby_id
    meta = race_meta.get(lobby_id)
    if not meta or meta["host_id"] != current_user.id or meta["finalized"]:
        return

    emit("bots_moved", data, room=meta["code"], include_self=False)

    state = race_state.get(lobby_id, {})
    changed = False
    for bot in data.get("bots", []):
        entry = state.get(bot.get("id"))
        if not entry or not entry["is_bot"] or entry["finished"]:
            continue
        lap, cp = int(bot.get("lap", 0)), int(bot.get("checkpoint", 0))
        if (lap, cp) != (entry["lap"], entry["checkpoint"]):
            entry["lap"], entry["checkpoint"] = lap, cp
            changed = True
        if lap >= meta["laps"]:
            mark_finished(lobby_id, bot["id"])

    if changed:
        update_standings_for_lobby(lobby_id)


def get_my_race_entry():
    lobby_id = current_user.lobby_id
    entry = race_state.get(lobby_id, {}).get(current_user.id)
    if not entry or race_meta.get(lobby_id, {}).get("finalized"):
        return None, None
    return lobby_id, entry


@socketio.on("checkpoint_passed")
def handle_cp(cp):
    lobby_id, entry = get_my_race_entry()
    if entry and not entry["finished"]:
        entry["checkpoint"] = int(cp)
        update_standings_for_lobby(lobby_id)


@socketio.on("lap_completed")
def handle_lap(lap):
    lobby_id, entry = get_my_race_entry()
    if entry and not entry["finished"]:
        entry["lap"] = int(lap)
        entry["checkpoint"] = 0
        update_standings_for_lobby(lobby_id)


@socketio.on("race_finished")
def handle_finish():
    lobby_id, entry = get_my_race_entry()
    if entry:
        mark_finished(lobby_id, current_user.id)


def mark_finished(lobby_id, participant_id):
    entry = race_state[lobby_id][participant_id]
    if entry["finished"]:
        return

    entry["finished"] = True
    entry["finish_time"] = time.time()
    meta = race_meta[lobby_id]

    players = [p for pid, p in race_state[lobby_id].items() if pid != "_final"]
    if all(p["finished"] for p in players):
        finalize_race(lobby_id)
        return

    # First driver across the line: the others get FINISH_TIMEOUT seconds
    if not meta["timer_started"]:
        meta["timer_started"] = True

        def finish_after_timeout():
            time.sleep(FINISH_TIMEOUT)
            with app.app_context():
                finalize_race(lobby_id)

        threading.Thread(target=finish_after_timeout, daemon=True).start()

    update_standings_for_lobby(lobby_id)


def finalize_race(lobby_id):
    with finalize_lock:
        meta = race_meta.get(lobby_id)
        if not meta or meta["finalized"]:
            return
        meta["finalized"] = True

    final_standings = get_standings(lobby_id)
    reward_table = meta["rewards"]
    results = []

    for idx, (pid, pdata) in enumerate(final_standings):
        pos = idx + 1
        reward = 0
        if not pdata["is_bot"]:
            reward = reward_table.get(str(pos), reward_table.get("default", 10))
            user = db.session.get(User, pid)
            if user:
                user.credits += reward

        results.append({
            "user_id": pid,
            "username": pdata["username"],
            "position": pos,
            "reward": reward,
            "is_bot": pdata["is_bot"],
            "finished": pdata["finished"]
        })

    db.session.commit()

    race_state[lobby_id]["_final"] = {"rewards": results}
    socketio.emit("race_results", race_state[lobby_id]["_final"], room=meta["code"])


# ================== RESULTS ==================

@app.route('/race/results/<code>')
@login_required
def race_results_page(code):
    lobby = Lobby.query.filter_by(code=code).first_or_404()

    if lobby.id not in race_state or "_final" not in race_state[lobby.id]:
        flash("Results not available.", "error")
        return redirect(url_for('garage'))

    return render_template("race_results.html", lobby=lobby, results=race_state[lobby.id]["_final"])


# ================== DESKTOP APP ==================

HOST = os.environ.get('CC_HOST', '127.0.0.1')
PORT = int(os.environ.get('CC_PORT', '5000'))
LOCAL_URL = f"http://127.0.0.1:{PORT}"


def wait_for_server():
    while True:
        try:
            urllib.request.urlopen(LOCAL_URL)
            break
        except Exception:
            time.sleep(0.2)


def start_app():
    def run_server():
        socketio.run(app, host=HOST, port=PORT, debug=False, allow_unsafe_werkzeug=True)

    threading.Thread(target=run_server, daemon=True).start()
    wait_for_server()

    import webview
    webview.create_window("Cyber Circuit", LOCAL_URL, width=1280, height=800)
    webview.start()


if __name__ == '__main__':
    start_app()
