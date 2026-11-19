import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/react/dialog";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Textarea } from "@ui-sdk/react/textarea";
import {
  FactoryClient,
  FactoryClientError,
  type PrivateAssistantReceipt,
  type PrivateAssistantStatus,
} from "@uzina/client";
import { visibleMessages, type ContextMessage } from "./context-messages";
import "./factory-chat.css";

type PendingInput = { inputId: string; text: string };
type Snapshot = { status: PrivateAssistantStatus; messages: ContextMessage[] };
const parkedReasons = {
  configuration_missing: "The coordinator is not configured on this host.",
  credential_unavailable:
    "Coordinator credentials are unavailable or revoked. Check the host configuration.",
  identity_mismatch:
    "The configured coordinator identity does not match its saved conversation. Check the host configuration; do not replace the saved identity.",
  identity_persistence_unavailable:
    "The coordinator could not verify its saved identity. Check the host's private storage.",
};
function describe(error: unknown) {
  if (error instanceof FactoryClientError)
    return error.status === 401 || error.status === 403
      ? "Owner access changed. Sign in again."
      : `Factory chat is unavailable (${error.code}). Refresh or reconcile the original input before retrying.`;
  return "Factory chat is unavailable. Refresh or reconcile the original input before retrying.";
}
function receiptLabel(receipt: PrivateAssistantReceipt) {
  const submission = receipt.submission;
  const status =
    submission && typeof submission === "object" && "status" in submission
      ? submission.status
      : undefined;
  switch (status) {
    case "queued":
      return "Input queued";
    case "placed":
      return "Reply in progress";
    case "done":
      return "Reply complete";
    case "unanswered":
      return "Input unanswered";
    default:
      return "Input accepted";
  }
}

export function FactoryChat({
  client,
  connected,
  onAccessDenied,
}: {
  client: FactoryClient;
  connected: boolean;
  onAccessDenied(): void;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingInput | null>(null);
  const [receipt, setReceipt] = useState<PrivateAssistantReceipt | null>(null);
  const [readError, setReadError] = useState("");
  const [sendError, setSendError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const currentInputId = useRef<string | null>(null);
  const history = useRef<HTMLElement>(null);
  const follow = useRef(true);
  const receiptId = receipt?.inputId;
  const available = snapshot?.status.available === true;
  function changeOpen(value: boolean) {
    if (value && !connected) return;
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    follow.current = true;
    setSnapshot(null);
    setReadError("");
    setOpen(value);
  }
  useEffect(() => {
    if (!connected) {
      operation.current?.abort();
      operation.current = null;
      setOpen(false);
      setSnapshot(null);
      setDraft("");
      setBusy(false);
    }
  }, [connected]);
  useEffect(
    () => () => {
      operation.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!open || !connected) return;
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (
        controller.signal.aborted ||
        inFlight ||
        document.visibilityState !== "visible"
      )
        return;
      inFlight = true;
      try {
        const options = { signal: controller.signal };
        const [status, context, updated] = await Promise.all([
          client.getPrivateAssistantStatus(options),
          client.getPrivateAssistantContext(options),
          receiptId
            ? client.getPrivateAssistantReceipt(receiptId, options)
            : null,
        ]);
        if (controller.signal.aborted) return;
        setSnapshot({ status, messages: visibleMessages(context) });
        if (updated && updated.inputId === currentInputId.current)
          setReceipt(updated);
        setReadError("");
      } catch (error) {
        if (controller.signal.aborted) return;
        setSnapshot(null);
        setReadError(describe(error));
        if (
          error instanceof FactoryClientError &&
          [401, 403].includes(error.status)
        )
          onAccessDenied();
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [client, open, connected, refresh, receiptId, onAccessDenied]);
  useLayoutEffect(() => {
    if (open && follow.current && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [snapshot, open]);

  async function submit(reconcile: boolean) {
    if (
      !connected ||
      !open ||
      operation.current ||
      (!reconcile && (!available || pending))
    )
      return;
    const input = reconcile
      ? pending
      : { inputId: `factory-chat:${crypto.randomUUID()}`, text: draft };
    if (!input || !input.text.trim()) return;
    if (input.text.length > 100_000) {
      setSendError("Shorten your message to 100,000 characters or fewer.");
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setSendError("");
    currentInputId.current = input.inputId;
    setPending(input);
    const options = { signal: controller.signal };
    try {
      let accepted: PrivateAssistantReceipt;
      if (reconcile) {
        try {
          accepted = await client.getPrivateAssistantReceipt(
            input.inputId,
            options,
          );
        } catch (error) {
          if (!(error instanceof FactoryClientError) || error.status !== 404)
            throw error;
          if (controller.signal.aborted) return;
          const status = await client.getPrivateAssistantStatus(options);
          if (!status.available) throw new Error("coordinator_parked");
          accepted = await client.submitPrivateAssistantInput(
            input.inputId,
            input.text,
            options,
          );
        }
      } else {
        setReceipt(null);
        accepted = await client.submitPrivateAssistantInput(
          input.inputId,
          input.text,
          options,
        );
      }
      if (controller.signal.aborted) return;
      if (accepted.inputId !== input.inputId)
        throw new Error("receipt_binding_conflict");
      setReceipt(accepted);
      setPending(null);
      setDraft("");
      setRefresh((value) => value + 1);
      follow.current = true;
    } catch (error) {
      if (controller.signal.aborted) return;
      setSendError(describe(error));
      if (
        error instanceof FactoryClientError &&
        [401, 403].includes(error.status)
      )
        onAccessDenied();
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
      }
    }
  }
  function send(event: FormEvent) {
    event.preventDefault();
    void submit(false);
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        className="quiet factory-chat-trigger"
        aria-label="Factory chat"
        disabled={!connected}
      >
        <span className="factory-chat-trigger-full">Factory chat</span>
        <span className="factory-chat-trigger-short">Chat</span>
      </DialogTrigger>
      <DialogBackdrop className="modal-backdrop" />
      <DialogContent className="factory-chat" initialFocus="content">
        <div className="factory-chat-header">
          <div>
            <DialogTitle>Factory chat</DialogTitle>
            <DialogDescription>
              Owner-only coordinator for goals, workers, and reviews. Native
              conversations stay in Rex.
            </DialogDescription>
          </div>
          <DialogClose className="quiet">Close chat</DialogClose>
        </div>
        <div className="factory-chat-state" role="status">
          {readError ||
            (snapshot
              ? available
                ? "Coordinator ready · Uses your configured model"
                : `Coordinator parked. ${snapshot.status.reason ? parkedReasons[snapshot.status.reason] : "Check the host configuration."} Saved messages remain readable.`
              : "Loading Factory chat…")}
          <Button
            className="quiet"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh chat
          </Button>
        </div>
        <section
          ref={history}
          className="factory-chat-conversation"
          tabIndex={0}
          aria-label="Factory conversation"
          aria-live="polite"
          onScroll={(event) => {
            const element = event.currentTarget;
            follow.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              48;
          }}
        >
          {snapshot?.messages.length ? (
            snapshot.messages.map((entry) => (
              <article className={`message ${entry.role}`} key={entry.key}>
                <div className="message-label">
                  {entry.role === "user" ? "Input" : "Factory"}
                </div>
                <div className="message-text">{entry.text}</div>
              </article>
            ))
          ) : snapshot ? (
            <div className="factory-chat-empty">
              <h3>What should the Factory work on?</h3>
              <p>
                Plan a goal, inspect your projects, or ask for a connected Pi
                worker. This conversation is private to the Owner and is not a
                Work item.
              </p>
            </div>
          ) : null}
        </section>
        <div className="factory-chat-compose">
          {pending || receipt ? (
            <div className="receipt" aria-live="polite">
              <strong>
                {pending
                  ? busy
                    ? "Awaiting receipt"
                    : "Acknowledgement unknown"
                  : receiptLabel(receipt!)}
              </strong>
              <span>
                {pending
                  ? "The original input ID and text stay in this tab only. Reconcile before reloading or sending anything else; closing this chat does not cancel admitted work."
                  : "This is a coordinator reply receipt, not proof that a worker finished or that a goal was accepted."}
              </span>
              <code>{pending?.inputId ?? receipt?.inputId}</code>
              {pending ? (
                <Button
                  className="quiet"
                  disabled={busy}
                  data-agent-confirm="Checks the original Factory input receipt and may retry the same input if it was not admitted"
                  onClick={() => submit(true)}
                >
                  Reconcile Factory input
                </Button>
              ) : null}
            </div>
          ) : null}
          {sendError ? (
            <p className="alert" role="alert">
              {sendError}
            </p>
          ) : null}
          <form className="composer" onSubmit={send}>
            <Field>
              <FieldLabel className="sr-only">Message to Factory</FieldLabel>
              <Textarea
                value={pending?.text ?? draft}
                onValueChange={setDraft}
                required
                maxLength={100_000}
                readOnly={pending !== null}
                disabled={!available || busy}
                rows={3}
                submitShortcut="enter"
                placeholder="Ask the Factory to plan or coordinate work…"
              />
            </Field>
            <div className="composer-footer">
              <span>Enter to send · Shift + Enter for a new line</span>
              <Button
                type="submit"
                className="primary"
                disabled={
                  busy || !available || pending !== null || !draft.trim()
                }
                data-agent-confirm="Sends this message to the private Factory coordinator; it may use model tokens and perform authorized Factory operations"
              >
                Send to Factory
              </Button>
            </div>
          </form>
          <p className="factory-chat-note">
            Current context may omit older, compacted messages. Closing chat
            does not stop work.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
