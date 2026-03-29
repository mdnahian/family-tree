import os
import re
import uuid
import secrets
import json
from collections import defaultdict
from datetime import datetime, timezone
from functools import wraps

from dotenv import load_dotenv
load_dotenv()

from flask import (Flask, render_template, request, jsonify, redirect,
                   url_for, flash, abort, send_file)
from flask_login import (LoginManager, login_user, logout_user,
                         login_required, current_user)
from werkzeug.utils import secure_filename
from sqlalchemy import event

from config import Config
from models import (db, set_sqlite_pragma, User, Invite, FriendRequest,
                    Friendship, Person, School, FamilyUnion, ParentChild,
                    Media, MediaPerson, Evidence, FaceDetection,
                    are_friends, get_friend_ids)


def _ensure_admin(app):
    email = app.config.get('ADMIN_EMAIL')
    password = app.config.get('ADMIN_PASSWORD')
    if not email or not password:
        return
    existing = User.query.filter_by(email=email).first()
    if not existing:
        admin = User(email=email, role='admin')
        admin.set_password(password)
        db.session.add(admin)
        db.session.commit()


def _migrate_media_columns():
    """Add new columns to existing media table if missing."""
    new_cols = [
        ('title', 'TEXT'),
        ('description', 'TEXT'),
        ('media_date', 'TEXT'),
        ('location', 'TEXT'),
    ]
    # Person table migration
    person_cols = [
        ('birth_year', 'INTEGER'),
    ]
    for col_name, col_type in person_cols:
        try:
            db.session.execute(db.text(f'ALTER TABLE person ADD COLUMN {col_name} {col_type}'))
            db.session.commit()
        except Exception:
            db.session.rollback()
    for col_name, col_type in new_cols:
        try:
            db.session.execute(db.text(f'ALTER TABLE media ADD COLUMN {col_name} {col_type}'))
            db.session.commit()
        except Exception:
            db.session.rollback()


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    db.init_app(app)

    with app.app_context():
        event.listen(db.engine, 'connect', set_sqlite_pragma)
        os.makedirs(os.path.join(app.instance_path), exist_ok=True)
        os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
        db.create_all()
        _migrate_media_columns()
        _ensure_admin(app)

    # Flask-Login
    login_manager = LoginManager()
    login_manager.login_view = 'login'
    login_manager.init_app(app)

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, int(user_id))

    # ── Helpers ───────────────────────────────────────────────────────────

    def slugify(text):
        text = text.lower().strip()
        text = re.sub(r'[^\w\s-]', '', text)
        text = re.sub(r'[\s_]+', '-', text)
        text = re.sub(r'-+', '-', text)
        return text.strip('-')

    def make_slug(first_name, last_name=''):
        name_part = slugify(f"{first_name} {last_name}".strip())
        if not name_part:
            name_part = 'person'
        return f"{name_part}-{uuid.uuid4().hex[:8]}"

    def allowed_file(filename):
        if '.' not in filename:
            return False
        ext = filename.rsplit('.', 1)[1].lower()
        return ext in (app.config['ALLOWED_IMAGE_EXTENSIONS'] |
                       app.config['ALLOWED_DOC_EXTENSIONS'])

    def get_file_type(filename):
        ext = filename.rsplit('.', 1)[1].lower()
        if ext in app.config['ALLOWED_IMAGE_EXTENSIONS']:
            return 'image'
        if ext == 'pdf':
            return 'pdf'
        return 'document'

    def save_upload(file_obj):
        filename = secure_filename(file_obj.filename)
        ext = filename.rsplit('.', 1)[1].lower()
        safe_name = f"media_{secrets.token_hex(8)}.{ext}"
        if app.config['STORAGE_BACKEND'] == 's3':
            import boto3
            s3 = boto3.client('s3',
                              region_name=app.config['AWS_S3_REGION'])
            s3_key = f"media/{safe_name}"
            s3.upload_fileobj(file_obj, app.config['AWS_S3_BUCKET'], s3_key,
                              ExtraArgs={'ContentType': file_obj.content_type or 'application/octet-stream'})
            return safe_name, None  # no local path in S3 mode
        else:
            save_path = os.path.join(app.config['UPLOAD_FOLDER'], safe_name)
            file_obj.save(save_path)
            return safe_name, save_path

    def get_media_url(media):
        if app.config['STORAGE_BACKEND'] == 's3' and app.config.get('CLOUDFRONT_DOMAIN'):
            return f"https://{app.config['CLOUDFRONT_DOMAIN']}/media/{media.file_path}"
        return f'/api/media/{media.id}/file'

    def can_edit_person(user, person):
        if user.is_admin:
            return True
        if person.owner_id == user.id:
            return True
        if person.owner_id is None and person.created_by == user.id:
            return True
        return False

    def can_view_details(user, person):
        if user.is_admin:
            return True
        if person.owner_id is None:
            return True
        if person.owner_id == user.id:
            return True
        return are_friends(user.id, person.owner_id)

    def can_view_media(user, media):
        if user.is_admin:
            return True
        for mp in media.person_tags:
            person = db.session.get(Person, mp.person_id)
            if person and can_view_details(user, person):
                return True
        return False

    def is_profile_photo(media):
        return MediaPerson.query.filter_by(
            media_id=media.id, is_profile_photo=1
        ).first() is not None

    def friends_required_for_person(f):
        @wraps(f)
        def decorated(person_id, *args, **kwargs):
            person = db.session.get(Person, person_id)
            if not person:
                abort(404)
            if not can_view_details(current_user, person):
                abort(403, description="Friend request required to view this information")
            return f(person_id, *args, **kwargs)
        return decorated

    def send_email(to_email, subject, html_content):
        api_key = app.config.get('SENDGRID_API_KEY')
        if not api_key:
            app.logger.warning(f"SendGrid not configured. Email to {to_email}: {subject}")
            return
        try:
            from sendgrid import SendGridAPIClient
            from sendgrid.helpers.mail import Mail
            message = Mail(
                from_email=app.config['SENDGRID_FROM_EMAIL'],
                to_emails=to_email,
                subject=subject,
                html_content=html_content,
            )
            sg = SendGridAPIClient(api_key)
            sg.send(message)
        except Exception as e:
            app.logger.error(f"Failed to send email: {e}")

    # ── Page Routes ───────────────────────────────────────────────────────

    @app.route('/login', methods=['GET', 'POST'])
    def login():
        if current_user.is_authenticated:
            return redirect(url_for('index'))
        if request.method == 'POST':
            email = request.form.get('email', '').strip().lower()
            password = request.form.get('password', '')
            user = User.query.filter_by(email=email).first()
            if user and user.check_password(password):
                user.last_login = datetime.now(timezone.utc).isoformat()
                db.session.commit()
                login_user(user, remember=True)
                next_page = request.args.get('next')
                return redirect(next_page or url_for('index'))
            flash('Invalid email or password.', 'error')
        return render_template('login.html')

    @app.route('/logout')
    @login_required
    def logout():
        logout_user()
        return redirect(url_for('login'))

    @app.route('/invite/<token>', methods=['GET', 'POST'])
    def accept_invite(token):
        invite = Invite.query.filter_by(token=token, status='pending').first()
        if not invite:
            flash('Invalid or expired invite link.', 'error')
            return redirect(url_for('login'))
        person = db.session.get(Person, invite.person_id)
        if request.method == 'POST':
            password = request.form.get('password', '')
            if len(password) < 6:
                flash('Password must be at least 6 characters.', 'error')
                return render_template('invite.html', invite=invite, person=person)
            user = User(
                email=invite.email.lower(),
                role='member',
                person_id=invite.person_id,
            )
            user.set_password(password)
            db.session.add(user)
            invite.status = 'accepted'
            invite.accepted_at = datetime.now(timezone.utc).isoformat()
            if person:
                person.owner_id = user.id
            db.session.commit()
            login_user(user, remember=True)
            return redirect(url_for('index'))
        return render_template('invite.html', invite=invite, person=person)

    @app.route('/')
    @login_required
    def index():
        return render_template('index.html')

    @app.route('/person/<slug>')
    @login_required
    def person_page(slug):
        return render_template('index.html')

    # ── Auth API ──────────────────────────────────────────────────────────

    @app.route('/api/me')
    @login_required
    def api_me():
        friend_ids = list(get_friend_ids(current_user.id))
        person = db.session.get(Person, current_user.person_id) if current_user.person_id else None
        return jsonify({
            'id': current_user.id,
            'email': current_user.email,
            'role': current_user.role,
            'person_id': current_user.person_id,
            'person_slug': person.slug if person else None,
            'person_name': f"{person.first_name} {person.last_name or ''}".strip() if person else None,
            'friend_ids': friend_ids,
        })

    # ── Invite API ────────────────────────────────────────────────────────

    @app.route('/api/invites', methods=['GET', 'POST'])
    @login_required
    def api_invites():
        if request.method == 'POST':
            data = request.get_json()
            email = data.get('email', '').strip().lower()
            person_id = data.get('person_id')
            if not email or not person_id:
                return jsonify({'error': 'email and person_id required'}), 400
            person = db.session.get(Person, person_id)
            if not person:
                return jsonify({'error': 'Person not found'}), 404
            if not can_edit_person(current_user, person):
                return jsonify({'error': 'Permission denied'}), 403
            if person.owner_id is not None:
                return jsonify({'error': 'Person already has an owner'}), 400
            existing_user = User.query.filter_by(email=email).first()
            if existing_user:
                return jsonify({'error': 'A user with this email already exists'}), 400
            existing_invite = Invite.query.filter_by(email=email, person_id=person_id, status='pending').first()
            if existing_invite:
                return jsonify({'error': 'An invite for this email is already pending'}), 400
            token = uuid.uuid4().hex
            invite = Invite(
                email=email,
                person_id=person_id,
                invited_by=current_user.id,
                token=token,
            )
            db.session.add(invite)
            db.session.commit()
            invite_url = f"{app.config['APP_URL']}/invite/{token}"
            send_email(
                email,
                f"You're invited to {app.config['APP_NAME']}",
                f"<p>You've been invited to join the {app.config['APP_NAME']} as <strong>{person.first_name} {person.last_name or ''}</strong>.</p>"
                f"<p><a href='{invite_url}'>Click here to set your password and get started.</a></p>",
            )
            return jsonify({'id': invite.id, 'token': token}), 201
        # GET — admin only
        if not current_user.is_admin:
            return jsonify({'error': 'Admin only'}), 403
        invites = Invite.query.order_by(Invite.created_at.desc()).all()
        return jsonify([{
            'id': i.id, 'email': i.email, 'person_id': i.person_id,
            'status': i.status, 'created_at': i.created_at,
        } for i in invites])

    # ── Friend Request API ────────────────────────────────────────────────

    @app.route('/api/friend-requests', methods=['GET', 'POST'])
    @login_required
    def api_friend_requests():
        if request.method == 'POST':
            data = request.get_json()
            to_user_id = data.get('to_user_id')
            message = data.get('message', '').strip()
            if not to_user_id or not message:
                return jsonify({'error': 'to_user_id and message required'}), 400
            to_user = db.session.get(User, to_user_id)
            if not to_user:
                return jsonify({'error': 'User not found'}), 404
            if to_user_id == current_user.id:
                return jsonify({'error': 'Cannot friend yourself'}), 400
            if are_friends(current_user.id, to_user_id):
                return jsonify({'error': 'Already friends'}), 400
            existing = FriendRequest.query.filter_by(
                from_user_id=current_user.id, to_user_id=to_user_id
            ).first()
            if existing and existing.status == 'pending':
                return jsonify({'error': 'Request already pending'}), 400
            if existing:
                existing.message = message
                existing.status = 'pending'
                existing.created_at = datetime.now(timezone.utc).isoformat()
                existing.responded_at = None
            else:
                fr = FriendRequest(
                    from_user_id=current_user.id,
                    to_user_id=to_user_id,
                    message=message,
                )
                db.session.add(fr)
            db.session.commit()
            from_person = db.session.get(Person, current_user.person_id) if current_user.person_id else None
            from_name = f"{from_person.first_name} {from_person.last_name or ''}".strip() if from_person else current_user.email
            send_email(
                to_user.email,
                f"Friend request on {app.config['APP_NAME']}",
                f"<p><strong>{from_name}</strong> sent you a friend request:</p>"
                f"<blockquote>{message}</blockquote>"
                f"<p><a href='{app.config['APP_URL']}'>Log in to accept or reject.</a></p>",
            )
            return jsonify({'status': 'sent'}), 201
        # GET — inbox
        requests = FriendRequest.query.filter_by(
            to_user_id=current_user.id, status='pending'
        ).order_by(FriendRequest.created_at.desc()).all()
        result = []
        for fr in requests:
            from_person = db.session.get(Person, fr.from_user.person_id) if fr.from_user.person_id else None
            result.append({
                'id': fr.id,
                'from_user_id': fr.from_user_id,
                'from_name': f"{from_person.first_name} {from_person.last_name or ''}".strip() if from_person else fr.from_user.email,
                'message': fr.message,
                'created_at': fr.created_at,
            })
        return jsonify(result)

    @app.route('/api/friend-requests/<int:req_id>/accept', methods=['POST'])
    @login_required
    def accept_friend_request(req_id):
        fr = db.session.get(FriendRequest, req_id)
        if not fr or fr.to_user_id != current_user.id or fr.status != 'pending':
            abort(404)
        fr.status = 'accepted'
        fr.responded_at = datetime.now(timezone.utc).isoformat()
        lo, hi = min(fr.from_user_id, fr.to_user_id), max(fr.from_user_id, fr.to_user_id)
        existing = Friendship.query.filter_by(user1_id=lo, user2_id=hi).first()
        if not existing:
            db.session.add(Friendship(user1_id=lo, user2_id=hi))
        db.session.commit()
        return jsonify({'status': 'accepted'})

    @app.route('/api/friend-requests/<int:req_id>/reject', methods=['POST'])
    @login_required
    def reject_friend_request(req_id):
        fr = db.session.get(FriendRequest, req_id)
        if not fr or fr.to_user_id != current_user.id or fr.status != 'pending':
            abort(404)
        fr.status = 'rejected'
        fr.responded_at = datetime.now(timezone.utc).isoformat()
        db.session.commit()
        return jsonify({'status': 'rejected'})

    @app.route('/api/friends')
    @login_required
    def api_friends():
        friend_ids = get_friend_ids(current_user.id)
        friends = []
        for fid in friend_ids:
            u = db.session.get(User, fid)
            if u:
                p = db.session.get(Person, u.person_id) if u.person_id else None
                friends.append({
                    'user_id': u.id,
                    'email': u.email,
                    'name': f"{p.first_name} {p.last_name or ''}".strip() if p else u.email,
                })
        return jsonify(friends)

    @app.route('/api/friends/<int:user_id>', methods=['DELETE'])
    @login_required
    def unfriend(user_id):
        lo, hi = min(current_user.id, user_id), max(current_user.id, user_id)
        f = Friendship.query.filter_by(user1_id=lo, user2_id=hi).first()
        if f:
            db.session.delete(f)
            db.session.commit()
        return jsonify({'status': 'unfriended'})

    @app.route('/api/notifications')
    @login_required
    def api_notifications():
        count = FriendRequest.query.filter_by(
            to_user_id=current_user.id, status='pending'
        ).count()
        return jsonify({'unread_count': count})

    # ── Media Cookie (CloudFront signed cookies) ────────────────────────

    @app.route('/api/auth/media-cookie')
    @login_required
    def api_media_cookie():
        if app.config['STORAGE_BACKEND'] != 's3':
            return jsonify({'status': 'local'})
        cf_domain = app.config.get('CLOUDFRONT_DOMAIN')
        key_pair_id = app.config.get('CLOUDFRONT_KEY_PAIR_ID')
        pk_path = app.config.get('CLOUDFRONT_PRIVATE_KEY_PATH')
        if not cf_domain or not key_pair_id or not pk_path:
            return jsonify({'status': 'not_configured'}), 200
        try:
            from datetime import timedelta
            from botocore.signers import CloudFrontSigner
            import rsa

            with open(pk_path, 'rb') as f:
                private_key = rsa.PrivateKey.load_pkcs1(f.read())

            def rsa_signer(message):
                return rsa.sign(message, private_key, 'SHA-1')

            cf_signer = CloudFrontSigner(key_pair_id, rsa_signer)
            duration = app.config.get('CLOUDFRONT_COOKIE_DURATION', 86400)
            expires = datetime.now(timezone.utc) + timedelta(seconds=duration)
            policy = cf_signer.build_policy(
                f'https://{cf_domain}/media/*', expires
            ).encode('utf-8')
            signature = rsa_signer(policy)

            import base64
            policy_b64 = base64.b64encode(policy).decode()
            sig_b64 = base64.b64encode(signature).decode()

            resp = jsonify({'status': 'ok'})
            cookie_opts = {
                'httponly': True,
                'secure': not app.debug,
                'samesite': 'Lax',
                'domain': cf_domain,
                'max_age': duration,
                'path': '/media/',
            }
            resp.set_cookie('CloudFront-Policy', policy_b64, **cookie_opts)
            resp.set_cookie('CloudFront-Signature', sig_b64, **cookie_opts)
            resp.set_cookie('CloudFront-Key-Pair-Id', key_pair_id, **cookie_opts)
            return resp
        except Exception as e:
            app.logger.error(f"CloudFront cookie error: {e}")
            return jsonify({'status': 'error', 'message': str(e)}), 500

    # ── Tree API ──────────────────────────────────────────────────────────

    @app.route('/api/tree')
    @login_required
    def api_tree():
        persons = Person.query.all()
        unions = FamilyUnion.query.all()
        parent_links = ParentChild.query.all()

        spouse_map = defaultdict(list)
        for u in unions:
            spouse_map[u.partner1_id].append(str(u.partner2_id))
            spouse_map[u.partner2_id].append(str(u.partner1_id))

        children_map = defaultdict(list)
        parents_map = defaultdict(list)
        for pc in parent_links:
            children_map[pc.parent_id].append(str(pc.child_id))
            parents_map[pc.child_id].append(str(pc.parent_id))

        # Build unions lookup keyed by sorted partner ids
        unions_lookup = {}
        for u in unions:
            key = f"{min(u.partner1_id, u.partner2_id)}-{max(u.partner1_id, u.partner2_id)}"
            if key not in unions_lookup:
                unions_lookup[key] = []
            unions_lookup[key].append(u.to_dict())

        tree_data = []
        for p in persons:
            pub = p.public_dict()
            rels = {}

            # Spouses — deduplicated
            spouses = list(set(spouse_map.get(p.id, [])))
            if spouses:
                rels['spouses'] = spouses

            # Children — deduplicated
            children = list(set(children_map.get(p.id, [])))
            if children:
                rels['children'] = children

            # Parents — family-chart expects father/mother keys
            # Only include if present (omit entirely if missing — avoids
            # the library creating "Unknown" placeholder cards)
            parent_ids = parents_map.get(p.id, [])
            for pid in parent_ids:
                parent_person = db.session.get(Person, int(pid))
                if parent_person:
                    if parent_person.gender == 'M':
                        rels['father'] = pid
                    else:
                        rels['mother'] = pid

            node = {
                'id': str(p.id),
                'data': {
                    'first name': pub['first_name'],
                    'last name': pub['last_name'],
                    'gender': pub['gender'],
                    'avatar': pub['profile_photo'],
                    'nickname': pub['nickname'],
                    'occupation': pub['occupation'],
                    'latest_school': pub['latest_school'],
                    'birth_year': pub['birth_year'],
                    'current_city': pub['current_city'],
                    'current_country': pub['current_country'],
                    'has_owner': pub['has_owner'],
                    'owner_id': pub['owner_id'],
                    'slug': pub['slug'],
                },
                'rels': rels,
            }
            tree_data.append(node)

        return jsonify({'persons': tree_data, 'unions': unions_lookup})

    # ── Person API ────────────────────────────────────────────────────────

    @app.route('/api/persons', methods=['GET'])
    @login_required
    def api_persons_list():
        q = request.args.get('q', '').strip()
        query = Person.query
        if q:
            like = f'%{q}%'
            school_subq = db.session.query(School.person_id).filter(
                School.name.ilike(like)
            ).subquery()
            query = query.filter(
                Person.first_name.ilike(like) |
                Person.last_name.ilike(like) |
                Person.nickname.ilike(like) |
                Person.occupation.ilike(like) |
                Person.current_city.ilike(like) |
                Person.current_country.ilike(like) |
                Person.id.in_(db.session.query(school_subq))
            )
        persons = query.order_by(Person.first_name).all()
        return jsonify([p.public_dict() for p in persons])

    @app.route('/api/persons', methods=['POST'])
    @login_required
    def api_persons_create():
        data = request.get_json()
        first_name = data.get('first_name', '').strip()
        if not first_name:
            return jsonify({'error': 'first_name is required'}), 400
        slug = make_slug(first_name, data.get('last_name', ''))
        person = Person(
            slug=slug,
            first_name=first_name,
            last_name=data.get('last_name', '').strip() or None,
            nickname=data.get('nickname', '').strip() or None,
            gender=data.get('gender', '').strip() or None,
            date_of_birth=data.get('date_of_birth', '').strip() or None,
            date_of_death=data.get('date_of_death', '').strip() or None,
            birth_city=data.get('birth_city', '').strip() or None,
            birth_country=data.get('birth_country', '').strip() or None,
            current_city=data.get('current_city', '').strip() or None,
            current_country=data.get('current_country', '').strip() or None,
            biography=data.get('biography', '').strip() or None,
            occupation=data.get('occupation', '').strip() or None,
            phone_number=data.get('phone_number', '').strip() or None,
            external_urls=data.get('external_urls', '').strip() or None,
            notes=data.get('notes', '').strip() or None,
            created_by=current_user.id,
        )
        # Auto-derive birth_year from date_of_birth, or accept explicit birth_year
        if person.date_of_birth and len(person.date_of_birth) >= 4:
            try: person.birth_year = int(person.date_of_birth[:4])
            except ValueError: pass
        elif data.get('birth_year'):
            try: person.birth_year = int(data['birth_year'])
            except (ValueError, TypeError): pass
        db.session.add(person)
        db.session.commit()
        return jsonify(person.full_dict()), 201

    @app.route('/api/persons/<int:person_id>', methods=['GET'])
    @login_required
    def api_person_detail(person_id):
        person = db.session.get(Person, person_id)
        if not person:
            abort(404)
        if can_view_details(current_user, person):
            d = person.full_dict()
            d['can_edit'] = can_edit_person(current_user, person)
            # Include unions
            unions = FamilyUnion.query.filter(
                (FamilyUnion.partner1_id == person_id) |
                (FamilyUnion.partner2_id == person_id)
            ).all()
            d['unions'] = [u.to_dict() for u in unions]
            # Include parent-child links
            as_parent = ParentChild.query.filter_by(parent_id=person_id).all()
            as_child = ParentChild.query.filter_by(child_id=person_id).all()
            d['children_links'] = [pc.to_dict() for pc in as_parent]
            d['parent_links'] = [pc.to_dict() for pc in as_child]
            return jsonify(d)
        else:
            d = person.public_dict()
            d['access'] = 'limited'
            d['can_edit'] = False
            return jsonify(d)

    @app.route('/api/persons/by-slug/<slug>', methods=['GET'])
    @login_required
    def api_person_by_slug(slug):
        person = Person.query.filter_by(slug=slug).first()
        if not person:
            abort(404)
        return api_person_detail(person.id)

    @app.route('/api/persons/<int:person_id>', methods=['PUT'])
    @login_required
    def api_person_update(person_id):
        person = db.session.get(Person, person_id)
        if not person:
            abort(404)
        if not can_edit_person(current_user, person):
            abort(403)
        data = request.get_json()
        for field in ['first_name', 'last_name', 'nickname', 'gender',
                      'date_of_birth', 'date_of_death', 'birth_city',
                      'birth_country', 'current_city', 'current_country',
                      'biography', 'occupation', 'phone_number',
                      'external_urls', 'notes']:
            if field in data:
                val = data[field].strip() if isinstance(data[field], str) else data[field]
                setattr(person, field, val or None)
        # Auto-derive birth_year from date_of_birth if it was updated
        if 'date_of_birth' in data and person.date_of_birth and len(person.date_of_birth) >= 4:
            try: person.birth_year = int(person.date_of_birth[:4])
            except ValueError: pass
        elif 'birth_year' in data:
            person.birth_year = int(data['birth_year']) if data['birth_year'] else None
        person.updated_at = datetime.now(timezone.utc).isoformat()
        db.session.commit()
        return jsonify(person.full_dict())

    @app.route('/api/persons/<int:person_id>', methods=['DELETE'])
    @login_required
    def api_person_delete(person_id):
        person = db.session.get(Person, person_id)
        if not person:
            abort(404)
        if not can_edit_person(current_user, person):
            abort(403)
        # Manually delete related rows that have FKs pointing to this person,
        # since multiple FKs to the same table makes ORM cascade unreliable.
        ParentChild.query.filter(
            (ParentChild.parent_id == person_id) | (ParentChild.child_id == person_id)
        ).delete(synchronize_session=False)
        FamilyUnion.query.filter(
            (FamilyUnion.partner1_id == person_id) | (FamilyUnion.partner2_id == person_id)
        ).delete(synchronize_session=False)
        MediaPerson.query.filter_by(person_id=person_id).delete(synchronize_session=False)
        FaceDetection.query.filter(
            (FaceDetection.person_id == person_id) | (FaceDetection.suggested_person_id == person_id)
        ).delete(synchronize_session=False)
        School.query.filter_by(person_id=person_id).delete(synchronize_session=False)
        # Clear user.person_id references
        User.query.filter_by(person_id=person_id).update({'person_id': None}, synchronize_session=False)
        Invite.query.filter_by(person_id=person_id).delete(synchronize_session=False)
        db.session.delete(person)
        db.session.commit()
        return jsonify({'status': 'deleted'})

    # ── Person media (protected) ──────────────────────────────────────────

    @app.route('/api/persons/<int:person_id>/media')
    @login_required
    @friends_required_for_person
    def api_person_media(person_id):
        q = request.args.get('q', '').strip()
        offset = request.args.get('offset', 0, type=int)
        limit = request.args.get('limit', 50, type=int)
        limit = min(limit, 100)

        query = db.session.query(Media, MediaPerson).join(
            MediaPerson, Media.id == MediaPerson.media_id
        ).filter(MediaPerson.person_id == person_id)

        if q:
            like = f'%{q}%'
            query = query.filter(
                Media.title.ilike(like) |
                Media.description.ilike(like) |
                Media.caption.ilike(like) |
                Media.original_filename.ilike(like)
            )

        total = query.count()
        results = query.order_by(Media.uploaded_at.desc()).offset(offset).limit(limit).all()

        media_list = []
        for m, mp in results:
            d = m.to_dict(file_url_fn=get_media_url)
            d['is_profile_photo'] = bool(mp.is_profile_photo)
            media_list.append(d)

        return jsonify({'items': media_list, 'total': total, 'offset': offset, 'limit': limit})

    # ── School API ────────────────────────────────────────────────────────

    @app.route('/api/persons/<int:person_id>/schools', methods=['GET'])
    @login_required
    @friends_required_for_person
    def api_person_schools(person_id):
        schools = School.query.filter_by(person_id=person_id).order_by(
            School.end_year.desc().nullsfirst()
        ).all()
        return jsonify([s.to_dict() for s in schools])

    @app.route('/api/persons/<int:person_id>/schools', methods=['POST'])
    @login_required
    def api_person_schools_create(person_id):
        person = db.session.get(Person, person_id)
        if not person:
            abort(404)
        if not can_edit_person(current_user, person):
            abort(403)
        data = request.get_json()
        school = School(
            person_id=person_id,
            name=data.get('name', '').strip(),
            degree=data.get('degree', '').strip() or None,
            field_of_study=data.get('field_of_study', '').strip() or None,
            start_year=data.get('start_year'),
            end_year=data.get('end_year'),
            notes=data.get('notes', '').strip() or None,
        )
        if not school.name:
            return jsonify({'error': 'School name is required'}), 400
        db.session.add(school)
        db.session.commit()
        return jsonify(school.to_dict()), 201

    @app.route('/api/schools/<int:school_id>', methods=['PUT'])
    @login_required
    def api_school_update(school_id):
        school = db.session.get(School, school_id)
        if not school:
            abort(404)
        person = db.session.get(Person, school.person_id)
        if not can_edit_person(current_user, person):
            abort(403)
        data = request.get_json()
        for field in ['name', 'degree', 'field_of_study', 'notes']:
            if field in data:
                setattr(school, field, data[field].strip() if data[field] else None)
        for field in ['start_year', 'end_year']:
            if field in data:
                setattr(school, field, data[field])
        db.session.commit()
        return jsonify(school.to_dict())

    @app.route('/api/schools/<int:school_id>', methods=['DELETE'])
    @login_required
    def api_school_delete(school_id):
        school = db.session.get(School, school_id)
        if not school:
            abort(404)
        person = db.session.get(Person, school.person_id)
        if not can_edit_person(current_user, person):
            abort(403)
        db.session.delete(school)
        db.session.commit()
        return jsonify({'status': 'deleted'})

    # ── Union API ─────────────────────────────────────────────────────────

    @app.route('/api/unions', methods=['POST'])
    @login_required
    def api_union_create():
        data = request.get_json()
        p1_id = data.get('partner1_id')
        p2_id = data.get('partner2_id')
        if not p1_id or not p2_id:
            return jsonify({'error': 'partner1_id and partner2_id required'}), 400
        if p1_id == p2_id:
            return jsonify({'error': 'Cannot create union with self'}), 400
        p1 = db.session.get(Person, p1_id)
        p2 = db.session.get(Person, p2_id)
        if not p1 or not p2:
            return jsonify({'error': 'Person not found'}), 404
        if not (can_edit_person(current_user, p1) or can_edit_person(current_user, p2)):
            abort(403)
        # Prevent duplicate unions (check both directions)
        existing = FamilyUnion.query.filter(
            ((FamilyUnion.partner1_id == p1_id) & (FamilyUnion.partner2_id == p2_id)) |
            ((FamilyUnion.partner1_id == p2_id) & (FamilyUnion.partner2_id == p1_id))
        ).first()
        if existing:
            return jsonify(existing.to_dict()), 200  # Return existing, not error
        union = FamilyUnion(
            partner1_id=p1_id,
            partner2_id=p2_id,
            union_type=data.get('union_type', 'marriage'),
            marriage_date=data.get('marriage_date') or None,
            divorce_date=data.get('divorce_date') or None,
            marriage_city=data.get('marriage_city') or None,
            marriage_country=data.get('marriage_country') or None,
            is_current=data.get('is_current', 1),
            notes=data.get('notes') or None,
        )
        db.session.add(union)
        db.session.commit()
        return jsonify(union.to_dict()), 201

    @app.route('/api/unions/<int:union_id>', methods=['GET'])
    @login_required
    def api_union_detail(union_id):
        union = db.session.get(FamilyUnion, union_id)
        if not union:
            abort(404)
        p1 = db.session.get(Person, union.partner1_id)
        p2 = db.session.get(Person, union.partner2_id)
        can_view = (can_view_details(current_user, p1) and
                    can_view_details(current_user, p2))
        if can_view:
            d = union.to_dict()
            d['partner1'] = p1.public_dict()
            d['partner2'] = p2.public_dict()
            evidence = Evidence.query.filter_by(union_id=union_id).all()
            d['evidence'] = [e.to_dict(file_url_fn=get_media_url) for e in evidence]
            return jsonify(d)
        else:
            d = union.public_dict()
            d['partner1'] = p1.public_dict()
            d['partner2'] = p2.public_dict()
            d['access'] = 'limited'
            return jsonify(d)

    @app.route('/api/unions/<int:union_id>', methods=['PUT'])
    @login_required
    def api_union_update(union_id):
        union = db.session.get(FamilyUnion, union_id)
        if not union:
            abort(404)
        p1 = db.session.get(Person, union.partner1_id)
        p2 = db.session.get(Person, union.partner2_id)
        if not (can_edit_person(current_user, p1) or can_edit_person(current_user, p2)):
            abort(403)
        data = request.get_json()
        for field in ['union_type', 'marriage_date', 'divorce_date',
                      'marriage_city', 'marriage_country', 'notes']:
            if field in data:
                setattr(union, field, data[field] or None)
        if 'is_current' in data:
            union.is_current = data['is_current']
        db.session.commit()
        return jsonify(union.to_dict())

    @app.route('/api/unions/<int:union_id>', methods=['DELETE'])
    @login_required
    def api_union_delete(union_id):
        union = db.session.get(FamilyUnion, union_id)
        if not union:
            abort(404)
        p1 = db.session.get(Person, union.partner1_id)
        p2 = db.session.get(Person, union.partner2_id)
        if not (can_edit_person(current_user, p1) or can_edit_person(current_user, p2)):
            abort(403)
        db.session.delete(union)
        db.session.commit()
        return jsonify({'status': 'deleted'})

    # ── Parent-Child API ──────────────────────────────────────────────────

    @app.route('/api/parent-child', methods=['POST'])
    @login_required
    def api_parent_child_create():
        data = request.get_json()
        parent_id = data.get('parent_id')
        child_id = data.get('child_id')
        if not parent_id or not child_id:
            return jsonify({'error': 'parent_id and child_id required'}), 400
        parent = db.session.get(Person, parent_id)
        child = db.session.get(Person, child_id)
        if not parent or not child:
            return jsonify({'error': 'Person not found'}), 404
        if not (can_edit_person(current_user, parent) or can_edit_person(current_user, child)):
            abort(403)
        existing = ParentChild.query.filter_by(parent_id=parent_id, child_id=child_id).first()
        if existing:
            return jsonify({'error': 'Relationship already exists'}), 400
        pc = ParentChild(
            parent_id=parent_id,
            child_id=child_id,
            relation_type=data.get('relation_type', 'biological'),
            notes=data.get('notes') or None,
        )
        db.session.add(pc)
        db.session.commit()
        return jsonify(pc.to_dict()), 201

    @app.route('/api/parent-child/<int:pc_id>', methods=['DELETE'])
    @login_required
    def api_parent_child_delete(pc_id):
        pc = db.session.get(ParentChild, pc_id)
        if not pc:
            abort(404)
        parent = db.session.get(Person, pc.parent_id)
        child = db.session.get(Person, pc.child_id)
        if not (can_edit_person(current_user, parent) or can_edit_person(current_user, child)):
            abort(403)
        db.session.delete(pc)
        db.session.commit()
        return jsonify({'status': 'deleted'})

    # ── Media API ─────────────────────────────────────────────────────────

    @app.route('/api/media', methods=['POST'])
    @login_required
    def api_media_upload():
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400
        file = request.files['file']
        if not file.filename or not allowed_file(file.filename):
            return jsonify({'error': 'File type not allowed'}), 400
        safe_name, save_path = save_upload(file)
        file_type = get_file_type(file.filename)
        media = Media(
            file_path=safe_name,
            file_type=file_type,
            original_filename=file.filename,
            caption=request.form.get('caption', '').strip() or None,
            title=request.form.get('title', '').strip() or None,
            description=request.form.get('description', '').strip() or None,
            media_date=request.form.get('media_date', '').strip() or None,
            location=request.form.get('location', '').strip() or None,
        )
        db.session.add(media)
        db.session.flush()
        # Tag persons
        person_ids = request.form.getlist('person_ids[]')
        for pid in person_ids:
            try:
                pid = int(pid)
            except (ValueError, TypeError):
                continue
            person = db.session.get(Person, pid)
            if person:
                db.session.add(MediaPerson(media_id=media.id, person_id=pid))
        db.session.commit()
        # Trigger face detection for images
        if file_type == 'image':
            _detect_faces_for_media(media.id, save_path)
        return jsonify(media.to_dict(file_url_fn=get_media_url)), 201

    @app.route('/api/media/<int:media_id>', methods=['GET'])
    @login_required
    def api_media_detail(media_id):
        media = db.session.get(Media, media_id)
        if not media:
            abort(404)
        if not can_view_media(current_user, media):
            abort(403)
        return jsonify(media.to_dict(file_url_fn=get_media_url))

    @app.route('/api/media/<int:media_id>/file')
    @login_required
    def serve_media_file(media_id):
        media = db.session.get(Media, media_id)
        if not media:
            abort(404)
        if not is_profile_photo(media) and not can_view_media(current_user, media):
            abort(403)
        if app.config['STORAGE_BACKEND'] == 's3' and app.config.get('CLOUDFRONT_DOMAIN'):
            return redirect(f"https://{app.config['CLOUDFRONT_DOMAIN']}/media/{media.file_path}")
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], media.file_path)
        if not os.path.exists(file_path):
            abort(404)
        return send_file(file_path)

    @app.route('/api/media/<int:media_id>/profile-photo')
    @login_required
    def serve_profile_photo(media_id):
        media = db.session.get(Media, media_id)
        if not media:
            abort(404)
        if app.config['STORAGE_BACKEND'] == 's3' and app.config.get('CLOUDFRONT_DOMAIN'):
            return redirect(f"https://{app.config['CLOUDFRONT_DOMAIN']}/media/{media.file_path}")
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], media.file_path)
        if not os.path.exists(file_path):
            abort(404)
        return send_file(file_path)

    @app.route('/api/media/<int:media_id>', methods=['DELETE'])
    @login_required
    def api_media_delete(media_id):
        media = db.session.get(Media, media_id)
        if not media:
            abort(404)
        if not current_user.is_admin:
            if not can_view_media(current_user, media):
                abort(403)
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], media.file_path)
        # Manually delete related rows to avoid ORM cascade issues
        FaceDetection.query.filter_by(media_id=media_id).delete(synchronize_session=False)
        Evidence.query.filter_by(media_id=media_id).delete(synchronize_session=False)
        MediaPerson.query.filter_by(media_id=media_id).delete(synchronize_session=False)
        db.session.delete(media)
        db.session.commit()
        if os.path.exists(file_path):
            os.remove(file_path)
        return jsonify({'status': 'deleted'})

    @app.route('/api/media/<int:media_id>/tag', methods=['POST'])
    @login_required
    def api_media_tag(media_id):
        media = db.session.get(Media, media_id)
        if not media:
            abort(404)
        data = request.get_json()
        person_ids = data.get('person_ids', [])
        for pid in person_ids:
            try:
                pid = int(pid)
            except (ValueError, TypeError):
                continue
            existing = MediaPerson.query.filter_by(media_id=media_id, person_id=pid).first()
            if not existing:
                db.session.add(MediaPerson(media_id=media_id, person_id=pid))
        db.session.commit()
        return jsonify(media.to_dict(file_url_fn=get_media_url))

    @app.route('/api/media/<int:media_id>/tag/<int:person_id>', methods=['DELETE'])
    @login_required
    def api_media_untag(media_id, person_id):
        mp = MediaPerson.query.filter_by(media_id=media_id, person_id=person_id).first()
        if mp:
            db.session.delete(mp)
            db.session.commit()
        return jsonify({'status': 'untagged'})

    @app.route('/api/media/<int:media_id>/set-profile/<int:person_id>', methods=['PUT'])
    @login_required
    def api_set_profile_photo(media_id, person_id):
        person = db.session.get(Person, person_id)
        if not person:
            abort(404)
        if not can_edit_person(current_user, person):
            abort(403)
        # Clear old profile photo
        old = MediaPerson.query.filter_by(person_id=person_id, is_profile_photo=1).all()
        for o in old:
            o.is_profile_photo = 0
        # Set new
        mp = MediaPerson.query.filter_by(media_id=media_id, person_id=person_id).first()
        if not mp:
            mp = MediaPerson(media_id=media_id, person_id=person_id, is_profile_photo=1)
            db.session.add(mp)
        else:
            mp.is_profile_photo = 1
        db.session.commit()
        return jsonify({'status': 'set'})

    @app.route('/api/persons/<int:person_id>/unset-profile', methods=['PUT'])
    @login_required
    def api_unset_profile_photo(person_id):
        person = db.session.get(Person, person_id)
        if not person:
            abort(404)
        if not can_edit_person(current_user, person):
            abort(403)
        old = MediaPerson.query.filter_by(person_id=person_id, is_profile_photo=1).all()
        for o in old:
            o.is_profile_photo = 0
        db.session.commit()
        return jsonify({'status': 'unset'})

    # ── Evidence API ──────────────────────────────────────────────────────

    @app.route('/api/evidence', methods=['POST'])
    @login_required
    def api_evidence_create():
        data = request.get_json()
        media_id = data.get('media_id')
        union_id = data.get('union_id')
        parent_child_id = data.get('parent_child_id')
        if not media_id:
            return jsonify({'error': 'media_id required'}), 400
        if not union_id and not parent_child_id:
            return jsonify({'error': 'union_id or parent_child_id required'}), 400
        media = db.session.get(Media, media_id)
        if not media:
            return jsonify({'error': 'Media not found'}), 404
        evidence = Evidence(
            media_id=media_id,
            union_id=union_id,
            parent_child_id=parent_child_id,
            notes=data.get('notes', '').strip() or None,
        )
        db.session.add(evidence)
        db.session.commit()
        return jsonify(evidence.to_dict(file_url_fn=get_media_url)), 201

    @app.route('/api/media/shared/<int:person1_id>/<int:person2_id>')
    @login_required
    def api_shared_media(person1_id, person2_id):
        p1 = db.session.get(Person, person1_id)
        p2 = db.session.get(Person, person2_id)
        if not p1 or not p2:
            abort(404)
        if not (can_view_details(current_user, p1) or can_view_details(current_user, p2)):
            abort(403)
        subq1 = db.session.query(MediaPerson.media_id).filter_by(person_id=person1_id)
        subq2 = db.session.query(MediaPerson.media_id).filter_by(person_id=person2_id)
        shared = Media.query.filter(Media.id.in_(subq1), Media.id.in_(subq2)).order_by(Media.uploaded_at.desc()).all()
        return jsonify([m.to_dict(file_url_fn=get_media_url) for m in shared])

    @app.route('/api/media/shared-multi')
    @login_required
    def api_shared_media_multi():
        """Find media where ALL specified people are tagged."""
        ids_str = request.args.get('ids', '')
        if not ids_str:
            return jsonify([])
        try:
            person_ids = [int(x) for x in ids_str.split(',') if x.strip()]
        except ValueError:
            return jsonify({'error': 'Invalid ids'}), 400
        if not person_ids:
            return jsonify([])
        # Permission: viewer must be able to see at least one person
        can_view = False
        for pid in person_ids:
            p = db.session.get(Person, pid)
            if p and can_view_details(current_user, p):
                can_view = True
                break
        if not can_view:
            abort(403)
        # Find media tagged to ALL specified people
        from sqlalchemy import func
        query = db.session.query(Media.id).join(MediaPerson).filter(
            MediaPerson.person_id.in_(person_ids)
        ).group_by(Media.id).having(
            func.count(db.distinct(MediaPerson.person_id)) >= len(person_ids)
        )
        media_ids = [row[0] for row in query.all()]
        if not media_ids:
            return jsonify([])
        shared = Media.query.filter(Media.id.in_(media_ids)).order_by(Media.uploaded_at.desc()).all()
        return jsonify([m.to_dict(file_url_fn=get_media_url) for m in shared])

    @app.route('/api/media/shared-family')
    @login_required
    def api_shared_media_family():
        """Find media where at least one parent AND at least one child are tagged.
        Logic: (parent1 OR parent2) AND (child1 OR child2 OR child3)
        """
        parents_str = request.args.get('parents', '')
        children_str = request.args.get('children', '')
        if not parents_str or not children_str:
            return jsonify([])
        try:
            parent_ids = [int(x) for x in parents_str.split(',') if x.strip()]
            child_ids = [int(x) for x in children_str.split(',') if x.strip()]
        except ValueError:
            return jsonify({'error': 'Invalid ids'}), 400
        if not parent_ids or not child_ids:
            return jsonify([])
        # Permission check
        all_ids = parent_ids + child_ids
        can_view = any(
            can_view_details(current_user, db.session.get(Person, pid))
            for pid in all_ids if db.session.get(Person, pid)
        )
        if not can_view:
            abort(403)
        # Find media tagged to at least one parent
        parent_media = db.session.query(MediaPerson.media_id).filter(
            MediaPerson.person_id.in_(parent_ids)
        ).subquery()
        # Find media tagged to at least one child
        child_media = db.session.query(MediaPerson.media_id).filter(
            MediaPerson.person_id.in_(child_ids)
        ).subquery()
        # Intersection: media in both sets
        shared = Media.query.filter(
            Media.id.in_(db.session.query(parent_media.c.media_id)),
            Media.id.in_(db.session.query(child_media.c.media_id))
        ).order_by(Media.uploaded_at.desc()).all()
        return jsonify([m.to_dict(file_url_fn=get_media_url) for m in shared])

    @app.route('/api/evidence/union/<int:union_id>')
    @login_required
    def api_evidence_for_union(union_id):
        union = db.session.get(FamilyUnion, union_id)
        if not union:
            abort(404)
        p1 = db.session.get(Person, union.partner1_id)
        p2 = db.session.get(Person, union.partner2_id)
        if not (can_view_details(current_user, p1) and can_view_details(current_user, p2)):
            abort(403)
        evidence = Evidence.query.filter_by(union_id=union_id).all()
        return jsonify([e.to_dict(file_url_fn=get_media_url) for e in evidence])

    @app.route('/api/evidence/parent-child/<int:pc_id>')
    @login_required
    def api_evidence_for_parent_child(pc_id):
        pc = db.session.get(ParentChild, pc_id)
        if not pc:
            abort(404)
        parent = db.session.get(Person, pc.parent_id)
        child = db.session.get(Person, pc.child_id)
        if not (can_view_details(current_user, parent) and can_view_details(current_user, child)):
            abort(403)
        evidence = Evidence.query.filter_by(parent_child_id=pc_id).all()
        return jsonify([e.to_dict(file_url_fn=get_media_url) for e in evidence])

    @app.route('/api/evidence/<int:evidence_id>', methods=['DELETE'])
    @login_required
    def api_evidence_delete(evidence_id):
        evidence = db.session.get(Evidence, evidence_id)
        if not evidence:
            abort(404)
        db.session.delete(evidence)
        db.session.commit()
        return jsonify({'status': 'deleted'})

    # ── Face Detection API ────────────────────────────────────────────────

    def _detect_faces_for_media(media_id, file_path):
        """Run face detection on upload. Non-blocking best-effort."""
        try:
            from face import detect_faces, suggest_matches
            faces = detect_faces(file_path)
            for f in faces:
                suggestion = suggest_matches(f['encoding'])
                fd = FaceDetection(
                    media_id=media_id,
                    box_x=f['box'][0],
                    box_y=f['box'][1],
                    box_w=f['box'][2],
                    box_h=f['box'][3],
                    encoding=f['encoding_bytes'],
                    suggested_person_id=suggestion['person_id'] if suggestion else None,
                    confidence=suggestion['distance'] if suggestion else None,
                )
                db.session.add(fd)
            db.session.commit()
        except ImportError:
            app.logger.warning("face_recognition not installed, skipping face detection")
        except Exception as e:
            app.logger.error(f"Face detection failed: {e}")

    @app.route('/api/media/<int:media_id>/faces')
    @login_required
    def api_media_faces(media_id):
        media = db.session.get(Media, media_id)
        if not media:
            abort(404)
        if not can_view_media(current_user, media):
            abort(403)
        faces = FaceDetection.query.filter_by(media_id=media_id).all()
        return jsonify([f.to_dict() for f in faces])

    @app.route('/api/media/<int:media_id>/faces/<int:face_id>/confirm', methods=['POST'])
    @login_required
    def api_face_confirm(media_id, face_id):
        fd = FaceDetection.query.filter_by(id=face_id, media_id=media_id).first()
        if not fd:
            abort(404)
        data = request.get_json()
        person_id = data.get('person_id')
        if not person_id:
            return jsonify({'error': 'person_id required'}), 400
        fd.person_id = person_id
        # Auto-tag person in media
        existing = MediaPerson.query.filter_by(media_id=media_id, person_id=person_id).first()
        if not existing:
            db.session.add(MediaPerson(media_id=media_id, person_id=person_id))
        db.session.commit()
        return jsonify(fd.to_dict())

    @app.route('/api/media/<int:media_id>/faces/<int:face_id>/reject', methods=['POST'])
    @login_required
    def api_face_reject(media_id, face_id):
        fd = FaceDetection.query.filter_by(id=face_id, media_id=media_id).first()
        if not fd:
            abort(404)
        fd.suggested_person_id = None
        fd.confidence = None
        db.session.commit()
        return jsonify(fd.to_dict())

    @app.route('/api/media/<int:media_id>/faces/manual', methods=['POST'])
    @login_required
    def api_face_manual(media_id):
        media = db.session.get(Media, media_id)
        if not media:
            abort(404)
        data = request.get_json()
        person_id = data.get('person_id')
        x = data.get('x', 0)
        y = data.get('y', 0)
        if not person_id:
            return jsonify({'error': 'person_id required'}), 400
        fd = FaceDetection(
            media_id=media_id,
            person_id=person_id,
            box_x=x,
            box_y=y,
            box_w=0.05,
            box_h=0.05,
            is_manual=1,
        )
        db.session.add(fd)
        # Auto-tag
        existing = MediaPerson.query.filter_by(media_id=media_id, person_id=person_id).first()
        if not existing:
            db.session.add(MediaPerson(media_id=media_id, person_id=person_id))
        db.session.commit()
        return jsonify(fd.to_dict()), 201

    @app.route('/api/media/<int:media_id>/faces/<int:face_id>', methods=['DELETE'])
    @login_required
    def api_face_delete(media_id, face_id):
        fd = FaceDetection.query.filter_by(id=face_id, media_id=media_id).first()
        if not fd:
            abort(404)
        db.session.delete(fd)
        db.session.commit()
        return jsonify({'status': 'deleted'})

    return app


app = create_app()

if __name__ == '__main__':
    app.run(debug=True)
