"""Face detection and recognition module.

Uses the face_recognition library (dlib-based, fully local).
Gracefully handles missing dependency.
"""
import struct

import face_recognition
import numpy as np


def detect_faces(image_path):
    """Detect faces in an image and return bounding boxes + encodings.

    Returns list of dicts:
        {box: (x_frac, y_frac, w_frac, h_frac), encoding: ndarray, encoding_bytes: bytes}
    Coordinates are fractions of image dimensions (0-1).
    """
    image = face_recognition.load_image_file(image_path)
    h, w = image.shape[:2]

    locations = face_recognition.face_locations(image)  # (top, right, bottom, left)
    encodings = face_recognition.face_encodings(image, locations)

    results = []
    for loc, enc in zip(locations, encodings):
        top, right, bottom, left = loc
        box = (
            left / w,           # x fraction
            top / h,            # y fraction
            (right - left) / w, # width fraction
            (bottom - top) / h, # height fraction
        )
        results.append({
            'box': box,
            'encoding': enc,
            'encoding_bytes': enc.tobytes(),
        })
    return results


def suggest_matches(encoding_bytes):
    """Compare a face encoding against all confirmed encodings in the DB.

    Must be called within Flask app context.

    Returns {person_id, distance} or None.
    """
    from models import FaceDetection, db

    encoding = np.frombuffer(encoding_bytes, dtype=np.float64)

    confirmed = FaceDetection.query.filter(
        FaceDetection.person_id.isnot(None),
        FaceDetection.encoding.isnot(None),
    ).all()

    if not confirmed:
        return None

    # Group encodings by person
    person_encodings = {}
    for fd in confirmed:
        pid = fd.person_id
        if pid not in person_encodings:
            person_encodings[pid] = []
        try:
            enc = np.frombuffer(fd.encoding, dtype=np.float64)
            if enc.shape == (128,):
                person_encodings[pid].append(enc)
        except Exception:
            continue

    best_person = None
    best_distance = float('inf')

    for pid, encs in person_encodings.items():
        if not encs:
            continue
        distances = face_recognition.face_distance(encs, encoding)
        min_dist = float(distances.min())
        if min_dist < best_distance:
            best_distance = min_dist
            best_person = pid

    # Conservative threshold
    if best_person and best_distance < 0.5:
        return {'person_id': best_person, 'distance': best_distance}

    return None
