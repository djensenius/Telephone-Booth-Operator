import { GlassPanel } from "../../components/booth/index.js";

export function QuestionsScreen(): JSX.Element {
  return (
    <GlassPanel title="Question library">
      <p className="screen-kicker">Digit 5</p>
      <h1>Questions</h1>
      <p>Placeholder for prompt recording, FLAC upload, and library management.</p>
    </GlassPanel>
  );
}
