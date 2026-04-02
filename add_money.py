from server import app, db, User

with app.app_context():
    user = User.query.filter_by(username='Raziel').first()
    if user:
        user.credits += 100000
        db.session.commit()
        print(f"💰 Soldi accreditati! Nuovo bilancio: {user.credits}")