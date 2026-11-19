import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@ui-sdk/react/avatar";
import { Button } from "@ui-sdk/react/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@ui-sdk/react/collapsible";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  createDialogController,
} from "@ui-sdk/react/dialog";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Textarea } from "@ui-sdk/react/textarea";
import { FactoryClient, FactoryClientError } from "@uzina/client";
import { factoryThreadSchema } from "@uzina/contracts/factory";
import { CoordinationInbox } from "./coordination-inbox";
import { FactoryChat } from "./factory-chat";
import {
  visibleMessages,
  type ContextMessage as Message,
} from "./context-messages";
type Identity = Awaited<ReturnType<FactoryClient["me"]>>;
type Project = Awaited<
  ReturnType<FactoryClient["listProjects"]>
>["projects"][number];
type Thread = Awaited<
  ReturnType<FactoryClient["listThreads"]>
>["threads"][number];
type Node = Awaited<ReturnType<FactoryClient["listNodes"]>>["nodes"][number];
type Workspace = Awaited<
  ReturnType<FactoryClient["listWorkspaces"]>
>["workspaces"][number];
type Receipt = Awaited<ReturnType<FactoryClient["submitInput"]>>;

function Icon({ name }: { name: "plus" | "close" | "back" | "chat" }) {
  const paths = {
    plus: "M12 5v14M5 12h14",
    close: "m6 6 12 12M18 6 6 18",
    back: "m12 5-7 7 7 7M5 12h14",
    chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z",
  };
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_RUNS: Receipt[] = [];
function ownValue<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}
function message(error: unknown): string {
  if (error instanceof FactoryClientError) {
    if (error.status === 401 || error.status === 403)
      return "Access was denied or revoked. Sign in again or ask the Factory Owner to check your access.";
    if (error.status === 0)
      return "Factory is unavailable. Check that it is running, then retry.";
    return `Factory request could not be completed (${error.code}).`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
function statusUnavailable(error: unknown): boolean {
  return error instanceof FactoryClientError && error.status >= 500;
}
export function App() {
  const { project: selectedProject = "", work: selectedId = "" } = useSearch({
    from: "/",
  });
  const navigate = useNavigate({ from: "/" });
  const setSelectedProject = useCallback(
    (project: string, replace = false) => {
      void navigate({
        search: (current) => ({
          project: project || undefined,
          work: current.project === project ? current.work : undefined,
        }),
        replace,
      });
    },
    [navigate],
  );
  const setSelectedId = useCallback(
    (value: string | ((current: string) => string)) => {
      void navigate({
        search: (current) => ({
          ...current,
          work:
            (typeof value === "function" ? value(current.work ?? "") : value) ||
            undefined,
        }),
      });
    },
    [navigate],
  );
  const [sessionActive, setSessionActive] = useState(true);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [threadBatchFull, setThreadBatchFull] = useState(false);
  const [workId, setWorkId] = useState("");
  const [metadataUnavailableId, setMetadataUnavailableId] = useState("");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [conversations, setConversations] = useState<Record<string, Message[]>>(
    {},
  );
  const [threadRuns, setThreadRuns] = useState<Record<string, Receipt[]>>({});
  const conversation = ownValue(conversations, selectedId) ?? EMPTY_MESSAGES;
  const runs = ownValue(threadRuns, selectedId) ?? EMPTY_RUNS;
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [receiptsByThread, setReceiptsByThread] = useState<
    Record<string, Receipt>
  >({});
  const [pendingInputs, setPendingInputs] = useState<
    Record<string, { threadId: string; requestId: string; text: string }>
  >({});
  const [draftsByThread, setDraftsByThread] = useState<Record<string, string>>(
    {},
  );
  const pendingInput = selectedId
    ? (ownValue(pendingInputs, selectedId) ?? null)
    : null;
  const draft =
    pendingInput?.text ??
    (selectedId ? (ownValue(draftsByThread, selectedId) ?? "") : "");
  const receipt = selectedId
    ? (ownValue(receiptsByThread, selectedId) ?? null)
    : null;
  const setDraft = (value: string) => {
    if (selectedId)
      setDraftsByThread((current) => ({ ...current, [selectedId]: value }));
  };
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showCreateThread, setShowCreateThread] = useState(false);
  const [projectDialog] = useState(createDialogController);
  const [threadDialog] = useState(createDialogController);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [threadTitle, setThreadTitle] = useState("");
  const [targetNode, setTargetNode] = useState("");
  const [targetWorkspace, setTargetWorkspace] = useState("");
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedProjectRef = useRef(selectedProject);
  selectedProjectRef.current = selectedProject;
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;
  const threadTitleRef = useRef(threadTitle);
  threadTitleRef.current = threadTitle;
  const projectDialogRef = useRef(showCreateProject);
  projectDialogRef.current = showCreateProject;
  const threadDialogRef = useRef(showCreateThread);
  threadDialogRef.current = showCreateThread;
  const projectDialogVersion = useRef(0);
  const threadDialogVersion = useRef(0);
  const aborts = useRef(new Set<AbortController>());
  const inputAborts = useRef(new Map<string, Set<AbortController>>());
  const authGeneration = useRef(0);
  const authChannel = useRef<BroadcastChannel | null>(null);
  const refreshSequence = useRef(0);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const conversationElement = useRef<HTMLElement>(null);
  const followConversation = useRef(true);
  const conversationThread = useRef("");
  useLayoutEffect(() => {
    if (conversationThread.current !== selectedId)
      followConversation.current = true;
    conversationThread.current = selectedId;
    const element = conversationElement.current;
    if (element && followConversation.current)
      element.scrollTop = element.scrollHeight;
  }, [selectedId, conversation]);
  const client = useMemo(
    () =>
      sessionActive && typeof window !== "undefined"
        ? new FactoryClient({ baseUrl: window.location.origin })
        : null,
    // A cookie account switch must also discard the client's pinned session ID.
    [sessionActive, sessionEpoch],
  );
  const stopRequests = () => {
    for (const controller of aborts.current) controller.abort();
    aborts.current.clear();
  };
  const request = async <T,>(
    fn: (signal: AbortSignal) => Promise<T>,
    threadId?: string,
  ) => {
    const controller = new AbortController();
    aborts.current.add(controller);
    if (threadId) {
      const scoped =
        inputAborts.current.get(threadId) ?? new Set<AbortController>();
      scoped.add(controller);
      inputAborts.current.set(threadId, scoped);
    }
    try {
      return await fn(controller.signal);
    } finally {
      aborts.current.delete(controller);
      if (threadId) {
        const scoped = inputAborts.current.get(threadId);
        scoped?.delete(controller);
        if (!scoped?.size) inputAborts.current.delete(threadId);
      }
    }
  };
  const updateConversation = (threadId: string, messages: Message[]) => {
    setConversations((current) => ({ ...current, [threadId]: messages }));
  };
  const updateRuns = (
    threadId: string,
    update: Receipt[] | ((current: Receipt[]) => Receipt[]),
  ) => {
    setThreadRuns((current) => ({
      ...current,
      [threadId]:
        typeof update === "function"
          ? update(ownValue(current, threadId) ?? [])
          : update,
    }));
  };
  useEffect(
    () => () => {
      for (const controller of inputAborts.current.get(selectedId) ?? [])
        controller.abort();
    },
    [selectedId],
  );
  const clearPrivate = useCallback(() => {
    authGeneration.current += 1;
    projectDialogVersion.current += 1;
    threadDialogVersion.current += 1;
    stopRequests();
    setIdentity(null);
    setProjects([]);
    setThreads([]);
    setNodes([]);
    setWorkspaces([]);
    void navigate({ search: {}, replace: true });
    setThreadBatchFull(false);
    setWorkId("");
    setMetadataUnavailableId("");
    setConversations({});
    setThreadRuns({});
    setReceiptsByThread({});
    setPendingInputs({});
    setDraftsByThread({});
    setBusy(false);
    setShowCreateProject(false);
    setShowCreateThread(false);
    setDetailsOpen(false);
    setProjectName("");
    setThreadTitle("");
    setTargetNode("");
    setTargetWorkspace("");
    setFilter("");
    setSessionActive(false);
    setSessionEpoch((epoch) => epoch + 1);
    setConnected(false);
    setError("");
  }, [navigate]);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("uzina-auth");
    authChannel.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (
        !event.data ||
        typeof event.data !== "object" ||
        !("credentialId" in event.data)
      )
        return;
      const id = event.data.credentialId;
      if (id !== null && typeof id !== "string") return;
      if (id === identityRef.current?.credentialId) return;
      clearPrivate();
      if (id !== null) setSessionActive(true);
    };
    return () => {
      authChannel.current = null;
      channel.close();
    };
  }, [clearPrivate]);
  useEffect(() => {
    if (identity?.credentialId)
      authChannel.current?.postMessage({ credentialId: identity.credentialId });
  }, [identity?.credentialId]);
  function openProjectDialog() {
    projectDialogVersion.current += 1;
    setShowCreateProject(true);
  }
  function closeProjectDialog() {
    projectDialogVersion.current += 1;
    setShowCreateProject(false);
  }
  function openThreadDialog() {
    threadDialogVersion.current += 1;
    setTargetNode("");
    setTargetWorkspace("");
    setShowCreateThread(true);
  }
  function closeThreadDialog() {
    threadDialogVersion.current += 1;
    setShowCreateThread(false);
  }
  const disconnect = useCallback((reason: string) => {
    authGeneration.current += 1;
    refreshSequence.current += 1;
    projectDialogVersion.current += 1;
    threadDialogVersion.current += 1;
    stopRequests();
    connectedRef.current = false;
    setConnected(false);
    setBusy(false);
    setConversations({});
    setThreadRuns({});
    setReceiptsByThread({});
    setDraftsByThread({});
    setMetadataUnavailableId("");
    // Unknown admission is not cancellation. Keep the original IDs and bytes
    // quarantined in memory; the disconnected render exposes none of them.
    setShowCreateProject(false);
    setShowCreateThread(false);
    setDetailsOpen(false);
    setProjectName("");
    setThreadTitle("");
    setTargetNode("");
    setTargetWorkspace("");
    setFilter("");
    setWorkId("");
    setError(reason);
  }, []);
  const forgetThread = useCallback(
    (threadId: string) => {
      const remove = <T,>(current: Record<string, T>) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      };
      setSelectedId((current) => (current === threadId ? "" : current));
      setMetadataUnavailableId((current) =>
        current === threadId ? "" : current,
      );
      setConversations(remove);
      setThreadRuns(remove);
      setDraftsByThread(remove);
      setPendingInputs(remove);
      setReceiptsByThread(remove);
    },
    [setSelectedId],
  );
  const refresh = useCallback(
    async (api: FactoryClient, wantedProject = selectedProjectRef.current) => {
      const generation = authGeneration.current;
      const sequence = ++refreshSequence.current;
      try {
        const me = await request((signal) => api.me({ signal }));
        if (
          generation !== authGeneration.current ||
          sequence !== refreshSequence.current
        )
          return;
        if (me.actor.kind !== "human") {
          throw new Error(
            "This screen accepts human Factory credentials only.",
          );
        }
        const projectResult = await request((signal) =>
          api.listProjects({ signal }),
        );
        if (
          generation !== authGeneration.current ||
          sequence !== refreshSequence.current
        )
          return;
        const projectId =
          wantedProject || projectResult.projects[0]?.projectId || "";
        const isOwner = me.participant?.role === "owner";
        const [threadResult, nodeResult, workspaceResult] = await Promise.all([
          projectId
            ? request((signal) => api.listThreads({ projectId, signal }))
            : Promise.resolve({ threads: [] as Thread[] }),
          isOwner
            ? request((signal) => api.listNodes({ signal }))
            : Promise.resolve({ nodes: [] as Node[] }),
          isOwner
            ? request((signal) => api.listWorkspaces({ signal }))
            : Promise.resolve({ workspaces: [] as Workspace[] }),
        ]);
        if (
          generation !== authGeneration.current ||
          sequence !== refreshSequence.current
        )
          return;
        const batch = [...threadResult.threads];
        const known = threadsRef.current.find(
          (thread) =>
            thread.threadId === selectedIdRef.current &&
            thread.projectId === projectId,
        );
        let deniedId: string | undefined;
        let unavailableId = "";
        const requestedId = selectedIdRef.current;
        if (
          requestedId &&
          !batch.some((thread) => thread.threadId === requestedId)
        ) {
          try {
            let current = known;
            try {
              const status = await request((signal) =>
                api.getStatus(requestedId, { signal }),
              );
              current = factoryThreadSchema.parse(status.thread);
              if (
                current.threadId !== requestedId ||
                current.projectId !== projectId
              )
                throw new Error("Work item binding changed.");
            } catch (error) {
              if (!statusUnavailable(error)) throw error;
              // A runtime failure is not an authorization result. Known metadata
              // remains usable only after a fresh authorized history read.
              await request((signal) => api.listRuns(requestedId, { signal }));
              unavailableId = requestedId;
            }
            if (current) batch.push(current);
          } catch (error) {
            if (
              error instanceof FactoryClientError &&
              [403, 404].includes(error.status)
            )
              deniedId = requestedId;
            else throw error;
          }
        }
        if (
          generation !== authGeneration.current ||
          sequence !== refreshSequence.current ||
          wantedProject !== selectedProjectRef.current
        )
          return;
        // A bounded list is not evidence of revocation. Forget recovery data only
        // after a specific authoritative denial, never because a page omitted it.
        if (deniedId) forgetThread(deniedId);
        setThreadBatchFull(threadResult.threads.length === 100);
        setMetadataUnavailableId(unavailableId);
        setIdentity(me);
        setProjects(projectResult.projects);
        setThreads(batch);
        setNodes(nodeResult.nodes);
        setWorkspaces(workspaceResult.workspaces);
        setConnected(true);
        selectedProjectRef.current = projectId;
        if (projectId !== wantedProject) setSelectedProject(projectId, true);
      } catch (error) {
        if (
          generation !== authGeneration.current ||
          sequence !== refreshSequence.current ||
          wantedProject !== selectedProjectRef.current
        )
          return;
        throw error;
      }
    },
    [forgetThread, setSelectedProject],
  );
  useEffect(() => {
    if (!client) return;
    let active = true;
    let inFlight = false;
    let initial = true;
    const load = async () => {
      if (
        !active ||
        inFlight ||
        document.visibilityState !== "visible" ||
        (!initial && !connectedRef.current)
      )
        return;
      inFlight = true;
      try {
        await refresh(client, selectedProject);
        if (active && initial) setError("");
      } catch (e: unknown) {
        if (active) {
          if (
            !identityRef.current ||
            (e instanceof FactoryClientError && [401, 403].includes(e.status))
          ) {
            clearPrivate();
            setError(message(e));
          } else disconnect(message(e));
        }
      } finally {
        if (active && initial) setBusy(false);
        initial = false;
        inFlight = false;
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 8000);
    const onVisibility = () => void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      stopRequests();
    };
  }, [client, selectedProject, refresh, clearPrivate, disconnect]);
  const selected =
    threads.find((thread) => thread.threadId === selectedId) ?? null;
  useEffect(() => {
    if (!client || !selected || !connected) {
      if (!client || !connected) {
        setConversations({});
        setThreadRuns({});
      }
      return;
    }
    const controller = new AbortController();
    const generation = authGeneration.current;
    aborts.current.add(controller);
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const [contextResult, runResult] = await Promise.allSettled([
          client.getContext(selected.threadId, { signal: controller.signal }),
          client.listRuns(selected.threadId, { signal: controller.signal }),
        ]);
        if (!active || generation !== authGeneration.current) return;
        const unavailable = [contextResult, runResult].find(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof FactoryClientError &&
            result.reason.status === 0,
        );
        if (unavailable?.status === "rejected") {
          disconnect(message(unavailable.reason));
          return;
        }
        if (contextResult.status === "fulfilled") {
          updateConversation(
            selected.threadId,
            visibleMessages(contextResult.value.runtime),
          );
        } else if (
          !(
            contextResult.reason instanceof Error &&
            contextResult.reason.name === "AbortError"
          )
        ) {
          updateConversation(selected.threadId, []);
          if (
            contextResult.reason instanceof FactoryClientError &&
            contextResult.reason.status === 0
          )
            setConnected(false);
          setError(message(contextResult.reason));
        }
        if (runResult.status === "fulfilled") {
          updateRuns(selected.threadId, runResult.value.runs);
          const currentReceipt = ownValue(receiptsByThread, selected.threadId);
          if (currentReceipt) {
            const updated = runResult.value.runs.find(
              (run) => run.requestId === currentReceipt.requestId,
            );
            if (
              updated &&
              updated.dispatchStatus !== currentReceipt.dispatchStatus
            )
              setReceiptsByThread((current) => ({
                ...current,
                [selected.threadId]: updated,
              }));
          }
        } else if (
          !(
            runResult.reason instanceof Error &&
            runResult.reason.name === "AbortError"
          )
        ) {
          if (
            runResult.reason instanceof FactoryClientError &&
            runResult.reason.status === 0
          )
            setConnected(false);
          setError(
            `Command history is unavailable. ${message(runResult.reason)}`,
          );
        }
        const denied = [contextResult, runResult].some(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof FactoryClientError &&
            [401, 403].includes(result.reason.status),
        );
        if (denied) {
          updateConversation(selected.threadId, []);
          updateRuns(selected.threadId, []);
          const denial = [contextResult, runResult].find(
            (result) =>
              result.status === "rejected" &&
              result.reason instanceof FactoryClientError &&
              [401, 403].includes(result.reason.status),
          );
          if (denial?.status === "rejected")
            handleAccessFailure(denial.reason, selected.threadId);
        } else if (
          contextResult.status === "fulfilled" &&
          runResult.status === "fulfilled"
        ) {
          setError("");
        }
      } finally {
        inFlight = false;
      }
    };
    void load();
    const interval = window.setInterval(() => {
      if (connected) void load();
    }, 8000);
    return () => {
      active = false;
      window.clearInterval(interval);
      controller.abort();
      aborts.current.delete(controller);
    };
  }, [
    client,
    selected?.threadId,
    clearPrivate,
    refresh,
    connected,
    receiptsByThread,
    disconnect,
  ]);
  function handleAccessFailure(error: unknown, threadId?: string): boolean {
    if (
      !(error instanceof FactoryClientError) ||
      (error.status !== 401 && error.status !== 403)
    )
      return false;
    if (error.status === 401) {
      clearPrivate();
      setError(message(error));
      return true;
    }
    if (threadId) forgetThread(threadId);
    const generation = authGeneration.current;
    if (client)
      void refresh(client).catch((refreshError: unknown) => {
        if (generation === authGeneration.current)
          setError(message(refreshError));
      });
    return true;
  }
  const shownThreads = threads.filter(
    (thread) =>
      thread.projectId === selectedProject &&
      `${thread.title} ${thread.threadId}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  async function retryConnection() {
    if (!client || busy) return;
    const generation = authGeneration.current;
    setBusy(true);
    try {
      await refresh(client);
      if (generation === authGeneration.current) setError("");
    } catch (error) {
      if (generation === authGeneration.current) {
        if (
          error instanceof FactoryClientError &&
          [401, 403].includes(error.status)
        ) {
          clearPrivate();
          setError(message(error));
        } else disconnect(message(error));
      }
    } finally {
      if (generation === authGeneration.current) setBusy(false);
    }
  }
  async function openWork(event: React.FormEvent) {
    event.preventDefault();
    if (!client || busy || !connected || !workId.trim()) return;
    const generation = authGeneration.current;
    const projectId = selectedProject;
    const selection = selectedId;
    const id = workId.trim();
    setBusy(true);
    try {
      const status = await request((signal) =>
        client.getStatus(id, { signal }),
      );
      const current = factoryThreadSchema.parse(status.thread);
      if (current.threadId !== id)
        throw new Error("Work item binding changed.");
      if (
        generation !== authGeneration.current ||
        projectId !== selectedProjectRef.current ||
        selection !== selectedIdRef.current
      )
        return;
      selectedProjectRef.current = current.projectId;
      void navigate({ search: { project: current.projectId, work: id } });
      setThreads((rows) => [
        ...rows.filter(
          (row) => row.projectId === current.projectId && row.threadId !== id,
        ),
        current,
      ]);
      setWorkId("");
      setError("");
    } catch (error) {
      if (
        generation !== authGeneration.current ||
        handleAccessFailure(error, id)
      )
        return;
      if (
        projectId !== selectedProjectRef.current ||
        selection !== selectedIdRef.current
      )
        return;
      setError(
        statusUnavailable(error)
          ? "This Factory cannot supply Work item details by ID while runtime status is unavailable. Select a shown Work item to read its command history."
          : message(error),
      );
    } finally {
      if (generation === authGeneration.current) setBusy(false);
    }
  }
  function connect() {
    setBusy(true);
    setError("");
    setSessionActive(true);
  }
  async function signOut() {
    setBusy(true);
    try {
      const response = await fetch("/v1/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error(
          "Sign-out failed. Retry while the Factory is available.",
        );
      authChannel.current?.postMessage({ credentialId: null });
      clearPrivate();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (!client || !projectName.trim() || busy) return;
    const generation = authGeneration.current;
    const dialogVersion = projectDialogVersion.current;
    const name = projectName.trim();
    setBusy(true);
    try {
      const created = await request((signal) =>
        client.createProject(name, undefined, { signal }),
      );
      if (generation !== authGeneration.current) return;
      await refresh(client);
      if (generation !== authGeneration.current) return;
      if (
        selectedProjectRef.current === selectedProject &&
        projectDialogVersion.current === dialogVersion &&
        projectDialogRef.current &&
        projectNameRef.current.trim() === name
      )
        setSelectedProject(created.projectId);
      if (
        projectDialogVersion.current === dialogVersion &&
        projectDialogRef.current &&
        projectNameRef.current.trim() === name
      ) {
        closeProjectDialog();
        setProjectName("");
      }
    } catch (e) {
      if (generation === authGeneration.current && handleAccessFailure(e))
        return;
      if (
        generation === authGeneration.current &&
        projectDialogVersion.current === dialogVersion
      )
        setError(message(e));
    } finally {
      if (generation === authGeneration.current) setBusy(false);
    }
  }
  async function createThread(event: React.FormEvent) {
    event.preventDefault();
    if (
      !client ||
      !selectedProject ||
      !targetNode ||
      !targetWorkspace ||
      !threadTitle.trim() ||
      busy
    )
      return;
    const generation = authGeneration.current;
    const dialogVersion = threadDialogVersion.current;
    const projectId = selectedProject;
    const title = threadTitle.trim();
    setBusy(true);
    try {
      const created = await request((signal) =>
        client.createThread(
          {
            projectId,
            title,
            target: { nodeId: targetNode, workspaceId: targetWorkspace },
          },
          { signal },
        ),
      );
      if (generation !== authGeneration.current) return;
      await refresh(client);
      if (generation !== authGeneration.current) return;
      if (
        selectedProjectRef.current === projectId &&
        threadDialogVersion.current === dialogVersion
      ) {
        setThreads((rows) => [
          ...rows.filter((row) => row.threadId !== created.threadId),
          created,
        ]);
        setSelectedId(created.threadId);
      }
      if (
        threadDialogVersion.current === dialogVersion &&
        threadDialogRef.current &&
        selectedProjectRef.current === projectId &&
        threadTitleRef.current.trim() === title
      ) {
        closeThreadDialog();
        setThreadTitle("");
      }
    } catch (e) {
      if (generation === authGeneration.current && handleAccessFailure(e))
        return;
      if (
        generation === authGeneration.current &&
        threadDialogVersion.current === dialogVersion
      )
        setError(message(e));
    } finally {
      if (generation === authGeneration.current) setBusy(false);
    }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (
      !client ||
      !selected ||
      !draft.trim() ||
      pendingInput ||
      !connected ||
      busy ||
      identity?.participant?.role === "viewer"
    )
      return;
    const threadId = selected.threadId;
    const generation = authGeneration.current;
    const text = draft;
    const requestId = `input-${crypto.randomUUID()}`;
    const pending = { threadId, requestId, text };
    setPendingInputs((current) => ({ ...current, [threadId]: pending }));
    setReceiptsByThread((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setBusy(true);
    setError("");
    try {
      const accepted = await request(
        (signal) => client.submitInput(threadId, requestId, text, { signal }),
        threadId,
      );
      if (generation !== authGeneration.current) return;
      setPendingInputs((current) => {
        const next = { ...current };
        if (next[threadId]?.requestId === requestId) delete next[threadId];
        return next;
      });
      setReceiptsByThread((current) => ({ ...current, [threadId]: accepted }));
      updateRuns(threadId, (current) => [
        accepted,
        ...current.filter((r) => r.requestId !== accepted.requestId),
      ]);
      setDraftsByThread((current) => {
        const next = { ...current };
        if (ownValue(next, threadId) === text) delete next[threadId];
        return next;
      });
    } catch (e) {
      if (
        generation === authGeneration.current &&
        handleAccessFailure(e, threadId)
      )
        return;
      if (
        generation === authGeneration.current &&
        selectedIdRef.current === threadId
      ) {
        setError(
          `${message(e)} The same request and text are held in this tab only. Check its receipt before retrying.`,
        );
        setReceiptsByThread((current) => {
          const next = { ...current };
          delete next[threadId];
          return next;
        });
      }
    } finally {
      if (generation === authGeneration.current) setBusy(false);
    }
  }
  async function reconcile() {
    if (
      !client ||
      (!receipt && !pendingInput) ||
      !selected ||
      selected.threadId !== (pendingInput?.threadId ?? selected.threadId) ||
      busy
    )
      return;
    const generation = authGeneration.current;
    const threadId = pendingInput?.threadId ?? selected.threadId;
    const requestId = receipt?.requestId ?? pendingInput!.requestId;
    const pending = pendingInput;
    setBusy(true);
    try {
      const found = await request(
        (signal) => client.getReceipt(requestId, { signal }),
        threadId,
      );
      if (
        generation !== authGeneration.current ||
        selectedIdRef.current !== threadId
      )
        return;
      if (found.threadId !== threadId)
        throw new Error(
          "Receipt belongs to a different Work item; no retry was made.",
        );
      setReceiptsByThread((current) => ({ ...current, [threadId]: found }));
      if (pending) {
        setPendingInputs((current) => {
          const next = { ...current };
          if (next[threadId]?.requestId === requestId) delete next[threadId];
          return next;
        });
        setDraftsByThread((current) => {
          const next = { ...current };
          if (ownValue(next, threadId) === pending.text) delete next[threadId];
          return next;
        });
      }
      updateRuns(threadId, (current) => [
        found,
        ...current.filter((r) => r.requestId !== found.requestId),
      ]);
    } catch (lookupError) {
      if (
        generation === authGeneration.current &&
        handleAccessFailure(lookupError, threadId)
      )
        return;
      if (
        generation !== authGeneration.current ||
        selectedIdRef.current !== threadId
      )
        return;
      if (
        !(lookupError instanceof FactoryClientError) ||
        lookupError.status !== 404 ||
        !pending ||
        pending.threadId !== threadId
      ) {
        setError(
          `Receipt status is still unknown. ${message(lookupError)} No request was sent to another Work item.`,
        );
        return;
      }
      try {
        if (identity?.participant?.role === "viewer") {
          setError("Your current access is read-only. No input was retried.");
          return;
        }
        const retried = await request(
          (signal) =>
            client.submitInput(
              pending.threadId,
              pending.requestId,
              pending.text,
              { signal },
            ),
          threadId,
        );
        if (
          generation !== authGeneration.current ||
          selectedIdRef.current !== threadId
        )
          return;
        setPendingInputs((current) => {
          const next = { ...current };
          if (next[threadId]?.requestId === requestId) delete next[threadId];
          return next;
        });
        setReceiptsByThread((current) => ({ ...current, [threadId]: retried }));
        setDraftsByThread((current) => {
          const next = { ...current };
          if (ownValue(next, threadId) === pending.text) delete next[threadId];
          return next;
        });
        updateRuns(threadId, (current) => [
          retried,
          ...current.filter((r) => r.requestId !== retried.requestId),
        ]);
      } catch (retryError) {
        if (
          generation === authGeneration.current &&
          handleAccessFailure(retryError, threadId)
        )
          return;
        if (
          generation === authGeneration.current &&
          selectedIdRef.current === threadId
        )
          setError(
            `Receipt status is still unknown. ${message(retryError)} The same request ID and text remain available.`,
          );
      }
    } finally {
      if (generation === authGeneration.current) setBusy(false);
    }
  }
  const canCreate = identity?.participant?.role === "owner";
  const canSteer =
    identity?.participant?.role === "owner" ||
    identity?.participant?.role === "guest";
  if (!identity)
    return (
      <main className="connect-page">
        <section className="connect-panel">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              U
            </span>
            <span>
              UZINA <small>FACTORY</small>
            </span>
          </div>
          <h1>Sign in to your Factory</h1>
          <p>
            Open the owner sign-in link printed by your local Factory, or ask
            its Owner for an invitation.
          </p>
          <p className="help">
            No Factory secret or model key to paste. Your sign-in stays in a
            private HttpOnly cookie, not browser storage.
          </p>
          <Button className="primary" onClick={connect} disabled={busy}>
            {busy ? "Connecting…" : "Check sign-in"}
          </Button>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
        </section>
      </main>
    );
  const header = (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          U
        </span>
        <span>
          UZINA <small>FACTORY</small>
        </span>
      </div>
      <div className="top-right">
        <span
          className={`connection ${connected ? "online" : "offline"}`}
          aria-label={connected ? "Connected" : "Unavailable"}
        >
          <i aria-hidden="true" />{" "}
          <span className="connection-label">
            {connected ? "Connected" : "Unavailable"}
          </span>
        </span>
        <span className="role">
          {identity.participant?.role ?? identity.actor.kind}
        </span>
        {client && identity.participant?.role === "owner" ? (
          <FactoryChat
            key={`${identity.credentialId}:${sessionEpoch}`}
            client={client}
            connected={connected}
            onAccessDenied={clearPrivate}
          />
        ) : null}
        {connected &&
        client &&
        selectedProject &&
        identity.participant?.role === "owner" ? (
          <CoordinationInbox
            key={`${identity.credentialId}:${selectedProject}`}
            client={client}
            projectId={selectedProject}
            projectName={
              projects.find((project) => project.projectId === selectedProject)
                ?.name ?? selectedProject
            }
            onAccessDenied={clearPrivate}
          />
        ) : null}
        {identity.participant?.role === "owner" && (
          <a href="/sharing">Sharing</a>
        )}
        <Button className="quiet" onClick={signOut} disabled={busy}>
          Sign out
        </Button>
      </div>
    </header>
  );
  if (!connected)
    return (
      <div className="app-shell">
        {header}
        <main className="disconnected">
          <h1>Factory unavailable</h1>
          <p role="alert">
            {error || "Check that the Factory is running, then retry."}
          </p>
          <p>
            Private work is hidden. Unsent drafts and forms were cleared.
            Uncertain input stays in this tab with its original Work item,
            request ID, and text. Retry to check current access before recovery.
          </p>
          <Button className="primary" onClick={retryConnection} disabled={busy}>
            {busy ? "Connecting…" : "Retry connection"}
          </Button>
        </main>
      </div>
    );
  return (
    <div className="app-shell">
      {header}
      {error && (
        <div className="alert banner" role="alert">
          {error}
        </div>
      )}
      <div className="layout">
        <aside className="sidebar" aria-label="Work navigation">
          <Field>
            <div className="section-head">
              <FieldLabel>PROJECT</FieldLabel>
              {canCreate && (
                <DialogTrigger
                  controller={projectDialog}
                  className="icon-button"
                  aria-label="Create project"
                >
                  <Icon name="plus" />
                </DialogTrigger>
              )}
            </div>
            {projects.length ? (
              <Select<string>
                value={selectedProject || null}
                onValueChange={(value) => setSelectedProject(value ?? "")}
                placeholder="Choose a project"
                items={[
                  ...(selectedProject &&
                  !projects.some((p) => p.projectId === selectedProject)
                    ? [{ value: selectedProject, label: selectedProject }]
                    : []),
                  ...projects.map((p) => ({
                    value: p.projectId,
                    label: p.name,
                  })),
                ]}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedProject &&
                    !projects.some((p) => p.projectId === selectedProject) && (
                      <SelectItem value={selectedProject}>
                        {selectedProject}
                        <SelectItemIndicator />
                      </SelectItem>
                    )}
                  {projects.map((p) => (
                    <SelectItem key={p.projectId} value={p.projectId}>
                      {p.name}
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="empty small">No accessible projects.</p>
            )}
          </Field>
          <div className="section-head work-head">
            <h2>Work items</h2>
            {canCreate && selectedProject && (
              <DialogTrigger
                controller={threadDialog}
                className="icon-button"
                aria-label="Create Work item"
              >
                <Icon name="plus" />
              </DialogTrigger>
            )}
          </div>
          {projects.length === 100 && (
            <p className="list-limit">
              First 100 projects shown. Open a Work item by ID if its project is
              not listed.
            </p>
          )}
          <Collapsible className="open-work">
            <CollapsibleTrigger>Open Work item by ID</CollapsibleTrigger>
            <CollapsiblePanel>
              <form onSubmit={openWork}>
                <Field>
                  <FieldLabel>Work item ID</FieldLabel>
                  <Input
                    value={workId}
                    onValueChange={setWorkId}
                    required
                    maxLength={128}
                  />
                </Field>
                <Button type="submit" className="primary" disabled={busy}>
                  Open Work item
                </Button>
              </form>
            </CollapsiblePanel>
          </Collapsible>
          {threadBatchFull && (
            <p className="list-limit">
              First 100 Work items in this project shown, oldest first. More may
              exist. Open a Work item by ID; search covers only the shown list.
            </p>
          )}
          <Field>
            <FieldLabel className="sr-only">Search Work items</FieldLabel>
            <Input
              className="search"
              placeholder="Search Work items"
              value={filter}
              onValueChange={setFilter}
            />
          </Field>
          <nav className="thread-list" aria-label="Work items">
            {shownThreads.map((thread) => (
              <Button
                className={`thread-item ${selectedId === thread.threadId ? "active" : ""}`}
                key={thread.threadId}
                aria-current={
                  selectedId === thread.threadId ? "page" : undefined
                }
                onClick={() => {
                  setError("");
                  setSelectedId(thread.threadId);
                }}
              >
                <span className="thread-title">{thread.title}</span>{" "}
                <span className="thread-meta">{thread.threadId}</span>
              </Button>
            ))}
            {!shownThreads.length && (
              <p className="empty">
                {threads.length
                  ? "No Work items match this search."
                  : "No Work items in this project yet."}
              </p>
            )}
          </nav>
          <div className="sidebar-foot">
            <Avatar className="avatar" aria-hidden="true">
              <AvatarFallback>
                {(identity.participant?.displayName ?? identity.actor.kind)
                  .slice(0, 1)
                  .toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="user-name">
              {identity.participant?.displayName ?? identity.actor.kind}
            </span>
          </div>
        </aside>
        <Collapsible
          render={<main />}
          className="work-area"
          aria-label="Work details"
          disabled={!selected}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
        >
          {selected ? (
            <>
              <div className="work-heading">
                <Button
                  className="mobile-back"
                  onClick={() => setSelectedId("")}
                >
                  <Icon name="back" /> Work items
                </Button>
                <div>
                  <p className="breadcrumb">
                    {projects.find((p) => p.projectId === selected.projectId)
                      ?.name ?? "Project"}
                  </p>
                  <h1>{selected.title}</h1>
                </div>
                <CollapsibleTrigger className="details-toggle">
                  Work details
                </CollapsibleTrigger>
              </div>
              {metadataUnavailableId === selected.threadId && (
                <p className="list-limit" role="status">
                  Runtime status is unavailable. Showing last-known Work item
                  details; command history has current access checks.
                </p>
              )}
              <div className="target-strip">
                <span className="target-label">EXECUTION TARGET</span>
                <strong>
                  {nodes.find((n) => n.nodeId === selected.target.nodeId)
                    ?.name ?? selected.target.nodeId}
                </strong>
                <span className="slash">/</span>
                <strong>
                  {workspaces.find(
                    (w) => w.workspaceId === selected.target.workspaceId,
                  )?.name ?? selected.target.workspaceId}
                </strong>
                <span
                  className={`availability ${nodes.find((n) => n.nodeId === selected.target.nodeId)?.availability ?? "unavailable"}`}
                >
                  {nodes.find((n) => n.nodeId === selected.target.nodeId)
                    ?.availability ?? "Status unavailable to this role"}
                </span>
              </div>
              <section
                ref={conversationElement}
                className="conversation"
                tabIndex={0}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  followConversation.current =
                    element.scrollHeight -
                      element.scrollTop -
                      element.clientHeight <
                    48;
                }}
                aria-label="Conversation"
                aria-live="polite"
              >
                {conversation.length ? (
                  conversation.map((entry) => (
                    <article
                      className={`message ${entry.role}`}
                      key={entry.key}
                    >
                      <div className="message-label">
                        {entry.role === "user" ? "Human" : "Assistant"}
                      </div>
                      <div className="message-text">{entry.text}</div>
                    </article>
                  ))
                ) : (
                  <div className="conversation-empty">
                    <div className="empty-icon" aria-hidden="true">
                      <Icon name="chat" />
                    </div>
                    <h2>Conversation will appear here</h2>
                    <p>
                      {canSteer
                        ? "Send input to this Work item. Accepted input does not mean execution is complete."
                        : "No visible conversation is available for this Work item yet."}
                    </p>
                  </div>
                )}
                {(receipt || pendingInput) && (
                  <article className="receipt">
                    <strong>
                      {receipt ? "Input accepted" : "Acknowledgement unknown"}
                    </strong>
                    <span>
                      {receipt
                        ? `Command status: ${receipt.dispatchStatus}. This receipt records admission; assistant text appears separately in the conversation.`
                        : "Check the existing request receipt. If no receipt exists, the same request ID and text will be retried."}
                    </span>
                    <Button
                      className="quiet"
                      onClick={reconcile}
                      disabled={busy}
                      data-agent-confirm={
                        pendingInput
                          ? "May retry the original input on this Work item if no receipt exists"
                          : undefined
                      }
                    >
                      {receipt ? "Check receipt" : "Reconcile request"}
                    </Button>
                  </article>
                )}
              </section>
              {canSteer ? (
                <form className="composer" onSubmit={send}>
                  <Field>
                    <FieldLabel className="sr-only">Message</FieldLabel>
                    <Textarea
                      value={draft}
                      onValueChange={setDraft}
                      readOnly={Boolean(pendingInput)}
                      aria-describedby={
                        pendingInput ? "pending-input-note" : undefined
                      }
                      placeholder="Add direction to this Work item…"
                      rows={3}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                  </Field>
                  <div className="composer-footer">
                    <span>
                      {pendingInput ? (
                        <span id="pending-input-note">
                          Input locked until its original receipt is reconciled.
                        </span>
                      ) : (
                        "Enter to send · Shift + Enter for a new line"
                      )}
                    </span>
                    <Button
                      type="submit"
                      className="primary"
                      data-agent-confirm="Sends this input to the selected Work item for execution"
                      disabled={
                        busy ||
                        !connected ||
                        Boolean(pendingInput) ||
                        !draft.trim()
                      }
                    >
                      {busy ? "Sending…" : "Send input"}
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="read-only-note">
                  Your Viewer access is read-only. Ask the Owner for Guest
                  access to send input.
                </p>
              )}
              <CollapsiblePanel
                render={<aside />}
                className="details"
                aria-label="Work item details"
              >
                <div className="details-title">
                  <h2>Execution &amp; history</h2>
                  <Button
                    className="icon-button close-details"
                    aria-label="Close work details"
                    onClick={() => setDetailsOpen(false)}
                  >
                    <Icon name="close" />
                  </Button>
                </div>
                <dl>
                  <dt>Work item</dt>
                  <dd>{selected.threadId}</dd>
                  <dt>Node</dt>
                  <dd>{selected.target.nodeId}</dd>
                  <dt>Workspace</dt>
                  <dd>{selected.target.workspaceId}</dd>
                  <dt>Command history</dt>
                  <dd>
                    {runs.length
                      ? `${runs.length} command${runs.length === 1 ? "" : "s"}`
                      : "No commands yet"}
                  </dd>
                </dl>
                {runs.length >= 100 && (
                  <p className="list-limit">
                    First 100 commands shown, oldest first. Newer commands may
                    be absent. This API has no history pagination; use Check
                    receipt for this tab’s last accepted input.
                  </p>
                )}
                {runs.map((run) => (
                  <div className="run" key={run.requestId}>
                    <b>{run.dispatchStatus}</b>
                    <span>
                      {run.acceptedAt
                        ? new Date(run.acceptedAt).toLocaleString()
                        : ""}
                    </span>
                    <code>{run.requestId}</code>
                  </div>
                ))}
                <p className="muted">
                  History shows command acceptance and status only. It does not
                  infer completion from an acknowledgement.
                </p>
              </CollapsiblePanel>
            </>
          ) : (
            <section className="welcome">
              <div className="welcome-top">
                <p className="breadcrumb">
                  {projects.find((p) => p.projectId === selectedProject)
                    ?.name ?? "Factory"}
                </p>
                <h1>Work items</h1>
                <p>
                  Select a Work item to read its conversation and execution
                  history.
                </p>
              </div>
              {threads.length === 0 && (
                <div className="empty-state">
                  <h2>Nothing here yet</h2>
                  <p>
                    Create a project and Work item to begin. Work items require
                    an explicit existing node and Workspace.
                  </p>
                  {canCreate && (
                    <DialogTrigger
                      controller={
                        projects.length ? threadDialog : projectDialog
                      }
                      className="primary"
                    >
                      {projects.length ? "Create Work item" : "Create project"}
                    </DialogTrigger>
                  )}
                </div>
              )}
            </section>
          )}
        </Collapsible>
        {canCreate && (
          <>
            <Dialog
              controller={projectDialog}
              open={showCreateProject}
              onOpenChange={(open) =>
                open ? openProjectDialog() : closeProjectDialog()
              }
            >
              <DialogBackdrop className="modal-backdrop" />
              <DialogContent
                className="dialog"
                initialFocus="#project-name"
                keepMounted
              >
                <DialogClose className="dialog-close" aria-label="Close">
                  <Icon name="close" />
                </DialogClose>
                <DialogTitle id="project-title">Create project</DialogTitle>
                <form onSubmit={createProject}>
                  <Field>
                    <FieldLabel>Project name</FieldLabel>
                    <Input
                      id="project-name"
                      value={projectName}
                      onValueChange={setProjectName}
                      required
                      maxLength={160}
                    />
                  </Field>
                  <div className="dialog-actions">
                    <DialogClose className="quiet">Cancel</DialogClose>
                    <Button type="submit" className="primary" disabled={busy}>
                      Create project
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
            <Dialog
              controller={threadDialog}
              open={showCreateThread}
              onOpenChange={(open) =>
                open ? openThreadDialog() : closeThreadDialog()
              }
            >
              <DialogBackdrop className="modal-backdrop" />
              <DialogContent
                className="dialog"
                initialFocus="#work-title"
                keepMounted
              >
                <DialogClose className="dialog-close" aria-label="Close">
                  <Icon name="close" />
                </DialogClose>
                <DialogTitle id="thread-title">Create Work item</DialogTitle>
                <DialogDescription className="muted">
                  Choose a registered node and its existing Workspace. No target
                  is selected automatically.
                </DialogDescription>
                <form onSubmit={createThread}>
                  <Field>
                    <FieldLabel>Work item name</FieldLabel>
                    <Input
                      id="work-title"
                      value={threadTitle}
                      onValueChange={setThreadTitle}
                      required
                      maxLength={160}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Execution node</FieldLabel>
                    <Select<string>
                      value={targetNode || null}
                      onValueChange={(value) => {
                        setTargetNode(value ?? "");
                        setTargetWorkspace("");
                      }}
                      items={nodes.map((node) => ({
                        value: node.nodeId,
                        label: `${node.name} · ${node.availability}`,
                      }))}
                      placeholder="Choose a node"
                      required
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {nodes.map((node) => (
                          <SelectItem key={node.nodeId} value={node.nodeId}>
                            {node.name} · {node.availability}
                            <SelectItemIndicator />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel>Workspace</FieldLabel>
                    <Select<string>
                      value={targetWorkspace || null}
                      onValueChange={(value) => setTargetWorkspace(value ?? "")}
                      items={workspaces
                        .filter((w) => w.nodeId === targetNode)
                        .map((w) => ({ value: w.workspaceId, label: w.name }))}
                      placeholder="Choose a Workspace"
                      required
                      disabled={!targetNode}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {workspaces
                          .filter((w) => w.nodeId === targetNode)
                          .map((w) => (
                            <SelectItem
                              key={w.workspaceId}
                              value={w.workspaceId}
                            >
                              {w.name}
                              <SelectItemIndicator />
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {!nodes.length && (
                    <p className="empty">
                      No execution nodes are registered. An Owner must configure
                      a node and Workspace first.
                    </p>
                  )}
                  <div className="dialog-actions">
                    <DialogClose className="quiet">Cancel</DialogClose>
                    <Button
                      type="submit"
                      className="primary"
                      disabled={
                        busy ||
                        !nodes.length ||
                        !workspaces.some((w) => w.nodeId === targetNode)
                      }
                    >
                      Create Work item
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>
    </div>
  );
}
