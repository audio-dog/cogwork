// PROTOTYPE — pieces every Customize variant needs, kept to what is genuinely neutral.
//
// The workspace picker is here because all three variants need the same one and none of them is
// arguing about it. The filter controls are *not* here: those are the thing being compared.

import { Label } from "@cogwork/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@cogwork/ui/components/select";
import type { WorkspaceId } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { useCustomizeViewStore } from "../store/customize-view";

const { workspaces } = placeholderConfiguration;

/** Labels must be declared or base-ui shows the raw value; and the path, not the remote, is what
 *  tells two clones of one repository apart. */
const workspaceItems = Object.fromEntries(
  workspaces.map((workspace) => [workspace.id, `${workspace.name} — ${workspace.checkoutPath}`]),
);

export function WorkspacePicker({ label = "Workspace" }: { label?: string }) {
  const workspaceId = useCustomizeViewStore((state) => state.workspaceId);
  const setWorkspaceId = useCustomizeViewStore((state) => state.setWorkspaceId);
  return (
    <div className="flex items-center gap-2">
      <Label className="shrink-0 text-xs text-muted-foreground">{label}</Label>
      <Select
        items={workspaceItems}
        value={workspaceId}
        onValueChange={(value) => setWorkspaceId(String(value) as WorkspaceId)}
      >
        <SelectTrigger size="sm" className="w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.name} — {workspace.checkoutPath}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function useWorkspaceId(): WorkspaceId {
  return useCustomizeViewStore((state) => state.workspaceId);
}
