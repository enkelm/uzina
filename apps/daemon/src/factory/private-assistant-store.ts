import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  PrivateAssistantError,
  type PrivateAssistantAdmission,
  type PrivateAssistantIdentity,
  type PrivateAssistantStore,
} from "@uzina/pi-runtime";

export class BunPrivateAssistantStore implements PrivateAssistantStore {
  private constructor(private readonly database: Database) {}

  static async open(path: string): Promise<BunPrivateAssistantStore> {
    const filename = resolve(path);
    await mkdir(dirname(filename), { recursive: true });
    const database = new Database(filename, { create: true });
    database.exec(`
      CREATE TABLE IF NOT EXISTS private_assistant_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        identity_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS private_assistant_inputs (
        input_id TEXT PRIMARY KEY,
        payload_sha256 TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        submission_id TEXT,
        accepted_at TEXT NOT NULL
      );
    `);
    return new BunPrivateAssistantStore(database);
  }

  async bindIdentity(identity: PrivateAssistantIdentity): Promise<boolean> {
    const encoded = JSON.stringify(identity);
    const row = this.database
      .query(
        "SELECT identity_json FROM private_assistant_identity WHERE singleton = 1",
      )
      .get() as { identity_json: string } | null;
    if (row) return row.identity_json === encoded;
    this.database
      .query(
        "INSERT INTO private_assistant_identity (singleton, identity_json) VALUES (1, ?)",
      )
      .run(encoded);
    return true;
  }

  async reserveInput(
    inputId: string,
    payloadSha256: string,
  ): Promise<PrivateAssistantAdmission> {
    const transaction = this.database.transaction(() => {
      const stored = this.database
        .query(
          "SELECT input_id, payload_sha256, request_id, submission_id, accepted_at FROM private_assistant_inputs WHERE input_id = ?",
        )
        .get(inputId) as {
        input_id: string;
        payload_sha256: string;
        request_id: string;
        submission_id: string | null;
        accepted_at: string;
      } | null;
      if (stored) {
        if (stored.payload_sha256 !== payloadSha256) {
          throw new PrivateAssistantError(
            409,
            "private_assistant_input_conflict",
          );
        }
        return {
          inputId: stored.input_id,
          payloadSha256: stored.payload_sha256,
          requestId: stored.request_id,
          submissionId: stored.submission_id,
          acceptedAt: stored.accepted_at,
        };
      }
      const admission: PrivateAssistantAdmission = {
        inputId,
        payloadSha256,
        requestId: inputId,
        submissionId: null,
        acceptedAt: new Date().toISOString(),
      };
      this.database
        .query(
          "INSERT INTO private_assistant_inputs (input_id, payload_sha256, request_id, accepted_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          admission.inputId,
          admission.payloadSha256,
          admission.requestId,
          admission.acceptedAt,
        );
      return admission;
    });
    return transaction.immediate();
  }

  async setSubmission(
    inputId: string,
    payloadSha256: string,
    submissionId: string,
  ): Promise<void> {
    const result = this.database
      .query(
        "UPDATE private_assistant_inputs SET submission_id = ? WHERE input_id = ? AND payload_sha256 = ?",
      )
      .run(submissionId, inputId, payloadSha256);
    if (result.changes !== 1) {
      throw new PrivateAssistantError(409, "private_assistant_input_conflict");
    }
  }

  async getInput(
    inputId: string,
  ): Promise<PrivateAssistantAdmission | undefined> {
    const row = this.database
      .query(
        "SELECT input_id, payload_sha256, request_id, submission_id, accepted_at FROM private_assistant_inputs WHERE input_id = ?",
      )
      .get(inputId) as {
      input_id: string;
      payload_sha256: string;
      request_id: string;
      submission_id: string | null;
      accepted_at: string;
    } | null;
    return row
      ? {
          inputId: row.input_id,
          payloadSha256: row.payload_sha256,
          requestId: row.request_id,
          submissionId: row.submission_id,
          acceptedAt: row.accepted_at,
        }
      : undefined;
  }

  close(): void {
    this.database.close();
  }
}
