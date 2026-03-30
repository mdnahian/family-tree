"""Face detection and recognition module using insightface.

Uses insightface (RetinaFace + ArcFace) for both detection and 512-D embeddings.
Gracefully handles missing dependency.
"""
import numpy as np

_face_app = None


def _get_face_app():
    """Lazy-load the insightface model singleton."""
    global _face_app
    if _face_app is None:
        from insightface.app import FaceAnalysis
        _face_app = FaceAnalysis(
            name='buffalo_sc',
            providers=['CPUExecutionProvider'],
        )
        _face_app.prepare(ctx_id=-1, det_size=(640, 640))
    return _face_app


def detect_faces(image_path):
    """Detect faces in an image and return bounding boxes + encodings.

    Returns list of dicts:
        {box: (x_frac, y_frac, w_frac, h_frac), encoding: ndarray, encoding_bytes: bytes}
    Coordinates are fractions of image dimensions (0-1).
    """
    import cv2
    image = cv2.imread(image_path)
    if image is None:
        return []
    h, w = image.shape[:2]

    app = _get_face_app()
    faces = app.get(image)

    results = []
    for face in faces:
        x1, y1, x2, y2 = face.bbox
        box = (
            max(0, x1) / w,
            max(0, y1) / h,
            (x2 - x1) / w,
            (y2 - y1) / h,
        )
        embedding = face.normed_embedding  # 512-D normalized float32
        results.append({
            'box': box,
            'encoding': embedding,
            'encoding_bytes': embedding.astype(np.float32).tobytes(),
        })
    return results


def suggest_matches(encoding_bytes):
    """Compare a 512-D face encoding against confirmed encodings in the DB.

    Must be called within Flask app context.
    Returns {person_id, distance} or None.
    """
    from models import FaceDetection

    encoding = np.frombuffer(encoding_bytes, dtype=np.float32)

    confirmed = FaceDetection.query.filter(
        FaceDetection.person_id.isnot(None),
        FaceDetection.encoding.isnot(None),
    ).all()

    if not confirmed:
        return None

    person_encodings = {}
    for fd in confirmed:
        pid = fd.person_id
        if pid not in person_encodings:
            person_encodings[pid] = []
        try:
            enc = np.frombuffer(fd.encoding, dtype=np.float32)
            if enc.shape == (512,):
                person_encodings[pid].append(enc)
        except Exception:
            continue

    best_person = None
    best_distance = float('inf')

    for pid, encs in person_encodings.items():
        if not encs:
            continue
        encs_array = np.array(encs)
        similarities = np.dot(encs_array, encoding)
        max_sim = float(similarities.max())
        distance = 1.0 - max_sim
        if distance < best_distance:
            best_distance = distance
            best_person = pid

    if best_person and best_distance < 0.4:
        return {'person_id': best_person, 'distance': best_distance}

    return None
