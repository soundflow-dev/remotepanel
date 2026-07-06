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
        if "sort_order" not in device_columns:
            connection.execute(text("ALTER TABLE devices ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"))
            device_rows = connection.execute(text("SELECT owner_id, id FROM devices ORDER BY owner_id ASC, name COLLATE NOCASE ASC, id ASC")).fetchall()
            owner_indexes: dict[int, int] = {}
            for owner_id, device_id in device_rows:
                owner_indexes[owner_id] = owner_indexes.get(owner_id, 0) + 1
                connection.execute(text("UPDATE devices SET sort_order = :sort_order WHERE id = :id"), {"sort_order": owner_indexes[owner_id] * 10, "id": device_id})

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

        if "ups_configs" not in tables:
            connection.execute(text("""
                CREATE TABLE ups_configs (
                    id INTEGER PRIMARY KEY,
                    owner_id INTEGER NOT NULL UNIQUE,
                    enabled BOOLEAN NOT NULL DEFAULT 0,
                    host VARCHAR(255) NOT NULL DEFAULT '',
                    port INTEGER NOT NULL DEFAULT 3493,
                    ups_name VARCHAR(120) NOT NULL DEFAULT '',
                    username VARCHAR(120) NOT NULL DEFAULT '',
                    credentials_encrypted TEXT,
                    battery_threshold INTEGER NOT NULL DEFAULT 25,
                    poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
                    selected_device_ids_json TEXT NOT NULL DEFAULT '[]',
                    last_status VARCHAR(120),
                    last_charge INTEGER,
                    last_error TEXT,
                    last_checked_at DATETIME,
                    last_triggered_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(owner_id) REFERENCES users (id)
                )
            """))
            connection.execute(text("CREATE INDEX ix_ups_configs_id ON ups_configs (id)"))
            connection.execute(text("CREATE INDEX ix_ups_configs_owner_id ON ups_configs (owner_id)"))

        if "audit_events" not in tables:
            connection.execute(text("""
                CREATE TABLE audit_events (
                    id INTEGER PRIMARY KEY,
                    owner_id INTEGER NOT NULL,
                    actor_name VARCHAR(120) NOT NULL,
                    action VARCHAR(80) NOT NULL,
                    target_type VARCHAR(40) NOT NULL,
                    target_name VARCHAR(255) NOT NULL DEFAULT '',
                    details_json TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(owner_id) REFERENCES users (id)
                )
            """))
            connection.execute(text("CREATE INDEX ix_audit_events_id ON audit_events (id)"))
            connection.execute(text("CREATE INDEX ix_audit_events_owner_id ON audit_events (owner_id)"))
            connection.execute(text("CREATE INDEX ix_audit_events_action ON audit_events (action)"))
            connection.execute(text("CREATE INDEX ix_audit_events_target_type ON audit_events (target_type)"))
            connection.execute(text("CREATE INDEX ix_audit_events_created_at ON audit_events (created_at)"))
