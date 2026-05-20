import { useQuery } from "@tanstack/react-query";

/**
 * Returns the configured agent name, falling back to "Agent2077".
 * Reads from the server settings store so it stays in sync.
 */
export function useAgentName(): string {
  const { data } = useQuery<Record<string, string>>({
    queryKey: ["/api/settings"],
    staleTime: 30_000,
  });
  return data?.["agent.name"] || "Agent2077";
}

/**
 * Read agent name synchronously from the injected global (for use outside React).
 */
export function getAgentName(): string {
  return (window as any).__AGENT2077_SETTINGS__?.["agent.name"] || "Agent2077";
}
