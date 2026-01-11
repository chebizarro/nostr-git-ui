import type { RepoAnnouncementEvent } from "@nostr-git/core/events";
import {
  createAuthRequiredError,
  createFsError,
  createNetworkError,
  createTimeoutError,
  createUnknownError,
  wrapError,
} from "@nostr-git/core/errors";
import { detectVendorFromUrl } from "@nostr-git/core/git";

import type { Token } from "$lib/stores/tokens";
import { tryTokensForHost, getTokensForHost } from "$lib/utils/tokenHelpers";
import { WorkerManager } from "./WorkerManager";

export interface VendorReadRouterConfig {
  getTokens: () => Promise<Token[]>;
  preferVendorReads?: boolean; // default true
}

export interface VendorRef {
  name: string;
  type: "heads" | "tags";
  fullRef: string;
  commitId: string;
}

export interface VendorFileInfo {
  path: string;
  type: "file" | "directory" | string;
  size?: number;
  mode?: string;
  oid?: string;
}

export interface VendorDirectoryResult {
  files: VendorFileInfo[];
  path: string;
  ref: string;
  fromVendor: boolean;
}

export interface VendorFileContentResult {
  content: string;
  path: string;
  ref: string;
  encoding?: string;
  size: number;
  fromVendor: boolean;
}

type SupportedVendor = "github" | "gitlab" | "gitea";

/**
 * VendorReadRouter performs vendor API reads first (when supported) and falls back to worker git RPC.
 * - Vendor reads are best-effort and should never block fallback git reads.
 * - Heavy git/FS operations always go through WorkerManager RPC.
 */
export class VendorReadRouter {
  private getTokens: () => Promise<Token[]>;
  private preferVendorReads: boolean;

  constructor(config: VendorReadRouterConfig) {
    this.getTokens = config.getTokens;
    this.preferVendorReads = config.preferVendorReads ?? true;
  }

  async listDirectory(params: {
    workerManager: WorkerManager;
    repoEvent: RepoAnnouncementEvent;
    repoKey?: string;
    cloneUrls: string[];
    branch: string;
    path?: string;
  }): Promise<VendorDirectoryResult> {
    const path = params.path || "";
    const branch = params.branch || "";
    const remote = this.pickRemote(params.cloneUrls);

    // 1) Vendor-first if possible
    if (this.preferVendorReads && remote) {
      const vendor = this.getSupportedVendor(remote);
      if (vendor) {
        try {
          const vendorResult = await this.vendorListDirectory({
            vendor,
            remoteUrl: remote,
            branch,
            path,
          });
          return { ...vendorResult, fromVendor: true };
        } catch (vendorErr) {
          // vendor failed -> fall back to git worker
          try {
            const filesRaw = await params.workerManager.listRepoFilesFromEvent({
              repoEvent: params.repoEvent,
              repoKey: params.repoKey,
              branch,
              path,
            });

            const files: VendorFileInfo[] = (filesRaw || []).map((f: any) => ({
              path: f.path || f.name || "",
              type:
                f.type === "dir" || f.type === "tree" || f.type === "directory"
                  ? "directory"
                  : "file",
              size: f.size,
              mode: f.mode,
              oid: f.oid || f.sha,
            }));

            return {
              files,
              path,
              ref: (branch || "").split("/").pop() || "",
              fromVendor: false,
            };
          } catch (workerErr) {
            // preserve vendor failure context as cause when worker also fails
            try {
              throw (wrapError as any)(vendorErr, workerErr);
            } catch {
              const err = workerErr instanceof Error ? workerErr : new Error(String(workerErr));
              (err as any).cause = vendorErr;
              throw err;
            }
          }
        }
      }
    }

    // 2) Git worker fallback
    const filesRaw = await params.workerManager.listRepoFilesFromEvent({
      repoEvent: params.repoEvent,
      repoKey: params.repoKey,
      branch,
      path,
    });

    const files: VendorFileInfo[] = (filesRaw || []).map((f: any) => ({
      path: f.path || f.name || "",
      type:
        f.type === "dir" || f.type === "tree" || f.type === "directory" ? "directory" : "file",
      size: f.size,
      mode: f.mode,
      oid: f.oid || f.sha,
    }));

    return {
      files,
      path,
      ref: (branch || "").split("/").pop() || "",
      fromVendor: false,
    };
  }

  async getFileContent(params: {
    workerManager: WorkerManager;
    repoEvent: RepoAnnouncementEvent;
    repoKey?: string;
    cloneUrls: string[];
    branch: string;
    path: string;
  }): Promise<VendorFileContentResult> {
    const branch = params.branch || "";
    const remote = this.pickRemote(params.cloneUrls);
    const ctx = this.ctx({ op: "getFileContent", remote, branch, path: params.path });

    // 1) Vendor-first if possible
    if (this.preferVendorReads && remote) {
      const vendor = this.getSupportedVendor(remote);
      if (vendor) {
        try {
          const vendorResult = await this.vendorGetFileContent({
            vendor,
            remoteUrl: remote,
            branch,
            path: params.path,
          });
          return { ...vendorResult, fromVendor: true };
        } catch (vendorErr) {
          // vendor failed -> fall back to git worker
          try {
            const contentRaw = await params.workerManager.getRepoFileContentFromEvent({
              repoEvent: params.repoEvent,
              repoKey: params.repoKey,
              branch,
              path: params.path,
            });

            const content = typeof contentRaw === "string" ? contentRaw : String(contentRaw ?? "");

            return {
              content,
              path: params.path,
              ref: (branch || "").split("/").pop() || "",
              encoding: "utf-8",
              size: content.length,
              fromVendor: false,
            };
          } catch (workerErr) {
            // preserve vendor failure context as cause when worker also fails
            try {
              throw (wrapError as any)(vendorErr, workerErr);
            } catch {
              const err = workerErr instanceof Error ? workerErr : new Error(String(workerErr));
              (err as any).cause = vendorErr;
              err.message = `${err.message}${ctx}`;
              throw err;
            }
          }
        }
      }
    }

    // 2) Git worker fallback
    const contentRaw = await params.workerManager.getRepoFileContentFromEvent({
      repoEvent: params.repoEvent,
      repoKey: params.repoKey,
      branch,
      path: params.path,
    });
    const content = typeof contentRaw === "string" ? contentRaw : String(contentRaw ?? "");

    return {
      content,
      path: params.path,
      ref: (branch || "").split("/").pop() || "",
      encoding: "utf-8",
      size: content.length,
      fromVendor: false,
    };
  }

  async listRefs(params: {
    workerManager: WorkerManager;
    repoEvent: RepoAnnouncementEvent;
    cloneUrls: string[];
  }): Promise<{ refs: VendorRef[]; fromVendor: boolean }> {
    const remote = this.pickRemote(params.cloneUrls);

    // 1) Vendor-first if possible
    if (this.preferVendorReads && remote) {
      const vendor = this.getSupportedVendor(remote);
      if (vendor) {
        try {
          const refs = await this.vendorListRefs({ vendor, remoteUrl: remote });
          return { refs, fromVendor: true };
        } catch (vendorErr) {
          // vendor failed -> fall back to git worker
          try {
            const branches = await params.workerManager.listBranchesFromEvent({
              repoEvent: params.repoEvent,
            });

            const refs: VendorRef[] = (branches || []).map((b: any) => {
              const name = typeof b === "string" ? b : String(b?.name ?? "");
              return {
                name,
                type: "heads",
                fullRef: `refs/heads/${name}`,
                commitId: String((b as any)?.commitId ?? (b as any)?.oid ?? ""),
              };
            });

            return { refs, fromVendor: false };
          } catch (workerErr) {
            try {
              throw (wrapError as any)(vendorErr, workerErr);
            } catch {
              const err = workerErr instanceof Error ? workerErr : new Error(String(workerErr));
              (err as any).cause = vendorErr;
              throw err;
            }
          }
        }
      }
    }

    // 2) Git worker fallback
    const branches = await params.workerManager.listBranchesFromEvent({
      repoEvent: params.repoEvent,
    });

    const refs: VendorRef[] = (branches || []).map((b: any) => {
      const name = typeof b === "string" ? b : String(b?.name ?? "");
      return {
        name,
        type: "heads",
        fullRef: `refs/heads/${name}`,
        commitId: String((b as any)?.commitId ?? (b as any)?.oid ?? ""),
      };
    });

    return { refs, fromVendor: false };
  }

  // -------------------------
  // Vendor implementations
  // -------------------------

  private getSupportedVendor(remoteUrl: string): SupportedVendor | null {
    try {
      const v = detectVendorFromUrl(remoteUrl) as any;
      if (v === "github") return "github";
      if (v === "gitlab") return "gitlab";
      if (v === "gitea") return "gitea";
      return null;
    } catch {
      return null;
    }
  }

  private async vendorListDirectory(params: {
    vendor: SupportedVendor;
    remoteUrl: string;
    branch: string;
    path: string;
  }): Promise<VendorDirectoryResult> {
    switch (params.vendor) {
      case "github":
      case "gitea":
        return this.vendorListDirectoryGitHubLike(params);
      case "gitlab":
        return this.vendorListDirectoryGitLab(params);
    }
  }

  private async vendorGetFileContent(params: {
    vendor: SupportedVendor;
    remoteUrl: string;
    branch: string;
    path: string;
  }): Promise<VendorFileContentResult> {
    switch (params.vendor) {
      case "github":
      case "gitea":
        return this.vendorGetFileContentGitHubLike(params);
      case "gitlab":
        return this.vendorGetFileContentGitLab(params);
    }
  }

  private async vendorListRefs(params: { vendor: SupportedVendor; remoteUrl: string }): Promise<VendorRef[]> {
    switch (params.vendor) {
      case "github":
        return this.vendorListRefsGitHub(params.remoteUrl);
      case "gitea":
        return this.vendorListRefsGitea(params.remoteUrl);
      case "gitlab":
        return this.vendorListRefsGitLab(params.remoteUrl);
    }
  }

  // -------------------------
  // GitHub-like (GitHub/Gitea) vendor support
  // -------------------------

  private async vendorListDirectoryGitHubLike(params: {
    vendor: "github" | "gitea";
    remoteUrl: string;
    branch: string;
    path: string;
  }): Promise<VendorDirectoryResult> {
    const { host, owner, repo } = this.parseOwnerRepoFromCloneUrl(params.remoteUrl);
    const apiBase = this.getApiBase(params.vendor, host);

    const cleanPath = this.normalizeRepoPath(params.path);
    const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/contents/${encodeURIComponent(cleanPath)}?ref=${encodeURIComponent(params.branch)}`;

    const ctx = this.ctx({
      op: "listDirectory",
      remote: params.remoteUrl,
      branch: params.branch,
      path: params.path,
    });

    const json = await this.fetchJsonWithOptionalTokenRetry({
      host,
      url,
      vendor: params.vendor,
      ctx,
    });

    // GitHub-style API returns array for directory, object for file
    if (Array.isArray(json)) {
      const files: VendorFileInfo[] = json.map((item: any) => ({
        path: item.path || item.name || "",
        type: item.type === "dir" ? "directory" : "file",
        size: item.size,
        oid: item.sha,
      }));
      return {
        files,
        path: params.path || "/",
        ref: (params.branch || "").split("/").pop() || "",
        fromVendor: true,
      };
    }

    if (json && typeof json === "object") {
      // If the path points to a file, surface as a singleton entry (still a successful vendor response)
      const item = json as any;
      const files: VendorFileInfo[] = [
        {
          path: item.path || item.name || params.path,
          type: item.type === "dir" ? "directory" : "file",
          size: item.size,
          oid: item.sha,
        },
      ];
      return {
        files,
        path: params.path || "/",
        ref: (params.branch || "").split("/").pop() || "",
        fromVendor: true,
      };
    }

    throw createUnknownError(`Unexpected vendor directory response.${ctx}`);
  }

  private async vendorGetFileContentGitHubLike(params: {
    vendor: "github" | "gitea";
    remoteUrl: string;
    branch: string;
    path: string;
  }): Promise<VendorFileContentResult> {
    const { host, owner, repo } = this.parseOwnerRepoFromCloneUrl(params.remoteUrl);
    const apiBase = this.getApiBase(params.vendor, host);
    const cleanPath = this.normalizeRepoPath(params.path);

    const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/contents/${encodeURIComponent(cleanPath)}?ref=${encodeURIComponent(params.branch)}`;

    const ctx = this.ctx({
      op: "getFileContent",
      remote: params.remoteUrl,
      branch: params.branch,
      path: params.path,
    });

    const json = await this.fetchJsonWithOptionalTokenRetry({
      host,
      url,
      vendor: params.vendor,
      ctx,
    });

    if (!json || typeof json !== "object") {
      const err = createUnknownError();
      err.message = `Unexpected vendor file response.${ctx}`;
      throw err;
    }

    const obj: any = json;
    if (obj.type && obj.type !== "file") {
      const ferr = createFsError();
      ferr.message = `Expected a file but got type='${String(obj.type)}'.${ctx}`;
      throw ferr;
    }

    const encoding = String(obj.encoding || "");
    const contentField = obj.content;

    if (encoding === "base64" && typeof contentField === "string") {
      const decoded = this.decodeBase64ToUtf8(contentField);
      return {
        content: decoded,
        path: params.path,
        ref: (params.branch || "").split("/").pop() || "",
        encoding: "utf-8",
        size: decoded.length,
        fromVendor: true,
      };
    }

    // Some providers may return raw content directly
    if (typeof contentField === "string") {
      return {
        content: contentField,
        path: params.path,
        ref: (params.branch || "").split("/").pop() || "",
        encoding: "utf-8",
        size: contentField.length,
        fromVendor: true,
      };
    }

    const err = createUnknownError();
    err.message = `Vendor did not return file content.${ctx}`;
    throw err;
  }

  private async vendorListRefsGitHub(remoteUrl: string): Promise<VendorRef[]> {
    const { host, owner, repo } = this.parseOwnerRepoFromCloneUrl(remoteUrl);
    const apiBase = this.getApiBase("github", host);
    const ctx = this.ctx({ op: "listRefs", remote: remoteUrl });

    const branchesUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/branches?per_page=100`;
    const tagsUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/tags?per_page=100`;

    const [branchesJson, tagsJson] = await Promise.all([
      this.fetchJsonWithOptionalTokenRetry({ host, url: branchesUrl, vendor: "github", ctx }),
      this.fetchJsonWithOptionalTokenRetry({ host, url: tagsUrl, vendor: "github", ctx }),
    ]);

    const out: VendorRef[] = [];
    if (Array.isArray(branchesJson)) {
      for (const b of branchesJson) {
        const name = String((b as any)?.name || "");
        const commitId = String((b as any)?.commit?.sha || "");
        if (!name) continue;
        out.push({ name, type: "heads", fullRef: `refs/heads/${name}`, commitId });
      }
    }
    if (Array.isArray(tagsJson)) {
      for (const t of tagsJson) {
        const name = String((t as any)?.name || "");
        const commitId = String((t as any)?.commit?.sha || "");
        if (!name) continue;
        out.push({ name, type: "tags", fullRef: `refs/tags/${name}`, commitId });
      }
    }
    return out;
  }

  private async vendorListRefsGitea(remoteUrl: string): Promise<VendorRef[]> {
    const { host, owner, repo } = this.parseOwnerRepoFromCloneUrl(remoteUrl);
    const apiBase = this.getApiBase("gitea", host);
    const ctx = this.ctx({ op: "listRefs", remote: remoteUrl });

    const branchesUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/branches?limit=100`;
    const tagsUrl = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags?limit=100`;

    const [branchesJson, tagsJson] = await Promise.all([
      this.fetchJsonWithOptionalTokenRetry({ host, url: branchesUrl, vendor: "gitea", ctx }),
      this.fetchJsonWithOptionalTokenRetry({ host, url: tagsUrl, vendor: "gitea", ctx }),
    ]);

    const out: VendorRef[] = [];
    if (Array.isArray(branchesJson)) {
      for (const b of branchesJson) {
        const name = String((b as any)?.name || "");
        const commitId = String((b as any)?.commit?.id || (b as any)?.commit?.sha || "");
        if (!name) continue;
        out.push({ name, type: "heads", fullRef: `refs/heads/${name}`, commitId });
      }
    }
    if (Array.isArray(tagsJson)) {
      for (const t of tagsJson) {
        const name = String((t as any)?.name || "");
        const commitId = String((t as any)?.id || (t as any)?.commit?.id || "");
        if (!name) continue;
        out.push({ name, type: "tags", fullRef: `refs/tags/${name}`, commitId });
      }
    }
    return out;
  }

  // -------------------------
  // GitLab vendor support
  // -------------------------

  private async vendorListDirectoryGitLab(params: {
    vendor: "gitlab";
    remoteUrl: string;
    branch: string;
    path: string;
  }): Promise<VendorDirectoryResult> {
    const parsed = this.parseOwnerRepoFromCloneUrl(params.remoteUrl);
    const host = parsed.host;
    const projectPath = `${parsed.owner}/${parsed.repo}`; // owner may contain slashes for groups/subgroups
    const projectId = encodeURIComponent(projectPath);

    const apiBase = this.getApiBase("gitlab", host);
    const cleanPath = this.normalizeRepoPath(params.path);
    const url = `${apiBase}/projects/${projectId}/repository/tree?ref=${encodeURIComponent(
      params.branch
    )}&path=${encodeURIComponent(cleanPath)}&per_page=100`;

    const ctx = this.ctx({
      op: "listDirectory",
      remote: params.remoteUrl,
      branch: params.branch,
      path: params.path,
    });

    const json = await this.fetchJsonWithOptionalTokenRetry({
      host,
      url,
      vendor: "gitlab",
      ctx,
    });

    if (!Array.isArray(json)) {
      const err = createUnknownError();
      err.message = `Unexpected GitLab tree response.${ctx}`;
      throw err;
    }

    const files: VendorFileInfo[] = json.map((item: any) => ({
      path: item.path || item.name || "",
      type: item.type === "tree" ? "directory" : "file",
      oid: item.id,
    }));

    return {
      files,
      path: params.path || "/",
      ref: (params.branch || "").split("/").pop() || "",
      fromVendor: true,
    };
  }

  private async vendorGetFileContentGitLab(params: {
    vendor: "gitlab";
    remoteUrl: string;
    branch: string;
    path: string;
  }): Promise<VendorFileContentResult> {
    const parsed = this.parseOwnerRepoFromCloneUrl(params.remoteUrl);
    const host = parsed.host;
    const projectPath = `${parsed.owner}/${parsed.repo}`;
    const projectId = encodeURIComponent(projectPath);
    const apiBase = this.getApiBase("gitlab", host);

    // Prefer raw endpoint to avoid base64 decoding
    const filePath = this.normalizeRepoPath(params.path);
    const url = `${apiBase}/projects/${projectId}/repository/files/${encodeURIComponent(
      filePath
    )}/raw?ref=${encodeURIComponent(params.branch)}`;

    const ctx = this.ctx({
      op: "getFileContent",
      remote: params.remoteUrl,
      branch: params.branch,
      path: params.path,
    });

    const content = await this.fetchTextWithOptionalTokenRetry({
      host,
      url,
      vendor: "gitlab",
      ctx,
    });

    return {
      content,
      path: params.path,
      ref: (params.branch || "").split("/").pop() || "",
      encoding: "utf-8",
      size: content.length,
      fromVendor: true,
    };
  }

  private async vendorListRefsGitLab(remoteUrl: string): Promise<VendorRef[]> {
    const parsed = this.parseOwnerRepoFromCloneUrl(remoteUrl);
    const host = parsed.host;
    const projectPath = `${parsed.owner}/${parsed.repo}`;
    const projectId = encodeURIComponent(projectPath);
    const apiBase = this.getApiBase("gitlab", host);
    const ctx = this.ctx({ op: "listRefs", remote: remoteUrl });

    const branchesUrl = `${apiBase}/projects/${projectId}/repository/branches?per_page=100`;
    const tagsUrl = `${apiBase}/projects/${projectId}/repository/tags?per_page=100`;

    const [branchesJson, tagsJson] = await Promise.all([
      this.fetchJsonWithOptionalTokenRetry({ host, url: branchesUrl, vendor: "gitlab", ctx }),
      this.fetchJsonWithOptionalTokenRetry({ host, url: tagsUrl, vendor: "gitlab", ctx }),
    ]);

    const out: VendorRef[] = [];

    if (Array.isArray(branchesJson)) {
      for (const b of branchesJson) {
        const name = String((b as any)?.name || "");
        const commitId = String((b as any)?.commit?.id || (b as any)?.commit?.sha || "");
        if (!name) continue;
        out.push({ name, type: "heads", fullRef: `refs/heads/${name}`, commitId });
      }
    }

    if (Array.isArray(tagsJson)) {
      for (const t of tagsJson) {
        const name = String((t as any)?.name || "");
        const commitId = String((t as any)?.commit?.id || (t as any)?.commit?.sha || "");
        if (!name) continue;
        out.push({ name, type: "tags", fullRef: `refs/tags/${name}`, commitId });
      }
    }

    return out;
  }

  // -------------------------
  // Fetch helpers + normalization
  // -------------------------

  private pickRemote(cloneUrls: string[]): string | null {
    const urls = Array.isArray(cloneUrls) ? cloneUrls : [];
    for (const u of urls) {
      const s = String(u || "").trim();
      if (!s) continue;
      // Skip nostr/grasp-like pseudo URLs
      if (s.startsWith("nostr://") || s.startsWith("nostr:")) continue;
      // Prefer https URLs; allow ssh-looking but we can still parse host/owner/repo and build API URLs for known providers
      return s;
    }
    return null;
  }

  private ctx(parts: { op: string; remote?: string | null; branch?: string; path?: string }): string {
    const tokens: string[] = [];
    tokens.push(`op=${parts.op}`);
    if (parts.remote) tokens.push(`remote=${parts.remote}`);
    if (parts.branch) tokens.push(`branch=${parts.branch}`);
    if (parts.path) tokens.push(`path=${parts.path}`);
    return tokens.length ? ` (${tokens.join(", ")})` : "";
  }

  private normalizeRepoPath(path: string): string {
    const p = String(path || "");
    if (!p) return "";
    return p.startsWith("/") ? p.slice(1) : p;
  }

  private getApiBase(vendor: SupportedVendor, host: string): string {
    const h = host.trim();
    if (vendor === "github") {
      // Special-case github.com to api.github.com; otherwise assume GH Enterprise at /api/v3
      if (h.toLowerCase() === "github.com") return "https://api.github.com";
      return `https://${h}/api/v3`;
    }
    if (vendor === "gitlab") {
      return `https://${h}/api/v4`;
    }
    // gitea
    return `https://${h}/api/v1`;
  }

  private parseOwnerRepoFromCloneUrl(url: string): { host: string; owner: string; repo: string } {
    // Supports:
    // - https://host/owner/repo.git
    // - http://host/owner/repo.git
    // - git@host:owner/repo.git
    // - ssh://git@host/owner/repo.git
    const raw = String(url || "").trim();

    // http(s)
    try {
      const u = new URL(raw);
      const host = u.hostname;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const repo = parts[parts.length - 1].replace(/\.git$/i, "");
        const owner = parts.slice(0, -1).join("/"); // support gitlab groups/subgroups
        return { host, owner, repo };
      }
    } catch {
      // fall through
    }

    // ssh (scp-like)
    const m = raw.match(/^git@([^:]+):(.+)$/);
    if (m) {
      const host = m[1];
      const path = m[2].replace(/^\//, "");
      const parts = path.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const repo = parts[parts.length - 1].replace(/\.git$/i, "");
        const owner = parts.slice(0, -1).join("/");
        return { host, owner, repo };
      }
    }

    // Generic fallback: try to find host and /owner/repo in string
    const g = raw.match(/^(?:https?:\/\/|ssh:\/\/git@)([^\/:]+)[\/:]([^\/]+)\/([^\/.]+)(?:\.git)?/i);
    if (g) {
      return { host: g[1], owner: g[2], repo: g[3] };
    }

    const err = createUnknownError();
    err.message = `Unable to parse clone URL: ${raw}`;
    throw err;
  }

  private decodeBase64ToUtf8(base64: string): string {
    // GitHub-style content often includes newlines
    const b64 = String(base64 || "").replace(/\s+/g, "");
    let binary = "";
    if (typeof (globalThis as any).atob === "function") {
      binary = (globalThis as any).atob(b64);
    } else if (typeof (globalThis as any).Buffer !== "undefined") {
      const buf = (globalThis as any).Buffer.from(b64, "base64");
      binary = buf.toString("binary");
    } else {
      const err = createUnknownError();
      err.message = "No base64 decoder available in this environment";
      throw err;
    }

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    return decoder.decode(bytes);
  }

  private async fetchJsonWithOptionalTokenRetry(params: {
    host: string;
    url: string;
    vendor: SupportedVendor;
    ctx: string;
  }): Promise<any> {
    const tokens = await this.getTokens().catch(() => []);
    const matching = getTokensForHost(tokens, params.host);

    // If tokens exist for this host, retry across them; else attempt unauth for public repos
    if (matching.length > 0) {
      return await tryTokensForHost(tokens, params.host, async (token: string) => {
        return await this.fetchJson({ url: params.url, vendor: params.vendor, token, ctx: params.ctx });
      });
    }

    return await this.fetchJson({ url: params.url, vendor: params.vendor, token: undefined, ctx: params.ctx });
  }

  private async fetchTextWithOptionalTokenRetry(params: {
    host: string;
    url: string;
    vendor: SupportedVendor;
    ctx: string;
  }): Promise<string> {
    const tokens = await this.getTokens().catch(() => []);
    const matching = getTokensForHost(tokens, params.host);

    if (matching.length > 0) {
      return await tryTokensForHost(tokens, params.host, async (token: string) => {
        return await this.fetchText({ url: params.url, vendor: params.vendor, token, ctx: params.ctx });
      });
    }

    return await this.fetchText({ url: params.url, vendor: params.vendor, token: undefined, ctx: params.ctx });
  }

  private vendorHeaders(vendor: SupportedVendor, token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (!token) return headers;

    if (vendor === "github" || vendor === "gitea") {
      headers["Authorization"] = `token ${token}`;
      return headers;
    }

    if (vendor === "gitlab") {
      headers["PRIVATE-TOKEN"] = token;
      return headers;
    }

    return headers;
  }

  private async fetchJson(params: {
    url: string;
    vendor: SupportedVendor;
    token?: string;
    ctx: string;
  }): Promise<any> {
    const res = await this.fetchWithTimeout({
      url: params.url,
      headers: this.vendorHeaders(params.vendor, params.token),
      ctx: params.ctx,
    });
    const txt = await res.text();
    let json: any;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch (e) {
      const err = createUnknownError();
      err.message = `Invalid JSON response.${params.ctx}`;
      throw (wrapError as any)(e, err);
    }
    return json;
  }

  private async fetchText(params: {
    url: string;
    vendor: SupportedVendor;
    token?: string;
    ctx: string;
  }): Promise<string> {
    const res = await this.fetchWithTimeout({
      url: params.url,
      headers: this.vendorHeaders(params.vendor, params.token),
      ctx: params.ctx,
    });
    return await res.text();
  }

  private async fetchWithTimeout(params: {
    url: string;
    headers: Record<string, string>;
    timeoutMs?: number;
    ctx: string;
  }): Promise<Response> {
    const timeoutMs = params.timeoutMs ?? 20_000;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(params.url, {
        method: "GET",
        headers: params.headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw this.httpError(res.status, params.ctx);
      }

      return res;
    } catch (e: any) {
      // Abort -> timeout
      if (e && (e.name === "AbortError" || String(e.message || "").includes("abort"))) {
        const terr = createTimeoutError();
        terr.message = `Vendor request timed out after ${timeoutMs}ms.${params.ctx}`;
        throw (wrapError as any)(e, terr);
      }

      // If we already created a typed error via httpError, rethrow
      if (e instanceof Error) {
        const name = (e as any).name || "";
        if (name === "FatalError" || name === "RetriableError" || name === "UserActionableError") {
          throw e;
        }
      }

      // Fetch network failures typically throw TypeError
      const nerr = createNetworkError();
      nerr.message = `Vendor network error.${params.ctx}`;
      throw (wrapError as any)(e, nerr);
    } finally {
      clearTimeout(t);
    }
  }

  private httpError(status: number, ctx: string): Error {
    if (status === 401 || status === 403) {
      const aerr = createAuthRequiredError();
      aerr.message = `Vendor authentication required (HTTP ${status}).${ctx}`;
      return aerr;
    }
    if (status === 404) {
      const ferr = createFsError();
      ferr.message = `Not found (HTTP 404).${ctx}`;
      return ferr;
    }
    if (status === 429 || (status >= 500 && status <= 599)) {
      const nerr = createNetworkError();
      nerr.message = `Vendor service error (HTTP ${status}).${ctx}`;
      return nerr;
    }
    const uerr = createUnknownError();
    uerr.message = `Vendor request failed (HTTP ${status}).${ctx}`;
    return uerr;
  }
}