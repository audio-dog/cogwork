import { HarnessSignIn, HarnessState } from "@cogwork/contracts";

import type { HarnessReadiness } from "./harness";

const diagnostic = (message: string) => message.trim() || "the harness gave no reason";

export const harnessStateOf = (readiness: HarnessReadiness, signIn: string | null): HarnessState => {
  if (readiness.installation.status === "missing") {
    return HarnessState.cases.NotInstalled.make({
      diagnostic: diagnostic(readiness.operational.diagnostic),
    });
  }
  if (readiness.compatibility.status === "incompatible") {
    return HarnessState.cases.UnsupportedVersion.make({
      requirement: readiness.compatibility.requirement,
    });
  }
  if (readiness.authentication.status === "unavailable") {
    return HarnessState.cases.NotSignedIn.make({
      signIn: signIn ? HarnessSignIn.make({ command: signIn }) : null,
    });
  }
  if (readiness.operational.status === "ready") return HarnessState.cases.Ready.make({});
  if (readiness.operational.status === "unknown") {
    return HarnessState.cases.Unknown.make({ diagnostic: diagnostic(readiness.operational.diagnostic) });
  }
  return HarnessState.cases.Unavailable.make({
    diagnostic: diagnostic(readiness.operational.diagnostic),
  });
};
