import type { PropsWithChildren } from "react";

export interface BoothFrameProps extends PropsWithChildren {
  readonly noise?: boolean;
}

export function BoothFrame({ children, noise = true }: BoothFrameProps): JSX.Element {
  return <div className={noise ? "booth-frame booth-frame--noise" : "booth-frame"}>{children}</div>;
}
