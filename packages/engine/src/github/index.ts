export { layer as adapterLayer, makeAdapter, workflowCatalogContribution } from "./adapter";
export { makeCliCredentialSource } from "./cli-credential";
export {
  GitHubClient,
  type GitHubClientService,
  type GitHubRepoRef,
  layer as clientLayer,
  repoRefFromRepository,
} from "./client";
export {
  layer as performanceIssueFilerLayer,
  makeTarget as makePerformanceIssueFilerTarget,
} from "./performance-issue-filer";
export { layer as providerLayer, makeProvider } from "./provider";
