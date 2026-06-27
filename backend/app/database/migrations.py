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
