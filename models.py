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
    active_car_id = db.Column(db.Integer, nullable=True)
    lobby_id = db.Column(db.Integer, db.ForeignKey('lobby.id'), nullable=True)
    
    owned_cars = db.relationship('UserCar', backref='owner', lazy=True)

class CarCatalog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), nullable=False)
    model_path = db.Column(db.String(100), default='generic_car.glb')
    speed = db.Column(db.Integer, default=50)
    accel = db.Column(db.Integer, default=50)
    handling = db.Column(db.Integer, default=50)
    price = db.Column(db.Integer, default=0)

class UserCar(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    catalog_id = db.Column(db.Integer, db.ForeignKey('car_catalog.id'), nullable=False)
    color = db.Column(db.String(7), default="#00f2ff")
    
    car = db.relationship('CarCatalog')
    __table_args__ = (UniqueConstraint('user_id', 'catalog_id', name='_user_car_uc'),)

class Friendship(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    friend_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    status = db.Column(db.String(10), default='pending')

class Track(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), nullable=False)
    difficulty = db.Column(db.String(20))
    model_path = db.Column(db.String(200))
    reward_multiplier = db.Column(db.Float, default=1.0)
    checkpoints = db.Column(db.Text)  # JSON string
    laps = db.Column(db.Integer, default=3)


class Lobby(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(10), unique=True, nullable=False)
    host_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    track_id = db.Column(db.Integer, db.ForeignKey('track.id'), nullable=True)
    is_started = db.Column(db.Boolean, default=False)
    
    # post_update=True evita conflitti di foreign key circolare
    host = db.relationship('User', foreign_keys=[host_id], post_update=True)
    players = db.relationship('User', foreign_keys=[User.lobby_id], backref='current_lobby_obj', lazy=True)