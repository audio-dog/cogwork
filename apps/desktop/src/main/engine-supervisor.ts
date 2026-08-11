import type { EngineStatus } from "../shared/ipc";
import type { EngineCommand } from "./engine-command";
import { waitForDaemonListening } from "./wait-for-socket";

export interface EngineChild {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
}

export type SpawnEngine = (command: EngineCommand) => EngineChild;

export interface EngineLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface EngineSupervisorOptions {
  readonly command: EngineCommand;
  readonly socketPath: string;
  readonly spawn: SpawnEngine;
  readonly probe: (socketPath: string) => Promise<boolean>;
  readonly onStatus: (status: EngineStatus) => void;
  readonly logger: EngineLogger;
  readonly maxRestarts?: number;
  readonly awaitReachable?: (socketPath: string, signal: AbortSignal) => Promise<boolean>;
}

export class EngineSupervisor {
  #status: EngineStatus = "stopped";
  #child: EngineChild | null = null;
  #owned = false;
  #shuttingDown = false;
  #restarts = 0;
  #readyController: AbortController | null = null;
  readonly #maxRestarts: number;
  readonly #awaitReachable: (socketPath: string, signal: AbortSignal) => Promise<boolean>;

  constructor(private readonly options: EngineSupervisorOptions) {
    this.#maxRestarts = options.maxRestarts ?? 3;
    this.#awaitReachable = options.awaitReachable ?? waitForDaemonListening;
  }

  get status(): EngineStatus {
    return this.#status;
  }

  async start(): Promise<void> {
    if (this.#child !== null || this.#status === "adopted") return;
    this.#shuttingDown = false;
    this.#restarts = 0;

    if (await this.options.probe(this.options.socketPath)) {
      this.options.logger.info("Adopted an engine already listening on the socket");
      this.#owned = false;
      this.#setStatus("adopted");
      return;
    }

    this.#spawnChild();
  }

  async stop(): Promise<void> {
    this.#shuttingDown = true;
    this.#readyController?.abort();
    const child = this.#child;

    if (!this.#owned || child === null) {
      this.#setStatus("stopped");
      return;
    }

    this.options.logger.info("Stopping the supervised engine");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }

  #spawnChild(): void {
    this.#setStatus("starting");
    const child = this.options.spawn(this.options.command);
    this.#child = child;
    this.#owned = true;
    const controller = new AbortController();
    this.#readyController = controller;
    this.#pipe(child);
    child.once("exit", (code, signal) => this.#handleExit(code, signal));
    this.options.logger.info(`Engine started (pid ${child.pid ?? "?"})`);
    void this.#promoteWhenReachable(child, controller.signal);
  }

  async #promoteWhenReachable(child: EngineChild, signal: AbortSignal): Promise<void> {
    const reachable = await this.#awaitReachable(this.options.socketPath, signal);
    if (!reachable || this.#child !== child || this.#shuttingDown) return;
    this.options.logger.info("Engine is listening on the socket");
    this.#setStatus("running");
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#readyController?.abort();
    this.#child = null;

    if (this.#shuttingDown) {
      this.#setStatus("stopped");
      return;
    }

    this.options.logger.warn(`Engine exited unexpectedly (code ${code}, signal ${signal})`);

    if (this.#restarts >= this.#maxRestarts) {
      this.options.logger.warn(`Giving up after ${this.#restarts} restarts`);
      this.#setStatus("failed");
      return;
    }

    this.#restarts += 1;
    this.options.logger.info(`Restarting engine (attempt ${this.#restarts})`);
    this.#spawnChild();
  }

  #pipe(child: EngineChild): void {
    child.stdout?.on("data", (chunk: Buffer) => this.options.logger.info(chunk.toString().trimEnd()));
    child.stderr?.on("data", (chunk: Buffer) => this.options.logger.warn(chunk.toString().trimEnd()));
  }

  #setStatus(status: EngineStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.options.onStatus(status);
  }
}
