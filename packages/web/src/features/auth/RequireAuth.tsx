import type { PropsWithChildren } from "react";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { FeatureSkeleton } from "../common/FeatureStates.js";
import { useCurrentUser } from "./useCurrentUser.js";

export function RequireAuth({ children }: PropsWithChildren): JSX.Element {
  const { isAuthenticated, isLoading } = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const didRedirect = useRef(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !didRedirect.current) {
      didRedirect.current = true;
      void navigate({ to: "/login", search: { return_to: location.href }, replace: true });
    }
  }, [isAuthenticated, isLoading, location.href, navigate]);

  if (isLoading || !isAuthenticated) {
    return <FeatureSkeleton label="Checking the operator line…" />;
  }
  return <>{children}</>;
}
