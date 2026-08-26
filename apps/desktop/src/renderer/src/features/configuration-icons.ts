import {
  RiFileTextLine,
  RiFolderLine,
  RiGitRepositoryLine,
  RiPulseLine,
  RiRobot2Line,
  RiServerLine,
  RiSparkling2Line,
  RiTerminalBoxLine,
  RiUserLine,
} from "@remixicon/react";
import type { ComponentType } from "react";
import type { ContributionKind, ScopeKind } from "./configuration-model";

export const kindIcons: Record<ContributionKind, ComponentType> = {
  "mcp-server": RiServerLine,
  skill: RiSparkling2Line,
  subagent: RiRobot2Line,
  rules: RiFileTextLine,
  command: RiTerminalBoxLine,
  hook: RiPulseLine,
};

export const scopeIcons: Record<ScopeKind, ComponentType> = {
  "settings-profile": RiUserLine,
  "workspace-input": RiGitRepositoryLine,
  "private-overlay": RiFolderLine,
};
