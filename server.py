import os
import uuid
import threading
import time
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, current_app
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import or_
from flask_bcrypt import Bcrypt
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from flask_socketio import SocketIO, emit, join_room, leave_room

from models import db, User, CarCatalog, UserCar, Friendship, Track, Lobby
from init_db import setup_db

app = Flask(__name__)
app.config['SECRET_KEY'] = 'neon_speed_secret_2026'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///racist_game.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)
setup_db(app)
bcrypt = Bcrypt(app)
socketio = SocketIO(app, cors_allowed_origins="*")

login_manager = LoginManager(app)
login_manager.login_view = 'login'

# Gestione spawn dinamico per lobby
lobby_spawn_counters = {}

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# --- ROTTE AUTH & GARAGE ---

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
    if current_user.lobby_id:
        current_user.lobby_id = None
        db.session.commit()

    car_id = request.args.get('select_car', type=int)
    if car_id:
        owned = UserCar.query.filter_by(id=car_id, user_id=current_user.id).first()
        if owned:
            current_user.active_car_id = owned.id
            db.session.commit()

    user_cars = db.session.query(UserCar, CarCatalog).join(CarCatalog).filter(UserCar.user_id == current_user.id).all()
    active_pair = next((p for p in user_cars if p.UserCar.id == current_user.active_car_id), user_cars[0] if user_cars else None)
    
    active_car = active_pair.UserCar if active_pair else None
    car_info = active_pair.CarCatalog if active_pair else None
    
    return render_template('garage.html', user_car=active_car, car_info=car_info, all_cars=user_cars, model_file=car_info.model_path if car_info else 'auto.glb')

# --- SHOP & CONFIG ---

@app.route('/shop')
@login_required
def shop():
    owned_ids = [c.catalog_id for c in UserCar.query.filter_by(user_id=current_user.id).all()]
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
    user_car = UserCar.query.filter_by(id=data.get('car_id'), user_id=current_user.id).first()
    if user_car:
        user_car.color = data.get('color')
        current_user.active_car_id = user_car.id 
        db.session.commit()
        return jsonify({'success': True})
    return jsonify({'success': False}), 400

# --- SOCIAL ---

@app.route('/social')
@login_required
def social_page():
    friendships = Friendship.query.filter(
        ((Friendship.user_id == current_user.id) | (Friendship.friend_id == current_user.id)),
        Friendship.status == 'accepted'
    ).all()
    friend_list = [User.query.get(f.friend_id if f.user_id == current_user.id else f.user_id) for f in friendships]
    pending = User.query.join(Friendship, Friendship.user_id == User.id).filter(Friendship.friend_id == current_user.id, Friendship.status == 'pending').all()
    return render_template('social.html', friends=friend_list, pending=pending)

@app.route('/search_players')
@login_required
def search_players():
    query = request.args.get('q', '').strip()
    if not query: return jsonify([])
    users = User.query.filter(User.username.ilike(f"%{query}%"), User.id != current_user.id).limit(10).all()
    return jsonify([{"id": u.id, "username": u.username} for u in users])

@app.route('/send_friend_request/<int:friend_id>', methods=['POST'])
@login_required
def send_request(friend_id):
    if friend_id == current_user.id: return jsonify({"success": False, "message": "Errore auto-reclutamento."})
    existing = Friendship.query.filter(or_((Friendship.user_id==current_user.id)&(Friendship.friend_id==friend_id),(Friendship.user_id==friend_id)&(Friendship.friend_id==current_user.id))).first()
    if not existing:
        db.session.add(Friendship(user_id=current_user.id, friend_id=friend_id))
        db.session.commit()
        return jsonify({"success": True, "message": "Richiesta inviata."})
    return jsonify({"success": False, "message": "Relazione già esistente."})

@app.route('/accept_friend/<int:user_id>', methods=['POST'])
@login_required
def accept_friend(user_id):
    f = Friendship.query.filter_by(user_id=user_id, friend_id=current_user.id, status='pending').first()
    if f:
        f.status = 'accepted'
        db.session.commit()
        flash('Nuovo alleato in crew!', 'success')
    return redirect(url_for('social_page'))

# --- LOBBY SYSTEM ---

@app.route('/create_lobby')
@login_required
def create_lobby():
    Lobby.query.filter_by(host_id=current_user.id).delete()
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
    friendships = Friendship.query.filter(((Friendship.user_id == current_user.id) | (Friendship.friend_id == current_user.id)), Friendship.status == 'accepted').all()
    friend_list = [User.query.get(f.friend_id if f.user_id == current_user.id else f.user_id) for f in friendships]
    return render_template('lobby.html', lobby=lobby, tracks=tracks, friends=friend_list)

@app.route('/select_track/<int:lobby_id>/<int:track_id>', methods=['POST'])
@login_required
def select_track(lobby_id, track_id):
    lobby = db.session.get(Lobby, lobby_id) 
    if lobby and lobby.host_id == current_user.id:
        lobby.track_id = track_id
        db.session.commit()
        return jsonify({"status": "success"})
    return jsonify({"status": "error"}), 403

# --- SOCKET.IO ---

@socketio.on('connect')
def handle_connect():
    if current_user.is_authenticated:
        join_room(f"user_{current_user.id}")

@socketio.on('join_lobby')
def handle_join(data):
    lobby_code = data['code']
    join_room(lobby_code)
    emit('player_joined', {'username': current_user.username, 'user_id': current_user.id}, room=lobby_code)

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
            thread = threading.Thread(target=delayed_cleanup, args=(current_app.app_context(), lobby.id))
            thread.start()

@socketio.on('send_lobby_invite')
def handle_invite(data):
    emit('receive_invite', {'host_name': current_user.username, 'lobby_code': data['lobby_code']}, room=f"user_{data['friend_id']}")

@socketio.on('change_track')
def handle_track(data):
    emit('track_updated', {'track_id': data['track_id']}, room=data['code'])

@socketio.on('update_position')
def handle_position(data):
    # Includiamo dati dell'auto per caricamento dinamico degli avversari
    data.update({
        'user_id': current_user.id, 
        'username': current_user.username
    })
    emit('player_moved', data, broadcast=True, include_self=False)

# --- RACE SYSTEM ---

@app.route('/race/start/<int:lobby_id>')
@login_required
def start_race_logic(lobby_id):
    lobby = db.session.get(Lobby, lobby_id)
    if not lobby: return "Lobby non trovata", 404
    if current_user.id == lobby.host_id:
        lobby.is_started = True
        db.session.commit()
        socketio.emit('redirect_to_race', {'url': url_for('race_screen', code=lobby.code)}, room=lobby.code)
        return redirect(url_for('race_screen', code=lobby.code))
    return "Non autorizzato", 403

@app.route('/race/<code>')
@login_required
def race_screen(code):
    lobby = Lobby.query.filter_by(code=code).first_or_404()
    user_car = UserCar.query.get(current_user.active_car_id)
    track = Track.query.get(lobby.track_id)
    if not user_car:
        user_car = UserCar.query.filter_by(user_id=current_user.id).first()
        if user_car:
            current_user.active_car_id = user_car.id
            db.session.commit()
    return render_template(
        'race.html',
        lobby=lobby,
        track_json_path=track.model_path,
        user_car=user_car
    )

@socketio.on('request_spawn_point')
def handle_spawn_request():
    lobby_id = current_user.lobby_id
    if not lobby_id:
        emit('spawn_data', {'spawnPos': {'x': 0, 'y': 1, 'z': 0}})
        return

    if lobby_id not in lobby_spawn_counters:
        lobby_spawn_counters[lobby_id] = 0
    
    count = lobby_spawn_counters[lobby_id]
    lobby_spawn_counters[lobby_id] += 1
    
    spawn_pos = {
        'x': count * 7, # Distanziati di 7 metri per evitare collisioni
        'y': 1,
        'z': 0
    }
    emit('spawn_data', {'spawnPos': spawn_pos})

@socketio.on('get_active_players')
def handle_get_players():
    # In questa versione semplificata, gli altri player vengono scoperti tramite 'player_moved'
    # che ora include modelPath e color
    pass

race_state = {}

@socketio.on("checkpoint_passed")
def handle_cp(cp):
    race_state[current_user.id]["checkpoint"] = cp
    update_standings()

@socketio.on("lap_completed")
def handle_lap(lap):
    race_state[current_user.id]["lap"] = lap
    update_standings()

@socketio.on("race_finished")
def handle_finish():
    race_state[current_user.id]["finished"] = True
    socketio.emit("race_results", race_state)

def update_standings():
    standings = sorted(
        race_state.items(),
        key=lambda p: (-p[1]["lap"], -p[1]["checkpoint"])
    )
    socketio.emit("standings_update", standings)


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)