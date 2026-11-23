import { useQuery } from "@tanstack/react-query";
import { api, RequestError } from "./api.ts";

export const meKey = ["me"] as const;

/** null = signed out. Errors other than 401 still surface. */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof RequestError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}
