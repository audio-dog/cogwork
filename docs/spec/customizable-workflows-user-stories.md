## User Stories

### Authoring

1. As a person, I want to create a Workflow from a template, so that I start from something that works.
2. As a person, I want to see only the templates that fit the Connections I have, so that I am not offered a Linear template with no Linear.
3. As a person, I want to author a Workflow from nothing in the desktop editor, so that I can automate work no template covers.
4. As a person, I want every Trigger, action, and option I can choose to come from one list the engine owns, so that I can never name something the engine cannot do.
5. As a person, I want to choose which Workspaces a Workflow observes and acts in — every one, a listed set, or none — so that a Workflow stays in its lane.
6. As a person, I want to write what each Operation must decide as a question with a closed set of choices, so that the agent's answer is typed and I can route on it.
7. As a person, I want to write what each Operation must produce for an action — an issue title, a review body — as a named input with my own hint, so that the agent writes what the action needs.
8. As a person, I want to say whether an Operation answers once or for each finding, so that one transcript can become many issues.
9. As a person, I want to choose the Harness, model, and model options for each Operation, or leave them empty and inherit my defaults, so that I control what I pay for.
10. As a person, I want to choose whether an Operation may change files, so that a read-only judgement never gets a worktree.
11. As a person, I want to require a concrete MCP server, Skill, or Connection for an Operation, so that a Run never starts without what it needs.
12. As a person, I want to name a first-party Operating-instructions package for an Operation and add my own instruction, so that the coding Operations keep their shipped guidance and I can still tune them.
13. As a person, I want the editor to tell me what is malformed, what blocks publish, and what is only advisory, each at the node it concerns, so that I know what to fix and what I can ignore.
14. As a person, I want an incomplete Workflow to save as I work, so that I never lose an edit because a hand-off is not wired yet.
15. As a person, I want to publish a Workflow as a separate act from editing it, so that nothing I am still changing can run.
16. As a person, I want to switch a Workflow on and off without changing its document, so that stopping it is one click and restarting it needs no re-publish.
17. As a person, I want to delete a Workflow I made from a template, so that a template I tried does not stay with me.
18. As a person, I want an app update to leave my Workflows alone, so that nothing I published changes under me.
19. As a person, I want to see "Operation X will run two times" when a Transition both hands off to X and fires a Trigger that starts X, so that I understand the shape I built.
20. As a person, I want two Workflows to compose through what they create — an issue one makes starts another — so that I build small Workflows, not one large one.

### Observing

21. As a person, I want a Workflow to fire once for each new event and never again for the same one, so that a redelivered event or a daemon restart does not repeat work.
22. As a person, I want a condition Trigger ("Issue has label") to pick up items that already match when I switch the Workflow on, so that my backlog is covered.
23. As a person, I want an occurrence Trigger ("New comment from a person") to skip events that happened while the Workflow was off, so that switching on does not replay a month of history.
24. As a person, I want to see how far back a Trigger reads after the daemon was down, and change it, so that I decide what "missed" means.
25. As a person, I want a Granola Workflow to act on a note when its summary and transcript exist, so that the agent never reads a partial transcript.
26. As a person, I want a Slack Workflow to wait until a conversation goes quiet before it acts, and to act at most so often on one conversation, so that it reads a finished exchange and does not nag.
27. As a person, I want a Slack Workflow to start when I am mentioned, in every channel or in one I choose, so that my own name is the signal.
28. As a person, I want a Slack message that Cogwork posted never to wake Cogwork again, so that a Workflow cannot talk to itself.
29. As a person, I want a scheduled Workflow to fire at a wall-clock time in my zone and to catch up once after downtime, so that a nightly sweep runs nightly.
30. As a person, I want a sweep Workflow that gives each parked or idle item its own Run, so that stale work is judged one item at a time.
31. As a person, I want to see which Workspaces a Trigger observes in and which it skips, with the reason, so that "observes in 3 of 5 Workspaces" is not a surprise.
32. As a person, I want a Connection that is not ready to stop its Trigger source and show me why, with no failed attempt, so that machine state is never counted as agent failure.
33. As a person, I want to connect Granola with the browser login and add an API key when my plan has one, so that the Trigger works on every plan and gets faster when it can.
34. As a person, I want to connect Slack with "Sign in with Slack", so that I create no app and copy no token.

### Running

35. As a person, I want each Run to see the item's prose — the issue and its comments, the transcript, the message and its thread, the pull request's description, review comments, checks, and changed files — frozen once, so that the agent starts with its brief.
36. As a person, I want the next Operation after a hand-off to receive the item again plus the previous Operation's answers and inputs, so that nothing it decided is lost.
37. As a person, I want an Operation that creates or comments on issues to get a read-only issue search Tool over my trackers, so that it can tell new work from a duplicate.
38. As a person, I want an Operation that acts on a named pull request to get a read-only pull request Tool, so that it can read the diff without a checkout.
39. As a person, I want the agent to choose which Workspace a transcript or message is about, from the Workflow's selection, or to say "none recognized", so that Cogwork never files an issue in a repository it does not recognize.
40. As a person, I want a fan-out element whose plan needs a Workspace, and that recognizes none, to park before any write and show me what it planned, so that a wrong guess costs nothing.
41. As a person, I want the agent to be able to say it is stuck on any Operation, so that it halts itself rather than guess.
42. As a person, I want a result the agent returns in the wrong shape to be retried with the exact decode problems shown to it, so that the second attempt can fix the first.
43. As a person, I want a Run that fails to retry while the failure is retryable, and after three in a row to park the item with the reason, so that a failing Run cannot spend my budget without limit.
44. As a person, I want a loop in my own Workflow — follow-up pushes, CI fails, follow-up runs — to stop after a cap of hops and park the item, so that no cycle runs forever.
45. As a person, I want the engine to push the branch and open the pull request, so that no agent writes to a shared system itself.
46. As a person, I want "Open a pull request" to refuse when the head is not ahead of the base, and to tell the agent why on the retry, so that an empty pull request is never opened.
47. As a person, I want every write a Run causes to be a frozen plan recorded before the first write, so that a failed write never runs the agent again and a retry never creates the artifact twice.
48. As a person, I want each artifact Cogwork creates to carry an origin record, so that Cogwork recognizes its own writes even though it writes as my account.
49. As a person, I want every output action to act as me through my Connection, so that Cogwork does my work with my accounts within what I published.
50. As a person, I want no merge and no delete in the catalog today, so that the irreversible acts stay mine.

### Reviewing with Slack → Review

51. As a person, I want a review Operation to post a review as approve, comment, or request changes, with line comments on the new side of the diff, so that a review Cogwork drafts reads like one I wrote.
52. As a person, I want to decide, as author, which review events the agent may post, so that the engine sets what can happen and I set what does.
53. As a person, I want a line comment on a line that is not in the diff to be refused at decode, so that a review never lands on the wrong line.
54. As a person, I want a frozen review plan to be withdrawn when new commits land, so that a review never describes an old head.
55. As a person, I want "Draft a review" to leave a pending review only I can see, so that I can submit it in GitHub as my own.

### Human touchpoints

56. As a person, I want to route any answer to "Notify me" and see the element's summary, the matched answers, and links to what the plan created, so that I am informed without being blocked.
57. As a person, I want to route any answer to "Wait for my approval" and have the whole plan wait, so that I gate what I choose to gate and nothing else.
58. As a person, I want to approve a plan by its digest, edit the agent's text and approve the new digest, reject it with a note, or hand it back with a note, so that each act names exactly what it acts on.
59. As a person, I want a plan that waits for approval to be withdrawn when the item changes at its source, so that I never approve something stale.
60. As a person, I want to route any answer to "Hand to me", so that the item waits for me with no label semantics the engine must know.
61. As a person, I want to choose an answer on a handed-to-me item and supply any input the chosen Transition needs, so that the engine builds and runs the plan as if the agent had answered.
62. As a person, I want a handback to resume the Operation that parked, with my note in its prompt, so that "I fixed the credentials" reaches the agent.
63. As a person, I want a handback after a failed write to run the rest of the plan, not the Operation, so that completed work is not redone.
64. As a person, I want one Attention page with lanes for what needs me, what notified me, and what Cogwork skipped, so that nothing waits where I cannot see it.
65. As a person, I want each parked card to show the Workflow and its published revision, the Operation, the lineage across hand-offs and Workflows, the element summary, and whether the item changed since it parked, so that I can act with context.
66. As a person, I want an OS notification for every park, whose click opens that card, so that I learn Cogwork needs me while I work elsewhere.
67. As a person, I want "Ready to merge" to be a view of Cogwork-opened pull requests that are green, conflict-free, and approved, with no model involved, so that merge stays mine.

### Migrating

68. As a person, I want the coding pipeline to become a template I own, so that I can change how triage decides and what follow-up does.
69. As a person, I want a reporter's answer on a `needs-info` issue to start triage again with no relabel, so that the conversation moves on its own.
70. As a person, I want the cut-over to be one pull request I can revert, so that a bad release costs one revert.

### A future agent

71. As a person, I want to set up a Workflow later by talking to an agent inside Cogwork, so that I never have to learn the editor.
72. As an authoring agent, I want to read the catalog, the templates as examples, and the validator's diagnostics as data, so that I can write and correct a Workflow without a person reading errors to me.
73. As an authoring agent, I want to edit the same working copy the person edits and to see their edits since my last turn, so that we work on one document.
74. As an authoring agent, I want publish and switch-on to be a person's acts, so that nothing I write runs until the person decides.

