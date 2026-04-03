import os
import uuid
import threading
import time
import json
import webview
import sys
import requests

from flask import (
    Flask, render_template, request, redirect,
    url_for, flash, jsonify, current_app
)
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import or_
from flask_bcrypt import Bcrypt
from flask_login import (
    LoginManager, login_user, logout_user,
    login_required, current_user
)
from flask_socketio import SocketIO, emit, join_room, leave_room

from models import db, User, CarCatalog, UserCar, Friendship, Track, Lobby
from init_db import setup_db

def resource_path(relative_path):
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.abspath("."), relative_path)

app = Flask(
    __name__,
    template_folder=resource_path("templates"),
    static_folder=resource_path("static")
)
app.config['SECRET_KEY'] = 'neon_speed_secret_2026'

basedir = os.path.abspath(os.path.dirname(__file__))
db_path = os.path.join(basedir, "racist_game.db")

app.config['SQLALCHEMY_DATABASE_URI'] = f"sqlite:///{db_path}"



db.init_app(app)
setup_db(app)
bcrypt = Bcrypt(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

login_manager = LoginManager(app)
login_manager.login_view = 'login'

# Gestione spawn dinamico per lobby
lobby_spawn_counters = {}

# Stato gara in memoria
# race_state[lobby_id] = {
#   user_id: { lap, checkpoint, finished, finish_time },
#   "_final": { standings: [...], rewards: [...] }
# }
race_state = {}


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


# ================== AUTH & GARAGE ==================

@app.route('/')
def home():
    return redirect(url_for('login'))


@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        user = request.form.get('username')
        pwd = request.form.get('password')

        if User.query.filter_by(username=user).first():
            flash('Username già occupato!', 'error')
            return redirect(url_for('register'))

        hashed_pwd = bcrypt.generate_password_hash(pwd).decode('utf-8')
        new_user = User(username=user, password=hashed_pwd, credits=100)
        db.session.add(new_user)
        db.session.commit()

        # Auto iniziale
        car = UserCar(user_id=new_user.id, catalog_id=1, color="#00f2ff")
        db.session.add(car)
        db.session.commit()

        flash('Registrazione completata! Benvenuto pilota.', 'success')
        return redirect(url_for('login'))

    return render_template('register.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        user = User.query.filter_by(username=request.form.get('username')).first()
        if user and bcrypt.check_password_hash(user.password, request.form.get('password')):
            login_user(user)
            return redirect(url_for('garage'))
        flash('Credenziali errate!', 'error')
    return render_template('login.html')


@app.route('/logout')
def logout():
    logout_user()
    return redirect(url_for('login'))


@app.route('/garage')
@login_required
def garage():
    # Uscita da eventuale lobby precedente
    if current_user.lobby_id:
        current_user.lobby_id = None
        db.session.commit()

    # Selezione auto attiva
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
        user_cars[0] if user_cars else None
    )

    active_car = active_pair.UserCar if active_pair else None
    car_info = active_pair.CarCatalog if active_pair else None

    if not current_user.active_car_id:
        first_car = UserCar.query.filter_by(user_id=current_user.id).first()
        if first_car:
            current_user.active_car_id = first_car.id
            db.session.commit()
        else:
            # crea un'auto di default per evitare errori
            default_car = UserCar(user_id=current_user.id, catalog_id=1, color="#00f2ff")
            db.session.add(default_car)
            db.session.commit()
            current_user.active_car_id = default_car.id
            db.session.commit()

    return render_template(
        'garage.html',
        user_car=active_car,
        car_info=car_info,
        all_cars=user_cars,
        model_file=car_info.model_path if car_info else 'auto.glb'
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
    car_to_buy = CarCatalog.query.get_or_404(car_id)
    if current_user.credits >= car_to_buy.price:
        new_car = UserCar(user_id=current_user.id, catalog_id=car_to_buy.id)
        current_user.credits -= car_to_buy.price
        db.session.add(new_car)
        db.session.commit()
        flash(f"Unità {car_to_buy.name} acquisita!", "success")
    else:
        flash("Crediti insufficienti.", "error")
    return redirect(url_for('shop'))


@app.route('/save_car_config', methods=['POST'])
@login_required
def save_car_config():
    data = request.get_json()
    user_car = UserCar.query.filter_by(
        id=data.get('car_id'),
        user_id=current_user.id
    ).first()

    if user_car:
        user_car.color = data.get('color')
        current_user.active_car_id = user_car.id
        db.session.commit()
        return jsonify({'success': True})

    return jsonify({'success': False}), 400


# ================== SOCIAL ==================

@app.route('/social')
@login_required
def social_page():
    friendships = Friendship.query.filter(
        ((Friendship.user_id == current_user.id) |
         (Friendship.friend_id == current_user.id)),
        Friendship.status == 'accepted'
    ).all()

    friend_list = [
        User.query.get(
            f.friend_id if f.user_id == current_user.id else f.user_id
        )
        for f in friendships
    ]

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
        friends=friend_list,
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
        return jsonify({"success": False, "message": "Errore auto-reclutamento."})

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
        return jsonify({"success": True, "message": "Richiesta inviata."})

    return jsonify({"success": False, "message": "Relazione già esistente."})


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
        flash('Nuovo alleato in crew!', 'success')

    return redirect(url_for('social_page'))


# ================== LOBBY SYSTEM ==================

@app.route('/create_lobby')
@login_required
def create_lobby():
    # Una sola lobby per host
    Lobby.query.filter_by(host_id=current_user.id).delete()
    db.session.commit()

    code = str(uuid.uuid4())[:6].upper()
    new_lobby = Lobby(code=code, host_id=current_user.id)
    db.session.add(new_lobby)
    db.session.commit()

    current_user.lobby_id = new_lobby.id
    db.session.commit()

    return redirect(url_for('view_lobby', code=code))


@app.route('/lobby/<code>')
@login_required
def view_lobby(code):
    lobby = Lobby.query.filter_by(code=code).first_or_404()
    current_user.lobby_id = lobby.id
    db.session.commit()

    tracks = Track.query.all()

    friendships = Friendship.query.filter(
        ((Friendship.user_id == current_user.id) |
         (Friendship.friend_id == current_user.id)),
        Friendship.status == 'accepted'
    ).all()

    friend_list = [
        User.query.get(
            f.friend_id if f.user_id == current_user.id else f.user_id
        )
        for f in friendships
    ]

    return render_template(
        'lobby.html',
        lobby=lobby,
        tracks=tracks,
        friends=friend_list
    )


@app.route('/select_track/<int:lobby_id>/<int:track_id>', methods=['POST'])
@login_required
def select_track(lobby_id, track_id):
    lobby = db.session.get(Lobby, lobby_id)
    if lobby and lobby.host_id == current_user.id:
        lobby.track_id = track_id
        db.session.commit()
        return jsonify({"status": "success"})
    return jsonify({"status": "error"}), 403


# ================== SOCKET.IO BASE ==================

@socketio.on('connect')
def handle_connect():
    if current_user.is_authenticated:
        join_room(f"user_{current_user.id}")


class BotPlayer:
    def __init__(self, bot_id, username, car_catalog_id, color):
        self.id = bot_id
        self.username = username
        self.car_id = car_catalog_id
        self.color = color
        self.is_bot = True

@socketio.on('join_lobby')
def handle_join(data):
    lobby_code = data['code']
    lobby = Lobby.query.filter_by(code=lobby_code).first()
    if not lobby or len(lobby.players) >= 3:
        emit('error', {'message': 'Lobby piena!'})
        return

    join_room(lobby_code)

    if lobby.id not in race_state:
        race_state[lobby.id] = {}

    race_state[lobby.id][current_user.id] = {
        "lap": 0,
        "checkpoint": 0,
        "finished": False,
        "finish_time": None
    }

    emit('player_joined', {
        'username': current_user.username,
        'user_id': current_user.id
    }, room=lobby_code)


@socketio.on('disconnect')
def handle_disconnect():
    if current_user.is_authenticated:
        lobby = Lobby.query.filter_by(host_id=current_user.id).first()
        if lobby and not lobby.is_started:
            def delayed_cleanup(app_context, lobby_id):
                with app_context:
                    time.sleep(5)
                    l = Lobby.query.get(lobby_id)
                    if l and not l.is_started:
                        db.session.delete(l)
                        db.session.commit()
                        if lobby_id in lobby_spawn_counters:
                            del lobby_spawn_counters[lobby_id]

            thread = threading.Thread(
                target=delayed_cleanup,
                args=(current_app.app_context(), lobby.id)
            )
            thread.start()


@socketio.on('send_lobby_invite')
def handle_invite(data):
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
    data.update({
        'user_id': current_user.id,
        'username': current_user.username
    })
    emit('player_moved', data, broadcast=True, include_self=False)


# ================== RACE SYSTEM ==================

def get_lobby_for_user():
    return current_user.lobby_id


def update_standings_for_lobby(lobby_id):
    if lobby_id not in race_state:
        return

    lobby_data = race_state[lobby_id]

    # escludiamo eventuale chiave "_final"
    players_only = {
        uid: d for uid, d in lobby_data.items()
        if uid != "_final"
    }

    standings = sorted(
        players_only.items(),
        key=lambda p: (-p[1]["lap"], -p[1]["checkpoint"])
    )

    lobby = Lobby.query.get(lobby_id)
    if not lobby:
        return

    socketio.emit(
        "standings_update",
        standings,
        room=lobby.code
    )


@app.route('/race')
@login_required
def quick_race():
    # modalità pratica: nessuna lobby, nessun reward, pista generata client-side
    return render_template(
        'race.html',
        lobby=None,
        lobby_host_id=None,
        track_json_path="practice",   # NON serve davvero
        track_data={},                # NON serve davvero
        user_car=UserCar.query.get(current_user.active_car_id),
        practice_mode=True
    )


@app.route('/race/start/<int:lobby_id>')
@login_required
def start_race_logic(lobby_id):
    lobby = db.session.get(Lobby, lobby_id)
    if not lobby or current_user.id != lobby.host_id:
        return "Non autorizzato", 403

    use_bots = request.args.get('use_bots') == 'true'
    lobby.is_started = True
    db.session.commit()

    # Comunica a tutti i client di spostarsi sulla pagina della gara
    if use_bots:
        num_players = len(lobby.players)

        host_pair = (
            db.session.query(UserCar, CarCatalog)
            .join(CarCatalog, CarCatalog.id == UserCar.catalog_id)
            .filter(UserCar.id == current_user.active_car_id)
            .first()
        )

        user_car = host_pair.UserCar
        catalog = host_pair.CarCatalog

        for i in range(3 - num_players):
            bot_id = f"bot_{uuid.uuid4().hex[:4]}"
            print(f"[SERVER] Spawning bot {bot_id} ({i+1}/{3-num_players})")

            race_state[lobby.id][bot_id] = {
                "username": f"RACIST_BOT_{i+1}",
                "is_bot": True,
                "car_catalog_id": catalog.id,
                "color": user_car.color,
                "lap": 0,
                "checkpoint": 0,
                "finished": False,
                "finish_time": None
            }

            socketio.emit("bot_spawn", {
                "bot_id": bot_id,
                "username": f"RACIST_BOT_{i+1}",
                "modelPath": catalog.model_path,
                "color": user_car.color
            }, room=lobby.code)

            print(f"[SERVER] bot_spawn sent for {bot_id}")

    socketio.emit('redirect_to_race', {'url': url_for('race_screen', code=lobby.code)}, room=lobby.code)

    # Reindirizza anche l'host stesso
    return redirect(url_for('race_screen', code=lobby.code))

@socketio.on('request_countdown')
def handle_countdown(data):
    lobby_code = data.get('lobbyCode')
    # Invia il countdown a tutti nella stanza
    socketio.emit('race_countdown', {'seconds': 3}, room=lobby_code)

@app.route('/race/<code>')
@login_required
def race_screen(code):
    lobby = Lobby.query.filter_by(code=code).first_or_404()
    user_car = UserCar.query.get(current_user.active_car_id)
    track = Track.query.get(lobby.track_id)

    if not track:
        return "Pista non selezionata", 400

    json_path = resource_path(track.model_path.lstrip("/"))
    with open(json_path, "r") as f:
        track_json = json.load(f)

    return render_template(
        'race.html',
        lobby=lobby,
        lobby_host_id=lobby.host_id,
        track_json_path=track.model_path,
        track_data=track_json,
        user_car=user_car,
        practice_mode=False
    )


@socketio.on('request_spawn_point')
def handle_spawn_request():
    lobby_id = current_user.lobby_id
    lobby = Lobby.query.get(lobby_id)

    if not lobby or not lobby.track_id:
        emit(
            'spawn_data',
            {'spawnPos': {'x': 0, 'y': 1, 'z': 0, 'rotY': 0}},
            room=request.sid
        )
        return

    track = Track.query.get(lobby.track_id)
    json_path = resource_path(track.model_path.lstrip("/"))
    with open(json_path, "r") as f:
        data = json.load(f)
    spawn_points = data.get("spawnPoints", [])

    if lobby_id not in lobby_spawn_counters:
        lobby_spawn_counters[lobby_id] = 0

    if not spawn_points:
        sp = {'x': 0, 'y': 1, 'z': 0, 'rotY': 0}
    else:
        index = lobby_spawn_counters[lobby_id] % len(spawn_points)
        lobby_spawn_counters[lobby_id] += 1
        sp = spawn_points[index]

    emit('spawn_data', {'spawnPos': sp}, room=request.sid)


@socketio.on('get_active_players')
def handle_get_players():
    # in questa versione gli altri player vengono scoperti via "player_moved"
    pass


@socketio.on("checkpoint_passed")
def handle_cp(cp):
    lobby_id = get_lobby_for_user()
    if lobby_id not in race_state or current_user.id not in race_state[lobby_id]:
        return

    race_state[lobby_id][current_user.id]["checkpoint"] = cp
    update_standings_for_lobby(lobby_id)


@socketio.on("lap_completed")
def handle_lap(lap):
    lobby_id = get_lobby_for_user()
    if lobby_id not in race_state or current_user.id not in race_state[lobby_id]:
        return

    race_state[lobby_id][current_user.id]["lap"] = lap
    update_standings_for_lobby(lobby_id)


@socketio.on("race_finished")
def handle_finish():
    lobby_id = get_lobby_for_user()
    if lobby_id not in race_state or current_user.id not in race_state[lobby_id]:
        return

    lobby_data = race_state[lobby_id]
    lobby = Lobby.query.get(lobby_id)

    # Segna il giocatore come arrivato
    lobby_data[current_user.id]["finished"] = True
    lobby_data[current_user.id]["finish_time"] = time.time()

    # Lista giocatori (senza _final)
    players_only = {
        uid: d for uid, d in lobby_data.items()
        if uid != "_final"
    }

    # === 1) Se è il primo a finire, salva il timestamp e avvia il timer ===
    if not hasattr(lobby, "first_finish_time") or lobby.first_finish_time is None:
        lobby.first_finish_time = time.time()
        db.session.commit()

        def finish_after_timeout(app_context, lobby_id, lobby_code):
            with app_context:
                time.sleep(60)

                players_only = {
                    uid: d for uid, d in race_state[lobby_id].items()
                    if uid != "_final"
                }

                # Se non tutti hanno finito → chiudi comunque la gara
                if not all(p["finished"] for p in players_only.values()):
                    finalize_race(lobby_id)

        threading.Thread(
            target=finish_after_timeout,
            args=(current_app.app_context(), lobby_id, lobby.code)
        ).start()

    # === 2) Se tutti hanno finito → chiudi subito ===
    if all(p["finished"] for p in players_only.values()):
        finalize_race(lobby_id)
        return

    # Aggiorna classifica provvisoria
    update_standings_for_lobby(lobby_id)

def finalize_race(lobby_id):
    lobby_data = race_state[lobby_id]
    lobby = Lobby.query.get(lobby_id)
    track = Track.query.get(lobby.track_id)

    players_only = {
        uid: d for uid, d in lobby_data.items()
        if uid != "_final"
    }

    # Ordina classifica
    final_standings = sorted(
        players_only.items(),
        key=lambda p: (
            not p[1]["finished"],
            p[1]["finish_time"] if p[1]["finish_time"] else 999999
        )
    )

    # Carica reward
    json_path = resource_path(track.model_path.lstrip("/"))
    with open(json_path, "r") as f:
        track_json = json.load(f)
    reward_table = track_json.get("reward", {})

    rewards_assigned = []

    for idx, (user_id, pdata) in enumerate(final_standings):
        pos = idx + 1
        reward = reward_table.get(str(pos), reward_table.get("default", 10))

        user = User.query.get(user_id)
        if user:
            user.credits += reward
            rewards_assigned.append({
                "user_id": user_id,
                "username": user.username,
                "position": pos,
                "reward": reward
            })

    db.session.commit()

    lobby_data["_final"] = {
        "standings": [
            {
                "user_id": uid,
                "lap": pdata["lap"],
                "checkpoint": pdata["checkpoint"],
                "finish_time": pdata["finish_time"]
            }
            for uid, pdata in final_standings
        ],
        "rewards": rewards_assigned
    }

    socketio.emit("race_results", lobby_data["_final"], room=lobby.code)


# ================== PODIO / RISULTATI ==================

@app.route('/race/results/<code>')
@login_required
def race_results_page(code):
    lobby = Lobby.query.filter_by(code=code).first_or_404()
    lobby_id = lobby.id

    if lobby_id not in race_state or "_final" not in race_state[lobby_id]:
        return "Risultati non disponibili", 404

    results = race_state[lobby_id]["_final"]
    # template "race_results.html" con podio + bottone "Torna al garage"
    return render_template("race_results.html", lobby=lobby, results=results)

def wait_for_server():
    while True:
        try:
            requests.get("http://127.0.0.1:5000")
            break
        except:
            time.sleep(0.2)

def start_app():
    def run_server():
        socketio.run(app, host='127.0.0.1', port=5000, debug=False)

    t = threading.Thread(target=run_server)
    t.daemon = True
    t.start()

    wait_for_server()

    webview.create_window("Racist Game", "http://127.0.0.1:5000")
    webview.start()

if __name__ == '__main__':
    start_app()