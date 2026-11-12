import { Bell } from "lucide-react";
import { EmptyState } from "../components/ui.js";

/** Route target for `#/notifications`. The bell and list are built in task 22.2. */
export function NotificationsWorkspace() {
  return (
    <EmptyState icon={Bell} title="Notifications">
      Wallet and mission notifications will appear here.
    </EmptyState>
  );
}
