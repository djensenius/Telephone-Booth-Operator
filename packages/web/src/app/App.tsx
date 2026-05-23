import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { BoothStatusProvider } from "../components/booth/index.js";
import { createAppRouter } from "./router.js";
import type { AppRouter } from "./router.js";

export interface AppProps {
  readonly router?: AppRouter;
}

export function App({ router }: AppProps = {}): JSX.Element {
  const [appRouter] = useState(() => router ?? createAppRouter());
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <BoothStatusProvider>
        <RouterProvider router={appRouter} />
      </BoothStatusProvider>
    </QueryClientProvider>
  );
}
