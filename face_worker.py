"""Background face detection worker.

Polls the face_job table for pending jobs and processes them one at a time.
Runs as a daemon thread started by the Flask app.
"""
import os
import threading
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_worker_thread = None
_stop_event = threading.Event()


def start_worker(app):
    """Start the background face detection worker thread."""
    global _worker_thread
    if _worker_thread is not None and _worker_thread.is_alive():
        return
    _stop_event.clear()
    _worker_thread = threading.Thread(
        target=_worker_loop, args=(app,), daemon=True, name='face-worker'
    )
    _worker_thread.start()
    logger.info("Face detection worker started")


def stop_worker():
    """Signal the worker to stop."""
    _stop_event.set()


def enqueue_face_job(media_id, file_path):
    """Add a face detection job to the queue. Must be called in app context."""
    from models import FaceJob, db, _now
    existing = FaceJob.query.filter_by(media_id=media_id, status='pending').first()
    if existing:
        return existing.id
    job = FaceJob(
        media_id=media_id,
        file_path=file_path,
        status='pending',
        created_at=_now(),
    )
    db.session.add(job)
    db.session.commit()
    return job.id


def _worker_loop(app):
    """Main worker loop. Polls for pending jobs every 2 seconds."""
    while not _stop_event.is_set():
        try:
            with app.app_context():
                _process_next_job(app)
        except Exception as e:
            logger.error(f"Worker loop error: {e}")
        _stop_event.wait(timeout=2)


def _process_next_job(app):
    """Pick and process the next pending job."""
    from models import FaceJob, FaceDetection, db

    job = FaceJob.query.filter_by(status='pending').order_by(FaceJob.id).first()
    if not job:
        return

    job.status = 'processing'
    db.session.commit()

    try:
        from face import detect_faces, suggest_matches

        file_path = os.path.join(app.config['UPLOAD_FOLDER'], job.file_path)
        faces = detect_faces(file_path)

        for f in faces:
            suggestion = suggest_matches(f['encoding_bytes'])
            fd = FaceDetection(
                media_id=job.media_id,
                box_x=f['box'][0],
                box_y=f['box'][1],
                box_w=f['box'][2],
                box_h=f['box'][3],
                encoding=f['encoding_bytes'],
                suggested_person_id=suggestion['person_id'] if suggestion else None,
                confidence=suggestion['distance'] if suggestion else None,
            )
            db.session.add(fd)

        job.status = 'done'
        job.completed_at = datetime.now(timezone.utc).isoformat()
        db.session.commit()
    except Exception as e:
        job.status = 'failed'
        job.error = str(e)[:500]
        db.session.commit()
        logger.error(f"Face job {job.id} failed: {e}")
