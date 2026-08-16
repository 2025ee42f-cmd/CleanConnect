import os
import json
import math
import secrets
from datetime import datetime, date, timedelta
from functools import wraps

import psycopg
from psycopg.rows import dict_row
from flask import (
    Flask, request, session, redirect, url_for,
    jsonify, render_template, send_from_directory
)
from werkzeug.security import generate_password_hash, check_password_hash


BASE = os.path.dirname(os.path.abspath(__file__))
UP = os.path.join(BASE, "static", "uploads")
os.makedirs(UP, exist_ok=True)

app = Flask(__name__)
app.secret_key = os.environ.get(
    "SECRET_KEY",
    "cleanconnect-dev-" + secrets.token_hex(16)
)

app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024

DATABASE_URL = os.environ.get("DATABASE_URL")

ALLOWED = {"jpg", "jpeg", "png", "webp", "gif"}

CATEGORIES = [
    "construction debris",
    "e-waste",
    "hazardous/chemical",
    "biomedical",
    "mixed dump",
    "tyres/scrap",
    "other",
]

STATUSES = [
    "Pending",
    "Accepted",
    "On the Way",
    "Collected",
    "Disposed",
]

URGENCY = [
    "normal",
    "urgent",
    "emergency",
]

LEVELS = [
    ("Green Scout", 0),
    ("Waste Warrior", 100),
    ("Eco Guardian", 300),
    ("City Champion", 600),
    ("Swachh Hero", 1000),
]

REWARDS = [
    ("Digital Green Citizen Certificate", 20),
    ("Priority cleanup voucher", 50),
    ("₹50 mobile recharge", 100),
    ("Segregation bin", 180),
    ("₹200 grocery voucher", 250),
]


# ---------------------------------------------------------
# DATABASE
# ---------------------------------------------------------

def db():
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is not configured. "
            "Add your Render PostgreSQL Internal Database URL "
            "as the DATABASE_URL environment variable."
        )

    return psycopg.connect(
        DATABASE_URL,
        row_factory=dict_row,
        connect_timeout=10
    )


def now():
    return datetime.now().isoformat(timespec="seconds")


def finite(x):
    try:
        return math.isfinite(float(x))
    except Exception:
        return False


def init_db():
    with db() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('citizen','manager')),
                phone TEXT,
                designation TEXT,
                employee_id TEXT,
                vehicle TEXT,
                eco_points INTEGER NOT NULL DEFAULT 0,
                reports_filed INTEGER NOT NULL DEFAULT 0,
                reports_verified INTEGER NOT NULL DEFAULT 0,
                badges TEXT NOT NULL DEFAULT '[]',
                streak INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS reports (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id),
                category TEXT NOT NULL,
                quantity_kg DOUBLE PRECISION NOT NULL,
                urgency TEXT NOT NULL,
                address TEXT NOT NULL,
                pincode TEXT NOT NULL,
                lat DOUBLE PRECISION,
                lng DOUBLE PRECISION,
                description TEXT,
                photo TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Pending',
                verified_bonus INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                accepted_at TEXT,
                disposed_at TEXT,
                accepted_by BIGINT REFERENCES users(id)
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS notifications (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id),
                message TEXT NOT NULL,
                is_read INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS redemptions (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id),
                reward TEXT NOT NULL,
                cost INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        # Demo manager
        demo_accounts = [
            (
                "CleanConnect Manager",
                "manager@cleanconnect.in",
                "manager123",
                "manager",
                "9876543210",
                "Municipal Cleanup Manager",
                "CC-MGR-001",
                "MH 01 CC 2026",
            ),
            (
                "Demo Citizen",
                "demo@cleanconnect.in",
                "demo123",
                "citizen",
                "9999999999",
                "",
                "",
                "",
            ),
        ]

        for (
            name,
            email,
            pw,
            role,
            phone,
            designation,
            employee_id,
            vehicle,
        ) in demo_accounts:

            existing = c.execute(
                "SELECT 1 FROM users WHERE email=%s",
                (email,)
            ).fetchone()

            if not existing:
                c.execute(
                    """
                    INSERT INTO users
                    (
                        name,
                        email,
                        password_hash,
                        role,
                        phone,
                        designation,
                        employee_id,
                        vehicle,
                        created_at
                    )
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        name,
                        email,
                        generate_password_hash(pw),
                        role,
                        phone,
                        designation,
                        employee_id,
                        vehicle,
                        now(),
                    ),
                )


# ---------------------------------------------------------
# AUTH
# ---------------------------------------------------------

def current():
    uid = session.get("uid")

    if not uid:
        return None

    with db() as c:
        return c.execute(
            "SELECT * FROM users WHERE id=%s",
            (uid,)
        ).fetchone()


def login_required(fn):
    @wraps(fn)
    def w(*a, **kw):
        if not current():
            return jsonify(error="Login required"), 401

        return fn(*a, **kw)

    return w


def role_required(role):
    def deco(fn):
        @wraps(fn)
        def w(*a, **kw):
            u = current()

            if not u:
                return jsonify(error="Login required"), 401

            if u["role"] != role:
                return jsonify(error="Forbidden"), 403

            return fn(*a, **kw)

        return w

    return deco


# ---------------------------------------------------------
# ECOPOINTS / BADGES
# ---------------------------------------------------------

def award(c, uid, points, msg):
    if points <= 0:
        return

    c.execute(
        """
        UPDATE users
        SET eco_points = eco_points + %s
        WHERE id=%s
        """,
        (points, uid),
    )

    c.execute(
        """
        INSERT INTO notifications(user_id,message,created_at)
        VALUES(%s,%s,%s)
        """,
        (
            uid,
            f"+{points} EcoPoints — {msg}",
            now(),
        ),
    )


def badges_and_streak(c, uid):
    u = c.execute(
        "SELECT * FROM users WHERE id=%s",
        (uid,)
    ).fetchone()

    if not u:
        return

    try:
        badges = json.loads(u["badges"] or "[]")
    except Exception:
        badges = []

    new = []

    def add(b):
        if b not in badges:
            badges.append(b)
            new.append(b)

    count = c.execute(
        "SELECT COUNT(*) AS n FROM reports WHERE user_id=%s",
        (uid,)
    ).fetchone()["n"]

    if count >= 1:
        add("First Report")
        add("Photo Pro")

    rows = c.execute(
        """
        SELECT DISTINCT LEFT(created_at,10) AS d
        FROM reports
        WHERE user_id=%s
        ORDER BY d DESC
        """,
        (uid,),
    ).fetchall()

    streak = 0
    expected = date.today()

    for row in rows:
        d = row["d"]

        try:
            dd = date.fromisoformat(d)
        except Exception:
            continue

        if dd == expected:
            streak += 1
            expected -= timedelta(days=1)
        elif dd < expected:
            break

    if streak >= 7:
        add("On Fire")

    night = c.execute(
        """
        SELECT COUNT(*) AS n
        FROM reports
        WHERE user_id=%s
        AND (
            SUBSTRING(created_at FROM 12 FOR 2)::INTEGER < 6
            OR SUBSTRING(created_at FROM 12 FOR 2)::INTEGER >= 22
        )
        """,
        (uid,),
    ).fetchone()["n"]

    if night:
        add("Night Owl")

    responder = c.execute(
        """
        SELECT COUNT(*) AS n
        FROM reports
        WHERE user_id=%s
        AND status!='Pending'
        """,
        (uid,),
    ).fetchone()["n"]

    if responder >= 1:
        add("First Responder")

    if u["eco_points"] >= 300:
        add("Eco Guardian")

    if u["eco_points"] >= 600:
        add("City Champion")

    c.execute(
        """
        UPDATE users
        SET badges=%s, streak=%s
        WHERE id=%s
        """,
        (
            json.dumps(badges),
            streak,
            uid,
        ),
    )

    for b in new:
        c.execute(
            """
            INSERT INTO notifications(user_id,message,created_at)
            VALUES(%s,%s,%s)
            """,
            (
                uid,
                f"Badge unlocked: {b} 🏅",
                now(),
            ),
        )


def level(points):
    current_level = LEVELS[0][0]

    for name, minimum in LEVELS:
        if points >= minimum:
            current_level = name

    return current_level


# ---------------------------------------------------------
# REPORT SERIALIZATION
# ---------------------------------------------------------

def report_json(r, c):
    user = c.execute(
        """
        SELECT name,phone,designation,employee_id,vehicle
        FROM users
        WHERE id=%s
        """,
        (r["user_id"],),
    ).fetchone()

    crew = None

    if r["status"] != "Pending" and r["accepted_by"]:
        crew = c.execute(
            """
            SELECT name,phone,designation,employee_id,vehicle
            FROM users
            WHERE id=%s
            """,
            (r["accepted_by"],),
        ).fetchone()

    result = dict(r)

    result["reporter"] = dict(user) if user else None
    result["crew"] = dict(crew) if crew else None

    if r["photo"]:
        result["photo_url"] = url_for(
            "photo",
            filename=r["photo"]
        )
    else:
        result["photo_url"] = None

    return result


def urgency_label(x):
    return x.capitalize()


# ---------------------------------------------------------
# PAGES
# ---------------------------------------------------------

@app.route("/")
def landing():
    return render_template(
        "index.html",
        user=current()
    )


@app.route("/register")
def register_page():
    return render_template(
        "auth.html",
        mode="register"
    )


@app.route("/login")
def login_page():
    return render_template(
        "auth.html",
        mode="login"
    )


@app.route("/dashboard")
def dashboard():
    u = current()

    if not u:
        return redirect(url_for("login_page"))

    return redirect(
        url_for(
            "crew_page"
            if u["role"] == "manager"
            else "dashboard_page"
        )
    )


@app.route("/dashboard/citizen")
def dashboard_page():
    return render_template(
        "dashboard.html",
        user=current()
    )


@app.route("/crew")
def crew_page():
    u = current()

    if u and u["role"] == "manager":
        return render_template(
            "crew.html",
            user=u
        )

    return redirect(url_for("login_page"))


@app.route("/profile")
def profile_page():
    u = current()

    if not u:
        return redirect(url_for("login_page"))

    return render_template(
        "profile.html",
        user=u
    )


@app.route("/certificate")
def cert_page():
    u = current()

    if not u:
        return redirect(url_for("login_page"))

    return render_template(
        "certificate.html",
        user=u
    )


# ---------------------------------------------------------
# REGISTER
# ---------------------------------------------------------

@app.post("/api/register")
def register():
    d = request.form or request.json or {}

    name = (d.get("name") or "").strip()
    email = (d.get("email") or "").strip().lower()
    pw = d.get("password") or ""

    if not name or not email or len(pw) < 6:
        return jsonify(
            error="Name, email and password (6+ characters) are required"
        ), 400

    try:
        with db() as c:
            try:
                c.execute(
                    """
                    INSERT INTO users
                    (
                        name,
                        email,
                        password_hash,
                        role,
                        phone,
                        created_at
                    )
                    VALUES(%s,%s,%s,'citizen',%s,%s)
                    """,
                    (
                        name,
                        email,
                        generate_password_hash(pw),
                        (d.get("phone") or "").strip(),
                        now(),
                    ),
                )

            except psycopg.errors.UniqueViolation:
                return jsonify(
                    error="Email already registered"
                ), 409

            u = c.execute(
                "SELECT id FROM users WHERE email=%s",
                (email,)
            ).fetchone()

        session["uid"] = u["id"]

        return jsonify(ok=True)

    except Exception:
        app.logger.exception("Registration failed")
        return jsonify(error="Registration failed. Please try again."), 500


# ---------------------------------------------------------
# LOGIN
# ---------------------------------------------------------

@app.post("/api/login")
def login():
    d = request.get_json(silent=True) or request.form

    email = (d.get("email") or "").strip().lower()
    pw = d.get("password") or ""

    with db() as c:
        u = c.execute(
            "SELECT * FROM users WHERE email=%s",
            (email,)
        ).fetchone()

    if not u or not check_password_hash(
        u["password_hash"],
        pw
    ):
        return jsonify(
            error="Invalid email or password"
        ), 401

    session["uid"] = u["id"]

    return jsonify(
        ok=True,
        role=u["role"]
    )


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("landing"))


# ---------------------------------------------------------
# ME
# ---------------------------------------------------------

@app.get("/api/me")
@login_required
def me():
    u = current()

    return jsonify(
        {
            **dict(u),
            "badges": json.loads(u["badges"] or "[]"),
            "level": level(u["eco_points"]),
        }
    )


# ---------------------------------------------------------
# REPORT CREATION
# ---------------------------------------------------------

@app.post("/api/reports")
@role_required("citizen")
def create_report():

    # Photo mandatory
    if (
        "photo" not in request.files
        or not request.files["photo"]
        or not request.files["photo"].filename
    ):
        return jsonify(
            error="Photo is mandatory. Please upload or capture a photo."
        ), 400

    f = request.files["photo"]

    ext = (
        f.filename.rsplit(".", 1)[-1].lower()
        if "." in f.filename
        else ""
    )

    if ext not in ALLOWED:
        return jsonify(
            error="Only JPG, PNG, WEBP or GIF images are allowed."
        ), 400

    d = request.form

    try:
        q = float(d.get("quantity_kg", ""))

        lat = (
            float(d.get("lat"))
            if d.get("lat") not in (None, "")
            else None
        )

        lng = (
            float(d.get("lng"))
            if d.get("lng") not in (None, "")
            else None
        )

    except Exception:
        return jsonify(
            error="Quantity and coordinates must be valid numbers."
        ), 400

    if not finite(q) or q <= 0:
        return jsonify(
            error="Quantity must be a finite number greater than 0."
        ), 400

    if lat is not None and (
        not finite(lat)
        or not -90 <= lat <= 90
    ):
        return jsonify(
            error="Latitude is invalid."
        ), 400

    if lng is not None and (
        not finite(lng)
        or not -180 <= lng <= 180
    ):
        return jsonify(
            error="Longitude is invalid."
        ), 400

    cat = d.get("category")
    urg = d.get("urgency", "normal")

    if cat not in CATEGORIES or urg not in URGENCY:
        return jsonify(
            error="Invalid category or urgency."
        ), 400

    if (
        not d.get("address", "").strip()
        or not d.get("pincode", "").strip()
    ):
        return jsonify(
            error="Address and pincode are required."
        ), 400

    u = current()

    with db() as c:

        # Insert first and retrieve PostgreSQL-generated ID.
        # Photo gets a temporary value, then is replaced with
        # a server-generated filename.
        cur = c.execute(
            """
            INSERT INTO reports
            (
                user_id,
                category,
                quantity_kg,
                urgency,
                address,
                pincode,
                lat,
                lng,
                description,
                photo,
                status,
                created_at
            )
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,'','Pending',%s)
            RETURNING id
            """,
            (
                u["id"],
                cat,
                q,
                urg,
                d["address"].strip(),
                d["pincode"].strip(),
                lat,
                lng,
                d.get("description", "").strip(),
                now(),
            ),
        )

        rid = cur.fetchone()["id"]

        # Server-generated filename
        filename = f"rep_{rid}.{ext}"

        f.save(
            os.path.join(UP, filename)
        )

        c.execute(
            """
            UPDATE reports
            SET photo=%s
            WHERE id=%s
            """,
            (
                filename,
                rid,
            ),
        )

        c.execute(
            """
            UPDATE users
            SET reports_filed=reports_filed+1
            WHERE id=%s
            """,
            (u["id"],),
        )

        points = (
            10
            + (5 if lat is not None and lng is not None else 0)
            + (
                3 if urg == "urgent"
                else 5 if urg == "emergency"
                else 0
            )
        )

        award(
            c,
            u["id"],
            points,
            "Report filed"
        )

        badges_and_streak(
            c,
            u["id"]
        )

        managers = c.execute(
            "SELECT id FROM users WHERE role='manager'"
        ).fetchall()

        for manager in managers:
            c.execute(
                """
                INSERT INTO notifications
                (user_id,message,created_at)
                VALUES(%s,%s,%s)
                """,
                (
                    manager["id"],
                    (
                        f"New {urgency_label(urg)} waste "
                        f"report #{rid} — {cat}"
                    ),
                    now(),
                ),
            )

        r = c.execute(
            "SELECT * FROM reports WHERE id=%s",
            (rid,)
        ).fetchone()

        response = report_json(r, c)

    return jsonify(
        report=response,
        message=(
            f"Report #{rid} submitted. "
            f"+{points} EcoPoints"
        ),
    )


# ---------------------------------------------------------
# REPORTS
# ---------------------------------------------------------

@app.get("/api/reports")
@login_required
def reports():
    u = current()

    with db() as c:

        if u["role"] == "citizen":
            rows = c.execute(
                """
                SELECT *
                FROM reports
                WHERE user_id=%s
                ORDER BY id DESC
                """,
                (u["id"],),
            ).fetchall()

        else:
            rows = c.execute(
                """
                SELECT *
                FROM reports
                ORDER BY id DESC
                """
            ).fetchall()

        out = [
            report_json(r, c)
            for r in rows
        ]

    return jsonify(
        reports=out
    )


# ---------------------------------------------------------
# NOTIFICATIONS
# ---------------------------------------------------------

@app.get("/api/notifications")
@login_required
def notifications():

    u = current()

    with db() as c:

        rows = c.execute(
            """
            SELECT *
            FROM notifications
            WHERE user_id=%s
            ORDER BY id DESC
            LIMIT 40
            """,
            (u["id"],),
        ).fetchall()

        unread = c.execute(
            """
            SELECT COUNT(*) AS n
            FROM notifications
            WHERE user_id=%s
            AND is_read=0
            """,
            (u["id"],),
        ).fetchone()["n"]

    return jsonify(
        notifications=[
            dict(x)
            for x in rows
        ],
        unread=unread,
    )


@app.post("/api/notifications/read")
@login_required
def notif_read():

    u = current()

    with db() as c:
        c.execute(
            """
            UPDATE notifications
            SET is_read=1
            WHERE user_id=%s
            """,
            (u["id"],),
        )

    return jsonify(ok=True)


# ---------------------------------------------------------
# REPORT STATUS
# ---------------------------------------------------------

@app.patch("/api/reports/<int:rid>/status")
@role_required("manager")
def status(rid):

    d = request.get_json(silent=True) or {}
    new = d.get("status")

    u = current()

    with db() as c:

        r = c.execute(
            "SELECT * FROM reports WHERE id=%s",
            (rid,),
        ).fetchone()

        if not r:
            return jsonify(
                error="Report not found"
            ), 404

        try:
            i = STATUSES.index(r["status"])
            j = STATUSES.index(new)
        except Exception:
            return jsonify(
                error="Invalid status"
            ), 400

        if not (
            j == i + 1
            or (i == 4 and j == 3)
        ):
            return jsonify(
                error=(
                    "Managers must advance one step at a time; "
                    "only a Disposed→Collected correction is allowed."
                )
            ), 400

        accepted_at = r["accepted_at"]
        disposed_at = r["disposed_at"]
        accepted_by = r["accepted_by"]

        if new == "Accepted":
            accepted_at = now()
            accepted_by = u["id"]

        if new == "Disposed":
            disposed_at = now()

        c.execute(
            """
            UPDATE reports
            SET
                status=%s,
                accepted_at=%s,
                disposed_at=%s,
                accepted_by=%s
            WHERE id=%s
            """,
            (
                new,
                accepted_at,
                disposed_at,
                accepted_by,
                rid,
            ),
        )

        # Exactly-once verified cleanup bonus
        if new == "Disposed" and r["verified_bonus"] == 0:

            cur = c.execute(
                """
                UPDATE reports
                SET verified_bonus=1
                WHERE id=%s
                AND verified_bonus=0
                """,
                (rid,),
            )

            if cur.rowcount == 1:

                award(
                    c,
                    r["user_id"],
                    25,
                    "Verified cleanup"
                )

                c.execute(
                    """
                    UPDATE users
                    SET reports_verified=reports_verified+1
                    WHERE id=%s
                    """,
                    (r["user_id"],),
                )

        c.execute(
            """
            INSERT INTO notifications
            (user_id,message,created_at)
            VALUES(%s,%s,%s)
            """,
            (
                r["user_id"],
                (
                    f"Report #{rid} status "
                    f"updated to {new}."
                ),
                now(),
            ),
        )

        badges_and_streak(
            c,
            r["user_id"]
        )

    return jsonify(ok=True)


# ---------------------------------------------------------
# MANAGER ANALYTICS
# ---------------------------------------------------------

@app.get("/api/stats")
@role_required("manager")
def stats():

    with db() as c:

        total = c.execute(
            "SELECT COUNT(*) AS n FROM reports"
        ).fetchone()["n"]

        kg = c.execute(
            """
            SELECT COALESCE(SUM(quantity_kg),0) AS x
            FROM reports
            """
        ).fetchone()["x"]

        today = c.execute(
            """
            SELECT COUNT(*) AS n
            FROM reports
            WHERE LEFT(created_at,10)=CURRENT_DATE::TEXT
            """
        ).fetchone()["n"]

        pending = c.execute(
            """
            SELECT COUNT(*) AS n
            FROM reports
            WHERE status='Pending'
            """
        ).fetchone()["n"]

        cats = c.execute(
            """
            SELECT
                category,
                COUNT(*) AS count,
                COALESCE(SUM(quantity_kg),0) AS kg
            FROM reports
            GROUP BY category
            ORDER BY count DESC
            """
        ).fetchall()

        pipe = c.execute(
            """
            SELECT
                status,
                COUNT(*) AS count
            FROM reports
            GROUP BY status
            """
        ).fetchall()

    return jsonify(
        total=total,
        total_kg=kg,
        new_today=today,
        pending=pending,
        categories=[
            dict(x)
            for x in cats
        ],
        pipeline=[
            dict(x)
            for x in pipe
        ],
    )


# ---------------------------------------------------------
# LEADERBOARD
# ---------------------------------------------------------

@app.get("/api/leaderboard")
@login_required
def leaderboard():

    with db() as c:

        rows = c.execute(
            """
            SELECT
                id,
                name,
                eco_points,
                reports_filed,
                reports_verified
            FROM users
            WHERE role='citizen'
            ORDER BY eco_points DESC, name
            LIMIT 20
            """
        ).fetchall()

    out = []

    for i, r in enumerate(rows):
        item = {
            **dict(r),
            "rank": i + 1,
            "level": level(r["eco_points"]),
        }

        out.append(item)

    return jsonify(
        leaderboard=out
    )


# ---------------------------------------------------------
# REWARDS
# ---------------------------------------------------------

@app.post("/api/redeem")
@role_required("citizen")
def redeem():

    d = request.get_json(silent=True) or {}

    reward = d.get("reward")

    cost = next(
        (
            c
            for r, c in REWARDS
            if r == reward
        ),
        None,
    )

    if cost is None:
        return jsonify(
            error="Unknown reward"
        ), 400

    u = current()

    with db() as c:

        # Atomic redemption.
        # Only one simultaneous request can successfully
        # reduce the balance below the required amount.
        cur = c.execute(
            """
            UPDATE users
            SET eco_points=eco_points-%s
            WHERE id=%s
            AND eco_points >= %s
            """,
            (
                cost,
                u["id"],
                cost,
            ),
        )

        if cur.rowcount != 1:
            c.rollback()

            return jsonify(
                error="Insufficient EcoPoints"
            ), 409

        c.execute(
            """
            INSERT INTO redemptions
            (user_id,reward,cost,created_at)
            VALUES(%s,%s,%s,%s)
            """,
            (
                u["id"],
                reward,
                cost,
                now(),
            ),
        )

        c.execute(
            """
            INSERT INTO notifications
            (user_id,message,created_at)
            VALUES(%s,%s,%s)
            """,
            (
                u["id"],
                (
                    f"Redeemed {reward} "
                    f"for {cost} EcoPoints."
                ),
                now(),
            ),
        )

    return jsonify(ok=True)


@app.get("/api/redemptions")
@role_required("citizen")
def redemptions():

    u = current()

    with db() as c:
        rows = c.execute(
            """
            SELECT *
            FROM redemptions
            WHERE user_id=%s
            ORDER BY id DESC
            """,
            (u["id"],),
        ).fetchall()

    return jsonify(
        redemptions=[
            dict(x)
            for x in rows
        ]
    )


# ---------------------------------------------------------
# CREW PROFILE
# ---------------------------------------------------------

@app.get("/api/crew-profile")
@role_required("manager")
def crew_get():

    return jsonify(
        user=dict(current())
    )


@app.patch("/api/crew-profile")
@role_required("manager")
def crew_patch():

    d = request.get_json(silent=True) or {}

    u = current()

    with db() as c:
        c.execute(
            """
            UPDATE users
            SET
                name=%s,
                phone=%s,
                designation=%s,
                employee_id=%s,
                vehicle=%s
            WHERE id=%s
            """,
            (
                (d.get("name") or "").strip(),
                (d.get("phone") or "").strip(),
                (d.get("designation") or "").strip(),
                (d.get("employee_id") or "").strip(),
                (d.get("vehicle") or "").strip(),
                u["id"],
            ),
        )

    return jsonify(ok=True)


# ---------------------------------------------------------
# PHOTOS
# ---------------------------------------------------------

@app.get("/photos/<path:filename>")
def photo(filename):
    return send_from_directory(
        UP,
        filename
    )


# ---------------------------------------------------------
# STARTUP
# ---------------------------------------------------------

if __name__ == "__main__":
    init_db()
    app.run(
        debug=False,
        host="0.0.0.0",
        port=5000
    )