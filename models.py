from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from sqlalchemy import UniqueConstraint
from datetime import datetime

db = SQLAlchemy()

class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(20), unique=True, nullable=False)
    password = db.Column(db.String(128), nullable=False)
    credits = db.Column(db.Integer, default=100)
    # ID della macchina attualmente in uso
    active_car_id = db.Column(db.Integer, nullable=True)
    
    # Relazioni
    owned_cars = db.relationship('UserCar', backref='owner', lazy=True)

class CarCatalog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), nullable=False)
    model_path = db.Column(db.String(100), default='generic_car.glb') # Nome del file .glb
    speed = db.Column(db.Integer, default=50)      # 0-100
    accel = db.Column(db.Integer, default=50)      # 0-100
    handling = db.Column(db.Integer, default=50)   # 0-100
    price = db.Column(db.Integer, default=0)

class UserCar(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    catalog_id = db.Column(db.Integer, db.ForeignKey('car_catalog.id'), nullable=False)
    color = db.Column(db.String(7), default="#00f2ff")
    current_speed = db.Column(db.Float)

    # Aggiungi questa relazione per facilitare i JOIN
    car = db.relationship('CarCatalog', backref='owners')

    # FIX: Qui deve esserci catalog_id, NON car_id
    __table_args__ = (UniqueConstraint('user_id', 'catalog_id', name='_user_car_uc'),)

class Friendship(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    friend_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    # Status: 'pending', 'accepted'
    status = db.Column(db.String(10), default='pending')

class MatchHistory(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    lobby_id = db.Column(db.String(50))
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    position = db.Column(db.Integer)
    date = db.Column(db.DateTime, default=datetime.utcnow)