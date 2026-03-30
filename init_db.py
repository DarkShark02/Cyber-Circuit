from models import db, CarCatalog, Track

def setup_db(app):
    with app.app_context():
        db.create_all()
        # Controlla se il catalogo è già popolato
        if not CarCatalog.query.filter_by(name="FIAT PUNTO GT").first():
            print("📦 Popolamento catalogo con nuovi modelli...")
            
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
            print("✅ Catalogo aggiornato con successo!")

    with app.app_context():
        if not Track.query.first():
            piste = [
                Track(name="Neon City Circuit", difficulty="Facile", model_path="track_easy.glb", reward_multiplier=1.0),
                Track(name="Cyber Canyon", difficulty="Media", model_path="track_medium.glb", reward_multiplier=1.5),
                Track(name="The Abyss", difficulty="Difficile", model_path="track_hard.glb", reward_multiplier=2.5)
            ]
            db.session.add_all(piste)
            db.session.commit()
            print("✅ Piste caricate!")