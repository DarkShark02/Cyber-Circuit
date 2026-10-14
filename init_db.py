from models import db, CarCatalog, Track

# Difficulty labels used by older databases
LEGACY_DIFFICULTIES = {"Facile": "Easy", "Media": "Medium", "Difficile": "Hard"}


def setup_db(app):
    with app.app_context():
        db.create_all()

        # Fill the car catalogue on first launch
        if not CarCatalog.query.filter_by(name="FIAT PUNTO GT").first():
            print("Populating car catalogue...")

            cars = [
                CarCatalog(name="FIAT PUNTO GT", model_path="fiat_punto_gt.glb",
                           speed=50, accel=50, handling=50, price=0),

                CarCatalog(name="TOYOTA GT 86", model_path="toyota_gt_86.glb",
                           speed=70, accel=70, handling=60, price=100),

                CarCatalog(name="PORSCHE 911 CARRERA", model_path="porsche_911_carrera.glb",
                           speed=80, accel=80, handling=70, price=250),

                CarCatalog(name="PORSCHE 911 TURBO", model_path="porsche_911_turbo.glb",
                           speed=80, accel=70, handling=80, price=250),

                CarCatalog(name="CYBERPUNK HOVERCAR", model_path="cyberpunk_hovercar.glb",
                           speed=90, accel=90, handling=90, price=1000)
            ]

            db.session.add_all(cars)
            db.session.commit()
            print("Car catalogue ready.")

        if not Track.query.first():
            tracks = [
                Track(name="Neon City Circuit", difficulty="Easy", model_path="/static/json/tracks/easy.json", reward_multiplier=1.0),
                Track(name="Cyber Canyon", difficulty="Medium", model_path="/static/json/tracks/medium.json", reward_multiplier=1.5),
                Track(name="The Abyss", difficulty="Hard", model_path="/static/json/tracks/hard.json", reward_multiplier=2.5)
            ]
            db.session.add_all(tracks)
            db.session.commit()
            print("Tracks loaded.")

        for old, new in LEGACY_DIFFICULTIES.items():
            Track.query.filter_by(difficulty=old).update({"difficulty": new})
        db.session.commit()
