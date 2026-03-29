from datetime import datetime, timezone
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import event

db = SQLAlchemy()


def _now():
    return datetime.now(timezone.utc).isoformat()


def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


# ── Auth ──────────────────────────────────────────────────────────────────────

class User(UserMixin, db.Model):
    __tablename__ = 'user'

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.Text, nullable=False, unique=True)
    password_hash = db.Column(db.Text)
    role = db.Column(db.Text, nullable=False, default='member')  # admin | member
    person_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=True)
    is_active_flag = db.Column('is_active', db.Integer, default=1)
    created_at = db.Column(db.Text, default=_now)
    last_login = db.Column(db.Text)

    person = db.relationship('Person', foreign_keys=[person_id], backref='user_account')

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        if not self.password_hash:
            return False
        return check_password_hash(self.password_hash, password)

    @property
    def is_admin(self):
        return self.role == 'admin'

    @property
    def is_active(self):
        return bool(self.is_active_flag)


class Invite(db.Model):
    __tablename__ = 'invite'

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.Text, nullable=False)
    person_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=False)
    invited_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    token = db.Column(db.Text, nullable=False, unique=True)
    status = db.Column(db.Text, default='pending')  # pending | accepted | expired
    created_at = db.Column(db.Text, default=_now)
    accepted_at = db.Column(db.Text)

    person = db.relationship('Person', foreign_keys=[person_id])
    inviter = db.relationship('User', foreign_keys=[invited_by])


class FriendRequest(db.Model):
    __tablename__ = 'friend_request'

    id = db.Column(db.Integer, primary_key=True)
    from_user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    to_user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    message = db.Column(db.Text, nullable=False)
    status = db.Column(db.Text, default='pending')  # pending | accepted | rejected
    created_at = db.Column(db.Text, default=_now)
    responded_at = db.Column(db.Text)

    from_user = db.relationship('User', foreign_keys=[from_user_id], backref='sent_requests')
    to_user = db.relationship('User', foreign_keys=[to_user_id], backref='received_requests')

    __table_args__ = (
        db.UniqueConstraint('from_user_id', 'to_user_id'),
    )


class Friendship(db.Model):
    __tablename__ = 'friendship'

    id = db.Column(db.Integer, primary_key=True)
    user1_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    user2_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.Text, default=_now)

    __table_args__ = (
        db.UniqueConstraint('user1_id', 'user2_id'),
        db.CheckConstraint('user1_id < user2_id'),
    )


def are_friends(user_id_a, user_id_b):
    if user_id_a == user_id_b:
        return True
    lo, hi = min(user_id_a, user_id_b), max(user_id_a, user_id_b)
    return Friendship.query.filter_by(user1_id=lo, user2_id=hi).first() is not None


def get_friend_ids(user_id):
    rows = Friendship.query.filter(
        (Friendship.user1_id == user_id) | (Friendship.user2_id == user_id)
    ).all()
    ids = set()
    for r in rows:
        ids.add(r.user1_id if r.user1_id != user_id else r.user2_id)
        ids.add(r.user2_id if r.user2_id != user_id else r.user1_id)
    ids.discard(user_id)
    return ids


# ── Family tree ───────────────────────────────────────────────────────────────

class Person(db.Model):
    __tablename__ = 'person'

    id = db.Column(db.Integer, primary_key=True)
    slug = db.Column(db.Text, nullable=False, unique=True)
    first_name = db.Column(db.Text, nullable=False)
    last_name = db.Column(db.Text)
    nickname = db.Column(db.Text)
    gender = db.Column(db.Text)  # M, F, O
    date_of_birth = db.Column(db.Text)
    date_of_death = db.Column(db.Text)
    birth_city = db.Column(db.Text)
    birth_country = db.Column(db.Text)
    current_city = db.Column(db.Text)
    current_country = db.Column(db.Text)
    biography = db.Column(db.Text)
    birth_year = db.Column(db.Integer)  # public field shown on cards
    occupation = db.Column(db.Text)
    phone_number = db.Column(db.Text)
    external_urls = db.Column(db.Text)  # JSON string
    notes = db.Column(db.Text)
    owner_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    created_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.Text, default=_now)
    updated_at = db.Column(db.Text, default=_now, onupdate=_now)

    owner = db.relationship('User', foreign_keys=[owner_id], backref='owned_persons')
    creator = db.relationship('User', foreign_keys=[created_by])
    schools = db.relationship('School', backref='person', lazy=True,
                              cascade='all, delete-orphan', order_by='School.end_year.desc()')
    media_tags = db.relationship('MediaPerson', backref='person', lazy=True,
                                 cascade='all, delete-orphan')

    def public_dict(self):
        profile_photo = self.get_profile_photo_url()
        latest = self.get_latest_school()
        return {
            'id': self.id,
            'slug': self.slug,
            'first_name': self.first_name,
            'last_name': self.last_name or '',
            'nickname': self.nickname or '',
            'gender': self.gender or '',
            'birth_year': self.birth_year,
            'occupation': self.occupation or '',
            'current_city': self.current_city or '',
            'current_country': self.current_country or '',
            'latest_school': latest,
            'profile_photo': profile_photo,
            'has_owner': self.owner_id is not None,
            'owner_id': self.owner_id,
        }

    def full_dict(self):
        d = self.public_dict()
        d.update({
            'access': 'full',
            'date_of_birth': self.date_of_birth or '',
            'date_of_death': self.date_of_death or '',
            'birth_city': self.birth_city or '',
            'birth_country': self.birth_country or '',
            'biography': self.biography or '',
            'phone_number': self.phone_number or '',
            'external_urls': self.external_urls or '',
            'notes': self.notes or '',
            'created_by': self.created_by,
            'owner_id': self.owner_id,
        })
        return d

    def get_profile_photo_url(self):
        mp = MediaPerson.query.filter_by(person_id=self.id, is_profile_photo=1).first()
        if mp:
            return f'/api/media/{mp.media_id}/profile-photo'
        return ''

    def get_latest_school(self):
        # NULL end_year = currently attending → show first
        for s in self.schools:
            if s.end_year is None:
                return s.name
        if self.schools:
            return self.schools[0].name
        return ''


class School(db.Model):
    __tablename__ = 'school'

    id = db.Column(db.Integer, primary_key=True)
    person_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=False)
    name = db.Column(db.Text, nullable=False)
    degree = db.Column(db.Text)
    field_of_study = db.Column(db.Text)
    start_year = db.Column(db.Integer)
    end_year = db.Column(db.Integer)
    notes = db.Column(db.Text)

    def to_dict(self):
        return {
            'id': self.id,
            'person_id': self.person_id,
            'name': self.name,
            'degree': self.degree or '',
            'field_of_study': self.field_of_study or '',
            'start_year': self.start_year,
            'end_year': self.end_year,
            'notes': self.notes or '',
        }


class FamilyUnion(db.Model):
    __tablename__ = 'family_union'

    id = db.Column(db.Integer, primary_key=True)
    partner1_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=False)
    partner2_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=False)
    union_type = db.Column(db.Text, default='marriage')
    marriage_date = db.Column(db.Text)
    divorce_date = db.Column(db.Text)
    marriage_city = db.Column(db.Text)
    marriage_country = db.Column(db.Text)
    is_current = db.Column(db.Integer, default=1)
    notes = db.Column(db.Text)

    partner1 = db.relationship('Person', foreign_keys=[partner1_id], backref='unions_as_p1')
    partner2 = db.relationship('Person', foreign_keys=[partner2_id], backref='unions_as_p2')

    __table_args__ = (
        db.CheckConstraint('partner1_id != partner2_id'),
    )

    def to_dict(self):
        return {
            'id': self.id,
            'partner1_id': self.partner1_id,
            'partner2_id': self.partner2_id,
            'union_type': self.union_type or 'marriage',
            'marriage_date': self.marriage_date or '',
            'divorce_date': self.divorce_date or '',
            'marriage_city': self.marriage_city or '',
            'marriage_country': self.marriage_country or '',
            'is_current': bool(self.is_current),
            'notes': self.notes or '',
        }

    def public_dict(self):
        return {
            'id': self.id,
            'partner1_id': self.partner1_id,
            'partner2_id': self.partner2_id,
            'union_type': self.union_type or 'marriage',
            'is_current': bool(self.is_current),
        }


class ParentChild(db.Model):
    __tablename__ = 'parent_child'

    id = db.Column(db.Integer, primary_key=True)
    parent_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=False)
    child_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=False)
    relation_type = db.Column(db.Text, default='biological')
    notes = db.Column(db.Text)

    parent = db.relationship('Person', foreign_keys=[parent_id], backref='children_links')
    child = db.relationship('Person', foreign_keys=[child_id], backref='parent_links')

    __table_args__ = (
        db.UniqueConstraint('parent_id', 'child_id'),
    )

    def to_dict(self):
        return {
            'id': self.id,
            'parent_id': self.parent_id,
            'child_id': self.child_id,
            'relation_type': self.relation_type or 'biological',
            'notes': self.notes or '',
        }


# ── Media & Evidence ──────────────────────────────────────────────────────────

class Media(db.Model):
    __tablename__ = 'media'

    id = db.Column(db.Integer, primary_key=True)
    file_path = db.Column(db.Text, nullable=False)
    file_type = db.Column(db.Text)  # image, pdf, document
    original_filename = db.Column(db.Text)
    caption = db.Column(db.Text)
    title = db.Column(db.Text)
    description = db.Column(db.Text)
    media_date = db.Column(db.Text)  # user-provided date (ISO 8601)
    location = db.Column(db.Text)
    uploaded_at = db.Column(db.Text, default=_now)

    person_tags = db.relationship('MediaPerson', backref='media', lazy=True,
                                  cascade='all, delete-orphan')
    evidence_links = db.relationship('Evidence', backref='media', lazy=True,
                                     cascade='all, delete-orphan')

    def to_dict(self, file_url_fn=None):
        url = file_url_fn(self) if file_url_fn else f'/api/media/{self.id}/file'
        return {
            'id': self.id,
            'file_type': self.file_type or '',
            'original_filename': self.original_filename or '',
            'caption': self.caption or '',
            'title': self.title or '',
            'description': self.description or '',
            'media_date': self.media_date or '',
            'location': self.location or '',
            'uploaded_at': self.uploaded_at or '',
            'file_url': url,
            'person_ids': [mp.person_id for mp in self.person_tags],
        }


class MediaPerson(db.Model):
    __tablename__ = 'media_person'

    id = db.Column(db.Integer, primary_key=True)
    media_id = db.Column(db.Integer, db.ForeignKey('media.id'), nullable=False)
    person_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=False)
    is_profile_photo = db.Column(db.Integer, default=0)

    __table_args__ = (
        db.UniqueConstraint('media_id', 'person_id'),
    )


class Evidence(db.Model):
    __tablename__ = 'evidence'

    id = db.Column(db.Integer, primary_key=True)
    media_id = db.Column(db.Integer, db.ForeignKey('media.id'), nullable=False)
    union_id = db.Column(db.Integer, db.ForeignKey('family_union.id'), nullable=True)
    parent_child_id = db.Column(db.Integer, db.ForeignKey('parent_child.id'), nullable=True)
    notes = db.Column(db.Text)

    union = db.relationship('FamilyUnion', backref='evidence_links')
    parent_child = db.relationship('ParentChild', backref='evidence_links')

    __table_args__ = (
        db.UniqueConstraint('media_id', 'union_id'),
        db.UniqueConstraint('media_id', 'parent_child_id'),
    )

    def to_dict(self, file_url_fn=None):
        return {
            'id': self.id,
            'media_id': self.media_id,
            'union_id': self.union_id,
            'parent_child_id': self.parent_child_id,
            'notes': self.notes or '',
            'media': self.media.to_dict(file_url_fn=file_url_fn) if self.media else None,
        }


# ── Face Detection ────────────────────────────────────────────────────────────

class FaceDetection(db.Model):
    __tablename__ = 'face_detection'

    id = db.Column(db.Integer, primary_key=True)
    media_id = db.Column(db.Integer, db.ForeignKey('media.id'), nullable=False)
    person_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=True)
    box_x = db.Column(db.Float)
    box_y = db.Column(db.Float)
    box_w = db.Column(db.Float)
    box_h = db.Column(db.Float)
    encoding = db.Column(db.LargeBinary)
    is_manual = db.Column(db.Integer, default=0)
    suggested_person_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=True)
    confidence = db.Column(db.Float)

    media = db.relationship('Media', backref='face_detections')
    person = db.relationship('Person', foreign_keys=[person_id])
    suggested_person = db.relationship('Person', foreign_keys=[suggested_person_id])

    def to_dict(self):
        return {
            'id': self.id,
            'media_id': self.media_id,
            'person_id': self.person_id,
            'box_x': self.box_x,
            'box_y': self.box_y,
            'box_w': self.box_w,
            'box_h': self.box_h,
            'is_manual': bool(self.is_manual),
            'suggested_person_id': self.suggested_person_id,
            'confidence': self.confidence,
            'person_name': f"{self.person.first_name} {self.person.last_name or ''}".strip() if self.person else None,
            'suggested_person_name': f"{self.suggested_person.first_name} {self.suggested_person.last_name or ''}".strip() if self.suggested_person else None,
        }
