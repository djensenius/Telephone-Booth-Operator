import type { PropsWithChildren } from "react";

export interface GlassPanelProps extends PropsWithChildren {
  readonly title?: string;
  readonly className?: string;
}

export function GlassPanel({ children, title, className }: GlassPanelProps): JSX.Element {
  const classes = className === undefined ? "glass-panel" : `glass-panel ${className}`;
  return (
    <section className={classes} aria-label={title}>
      {children}
    </section>
  );
}
