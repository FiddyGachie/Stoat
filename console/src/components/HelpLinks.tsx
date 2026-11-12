import { BookOpen } from "lucide-react";
import { Icon } from "./ui.js";

/** Role-aware links to the static guides served from /docs. Opens in a new tab so no work is lost. */
export function HelpLinks({ guide = "user" }: { guide?: "user" | "admin" }) {
  const href = guide === "admin" ? "/docs/admin-guide.html" : "/docs/user-guide.html";
  return (
    <a className="btn btn-secondary" href={href} target="_blank" rel="noopener noreferrer">
      <Icon icon={BookOpen} /> {guide === "admin" ? "Admin guide" : "Help"}
    </a>
  );
}
