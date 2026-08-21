import { ActivityTranscript } from "./activity-transcript";
import { ActivityViewProvider } from "./activity-view";

export function ActivityTab() {
  return (
    <ActivityViewProvider>
      <ActivityTranscript />
    </ActivityViewProvider>
  );
}
