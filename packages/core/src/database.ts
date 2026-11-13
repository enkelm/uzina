export type SqlValue = string | number | null;
export type SqlRow = Record<string, unknown>;

/** Synchronous SQL and transaction boundary shared by Bun SQLite and DO SQLite. */
export interface FactoryDatabase {
  exec(sql: string, values?: readonly SqlValue[]): void;
  all<T extends SqlRow = SqlRow>(
    sql: string,
    values?: readonly SqlValue[],
  ): T[];
  transaction<T>(operation: () => T): T;
}

const schema = [
  `CREATE TABLE IF NOT EXISTS factory_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner_id TEXT NOT NULL,
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS credentials (
    credential_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    actor_json TEXT NOT NULL,
    name TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nodes (
    node_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    availability TEXT NOT NULL CHECK (availability IN ('offline', 'online')),
    last_seen_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    name TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS threads (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    title TEXT NOT NULL,
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS dispatch_intents (
    job_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    actor_json TEXT NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(thread_id),
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'unavailable', 'running', 'dispatched', 'completed', 'failed', 'uncertain')),
    outcome TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS command_receipts (
    request_id TEXT PRIMARY KEY,
    actor_json TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(thread_id),
    payload_hash TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES dispatch_intents(job_id),
    accepted_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS factory_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    project_id TEXT,
    thread_id TEXT,
    request_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS execution_node_state (
    node_id TEXT PRIMARY KEY REFERENCES nodes(node_id),
    daemon_version TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS execution_node_workspaces (
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'fenced')),
    PRIMARY KEY (node_id, workspace_id)
  )`,
  `CREATE TABLE IF NOT EXISTS execution_jobs (
    job_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
    operation TEXT NOT NULL CHECK (operation IN ('read-file', 'write-file', 'argv-command')),
    payload_json TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'failed', 'uncertain')),
    accepted_at TEXT NOT NULL,
    claimed_at TEXT,
    finished_at TEXT,
    report_json TEXT,
    report_sha256 TEXT,
    error_code TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS execution_job_claims (
    job_id TEXT NOT NULL REFERENCES execution_jobs(job_id),
    claim_number INTEGER NOT NULL CHECK (claim_number > 0),
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    payload_sha256 TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (job_id, claim_number)
  )`,
  `CREATE INDEX IF NOT EXISTS dispatch_queue_by_node ON dispatch_intents(status, node_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS execution_queue_by_node ON execution_jobs(status, node_id, accepted_at)`,
  `CREATE INDEX IF NOT EXISTS factory_events_by_cursor ON factory_events(cursor)`,
];

export function initializeFactoryDatabase(database: FactoryDatabase): void {
  for (const statement of schema) database.exec(statement);
}
