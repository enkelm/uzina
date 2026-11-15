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
    access_generation INTEGER NOT NULL DEFAULT 0 CHECK (access_generation >= 0),
    assistant_scope_initialized INTEGER NOT NULL DEFAULT 0 CHECK (assistant_scope_initialized IN (0, 1)),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS factory_users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'guest', 'viewer')),
    access_generation INTEGER NOT NULL DEFAULT 0 CHECK (access_generation >= 0),
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assistant_credential_grants (
    credential_id TEXT NOT NULL REFERENCES credentials(credential_id),
    resource_type TEXT NOT NULL CHECK (resource_type IN ('factory', 'project', 'thread')),
    resource_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (credential_id, resource_type, resource_id)
  )`,
  `CREATE TABLE IF NOT EXISTS access_grants (
    user_id TEXT NOT NULL REFERENCES factory_users(user_id),
    resource_type TEXT NOT NULL CHECK (resource_type IN ('project', 'thread')),
    resource_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, resource_type, resource_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invitations (
    invitation_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('guest', 'viewer')),
    grants_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    redeemed_at TEXT,
    redeemed_by TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS thread_discussion (
    discussion_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(thread_id),
    actor_json TEXT NOT NULL,
    text TEXT NOT NULL,
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
    owner_private INTEGER NOT NULL DEFAULT 0 CHECK (owner_private IN (0, 1)),
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
    request_id TEXT,
    pi_task_id TEXT,
    pi_call_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'failed', 'uncertain')),
    accepted_at TEXT NOT NULL,
    claimed_at TEXT,
    finished_at TEXT,
    report_json TEXT,
    report_sha256 TEXT,
    error_code TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS managed_work_captures (
    capture_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE REFERENCES threads(thread_id),
    workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(workspace_id),
    owner_id TEXT NOT NULL,
    started_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS managed_work_runtime_permits (
    thread_id TEXT PRIMARY KEY REFERENCES threads(thread_id),
    permit_id TEXT NOT NULL UNIQUE,
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
    acquired_at TEXT NOT NULL,
    released_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS capture_control_requests (
    request_id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL UNIQUE,
    capture_id TEXT NOT NULL UNIQUE,
    actor_json TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    thread_id TEXT NOT NULL REFERENCES threads(thread_id),
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
    payload_json TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'source-capture-fenced', 'blocked')),
    accepted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_at TEXT,
    report_json TEXT,
    report_sha256 TEXT,
    error_code TEXT,
    claim_count INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0)
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
  `CREATE TABLE IF NOT EXISTS workspace_snapshot_requests (
    request_id TEXT PRIMARY KEY,
    capture_request_id TEXT NOT NULL UNIQUE REFERENCES capture_control_requests(request_id),
    snapshot_id TEXT NOT NULL UNIQUE,
    capture_id TEXT NOT NULL UNIQUE,
    actor_json TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    thread_id TEXT NOT NULL REFERENCES threads(thread_id),
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'workspace-checkpoint-available', 'blocked', 'uncertain')),
    accepted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_at TEXT,
    manifest_reference TEXT,
    report_json TEXT,
    report_sha256 TEXT,
    error_code TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_snapshot_blobs (
    capture_id TEXT NOT NULL,
    reference TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    PRIMARY KEY (capture_id, reference)
  )`,
  `CREATE TABLE IF NOT EXISTS managed_work_checkpoint_requests (
    request_id TEXT PRIMARY KEY,
    capture_request_id TEXT NOT NULL UNIQUE REFERENCES capture_control_requests(request_id),
    workspace_snapshot_request_id TEXT NOT NULL UNIQUE REFERENCES workspace_snapshot_requests(request_id),
    capture_id TEXT NOT NULL UNIQUE,
    actor_json TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    thread_id TEXT NOT NULL REFERENCES threads(thread_id),
    node_id TEXT NOT NULL REFERENCES nodes(node_id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
    status TEXT NOT NULL CHECK (status IN ('assembling', 'available', 'blocked', 'uncertain')),
    stage TEXT NOT NULL CHECK (stage IN ('admitted', 'runtime-export-started', 'runtime-export-recorded', 'evidence-write-started', 'evidence-recorded', 'bundle-compose-started', 'bundle-composed', 'closure-verification-started', 'available')),
    accepted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    manifest_reference TEXT,
    runtime_requirements_json TEXT,
    CHECK ((status = 'available' AND stage = 'available' AND manifest_reference IS NOT NULL)
      OR (status <> 'available' AND manifest_reference IS NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS managed_work_checkpoint_artifacts (
    request_id TEXT NOT NULL REFERENCES managed_work_checkpoint_requests(request_id),
    role TEXT NOT NULL CHECK (role IN ('runtime', 'evidence', 'attachment', 'inner-manifest', 'outer-manifest')),
    reference TEXT NOT NULL CHECK (length(reference) = 64 AND reference NOT GLOB '*[^a-f0-9]*'),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 536870912),
    verified_at TEXT NOT NULL,
    PRIMARY KEY (request_id, role, reference)
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_relocations (
    request_id TEXT PRIMARY KEY,
    relocation_id TEXT NOT NULL UNIQUE,
    checkpoint_request_id TEXT NOT NULL UNIQUE REFERENCES managed_work_checkpoint_requests(request_id),
    capture_request_id TEXT NOT NULL UNIQUE REFERENCES capture_control_requests(request_id),
    capture_id TEXT NOT NULL UNIQUE,
    workspace_snapshot_request_id TEXT NOT NULL UNIQUE REFERENCES workspace_snapshot_requests(request_id),
    snapshot_id TEXT NOT NULL UNIQUE,
    actor_json TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    thread_id TEXT NOT NULL REFERENCES threads(thread_id),
    source_node_id TEXT NOT NULL REFERENCES nodes(node_id),
    source_workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    destination_node_id TEXT NOT NULL REFERENCES nodes(node_id),
    destination_workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    ownership_generation INTEGER NOT NULL CHECK (ownership_generation >= 0),
    manifest_reference TEXT NOT NULL CHECK (length(manifest_reference) = 64 AND manifest_reference NOT GLOB '*[^a-f0-9]*'),
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'prepared-inactive', 'blocked', 'uncertain')),
    accepted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_at TEXT,
    report_json TEXT,
    report_sha256 TEXT,
    receipt_sha256 TEXT,
    previous_report_json TEXT,
    previous_report_sha256 TEXT,
    previous_receipt_sha256 TEXT,
    error_code TEXT,
    UNIQUE (destination_node_id, destination_workspace_id),
    CHECK (source_node_id <> destination_node_id),
    CHECK (source_workspace_id <> destination_workspace_id),
    CHECK (
      (status IN ('queued', 'claimed') AND report_json IS NULL AND report_sha256 IS NULL AND receipt_sha256 IS NULL AND error_code IS NULL)
      OR (status = 'prepared-inactive' AND report_json IS NOT NULL AND report_sha256 IS NOT NULL AND receipt_sha256 IS NOT NULL AND error_code IS NULL)
      OR (status IN ('blocked', 'uncertain') AND report_json IS NOT NULL AND report_sha256 IS NOT NULL AND receipt_sha256 IS NOT NULL AND error_code IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS workspace_relocation_queue_by_node ON workspace_relocations(status, destination_node_id, accepted_at)`,
  `CREATE INDEX IF NOT EXISTS workspace_snapshot_queue_by_node ON workspace_snapshot_requests(status, node_id, accepted_at)`,
  `CREATE INDEX IF NOT EXISTS capture_control_queue_by_node ON capture_control_requests(status, node_id, accepted_at)`,
  `CREATE INDEX IF NOT EXISTS factory_events_by_cursor ON factory_events(cursor)`,
];

export function initializeFactoryDatabase(database: FactoryDatabase): void {
  for (const statement of schema) database.exec(statement);
  const managedWorkCheckpointColumns = new Set(
    database
      .all<{ name: string }>(
        "PRAGMA table_info(managed_work_checkpoint_requests)",
      )
      .map((column) => column.name),
  );
  if (!managedWorkCheckpointColumns.has("runtime_requirements_json")) {
    database.exec(
      "ALTER TABLE managed_work_checkpoint_requests ADD COLUMN runtime_requirements_json TEXT",
    );
  }
  const workspaceRelocationColumns = new Set(
    database
      .all<{ name: string }>("PRAGMA table_info(workspace_relocations)")
      .map((column) => column.name),
  );
  for (const column of [
    "previous_report_json",
    "previous_report_sha256",
    "previous_receipt_sha256",
  ] as const) {
    if (!workspaceRelocationColumns.has(column)) {
      database.exec(
        `ALTER TABLE workspace_relocations ADD COLUMN ${column} TEXT`,
      );
    }
  }
  const columns = new Set(
    database
      .all<{ name: string }>("PRAGMA table_info(execution_jobs)")
      .map((column) => column.name),
  );
  for (const column of ["request_id", "pi_task_id", "pi_call_id"] as const) {
    if (!columns.has(column)) {
      database.exec(`ALTER TABLE execution_jobs ADD COLUMN ${column} TEXT`);
    }
  }
  const credentialColumns = new Set(
    database
      .all<{ name: string }>("PRAGMA table_info(credentials)")
      .map((column) => column.name),
  );
  if (!credentialColumns.has("access_generation")) {
    database.exec(
      "ALTER TABLE credentials ADD COLUMN access_generation INTEGER NOT NULL DEFAULT 0 CHECK (access_generation >= 0)",
    );
  }
  if (!credentialColumns.has("assistant_scope_initialized")) {
    database.exec(
      "ALTER TABLE credentials ADD COLUMN assistant_scope_initialized INTEGER NOT NULL DEFAULT 0 CHECK (assistant_scope_initialized IN (0, 1))",
    );
  }
  const userColumns = new Set(
    database
      .all<{ name: string }>("PRAGMA table_info(factory_users)")
      .map((column) => column.name),
  );
  if (!userColumns.has("access_generation")) {
    database.exec(
      "ALTER TABLE factory_users ADD COLUMN access_generation INTEGER NOT NULL DEFAULT 0 CHECK (access_generation >= 0)",
    );
  }
  const threadColumns = new Set(
    database
      .all<{ name: string }>("PRAGMA table_info(threads)")
      .map((column) => column.name),
  );
  if (!threadColumns.has("owner_private")) {
    database.exec(
      "ALTER TABLE threads ADD COLUMN owner_private INTEGER NOT NULL DEFAULT 0 CHECK (owner_private IN (0, 1))",
    );
  }
  const owner = database.all<{ owner_id: string }>(
    "SELECT owner_id FROM factory_meta WHERE singleton = 1",
  )[0];
  const assistantCredentials = database.all<{
    credential_id: string;
    actor_json: string;
    created_at: string;
    assistant_scope_initialized: number;
  }>(
    "SELECT credential_id, actor_json, created_at, assistant_scope_initialized FROM credentials ORDER BY created_at, credential_id",
  );
  for (const credential of assistantCredentials) {
    let actor: { kind?: string };
    try {
      actor = JSON.parse(credential.actor_json) as { kind?: string };
    } catch {
      continue;
    }
    if (
      actor.kind === "assistant" &&
      credential.assistant_scope_initialized === 0
    ) {
      const hasStoredScope =
        database.all(
          "SELECT credential_id FROM assistant_credential_grants WHERE credential_id = ? LIMIT 1",
          [credential.credential_id],
        ).length > 0;
      if (!hasStoredScope) {
        // Existing assistant credentials retain their prior breadth as an explicit stored grant.
        database.exec(
          "INSERT INTO assistant_credential_grants (credential_id, resource_type, resource_id, created_at) VALUES (?, 'factory', 'factory', ?)",
          [credential.credential_id, credential.created_at],
        );
      }
      database.exec(
        "UPDATE credentials SET assistant_scope_initialized = 1 WHERE credential_id = ?",
        [credential.credential_id],
      );
    }
  }
  if (owner) {
    const legacyOwnerCredentials = database.all<{
      actor_json: string;
      name: string;
      created_at: string;
    }>(
      "SELECT actor_json, name, created_at FROM credentials ORDER BY created_at, credential_id",
    );
    const legacyOwnerCredential = legacyOwnerCredentials.find((credential) => {
      try {
        const actor = JSON.parse(credential.actor_json) as {
          kind?: string;
          userId?: string;
        };
        return actor.kind === "human" && actor.userId === owner.owner_id;
      } catch {
        return false;
      }
    });
    database.exec(
      "INSERT OR IGNORE INTO factory_users (user_id, display_name, role, revoked_at, created_at) VALUES (?, ?, 'owner', NULL, ?)",
      [
        owner.owner_id,
        legacyOwnerCredential?.name ?? "Owner",
        legacyOwnerCredential?.created_at ?? new Date().toISOString(),
      ],
    );
  }
}
