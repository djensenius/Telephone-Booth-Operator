import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { GlassPanel } from "../../components/booth/index.js";
import { useMessage, useQuestionsList } from "../../lib/api-client.js";
import { FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

const listenedKey = (id: string): string => `booth.message.listened.${id}`;

function readListened(id: string): boolean {
  try {
    return window.localStorage.getItem(listenedKey(id)) === "true";
  } catch {
    return false;
  }
}

function writeListened(id: string, value: boolean): void {
  try {
    window.localStorage.setItem(listenedKey(id), String(value));
  } catch {
    // local preference only
  }
}

export function MessageDetail(): JSX.Element {
  const { id } = useParams({ from: "/messages/$id" });
  const message = useMessage(id);
  const questions = useQuestionsList();
  const [listened, setListened] = useState(() => readListened(id));
  const prompt = questions.data?.items.find((question) => question.id === message.data?.questionId)?.prompt;

  function toggle(value: boolean): void {
    setListened(value);
    writeListened(id, value);
  }

  return (
    <GlassPanel title="Message detail" className="feature-screen messages-screen">
      <p className="screen-kicker">Message detail</p>
      <h1>Message playback</h1>
      {message.isLoading ? <FeatureSkeleton /> : null}
      {message.error ? <FeatureError message="Could not fetch this message." /> : null}
      {message.data === undefined ? null : (
        <section className="feature-card feature-card--wide">
          <h2>{prompt ?? "Unlinked booth recording"}</h2>
          <audio controls src={message.data.audio.url}>Message audio</audio>
          <dl className="debug-kv-grid debug-kv-grid--compact">
            <div><dt>Status</dt><dd>{message.data.status}</dd></div>
            <div><dt>Received</dt><dd>{message.data.receivedAt ?? "Not received"}</dd></div>
            <div><dt>Created</dt><dd>{message.data.createdAt}</dd></div>
            <div><dt>SHA-256</dt><dd>{message.data.audio.sha256}</dd></div>
            <div><dt>Notes</dt><dd>{message.data.notes ?? "None"}</dd></div>
          </dl>
          <label className="feature-check">
            <input type="checkbox" checked={listened} onChange={(event) => toggle(event.currentTarget.checked)} />
            Mark as listened
          </label>
          <div className="debug-button-row">
            <a href={message.data.audio.url} download>Download audio</a>
            <Link to="/messages">Back to messages</Link>
          </div>
        </section>
      )}
    </GlassPanel>
  );
}
