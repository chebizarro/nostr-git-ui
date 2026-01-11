import { getGitWorker } from "@nostr-git/core";
import type { RepoAnnouncementEvent } from "@nostr-git/core/events";
import {
  createAuthRequiredError,
  createNetworkError,
  createTimeoutError,
  createFsError,
  createUnknownError,
  wrapError,
  FatalError,
} from "@nostr-git/core/errors";

export interface WorkerProgressEvent {
  repoId: string;
  phase: string;
  progress?: number;
  patchId?: string;
  targetBranch?: string;
  message?: string;
}

export interface WorkerProgressCallback {
  (event: WorkerProgressEvent): void;
}

export interface CloneProgress {
  isCloning: boolean;
  phase: string;
  progress?: number;
}

export interface AuthToken {
  host: string;
  token: string;
}

export interface AuthConfig {
  tokens: AuthToken[];
}

/**
 * WorkerManager handles all git worker communication and lifecycle management.
 * This provides a clean interface for git operations while managing the underlying worker.
 */
export class WorkerManager {
  private worker: Worker | null = null;
  private api: any = null;
  private isInitialized = false;
  private progressCallback?: WorkerProgressCallback;
  private authConfig: AuthConfig = { tokens: [] };
  // Throttle repeated initialize() calls and avoid duplicate work
  private initInFlight: Promise<void> | null = null;
  private lastInitAt = 0;
  private static readonly MIN_INIT_INTERVAL_MS = 1500;
  // Deduplicate auth-config updates
  private lastAuthConfigJson = "";
  constructor(progressCallback?: WorkerProgressCallback) {
    this.progressCallback = progressCallback;
    // Clean architecture - worker handles EventIO internally
  }

  /**
   * Initialize the git worker and API
   */
  async initialize() {
    if (this.initInFlight) {
      return this.initInFlight;
    }
    if (this.isInitialized) {
      return;
    }
    this.initInFlight = (async () => {
      const { worker, api } = getGitWorker(this.handleWorkerProgress);
      this.worker = worker;
      this.api = api as any;
      this.isInitialized = true;
      
      try {
        if (this.worker) {
          // Comlink proxies do not enumerate properties reliably; avoid Object.keys checks
        }

        // Set authentication configuration in the worker (dedup)
        const cfgJson = JSON.stringify(this.authConfig || {});
        if (cfgJson !== this.lastAuthConfigJson) {
          if (this.authConfig.tokens.length > 0 && this.api && typeof (this.api as any).setAuthConfig === 'function') {
            await (this.api as any).setAuthConfig(this.authConfig);
          }
          this.lastAuthConfigJson = cfgJson;
        }
      } catch (error) {
        console.error("Failed to initialize git worker:", error);
        throw new Error(
          `Worker initialization failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      this.lastInitAt = Date.now();
    })();

    try {
      await this.initInFlight;
    } finally {
      this.initInFlight = null;
    }
  }

  /**
   * Execute a git operation in the worker
   */
  async execute<T>(operation: string, params: any, options?: { timeoutMs?: number }): Promise<T> {
    const ctxFrom = (p: any): string => {
      if (!p) return "";
      if (typeof p !== "object") return "";
      const parts: string[] = [];
      const repoId = p.repoId || p.repoKey;
      if (repoId) parts.push(`repoId=${String(repoId)}`);
      const remoteUrl = p.remoteUrl;
      if (remoteUrl) parts.push(`remote=${String(remoteUrl)}`);
      const branch = p.branch || p.targetBranch;
      if (branch) parts.push(`branch=${String(branch)}`);
      const path = p.path;
      if (path) parts.push(`path=${String(path)}`);
      const commit = p.commit || p.commitId;
      if (commit) parts.push(`commit=${String(commit)}`);
      return parts.length ? ` (${parts.join(", ")})` : "";
    };

    const withCause = (cause: unknown, err: Error): Error => {
      try {
        // Prefer library helper to preserve cause/stack/metadata if available
        return (wrapError as any)(cause, err) as Error;
      } catch {
        (err as any).cause = cause;
        return err;
      }
    };

    const ctx = ctxFrom(params);

    if (!this.isInitialized || !this.api) {
      const err = createUnknownError();
      err.message = `WorkerManager not initialized. Call initialize() first.${ctx}`;
      throw err;
    }

    try {
      let safeParams = params;
      try {
        safeParams = JSON.parse(JSON.stringify(params));
      } catch {
        /* fall back to original */
      }

      const method = (this.api as any)[operation];

      if (typeof method !== "function") {
        throw new FatalError(`Operation '${operation}' is not supported by current worker.${ctx}`);
      }

      // Check if params are actually serializable
      try {
        JSON.stringify(safeParams, null, 2);
      } catch (serError) {
        const err = createUnknownError();
        err.message = `Cannot serialize params for '${operation}'.${ctx}`;
        throw withCause(serError, err);
      }

      // Add timeout to detect hanging worker calls
      // Allow custom timeout to be specified for long-running background operations
      const timeoutMs =
        options?.timeoutMs ??
        (operation === "analyzePatchMerge" ? 90000 : 30000);

      // If timeout is 0 or negative, don't apply timeout (for truly long-running background ops)
      if (timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          const t = setTimeout(() => {
            const terr = createTimeoutError();
            terr.message = `Worker operation '${operation}' timed out after ${timeoutMs}ms.${ctx}`;
            reject(terr);
          }, timeoutMs);
          // Avoid leaking timers in unusual promise scheduling cases
          void t;
        });

        const resultPromise = method(safeParams);
        const result = await Promise.race([resultPromise, timeoutPromise]);
        try {
          return JSON.parse(JSON.stringify(result)) as T;
        } catch {
          return result as T;
        }
      } else {
        // No timeout - for long-running background operations
        const result = await method(safeParams);
        try {
          return JSON.parse(JSON.stringify(result)) as T;
        } catch {
          return result as T;
        }
      }
    } catch (error) {
      console.error("[WorkerManager] execute error:", error);

      // Pass through typed errors as-is
      if (error instanceof Error) {
        const name = (error as any).name || "";
        if (name === "FatalError" || name === "RetriableError" || name === "UserActionableError") {
          throw error;
        }
      }

      const msg = error instanceof Error ? error.message : String(error);
      const lowered = (msg || "").toLowerCase();

      // Comlink clone errors / worker capability mismatches should be fatal
      if (msg && msg.includes("Proxy object could not be cloned")) {
        const ferr = new FatalError(`Worker returned a non-transferable value for '${operation}'.${ctx}`);
        throw withCause(error, ferr);
      }

      // Auth-ish errors
      if (
        /unauthorized|forbidden|permission denied|auth|token|401|403/.test(lowered)
      ) {
        const aerr = createAuthRequiredError();
        aerr.message = `Authentication required for '${operation}'.${ctx}`;
        throw withCause(error, aerr);
      }

      // Timeout-ish errors
      if (/timed out|timeout/.test(lowered)) {
        const terr = createTimeoutError();
        terr.message = `Worker operation '${operation}' timed out.${ctx}`;
        throw withCause(error, terr);
      }

      // Network-ish errors
      if (
        /failed to fetch|networkerror|fetch failed|econnreset|enotfound|eai_again/.test(lowered)
      ) {
        const nerr = createNetworkError();
        nerr.message = `Network error during '${operation}'.${ctx}`;
        throw withCause(error, nerr);
      }

      // FS-ish errors (isomorphic-git and browser fs backends often emit these)
      if (/enoent|eacces|eperm|enospc|notfounderror/.test(lowered)) {
        const ferr = createFsError();
        ferr.message = `Filesystem error during '${operation}'.${ctx}`;
        throw withCause(error, ferr);
      }

      // Unknown
      const uerr = createUnknownError();
      uerr.message = `Worker operation '${operation}' failed.${ctx}`;
      throw withCause(error, uerr);
    }
  }

  /**
   * Smart repository initialization
   */
  async smartInitializeRepo(params: {
    repoId: string;
    cloneUrls: string[];
    branch?: string;
    forceUpdate?: boolean;
    timeoutMs?: number; // Optional custom timeout for background operations
  }): Promise<any> {
    const { timeoutMs, ...executeParams } = params;
    return this.execute("smartInitializeRepo", executeParams, { timeoutMs });
  }

  /**
   * Sync local repository with remote HEAD
   * Ensures the local repo always points to the latest remote HEAD
   */
  async syncWithRemote(params: {
    repoId: string;
    cloneUrls: string[];
    branch?: string;
  }): Promise<any> {
    return this.execute("syncWithRemote", params);
  }

  /**
   * Check if repository is cloned locally
   */
  async isRepoCloned(params: {
    repoId: string;
  }): Promise<boolean> {
    return this.execute("isRepoCloned", params);
  }

  /**
   * Push local repository to a remote
   */
  async pushToRemote(params: {
    repoId: string;
    remoteUrl: string;
    branch?: string;
    token?: string;
    provider?: string;
  }): Promise<any> {
    return this.execute("pushToRemote", params);
  }

  /**
   * Safe push with preflight checks and optional destructive-action confirmation
   */
  async safePushToRemote(params: {
    repoId: string;
    remoteUrl: string;
    branch?: string;
    token?: string;
    provider?: string;
    allowForce?: boolean;
    confirmDestructive?: boolean;
    preflight?: {
      blockIfUncommitted?: boolean;
      requireUpToDate?: boolean;
      blockIfShallow?: boolean;
    };
  }): Promise<any> {
    return this.execute("safePushToRemote", params);
  }

  /**
   * Get repository data level (refs, shallow, full)
   */
  async getRepoDataLevel(repoId: string): Promise<string> {
    return this.execute("getRepoDataLevel", repoId);
  }

  /**
   * Ensure full clone of repository
   */
  async ensureFullClone(params: { repoId: string; branch: string; depth?: number }): Promise<any> {
    return this.execute("ensureFullClone", params);
  }

  /**
   * Get commit history
   */
  async getCommitHistory(params: {
    repoId: string;
    branch: string;
    depth: number;
    offset?: number;
  }): Promise<any> {
    return this.execute("getCommitHistory", params);
  }

  /**
   * Get detailed information about a specific commit including metadata and file changes
   */
  async getCommitDetails(params: {
    repoId: string;
    commitId: string;
    branch?: string;
  }): Promise<any> {
    return this.execute("getCommitDetails", params);
  }

  /**
   * Get commit count
   */
  async getCommitCount(params: { repoId: string; branch: string }): Promise<any> {
    return this.execute("getCommitCount", params);
  }

  /**
   * Get working tree status using worker's getStatus()
   */
  async getStatus(params: { repoId: string; branch?: string }): Promise<any> {
    return this.execute("getStatus", params);
  }

  /**
   * Delete repository
   */
  async deleteRepo(params: { repoId: string }): Promise<any> {
    return this.execute("deleteRepo", params);
  }

  /**
   * Analyze patch merge
   */
  async analyzePatchMerge(params: {
    repoId: string;
    patchData: any;
    targetBranch: string;
  }): Promise<any> {
    return this.execute("analyzePatchMerge", params);
  }

  /**
   * List branches from repository event (RPC)
   */
  async listBranchesFromEvent(params: { repoEvent: RepoAnnouncementEvent }): Promise<any> {
    await this.initialize();
    return this.execute("listBranchesFromEvent", params);
  }

  /**
   * List repository files (RPC)
   */
  async listRepoFilesFromEvent(params: {
    repoEvent: RepoAnnouncementEvent;
    branch?: string;
    path?: string;
    repoKey?: string;
  }): Promise<any> {
    await this.initialize();
    return this.execute("listRepoFilesFromEvent", params);
  }

  /**
   * Get repository file content (RPC)
   */
  async getRepoFileContentFromEvent(params: {
    repoEvent: RepoAnnouncementEvent;
    branch?: string;
    path: string;
    commit?: string;
    repoKey?: string;
  }): Promise<any> {
    await this.initialize();
    return this.execute("getRepoFileContentFromEvent", params);
  }

  /**
   * List tree at a specific commit (for tag browsing) (RPC)
   */
  async listTreeAtCommit(params: {
    repoEvent: RepoAnnouncementEvent;
    commit: string;
    path?: string;
    repoKey?: string;
  }): Promise<any> {
    await this.initialize();
    return this.execute("listTreeAtCommit", params);
  }

  /**
   * Check if file exists at commit (RPC)
   */
  async fileExistsAtCommit(params: {
    repoEvent: RepoAnnouncementEvent;
    branch?: string;
    path: string;
    commit?: string;
    repoKey?: string;
  }): Promise<any> {
    await this.initialize();
    return this.execute("fileExistsAtCommit", params);
  }

  /**
   * Get commit information (RPC)
   */
  async getCommitInfo(params: { repoEvent: RepoAnnouncementEvent; commit: string }): Promise<any> {
    await this.initialize();
    return this.execute("getCommitInfo", params);
  }

  /**
   * Get file history (RPC)
   */
  async getFileHistory(params: {
    repoEvent: RepoAnnouncementEvent;
    path: string;
    branch: string;
    maxCount?: number;
    repoKey?: string;
  }): Promise<any> {
    await this.initialize();
    return this.execute("getFileHistory", params);
  }

  /**
   * Get commit history (alternative method using repo event) (RPC)
   */
  async getCommitHistoryFromEvent(params: {
    repoEvent: RepoAnnouncementEvent;
    branch: string;
    depth?: number;
  }): Promise<any> {
    await this.initialize();
    return this.execute("getCommitHistoryFromEvent", params);
  }

  /**
   * Apply a patch and push to remotes (RPC)
   */
  async applyPatchAndPush(params: {
    repoId: string;
    patchData: any;
    targetBranch?: string;
    mergeCommitMessage?: string;
    authorName?: string;
    authorEmail?: string;
  }): Promise<{
    success: boolean;
    error?: string;
    mergeCommitOid?: string;
    pushedRemotes?: string[];
    skippedRemotes?: string[];
    warning?: string;
    pushErrors?: Array<{ remote: string; url: string; error: string; code: string; stack: string }>;
  }> {
    await this.initialize();
    return this.execute("applyPatchAndPush", params, { timeoutMs: 120000 });
  }

  /**
   * Check if worker is ready for operations
   */
  get isReady(): boolean {
    return this.isInitialized && this.worker !== null && this.api !== null;
  }

  /**
   * Get the underlying worker instance (for advanced use cases)
   */
  get workerInstance(): Worker | null {
    return this.worker;
  }

  /**
   * Get the API instance (for direct access if needed)
   */
  get apiInstance(): any {
    return this.api;
  }

  /**
   * Set authentication configuration for git operations
   */
  async setAuthConfig(config: AuthConfig): Promise<void> {
    this.authConfig = config;

    // If worker is already initialized, update the configuration
    if (this.isInitialized && this.api) {
      try {
        const nextJson = JSON.stringify(config || {});
        if (nextJson !== this.lastAuthConfigJson) {
          await this.api.setAuthConfig(config);
          this.lastAuthConfigJson = nextJson;
        } // else no-op
      } catch (error) {
        console.error("Failed to update authentication configuration:", error);
      }
    }
  }

  /**
   * Add or update a single authentication token
   */
  async addAuthToken(token: AuthToken): Promise<void> {
    // Remove existing token for the same host
    this.authConfig.tokens = this.authConfig.tokens.filter((t) => t.host !== token.host);
    // Add the new token
    this.authConfig.tokens.push(token);

    // Update the worker if initialized
    if (this.isInitialized && this.api) {
      await this.setAuthConfig(this.authConfig);
    }
  }

  /**
   * Remove authentication token for a specific host
   */
  async removeAuthToken(host: string): Promise<void> {
    this.authConfig.tokens = this.authConfig.tokens.filter((t) => t.host !== host);

    // Update the worker if initialized
    if (this.isInitialized && this.api) {
      await this.setAuthConfig(this.authConfig);
    }
  }

  /**
   * Get current authentication configuration
   */
  getAuthConfig(): AuthConfig {
    return { ...this.authConfig };
  }

  /**
   * Reset repository to match remote HEAD state (RPC)
   * This performs a hard reset to remove any local commits that diverge from remote
   */
  async resetRepoToRemote(repoId: string, branch?: string): Promise<any> {
    await this.initialize();

    const result = await this.execute("resetRepoToRemote", { repoId, branch }, { timeoutMs: 60000 });

    if (!result?.success) {
      const err = createUnknownError();
      err.message = `Reset to remote failed (repoId=${repoId}${branch ? `, branch=${branch}` : ""})`;
      throw err;
    }

    console.log(`Repository ${repoId} reset to remote commit ${result.remoteCommit}`);
    return result;
  }

  /**
   * Update the progress callback
   */
  setProgressCallback(callback: WorkerProgressCallback): void {
    this.progressCallback = callback;
  }

  private handleWorkerProgress = (event: WorkerProgressEvent | MessageEvent): void => {
    const payload = event instanceof MessageEvent ? event.data : event;
    if (!payload || typeof payload !== 'object') {
      return;
    }
    if ('type' in payload && payload.type !== 'clone-progress' && payload.type !== 'merge-progress') {
      return;
    }

    if (!this.progressCallback) {
      return;
    }

    this.progressCallback({
      repoId: (payload as any).repoId,
      phase: (payload as any).phase ?? (payload as any).step ?? 'unknown',
      progress: typeof payload.progress === 'number' ? payload.progress : undefined,
      patchId: (payload as any).patchId,
      targetBranch: (payload as any).targetBranch,
      message: (payload as any).message,
    });
  };

  /**
   * Terminate the worker and clean up resources
   */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.api = null;
    this.isInitialized = false;
    this.progressCallback = undefined;
  }

  /**
   * Check if the worker is still alive and responsive
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isReady) {
      return false;
    }

    try {
      // Try a simple operation to verify worker is responsive
      await this.execute("ping", {});
      return true;
    } catch (error) {
      console.warn("Worker health check failed:", error);
      return false;
    }
  }

  /**
   * Restart the worker if it becomes unresponsive
   */
  async restart(): Promise<void> {
    this.dispose();
    await this.initialize();
  }
}
