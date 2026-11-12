import { EmptyState } from "../components/ui.js";

/** Stand-in until the real workspace for this entry is built (agentic-commerce tasks 11.3 to 11.6). */
export function AgenticPlaceholder({ name }: { name: string }) {
  return <EmptyState title={`${name} is coming soon`}>This workspace is not built yet.</EmptyState>;
}
