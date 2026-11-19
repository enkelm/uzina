import { useEffect, useRef, useState, type FormEvent } from "react";
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
import { FactoryClient, FactoryClientError } from "@uzina/client";
import type { CoordinationItem } from "@uzina/contracts/coordination";

const statusLabels = {
  bot_pending: "With Factory bot",
  needs_user: "Needs your decision",
  answered: "Answer queued",
  acknowledged: "Received by worker",
};
function describe(error: unknown): string {
  if (error instanceof FactoryClientError) {
    if (error.status === 401 || error.status === 403)
      return "Access changed. Close this inbox and sign in again.";
    return `The Factory could not complete this request (${error.code}). Retry to reconcile the same decision.`;
  }
  return "The inbox is unavailable. Retry to reconnect.";
}

export function CoordinationInbox({
  client,
  projectId,
  projectName,
  onAccessDenied,
}: {
  client: FactoryClient;
  projectId: string;
  projectName: string;
  onAccessDenied(): void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CoordinationItem[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [offsets, setOffsets] = useState([0]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [needsYou, setNeedsYou] = useState(0);
  const offset = offsets[offsets.length - 1]!;
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (
        inFlight ||
        controller.signal.aborted ||
        document.visibilityState !== "visible"
      )
        return;
      inFlight = true;
      try {
        const response = await client.listCoordinationItems(projectId, {
          signal: controller.signal,
          offset,
        });
        if (!controller.signal.aborted) {
          setItems(response.items);
          setNextOffset(response.nextOffset);
          setNeedsYou(response.needsUserCount);
          setLoaded(true);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setItems([]);
          setLoaded(false);
          setError(describe(error));
          if (
            error instanceof FactoryClientError &&
            [401, 403].includes(error.status)
          )
            onAccessDenied();
        }
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [client, projectId, refresh, offset, onAccessDenied]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className="quiet factory-inbox-trigger"
        aria-label="Factory inbox"
        aria-description={
          needsYou > 0
            ? `${needsYou} items need your decision`
            : "Questions and reports from native workers"
        }
      >
        <span className="inbox-trigger-full">
          Factory inbox{needsYou > 0 ? ` · ${needsYou} need you` : ""}
        </span>
        <span className="inbox-trigger-short">
          Inbox{needsYou > 0 ? ` · ${needsYou}` : ""}
        </span>
      </DialogTrigger>
      <DialogBackdrop className="modal-backdrop" />
      <DialogContent className="coordination-inbox" initialFocus="content">
        <div className="inbox-header">
          <div>
            <DialogTitle>Factory inbox</DialogTitle>
            <DialogDescription>
              {projectName} · Decisions and reports from native workers. Open
              Rex to interact with their sessions.
            </DialogDescription>
          </div>
          <DialogClose className="quiet">Close inbox</DialogClose>
        </div>
        <div className="inbox-items" aria-live="polite">
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}
          {!loaded && !error ? <p>Loading coordination items…</p> : null}
          {loaded && items.length === 0 ? (
            <p>
              No questions or reports yet. Native workers can contact the
              Factory bot through their coordination tools.
            </p>
          ) : null}
          {items.map((item) => (
            <InboxItem
              key={item.itemId}
              client={client}
              item={item}
              onChanged={() => setRefresh((value) => value + 1)}
              onAccessDenied={onAccessDenied}
            />
          ))}
        </div>
        <div className="inbox-footer">
          <span>
            Answers remain queued until the worker acknowledges receipt. Receipt
            does not mean execution.
          </span>
          <div className="inbox-pages">
            {offsets.length > 1 ? (
              <Button
                className="quiet"
                onClick={() => {
                  setItems([]);
                  setLoaded(false);
                  setOffsets((pages) => pages.slice(0, -1));
                }}
                disabled={!loaded}
              >
                Previous items
              </Button>
            ) : null}
            {nextOffset !== null ? (
              <Button
                className="quiet"
                onClick={() => {
                  setItems([]);
                  setLoaded(false);
                  setOffsets((pages) => [...pages, nextOffset]);
                }}
                disabled={!loaded}
              >
                Next items
              </Button>
            ) : null}
            <Button
              className="quiet"
              onClick={() => {
                setOffsets([0]);
                setRefresh((value) => value + 1);
              }}
            >
              Refresh inbox
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InboxItem({
  client,
  item,
  onChanged,
  onAccessDenied,
}: {
  client: FactoryClient;
  item: CoordinationItem;
  onChanged(): void;
  onAccessDenied(): void;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<{
    requestId: string;
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const canAnswer =
    !sent && (item.status === "needs_user" || item.status === "bot_pending");
  async function answer(event: FormEvent) {
    event.preventDefault();
    if (busy || !canAnswer || !(pending?.text ?? draft).trim()) return;
    const input = pending ?? {
      requestId: `decision:${crypto.randomUUID()}`,
      text: draft.trim(),
    };
    setPending(input);
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      await client.decideCoordinationItem(
        item.itemId,
        { ...input, action: "answer" },
        { signal: abort.signal },
      );
      if (!abort.signal.aborted) {
        setPending(null);
        setDraft("");
        setSent(true);
        onChanged();
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        setError(describe(error));
        if (
          error instanceof FactoryClientError &&
          [400, 403, 409].includes(error.status)
        ) {
          setPending(null);
          onChanged();
        }
        if (
          error instanceof FactoryClientError &&
          [401, 403].includes(error.status)
        )
          onAccessDenied();
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return (
    <article className="inbox-item" aria-labelledby={`inbox-${item.itemId}`}>
      <div className="inbox-item-heading">
        <h3 id={`inbox-${item.itemId}`}>{item.title}</h3>
        <span
          className="inbox-status"
          data-state={sent ? "answered" : item.status}
        >
          {
            statusLabels[
              sent && item.status !== "acknowledged" ? "answered" : item.status
            ]
          }
        </span>
      </div>
      <p className="inbox-origin">
        {item.workerId} · {item.kind}
        {item.blocking ? " · Worker reports blocked" : ""}
      </p>
      <p className="inbox-copy">{item.text}</p>
      {item.escalation ? (
        <p className="inbox-copy">
          <strong>Factory bot:</strong> {item.escalation}
        </p>
      ) : null}
      {item.answer ? (
        <p className="inbox-copy">
          <strong>Answer:</strong> {item.answer.text}
        </p>
      ) : null}
      {canAnswer ? (
        <form onSubmit={answer}>
          <Field>
            <FieldLabel>Your decision for {item.title}</FieldLabel>
            <Textarea
              required
              rows={3}
              maxLength={8_000}
              value={pending?.text ?? draft}
              onValueChange={setDraft}
              readOnly={pending !== null}
              disabled={busy}
            />
          </Field>
          <Button
            type="submit"
            className="primary"
            disabled={busy || !(pending?.text ?? draft).trim()}
            data-agent-confirm={`Sends your decision about ${item.title} to the native worker`}
          >
            {busy
              ? "Sending decision…"
              : pending
                ? "Retry decision"
                : "Send decision"}
          </Button>
        </form>
      ) : null}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
