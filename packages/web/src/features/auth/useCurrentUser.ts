import { ApiError, useAuthMeQuery } from "../../lib/api-client.js";
import type { OperatorMe } from "@telephone-booth-operator/shared";

export interface CurrentUserState {
  readonly user: OperatorMe | null;
  readonly isLoading: boolean;
  readonly isAuthenticated: boolean;
}

export function useCurrentUser(): CurrentUserState {
  const query = useAuthMeQuery();
  const unauthenticated = query.error instanceof ApiError && query.error.status === 401;
  return {
    user: query.data ?? null,
    isLoading: query.isLoading,
    isAuthenticated: query.data !== undefined && !unauthenticated,
  };
}
