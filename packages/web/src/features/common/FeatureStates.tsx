import type { ReactNode } from "react";
import { LineBusyPlacard } from "../../components/booth/index.js";

export function FeatureSkeleton({
  label = "Connecting the cord…",
}: {
  readonly label?: string;
}): JSX.Element {
  return (
    <div className="feature-skeleton" role="status" aria-live="polite">
      <span className="feature-skeleton__cord" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function FeatureEmpty({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className="feature-empty">
      <strong>{title}</strong>
      {children === undefined ? null : <p>{children}</p>}
    </div>
  );
}

export function FeatureError({ message }: { readonly message: string }): JSX.Element {
  return <LineBusyPlacard inline visible message={message} />;
}
