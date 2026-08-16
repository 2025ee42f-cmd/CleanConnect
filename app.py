import os, json, math, sqlite3, secrets
from datetime import datetime, date, timedelta
from functools import wraps
from flask import Flask, request, session, redirect, url_for, jsonify, render_template, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

BASE=os.path.dirname(os.path.abspath(__file__)); DB=os.path.join(BASE,'cleanconnect.db'); UP=os.path.join(BASE,'static','uploads')
os.makedirs(UP, exist_ok=True)
app=Flask(__name__); app.secret_key=os.environ.get('SECRET_KEY','cleanconnect-dev-'+secrets.token_hex(16)); app.config['MAX_CONTENT_LENGTH']=10*1024*1024
ALLOWED={'jpg','jpeg','png','webp','gif'}
CATEGORIES=['construction debris','e-waste','hazardous/chemical','biomedical','mixed dump','tyres/scrap','other']
STATUSES=['Pending','Accepted','On the Way','Collected','Disposed']; URGENCY=['normal','urgent','emergency']
LEVELS=[('Green Scout',0),('Waste Warrior',100),('Eco Guardian',300),('City Champion',600),('Swachh Hero',1000)]
REWARDS=[('Digital Green Citizen Certificate',20),('Priority cleanup voucher',50),('₹50 mobile recharge',100),('Segregation bin',180),('₹200 grocery voucher',250)]

def db():
 c=sqlite3.connect(DB); c.row_factory=sqlite3.Row; return c

def now(): return datetime.now().isoformat(timespec='seconds')
def finite(x):
 try: return math.isfinite(float(x))
 except: return False

def init_db():
 c=db(); c.executescript('''CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('citizen','manager')),phone TEXT,designation TEXT,employee_id TEXT,vehicle TEXT,eco_points INTEGER NOT NULL DEFAULT 0,reports_filed INTEGER NOT NULL DEFAULT 0,reports_verified INTEGER NOT NULL DEFAULT 0,badges TEXT NOT NULL DEFAULT '[]',streak INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,category TEXT NOT NULL,quantity_kg REAL NOT NULL,urgency TEXT NOT NULL,address TEXT NOT NULL,pincode TEXT NOT NULL,lat REAL,lng REAL,description TEXT,photo TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Pending',verified_bonus INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,accepted_at TEXT,disposed_at TEXT,accepted_by INTEGER,FOREIGN KEY(user_id) REFERENCES users(id));
 CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,message TEXT NOT NULL,is_read INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id));
 CREATE TABLE IF NOT EXISTS redemptions(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,reward TEXT NOT NULL,cost INTEGER NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id));''')
 # Lightweight migration for older DBs
 try: c.execute('ALTER TABLE reports ADD COLUMN accepted_by INTEGER')
 except sqlite3.OperationalError: pass
 # Demo accounts
 for name,email,pw,role,phone,desig,eid,vehicle in [('CleanConnect Manager','manager@cleanconnect.in','manager123','manager','9876543210','Municipal Cleanup Manager','CC-MGR-001','MH 01 CC 2026'),('Demo Citizen','demo@cleanconnect.in','demo123','citizen','9999999999','','','')]:
  if not c.execute('SELECT 1 FROM users WHERE email=?',(email,)).fetchone():
   c.execute('INSERT INTO users(name,email,password_hash,role,phone,designation,employee_id,vehicle,created_at) VALUES(?,?,?,?,?,?,?,?,?)',(name,email,generate_password_hash(pw),role,phone,desig,eid,vehicle,now()))
 c.commit(); c.close()

def current():
 uid=session.get('uid');
 if not uid:return None
 c=db(); u=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone(); c.close(); return u

def login_required(fn):
 @wraps(fn)
 def w(*a,**kw):
  if not current(): return jsonify(error='Login required'),401
  return fn(*a,**kw)
 return w

def role_required(role):
 def deco(fn):
  @wraps(fn)
  def w(*a,**kw):
   u=current()
   if not u:return jsonify(error='Login required'),401
   if u['role']!=role:return jsonify(error='Forbidden'),403
   return fn(*a,**kw)
  return w
 return deco

def award(c,uid,points,msg):
 if points<=0:return
 c.execute('UPDATE users SET eco_points=eco_points+? WHERE id=?',(points,uid)); c.execute('INSERT INTO notifications(user_id,message,created_at) VALUES(?,?,?)',(uid,f'+{points} EcoPoints — {msg}',now()))

def badges_and_streak(c,uid):
 u=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone(); badges=json.loads(u['badges'] or '[]'); new=[]
 def add(b):
  if b not in badges: badges.append(b); new.append(b)
 count=c.execute('SELECT COUNT(*) n FROM reports WHERE user_id=?',(uid,)).fetchone()['n']; add('First Report') if count>=1 else None; add('Photo Pro') if count>=1 else None
 # streak is consecutive reporting days ending today/most recent
 days=[r['d'] for r in c.execute("SELECT DISTINCT substr(created_at,1,10) d FROM reports WHERE user_id=? ORDER BY d DESC",(uid,))]
 streak=0; expected=date.today()
 for d in days:
  try: dd=date.fromisoformat(d)
  except: continue
  if dd==expected: streak+=1; expected-=timedelta(days=1)
  elif dd<expected: break
 if streak>=7:add('On Fire')
 if any((r['created_at'][11:13]<'06' or r['created_at'][11:13]>='22') for r in c.execute('SELECT created_at FROM reports WHERE user_id=?',(uid,))): add('Night Owl')
 if c.execute("SELECT COUNT(*) n FROM reports WHERE user_id=? AND status!='Pending'",(uid,)).fetchone()['n']>=1:add('First Responder')
 if u['eco_points']>=300:add('Eco Guardian')
 if u['eco_points']>=600:add('City Champion')
 c.execute('UPDATE users SET badges=?,streak=? WHERE id=?',(json.dumps(badges),streak,uid))
 for b in new:c.execute('INSERT INTO notifications(user_id,message,created_at) VALUES(?,?,?)',(uid,f'Badge unlocked: {b} 🏅',now()))

def report_json(r,c):
 user=c.execute('SELECT name,phone,designation,employee_id,vehicle FROM users WHERE id=?',(r['user_id'],)).fetchone(); crew=None
 if r['status']!='Pending':
  crew=c.execute("SELECT u.name,u.phone,u.designation,u.employee_id,u.vehicle FROM notifications n JOIN users u ON u.role='manager' WHERE 1=0").fetchone()
  # accepted manager identity stored as notification isn't enough; use earliest manager as demo crew identity
  crew=c.execute("SELECT name,phone,designation,employee_id,vehicle FROM users WHERE id=(SELECT accepted_by FROM reports WHERE id=?)",(r['id'],)).fetchone()
 return {**dict(r),'reporter':dict(user) if user else None,'crew':dict(crew) if crew else None,'photo_url':url_for('photo',filename=r['photo'])}

@app.route('/')
def landing(): return render_template('index.html',user=current())
@app.route('/register')
def register_page(): return render_template('auth.html',mode='register')
@app.route('/login')
def login_page(): return render_template('auth.html',mode='login')
@app.route('/dashboard')
def dashboard():
 u=current();
 if not u:return redirect(url_for('login_page'))
 return redirect(url_for('crew_page' if u['role']=='manager' else 'dashboard_page'))
@app.route('/dashboard/citizen')
def dashboard_page(): return render_template('dashboard.html',user=current())
@app.route('/crew')
def crew_page(): return render_template('crew.html',user=current()) if current() and current()['role']=='manager' else redirect(url_for('login_page'))
@app.route('/profile')
def profile_page(): return render_template('profile.html',user=current()) if current() else redirect(url_for('login_page'))
@app.route('/certificate')
def cert_page(): return render_template('certificate.html',user=current()) if current() else redirect(url_for('login_page'))

@app.post('/api/register')
def register():
 d=request.form or request.json or {}; name=(d.get('name') or '').strip(); email=(d.get('email') or '').strip().lower(); pw=d.get('password') or ''
 if not name or not email or len(pw)<6:return jsonify(error='Name, email and password (6+ characters) are required'),400
 c=db()
 try:c.execute('INSERT INTO users(name,email,password_hash,role,phone,created_at) VALUES(?,?,?,?,?,?)',(name,email,generate_password_hash(pw),'citizen',(d.get('phone') or '').strip(),now()));c.commit()
 except sqlite3.IntegrityError:return jsonify(error='Email already registered'),409
 u=c.execute('SELECT id FROM users WHERE email=?',(email,)).fetchone();c.close();session['uid']=u['id'];return jsonify(ok=True)
@app.post('/api/login')
def login():
 d=request.get_json(silent=True) or request.form; email=(d.get('email') or '').strip().lower(); pw=d.get('password') or ''; c=db();u=c.execute('SELECT * FROM users WHERE email=?',(email,)).fetchone();c.close()
 if not u or not check_password_hash(u['password_hash'],pw):return jsonify(error='Invalid email or password'),401
 session['uid']=u['id'];return jsonify(ok=True,role=u['role'])
@app.post('/logout')
def logout():session.clear();return redirect(url_for('landing'))

@app.get('/api/me')
@login_required
def me():
 u=current(); return jsonify({**dict(u),'badges':json.loads(u['badges'] or '[]'),'level':level(u['eco_points'])})
def level(p):
 cur=LEVELS[0][0]
 for n,v in LEVELS:
  if p>=v:cur=n
 return cur

@app.post('/api/reports')
@role_required('citizen')
def create_report():
 if 'photo' not in request.files or not request.files['photo'] or not request.files['photo'].filename:return jsonify(error='Photo is mandatory. Please upload or capture a photo.'),400
 f=request.files['photo']; ext=f.filename.rsplit('.',1)[-1].lower() if '.' in f.filename else ''
 if ext not in ALLOWED:return jsonify(error='Only JPG, PNG, WEBP or GIF images are allowed.'),400
 d=request.form
 try:q=float(d.get('quantity_kg','')); lat=float(d.get('lat')) if d.get('lat') not in (None,'') else None; lng=float(d.get('lng')) if d.get('lng') not in (None,'') else None
 except:return jsonify(error='Quantity and coordinates must be valid numbers.'),400
 if not finite(q) or q<=0:return jsonify(error='Quantity must be a finite number greater than 0.'),400
 if lat is not None and (not finite(lat) or not -90<=lat<=90):return jsonify(error='Latitude is invalid.'),400
 if lng is not None and (not finite(lng) or not -180<=lng<=180):return jsonify(error='Longitude is invalid.'),400
 cat=d.get('category'); urg=d.get('urgency','normal')
 if cat not in CATEGORIES or urg not in URGENCY:return jsonify(error='Invalid category or urgency.'),400
 if not d.get('address','').strip() or not d.get('pincode','').strip():return jsonify(error='Address and pincode are required.'),400
 c=db(); cur=c.execute('INSERT INTO reports(user_id,category,quantity_kg,urgency,address,pincode,lat,lng,description,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(current()['id'],cat,q,urg,d['address'].strip(),d['pincode'].strip(),lat,lng,d.get('description','').strip(),'Pending',now())); rid=cur.lastrowid
 filename=f'rep_{rid}.{ext}'; f.save(os.path.join(UP,filename)); c.execute('UPDATE reports SET photo=? WHERE id=?',(filename,rid));c.execute('UPDATE users SET reports_filed=reports_filed+1 WHERE id=?',(current()['id'],))
 pts=10+(5 if lat is not None and lng is not None else 0)+(3 if urg=='urgent' else 5 if urg=='emergency' else 0); award(c,current()['id'],pts,'Report filed'); badges_and_streak(c,current()['id'])
 managers=c.execute("SELECT id FROM users WHERE role='manager'").fetchall()
 for m in managers:c.execute('INSERT INTO notifications(user_id,message,created_at) VALUES(?,?,?)',(m['id'],f'New {urgency_label(urg)} waste report #{rid} — {cat}',now()))
 c.commit();r=c.execute('SELECT * FROM reports WHERE id=?',(rid,)).fetchone();c.close();return jsonify(report=report_json(r,db()),message=f'Report #{rid} submitted. +{pts} EcoPoints')
def urgency_label(x):return x.capitalize()

@app.get('/api/reports')
@login_required
def reports():
 u=current();c=db(); rows=c.execute('SELECT * FROM reports '+('WHERE user_id=? ' if u['role']=='citizen' else '')+'ORDER BY id DESC',((u['id'],) if u['role']=='citizen' else ())).fetchall(); out=[report_json(r,c) for r in rows];c.close();return jsonify(reports=out)

@app.get('/api/notifications')
@login_required
def notifications():
 c=db(); rows=c.execute('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 40',(current()['id'],)).fetchall(); unread=c.execute('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND is_read=0',(current()['id'],)).fetchone()['n'];c.close();return jsonify(notifications=[dict(x) for x in rows],unread=unread)
@app.post('/api/notifications/read')
@login_required
def notif_read():
 c=db();c.execute('UPDATE notifications SET is_read=1 WHERE user_id=?',(current()['id'],));c.commit();c.close();return jsonify(ok=True)

@app.patch('/api/reports/<int:rid>/status')
@role_required('manager')
def status(rid):
 d=request.get_json(silent=True) or {}; new=d.get('status');c=db();r=c.execute('SELECT * FROM reports WHERE id=?',(rid,)).fetchone()
 if not r:return jsonify(error='Report not found'),404
 try:i=STATUSES.index(r['status']);j=STATUSES.index(new)
 except:return jsonify(error='Invalid status'),400
 if not (j==i+1 or (i==4 and j==3)): return jsonify(error='Managers must advance one step at a time; only a Disposed→Collected correction is allowed.'),400
 c.execute('UPDATE reports SET status=?,accepted_at=CASE WHEN ?="Accepted" THEN ? ELSE accepted_at END,disposed_at=CASE WHEN ?="Disposed" THEN ? ELSE disposed_at END,accepted_by=CASE WHEN ?="Accepted" THEN ? ELSE accepted_by END WHERE id=?',(new,new,now(),new,now(),new,current()['id'],rid))
 if new=='Disposed' and r['verified_bonus']==0:
  c.execute('UPDATE reports SET verified_bonus=1 WHERE id=? AND verified_bonus=0',(rid,))
  if c.execute('SELECT changes()').fetchone()[0]==1: award(c,r['user_id'],25,'Verified cleanup');c.execute('UPDATE users SET reports_verified=reports_verified+1 WHERE id=?',(r['user_id'],))
 c.execute('INSERT INTO notifications(user_id,message,created_at) VALUES(?,?,?)',(r['user_id'],f'Report #{rid} status updated to {new}.',now()));badges_and_streak(c,r['user_id']);c.commit();c.close();return jsonify(ok=True)

@app.get('/api/stats')
@role_required('manager')
def stats():
 c=db(); total=c.execute('SELECT COUNT(*) n FROM reports').fetchone()['n'];kg=c.execute('SELECT COALESCE(SUM(quantity_kg),0) x FROM reports').fetchone()['x'];today=c.execute("SELECT COUNT(*) n FROM reports WHERE substr(created_at,1,10)=date('now','localtime')").fetchone()['n'];pending=c.execute("SELECT COUNT(*) n FROM reports WHERE status='Pending'").fetchone()['n'];cats=[dict(x) for x in c.execute('SELECT category,COUNT(*) count,COALESCE(SUM(quantity_kg),0) kg FROM reports GROUP BY category ORDER BY count DESC')];pipe=[dict(x) for x in c.execute('SELECT status,COUNT(*) count FROM reports GROUP BY status')];c.close();return jsonify(total=total,total_kg=kg,new_today=today,pending=pending,categories=cats,pipeline=pipe)
@app.get('/api/leaderboard')
@login_required
def leaderboard():
 c=db();rows=c.execute("SELECT id,name,eco_points,reports_filed,reports_verified FROM users WHERE role='citizen' ORDER BY eco_points DESC,name LIMIT 20").fetchall();out=[{**dict(r),'rank':i+1,'level':level(r['eco_points'])} for i,r in enumerate(rows)];c.close();return jsonify(leaderboard=out)
@app.post('/api/redeem')
@role_required('citizen')
def redeem():
 d=request.get_json(silent=True) or {}; reward=d.get('reward'); cost=next((c for r,c in REWARDS if r==reward),None)
 if cost is None:return jsonify(error='Unknown reward'),400
 c=db();cur=c.execute('UPDATE users SET eco_points=eco_points-? WHERE id=? AND eco_points>=?',(cost,current()['id'],cost))
 if cur.rowcount!=1:c.rollback();c.close();return jsonify(error='Insufficient EcoPoints'),409
 c.execute('INSERT INTO redemptions(user_id,reward,cost,created_at) VALUES(?,?,?,?)',(current()['id'],reward,cost,now()));c.execute('INSERT INTO notifications(user_id,message,created_at) VALUES(?,?,?)',(current()['id'],f'Redeemed {reward} for {cost} EcoPoints.',now()));c.commit();c.close();return jsonify(ok=True)
@app.get('/api/redemptions')
@role_required('citizen')
def redemptions():
 c=db();r=[dict(x) for x in c.execute('SELECT * FROM redemptions WHERE user_id=? ORDER BY id DESC',(current()['id'],)).fetchall()];c.close();return jsonify(redemptions=r)
@app.get('/api/crew-profile')
@role_required('manager')
def crew_get():return jsonify(user=dict(current()))
@app.patch('/api/crew-profile')
@role_required('manager')
def crew_patch():
 d=request.get_json(silent=True) or {};c=db();c.execute('UPDATE users SET name=?,phone=?,designation=?,employee_id=?,vehicle=? WHERE id=?',((d.get('name') or '').strip(),(d.get('phone') or '').strip(),(d.get('designation') or '').strip(),(d.get('employee_id') or '').strip(),(d.get('vehicle') or '').strip(),current()['id']));c.commit();c.close();return jsonify(ok=True)
@app.get('/photos/<path:filename>')
def photo(filename):return send_from_directory(UP,filename)

init_db()

if __name__ == '__main__':
    app.run(debug=True, host='127.0.0.1', port=5000)
