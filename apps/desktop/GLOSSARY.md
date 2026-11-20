# Desktop (mission control shell)

The Electron app that is the primary **daemon host** on a laptop (product ADR 0008). It supervises
the engine as a bundled Node child, keeps a single window that hides instead of quitting, and gives
the renderer a typed seam to the daemon without ever handing it the socket. It speaks the shared
kernel ([contracts](../../packages/contracts/GLOSSARY.md)) over the same RPC transport the
[cli](../cli/GLOSSARY.md) uses.

Built with electron-vite + electron-builder. The renderer stack is React + TanStack Router with
Effect AtomRpc (`@effect/atom-react`) for daemon read-model state and zustand for local chrome; UI
primitives come from [ui](../../packages/ui/GLOSSARY.md) (shadcn + Tailwind v4). See product ADR 0009.

## Language

Each file below holds one group of terms. Find a term in this list, then read its file.

- [Shell](./GLOSSARY-shell.md): **Desktop shell**, **Engine supervisor**, **Adopt**, **Close-to-hide**, **Typed IPC seam**, **RPC relay**, **Engine toggle**, **Activity session**
- [Shell surfaces](./GLOSSARY-surfaces.md): **Side panel**, **Surface catalog**, **Tool surface**, **Subject surface**, **Feed**, **Waiting**, **Item tab**, **Queue state**, **Open item**, **Attention tab**, **Needs a decision**, **Ready to merge**, **Activity tab**, **Run transcript**, **Step**, **Provider picker**, **Traits**
- [Settings surfaces](./GLOSSARY-settings.md): **Plugins**, **Customize**, **Connections**, **Workspaces**

## Cross-context edges

- **desktop → cli.** In development the supervisor spawns the CLI `daemon` command as the engine
  child; the CLI remains the one place that composes the engine's host adapters. A packaged build
  ships its own bundled engine entry (signing/distribution is human-paired and not built here).
- **desktop → contracts.** The renderer builds its AtomRpc client from `DaemonRpcs` and decodes the
  contracts read models (`DaemonStatus`, `DaemonEvent`) itself; `main` only relays the wire frames
  (see **RPC relay** in the Shell part). Contracts is bundled into the renderer build so its schemas
  are available without a separate build step.
