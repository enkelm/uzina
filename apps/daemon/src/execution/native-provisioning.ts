import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { statSync, realpathSync } from "node:fs";
import { FactoryError } from "@uzina/core";
import type {
  NativeWorkerProvisioningHost,
  NativeWorkerProvisioningJournal,
} from "@uzina/core/http";
import {
  nativeProvisioningBindingSchema,
  nativeProvisioningTargetsSchema,
  factoryWorkerConfigurationSchema,
  type NativeProvisioningBinding,
  type NativeProvisioningStatus,
  type NativeProvisioningTargets,
  type NativeProvisioningTargetInput,
  type ProvisionNativeWorkerRequest,
} from "@uzina/contracts/native-provisioning";
import type { NativeAgentLaunchInput } from "@uzina/contracts/native-agents";
import { ExecutionError } from "./errors";
import { observeNativePi } from "./native-pi-state";
import {
  NativeAgentLauncher,
  type NativeAgentLaunchReceipt,
} from "./native-agents";
import {
  privateNativeDirectory,
  readNativeBootstrapFile,
  writeNativeBootstrapFile,
} from "./native-agent-bootstrap";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const launchId = (scopeId: string, requestId: string) =>
  `provision:${hash(`${scopeId}:${requestId}`)}`;
function errorCode(error: unknown) {
  return error instanceof ExecutionError
    ? error.code
    : "native_provisioning_failed";
}

/** A finite, idempotent provisioning operation over Core records and the existing executor. No scheduler. */
export class NativeWorkerProvisioner implements NativeWorkerProvisioningHost {
  readonly #launcher: NativeAgentLauncher;
  readonly #targets: (projectId: string) => NativeProvisioningTargets;
  readonly #entry: string;
  readonly #baseUrl: () => string;
  readonly #root: string;
  readonly #scopeId: string;
  readonly #pending = new Set<Promise<void>>();
  #closing = false;
  constructor(options: {
    launcher: NativeAgentLauncher;
    factoryWorkerEntry: string;
    factoryBaseUrl: () => string;
    factoryScopeId: string;
    targets:
      | NativeProvisioningTargetInput
      | ((projectId: string) => NativeProvisioningTargetInput);
  }) {
    this.#launcher = options.launcher;
    const validate = (targets: NativeProvisioningTargetInput) => {
      const parsed = nativeProvisioningTargetsSchema.parse({
        contractVersion: 1,
        targets,
      });
      if (Buffer.byteLength(JSON.stringify(parsed)) > 96 * 1024)
        throw new ExecutionError("native_provisioning_configuration_limit");
      if (
        new Set(
          parsed.targets.map(
            (target) => `${target.projectId}:${target.targetId}`,
          ),
        ).size !== parsed.targets.length
      )
        throw new ExecutionError("native_provisioning_duplicate_target");
      return parsed;
    };
    const targets = options.targets;
    if (typeof targets === "function")
      this.#targets = (projectId) => validate(targets(projectId));
    else {
      const configured = validate(targets);
      this.#targets = () => configured;
    }
    this.#entry = realpathSync(options.factoryWorkerEntry);
    if (!statSync(this.#entry).isFile())
      throw new ExecutionError("native_provisioning_invalid_entry");
    this.#baseUrl = options.factoryBaseUrl;
    this.#scopeId = options.factoryScopeId;
    options.launcher.bindFactoryScope(this.#scopeId);
    // The launcher already verified this entire private root against every workspace.
    this.#root = privateNativeDirectory(
      join(
        privateNativeDirectory(
          join(options.launcher.protectedRoots[0]!, "factory-workers"),
        ),
        this.#scopeId,
      ),
    );
  }
  get protectedRoots() {
    return this.#launcher.protectedRoots;
  }
  targets(projectId: string): NativeProvisioningTargets {
    return {
      contractVersion: 1,
      targets: this.#targets(projectId).targets.filter(
        (target) => target.projectId === projectId,
      ),
    };
  }
  #binding(request: ProvisionNativeWorkerRequest): NativeProvisioningBinding {
    const target = this.targets(request.projectId).targets.find(
      (item) =>
        item.projectId === request.projectId &&
        item.targetId === request.targetId &&
        item.profileIds.includes(request.profileId),
    );
    if (!target)
      throw new FactoryError(409, "native_provisioning_target_unavailable");
    const { profileIds: _profiles, ...binding } = target;
    return nativeProvisioningBindingSchema.parse({
      ...binding,
      profileId: request.profileId,
    });
  }
  #track(operation: () => Promise<void>) {
    if (this.#closing)
      return Promise.reject(
        new FactoryError(503, "native_provisioning_host_closed"),
      );
    if (this.#pending.size >= 8)
      return Promise.reject(new FactoryError(429, "native_provisioning_busy"));
    const pending = operation();
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }
  run(
    request: ProvisionNativeWorkerRequest,
    journal: NativeWorkerProvisioningJournal,
  ) {
    return this.#track(() => this.#run(request, journal));
  }
  refresh(
    status: NativeProvisioningStatus,
    journal: NativeWorkerProvisioningJournal,
  ) {
    return this.#track(() => this.#refresh(status, journal));
  }
  observeActivity(status: NativeProvisioningStatus) {
    if (status.scopeId !== this.#scopeId)
      throw new ExecutionError("native_provisioning_scope_conflict");
    const config = factoryWorkerConfigurationSchema.parse(
      JSON.parse(
        readNativeBootstrapFile(
          join(this.#root, hash(status.request.requestId), "server.json"),
        ),
      ),
    );
    if (
      config.workerId !== status.workerId ||
      config.projectId !== status.request.projectId ||
      config.baseUrl !== this.#baseUrl()
    )
      throw new ExecutionError("native_agent_factory_binding_conflict");
    return config.nativeDelivery ? observeNativePi(config) : null;
  }
  async close() {
    this.#closing = true;
    await Promise.allSettled(this.#pending);
  }
  #record(
    receipt: NativeAgentLaunchReceipt,
    journal: NativeWorkerProvisioningJournal,
  ) {
    journal.record({
      process: receipt.process,
      nativeBinding: receipt.nativeBinding ?? null,
      mcp: {
        rex: receipt.mcp,
        factory:
          receipt.factoryOrigin !== this.#baseUrl()
            ? { status: "unavailable", errorCode: "factory_origin_changed" }
            : (receipt.factoryMcp ?? {
                status: "unavailable",
                errorCode: "factory_mcp_not_configured",
              }),
      },
      errorCode:
        receipt.factoryOrigin !== this.#baseUrl()
          ? "factory_origin_changed"
          : (receipt.observationError ?? null),
    });
  }
  async #refresh(
    status: NativeProvisioningStatus,
    journal: NativeWorkerProvisioningJournal,
  ) {
    try {
      this.#record(
        await this.#launcher.inspect(
          launchId(this.#scopeId, status.request.requestId),
        ),
        journal,
      );
    } catch (error) {
      if (error instanceof FactoryError) throw error;
      // A GET never prepares files, reserves identities or creates a process.
      if (
        error instanceof ExecutionError &&
        [
          "native_agent_launch_not_found",
          "native_agent_preparation_incomplete",
        ].includes(error.code) &&
        !status.process
      )
        return;
      journal.record({
        process: status.process,
        mcp: status.mcp
          ? {
              rex: { ...status.mcp.rex, status: "unavailable" },
              factory: { ...status.mcp.factory, status: "unavailable" },
            }
          : null,
        errorCode: errorCode(error),
      });
    }
  }
  #credential(request: ProvisionNativeWorkerRequest) {
    const directory = privateNativeDirectory(
      join(this.#root, hash(request.requestId)),
    );
    const path = join(directory, "credential.json");
    const load = () => {
      const data = JSON.parse(readNativeBootstrapFile(path)) as {
        request: unknown;
        workerId: unknown;
        credential: unknown;
      };
      if (
        JSON.stringify(data.request) !== JSON.stringify(request) ||
        data.workerId !==
          `worker:${hash(`${this.#scopeId}:${request.requestId}`)}` ||
        typeof data.credential !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(data.credential)
      )
        throw new ExecutionError("native_provisioning_credential_conflict");
      return {
        directory,
        workerId: data.workerId,
        credential: data.credential,
      };
    };
    try {
      return load();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      writeNativeBootstrapFile(
        path,
        JSON.stringify({
          request,
          workerId: `worker:${hash(`${this.#scopeId}:${request.requestId}`)}`,
          credential: randomBytes(32).toString("base64url"),
        }),
      );
    } catch (error) {
      if (
        !(error instanceof ExecutionError) ||
        error.code !== "native_agent_bootstrap_conflict"
      )
        throw error;
    }
    return load();
  }
  async #run(
    request: ProvisionNativeWorkerRequest,
    journal: NativeWorkerProvisioningJournal,
  ) {
    let status = journal.existing();
    if (status && JSON.stringify(status.request) !== JSON.stringify(request))
      throw new FactoryError(409, "native_provisioning_request_conflict");
    if (status?.process) {
      await this.#refresh(status, journal);
      return;
    }
    if (status) {
      try {
        this.#record(
          await this.#launcher.inspect(
            launchId(this.#scopeId, request.requestId),
          ),
          journal,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof ExecutionError) ||
          ![
            "native_agent_launch_not_found",
            "native_agent_preparation_incomplete",
          ].includes(error.code)
        )
          throw error;
      }
    }
    const binding = this.#binding(request);
    journal.authorize(binding);
    const credentials = this.#credential(request);
    status = await journal.admit(binding, credentials.credential);
    if (status.scopeId !== this.#scopeId)
      throw new FactoryError(409, "native_provisioning_scope_conflict");
    if (status.process) {
      await this.#refresh(status, journal);
      return;
    }
    try {
      const configPath = join(credentials.directory, "server.json");
      const journalPath = join(credentials.directory, "journal.sqlite");
      const input: NativeAgentLaunchInput = {
        requestId: launchId(this.#scopeId, request.requestId),
        projectId: request.projectId,
        profileId: request.profileId,
        target: binding.target,
        ownershipGeneration: binding.ownershipGeneration,
      };
      const delivery = this.#launcher.deliveryConfiguration(input);
      const config = factoryWorkerConfigurationSchema.parse({
        baseUrl: this.#baseUrl(),
        credential: credentials.credential,
        workerId: status.workerId,
        projectId: request.projectId,
        target: binding.target,
        ownershipGeneration: binding.ownershipGeneration,
        journalPath,
        ...(delivery
          ? {
              nativeDelivery: {
                ...delivery,
                statePath: join(credentials.directory, "activity.json"),
              },
            }
          : {}),
      });
      writeNativeBootstrapFile(configPath, JSON.stringify(config));
      this.#record(
        await this.#launcher.launch(
          input,
          0,
          () => journal.assertAdmission(this.#binding(request)),
          {
            workerId: status.workerId,
            configPath,
            journalPath,
            entry: this.#entry,
            baseUrl: config.baseUrl,
            ...(delivery ? { nativeBinding: delivery.binding } : {}),
          },
        ),
        journal,
      );
    } catch (error) {
      if (error instanceof FactoryError) throw error;
      // Observation/reply loss must never discard a committed process receipt.
      try {
        this.#record(
          await this.#launcher.inspect(
            launchId(this.#scopeId, request.requestId),
          ),
          journal,
        );
      } catch (inspectionError) {
        if (inspectionError instanceof FactoryError) throw inspectionError;
        journal.record({
          process: status.process,
          mcp: null,
          errorCode: errorCode(error),
        });
      }
    }
  }
}
