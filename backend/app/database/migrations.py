from __future__ import annotations

from sqlalchemy import inspect, text

from app.database.session import engine


def run_startup_migrations() -> None:
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    if "devices" not in tables:
        return

    with engine.begin() as connection:
        device_columns = {column["name"] for column in inspector.get_columns("devices")}
        if "connection_url" not in device_columns:
            connection.execute(text("ALTER TABLE devices ADD COLUMN connection_url TEXT"))
        if "mac_address" not in device_columns:
            connection.execute(text("ALTER TABLE devices ADD COLUMN mac_address VARCHAR(32)"))

        if "transfer_jobs" in tables:
            transfer_job_columns = {column["name"] for column in inspector.get_columns("transfer_jobs")}
            if "speed_bytes_per_second" not in transfer_job_columns:
                connection.execute(text("ALTER TABLE transfer_jobs ADD COLUMN speed_bytes_per_second BIGINT NOT NULL DEFAULT 0"))
            if "last_progress_at" not in transfer_job_columns:
                connection.execute(text("ALTER TABLE transfer_jobs ADD COLUMN last_progress_at DATETIME"))
            if "dismissed_at" not in transfer_job_columns:
                connection.execute(text("ALTER TABLE transfer_jobs ADD COLUMN dismissed_at DATETIME"))
            if "source_target_type" not in transfer_job_columns:
                connection.execute(text("ALTER TABLE transfer_jobs ADD COLUMN source_target_type VARCHAR(16) NOT NULL DEFAULT 'device'"))
            if "destination_target_type" not in transfer_job_columns:
                connection.execute(text("ALTER TABLE transfer_jobs ADD COLUMN destination_target_type VARCHAR(16) NOT NULL DEFAULT 'device'"))
            if "transfer_profile" not in transfer_job_columns:
                connection.execute(text("ALTER TABLE transfer_jobs ADD COLUMN transfer_profile VARCHAR(16) NOT NULL DEFAULT 'turbo'"))

        if "transfer_events" not in tables:
            connection.execute(text("""
                CREATE TABLE transfer_events (
                    id INTEGER PRIMARY KEY,
                    job_id INTEGER NOT NULL,
                    event_type VARCHAR(32) NOT NULL,
                    message TEXT NOT NULL,
                    source_path TEXT,
                    destination_path TEXT,
                    details_json TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(job_id) REFERENCES transfer_jobs (id)
                )
            """))
            connection.execute(text("CREATE INDEX ix_transfer_events_id ON transfer_events (id)"))
            connection.execute(text("CREATE INDEX ix_transfer_events_job_id ON transfer_events (job_id)"))
            connection.execute(text("CREATE INDEX ix_transfer_events_event_type ON transfer_events (event_type)"))
