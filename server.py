import os
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_bcrypt import Bcrypt
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from flask_socketio import SocketIO, emit
from models import db, User, CarCatalog, UserCar
from init_db import setup_catalog

app = Flask(__name__)
app.config['SECRET_KEY'] = 'neon_speed_secret_2026'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///racist_game.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)
setup_catalog(app)
bcrypt = Bcrypt(app)
socketio = SocketIO(app, cors_allowed_origins="*")

login_manager = LoginManager(app)
login_manager.login_view = 'login'

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# --- ROTTE HTTP ---

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
        new_user = User(username=user, password=hashed_pwd, credits=100) # Soldi iniziali
        db.session.add(new_user)
        db.session.commit()
        
        # Regalo auto iniziale (PUNTO è la ID 1)
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

@app.route('/garage')
@login_required
def garage():
    car_id = request.args.get('select_car', type=int)
    # JOIN per avere dati dell'auto e del catalogo insieme
    user_cars = db.session.query(UserCar, CarCatalog).join(CarCatalog).filter(UserCar.user_id == current_user.id).all()
    
    if car_id:
        # Cerchiamo la specifica auto posseduta tra quelle dell'utente
        active_pair = next((p for p in user_cars if p.UserCar.id == car_id), user_cars[0] if user_cars else None)
    else:
        active_pair = user_cars[0] if user_cars else None

    active_car = active_pair.UserCar if active_pair else None
    car_info = active_pair.CarCatalog if active_pair else None
    model_file = car_info.model_path if car_info else 'auto.glb'
    
    return render_template('garage.html', 
                           user_car=active_car, 
                           car_info=car_info, 
                           all_cars=user_cars,
                           model_file=model_file)

@app.route('/shop')
@login_required
def shop():
    # Trova ID delle auto già possedute
    owned_ids = [c.catalog_id for c in UserCar.query.filter_by(user_id=current_user.id).all()]
    # Mostra solo quelle che mancano
    available_cars = CarCatalog.query.filter(~CarCatalog.id.in_(owned_ids)).all()
    return render_template('shop.html', cars=available_cars)

@app.route('/buy_car/<int:car_id>', methods=['POST'])
@login_required
def buy_car(car_id):
    car_to_buy = CarCatalog.query.get_or_404(car_id)
    if current_user.credits >= car_to_buy.price:
        try:
            new_car = UserCar(user_id=current_user.id, catalog_id=car_to_buy.id)
            current_user.credits -= car_to_buy.price
            db.session.add(new_car)
            db.session.commit()
            flash(f"Unità {car_to_buy.name} acquisita!", "success")
        except:
            db.session.rollback()
            flash("Sistema: Unità già presente nel database utente.", "error")
    else:
        flash("Crediti insufficienti per l'acquisizione.", "error")
    return redirect(url_for('shop'))

@app.route('/save_car_config', methods=['POST'])
@login_required
def save_car_config():
    data = request.get_json()
    car_id = data.get('car_id')
    new_color = data.get('color')
    
    user_car = UserCar.query.filter_by(id=car_id, user_id=current_user.id).first()
    if user_car:
        user_car.color = new_color
        db.session.commit()
        return jsonify({'success': True})
    
    return jsonify({'success': False}), 400

@app.route('/race')
@login_required
def race():
    return render_template('race.html')

@app.route('/logout')
def logout():
    logout_user()
    return redirect(url_for('login'))

# --- SOCKET.IO ---
@socketio.on('update_position')
def handle_position(data):
    data['user_id'] = current_user.id
    data['username'] = current_user.username
    emit('player_moved', data, broadcast=True, include_self=False)

if __name__ == '__main__':
    socketio.run(app, debug=True)