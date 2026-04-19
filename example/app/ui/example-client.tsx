"use client";

import { useMemo, useState } from "react";
import { ConvexProvider, ConvexReactClient, useAction } from "convex/react";

import { api } from "../../convex/_generated/api";

type Props = {
  convexUrl: string;
};

type FormState = {
  fromAddress: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

const initialForm: FormState = {
  fromAddress: "noreply@example.com",
  fromName: "Cloudflare Email Example",
  to: "",
  subject: "Convex Cloudflare Email smoke test",
  text: "This email was sent from the local Next.js example app.",
  html: "<p>This email was sent from the local Next.js example app.</p>",
};

export default function ExampleClient({ convexUrl }: Props) {
  const client = useMemo(() => {
    return convexUrl ? new ConvexReactClient(convexUrl) : null;
  }, [convexUrl]);

  if (!convexUrl) {
    return (
      <main className="page">
        <section className="hero">
          <p className="eyebrow">Next.js Example</p>
          <h1>Convex Cloudflare Email Sending</h1>
          <p className="lede">
            Missing a Convex URL. Run <code>pnpm dev</code> from the repository
            root so <code>convex dev</code> can provision the example and write
            the local env file.
          </p>
        </section>
      </main>
    );
  }

  return (
    <ConvexProvider client={client!}>
      <ExampleScreen />
    </ConvexProvider>
  );
}

function ExampleScreen() {
  const sendExample = useAction(api.smoke.sendExample);
  const getStatusExample = useAction(api.smoke.getStatusExample);
  const cancelExample = useAction(api.smoke.cancelExample);

  const [form, setForm] = useState<FormState>(initialForm);
  const [emailId, setEmailId] = useState<string | null>(null);
  const [statusJson, setStatusJson] = useState<string>("No email queued yet.");
  const [busy, setBusy] = useState<"send" | "status" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSend = useMemo(() => {
    return (
      form.fromAddress.trim().length > 0 &&
      form.to.trim().length > 0 &&
      form.subject.trim().length > 0 &&
      form.text.trim().length > 0
    );
  }, [form]);

  async function handleSend() {
    setBusy("send");
    setError(null);
    try {
      const result = await sendExample({
        fromAddress: form.fromAddress.trim(),
        fromName: form.fromName.trim() || undefined,
        to: form.to.trim(),
        subject: form.subject.trim(),
        text: form.text,
        html: form.html.trim() || undefined,
      });
      setEmailId(result.id);
      setStatusJson(
        JSON.stringify(
          {
            queued: true,
            emailId: result.id,
            note: "The send request was accepted by the component. Fetch status to see processing progress.",
          },
          null,
          2,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleFetchStatus() {
    if (!emailId) return;
    setBusy("status");
    setError(null);
    try {
      const result = await getStatusExample({ id: emailId });
      setStatusJson(JSON.stringify(result, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Status lookup failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCancel() {
    if (!emailId) return;
    setBusy("cancel");
    setError(null);
    try {
      const result = await cancelExample({ id: emailId });
      setStatusJson(
        JSON.stringify(
          {
            emailId,
            cancelledState: result,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed.");
    } finally {
      setBusy(null);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Next.js Example</p>
        <h1>Convex Cloudflare Email Sending</h1>
        <p className="lede">
          This example runs the component locally with Convex and gives you a
          small React UI to enqueue an email, poll its status, and cancel it
          before dispatch.
        </p>
      </section>

      <section className="layout">
        <form
          className="panel formPanel"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSend();
          }}
        >
          <div className="panelHeader">
            <h2>Send Test Email</h2>
            <p>
              <code>pnpm dev</code> starts both <code>convex dev</code> and the
              Next.js app. You only need real Cloudflare credentials if you want
              the background send to succeed.
            </p>
          </div>

          <label>
            <span>From address</span>
            <input
              value={form.fromAddress}
              onChange={(event) => update("fromAddress", event.target.value)}
              placeholder="noreply@yourdomain.com"
            />
          </label>

          <label>
            <span>From name</span>
            <input
              value={form.fromName}
              onChange={(event) => update("fromName", event.target.value)}
              placeholder="Acme Notifications"
            />
          </label>

          <label>
            <span>Recipient</span>
            <input
              value={form.to}
              onChange={(event) => update("to", event.target.value)}
              placeholder="you@example.com"
            />
          </label>

          <label>
            <span>Subject</span>
            <input
              value={form.subject}
              onChange={(event) => update("subject", event.target.value)}
              placeholder="Welcome"
            />
          </label>

          <label>
            <span>Plain text body</span>
            <textarea
              rows={5}
              value={form.text}
              onChange={(event) => update("text", event.target.value)}
            />
          </label>

          <label>
            <span>HTML body</span>
            <textarea
              rows={5}
              value={form.html}
              onChange={(event) => update("html", event.target.value)}
            />
          </label>

          <div className="actions">
            <button disabled={!canSend || busy !== null} type="submit">
              {busy === "send" ? "Queueing..." : "Queue email"}
            </button>
            <button
              disabled={!emailId || busy !== null}
              type="button"
              onClick={() => void handleFetchStatus()}
            >
              {busy === "status" ? "Refreshing..." : "Fetch status"}
            </button>
            <button
              className="ghost"
              disabled={!emailId || busy !== null}
              type="button"
              onClick={() => void handleCancel()}
            >
              {busy === "cancel" ? "Cancelling..." : "Cancel"}
            </button>
          </div>

          {error ? <p className="error">{error}</p> : null}
        </form>

        <section className="panel statusPanel">
          <div className="panelHeader">
            <h2>Current Status</h2>
            <p>
              Use the generated component email id to inspect the current local
              processing state.
            </p>
          </div>

          <dl className="meta">
            <div>
              <dt>Latest email id</dt>
              <dd>{emailId ?? "None yet"}</dd>
            </div>
            <div>
              <dt>Cloudflare credentials</dt>
              <dd>Optional for app startup, required for successful delivery</dd>
            </div>
          </dl>

          <pre>{statusJson}</pre>
        </section>
      </section>
    </main>
  );
}
