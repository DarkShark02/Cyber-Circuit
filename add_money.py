"""Developer helper: give credits to a player.

Usage: python add_money.py <username> [amount]
"""
import sys

from server import app, db, User

if len(sys.argv) < 2:
    sys.exit(__doc__)

username = sys.argv[1]
amount = int(sys.argv[2]) if len(sys.argv) > 2 else 1000

with app.app_context():
    user = User.query.filter_by(username=username).first()
    if not user:
        sys.exit(f"No player named '{username}'.")
    user.credits += amount
    db.session.commit()
    print(f"Added {amount} credits to {username}. New balance: {user.credits}")
