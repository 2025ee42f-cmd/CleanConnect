# CleanConnect

A complete Flask + SQLite Smart India Hackathon 2026 prototype for citizen reporting and accountable cleanup of illegally dumped/bulk waste. It is **not** a household pickup scheduler.

## Run
```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python app.py
```
Open http://127.0.0.1:5000

Demo manager: `manager@cleanconnect.in` / `manager123`  
Demo citizen: `demo@cleanconnect.in` / `demo123`

SQLite DB and uploaded photos are created automatically. Set `SECRET_KEY` in production.
