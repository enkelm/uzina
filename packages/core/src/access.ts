import type {
  AccessGrant,
  FactoryActor,
  ParticipantRole,
} from "@uzina/contracts/factory";

export type StoredAccessPrincipal = {
  actor: FactoryActor;
  userId: string | null;
  role: "owner" | ParticipantRole | null;
  grants: readonly AccessGrant[];
  accessGeneration: number;
  active: boolean;
};

/** Shared authorization decisions derived from the authenticated actor and stored grants. */
export class FactoryAccessPolicy {
  constructor(
    private readonly ownerId: string,
    readonly principal: StoredAccessPrincipal,
  ) {}

  get isOwner(): boolean {
    if (!this.principal.active) return false;
    return (
      (this.principal.actor.kind === "human" &&
        this.principal.actor.userId === this.ownerId) ||
      (this.principal.actor.kind === "assistant" &&
        this.principal.actor.ownerId === this.ownerId)
    );
  }

  get canAdminister(): boolean {
    return (
      this.principal.active &&
      this.principal.actor.kind === "human" &&
      this.principal.actor.userId === this.ownerId
    );
  }

  get canReadFactoryAdministration(): boolean {
    return this.isOwner;
  }

  canReadProject(projectId: string): boolean {
    return (
      this.isOwner ||
      (this.principal.active &&
        this.principal.grants.some(
          (grant) => grant.type === "project" && grant.resourceId === projectId,
        ))
    );
  }

  canReadThread(
    projectId: string,
    threadId: string,
    ownerPrivate = false,
  ): boolean {
    if (!this.principal.active) return false;
    if (this.isOwner) return true;
    if (ownerPrivate) return false;
    return this.principal.grants.some(
      (grant) =>
        (grant.type === "project" && grant.resourceId === projectId) ||
        (grant.type === "thread" && grant.resourceId === threadId),
    );
  }

  canPostDiscussion(
    projectId: string,
    threadId: string,
    ownerPrivate = false,
  ): boolean {
    return this.canReadThread(projectId, threadId, ownerPrivate);
  }

  canSteer(projectId: string, threadId: string, ownerPrivate = false): boolean {
    if (!this.canReadThread(projectId, threadId, ownerPrivate)) return false;
    return (
      this.isOwner ||
      (this.principal.actor.kind === "human" && this.principal.role === "guest")
    );
  }
}
