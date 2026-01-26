/**
 * Repository Import Hook
 *
 * Main import logic for importing repositories from Git hosting providers
 * (GitHub, GitLab, Gitea, Bitbucket) into the Nostr Git system.
 */

import {
  getGitServiceApi,
  getGitServiceApiFromUrl,
  parseRepoUrl,
  validateTokenPermissions,
  checkRepoOwnership,
  type ImportConfig,
  DEFAULT_IMPORT_CONFIG,
  ImportAbortController,
  ImportAbortedError,
  RateLimiter,
  generatePlatformUserProfile,
  getProfileMapKey,
  convertRepoToNostrEvent,
  convertRepoToStateEvent,
  convertIssuesToNostrEvents,
  convertIssueStatusesToEvents,
  convertCommentsToNostrEvents,
  convertPullRequestsToNostrEvents,
  signEvent,
  type UserProfileMap,
  type CommentEventMap,
  type ConvertedComment,
  type GitServiceApi,
  type ListCommentsOptions,
} from "@nostr-git/core";
import type {
  RepoAnnouncementEvent,
  RepoStateEvent,
  NostrEvent,
  EventIO,
} from "@nostr-git/core";
import type {
  GitIssue as Issue,
  GitComment as Comment,
  GitPullRequest as PullRequest,
  RepoMetadata,
} from "@nostr-git/core";

/**
 * Import progress information
 */
export interface ImportProgress {
  /**
   * Current step/message
   */
  step: string;

  /**
   * Current item number (for batch operations)
   */
  current?: number;

  /**
   * Total items (for batch operations)
   */
  total?: number;

  /**
   * Whether the import is complete
   */
  isComplete: boolean;

  /**
   * Error message if import failed
   */
  error?: string;
}

/**
 * Import result
 */
export interface ImportResult {
  /**
   * Repository announcement event
   */
  announcementEvent: RepoAnnouncementEvent;

  /**
   * Repository state event
   */
  stateEvent: RepoStateEvent;

  /**
   * Number of issues imported
   */
  issuesImported: number;

  /**
   * Number of comments imported
   */
  commentsImported: number;

  /**
   * Number of PRs imported
   */
  prsImported: number;

  /**
   * Number of profiles created
   */
  profilesCreated: number;

  /**
   * Final repository metadata (after forking if needed)
   */
  repo: RepoMetadata;
}

/**
 * Options for the import hook
 */
export interface UseImportRepoOptions {
  /**
   * EventIO instance for publishing events
   */
  eventIO?: EventIO;

  /**
   * Function to sign events (required if eventIO not provided)
   */
  onSignEvent?: (event: Omit<NostrEvent, "id" | "sig" | "pubkey">) => Promise<NostrEvent>;

  /**
   * Function to publish events (required if eventIO not provided)
   */
  onPublishEvent?: (event: NostrEvent) => Promise<void>;

  /**
   * Progress callback
   */
  onProgress?: (progress: ImportProgress) => void;

  /**
   * Import completed callback
   */
  onImportCompleted?: (result: ImportResult) => void;

  /**
   * User's Nostr public key (hex format)
   */
  userPubkey: string;
}

// ===== Import Context & Types =====

/**
 * Shared context for import operations
 * Holds all state and dependencies needed throughout the import process
 */
interface ImportContext {
  // Core dependencies
  abortController: ImportAbortController;
  rateLimiter: RateLimiter;
  withRateLimit: <T>(provider: string, method: string, operation: () => Promise<T>) => Promise<T>;
  updateProgress: (step: string, current?: number, total?: number) => void;

  // API and platform info
  api: Awaited<ReturnType<typeof getGitServiceApiFromUrl>>;
  platform: string;
  parsed: ReturnType<typeof parseRepoUrl>;

  // Repository info
  finalRepo: RepoMetadata;
  repoAddr: string;

  // Timestamps
  importTimestamp: number;
  startTimestamp: number;
  currentTimestamp: number; // Increments for each event published

  // User profiles
  userProfiles: UserProfileMap;
  profileEvents: Map<string, NostrEvent>;

  // Lightweight tracking maps (for dependency resolution)
  issueEventIdMap: Map<number, string>; // issue.number -> nostr event ID
  prEventIdMap: Map<number, string>; // pr.number -> nostr event ID
  commentEventMap: Map<string, string>; // platformCommentId -> nostr event ID (for threading)

  // Running counters
  issuesPublished: number;
  prsPublished: number;
  commentsPublished: number;

  // Configuration
  config: ImportConfig;
  userPubkey: string;
  batchSize: number; // Number of events per batch
  batchDelay: number; // Delay between batches (ms)

  // Batched event publishing
  eventQueue: NostrEvent[]; // Queue of events waiting to be published

  // Event publishing
  onSignEvent?: (event: Omit<NostrEvent, "id" | "sig" | "pubkey">) => Promise<NostrEvent>;
  onPublishEvent?: (event: NostrEvent) => Promise<void>;
  eventIO?: EventIO;
}

// ===== Batch Publishing Functions =====

/**
 * Publish a single event using batched publishing
 * Events are collected into batches and published together for better performance
 */
async function publishEventBatched(context: ImportContext, event: NostrEvent): Promise<void> {
  context.eventQueue.push(event);

  // If queue reaches batch size, flush it
  if (context.eventQueue.length >= context.batchSize) {
    await flushEventQueue(context);
  }
}

/**
 * Flush all queued events by publishing them in parallel, then wait before next batch
 */
async function flushEventQueue(context: ImportContext): Promise<void> {
  if (context.eventQueue.length === 0) return;

  const batch = [...context.eventQueue];
  context.eventQueue = [];

  // Publish all events in batch in parallel
  await Promise.allSettled(
    batch.map((event) => {
      if (context.onPublishEvent) {
        return context.onPublishEvent(event);
      }
      // If no onPublishEvent, just resolve (events can't be published)
      return Promise.resolve();
    })
  );

  // Single delay after the batch (not per event)
  if (context.batchDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, context.batchDelay));
  }
}

// ===== Setup Functions =====

/**
 * Create and configure rate limiter
 */
function createRateLimiter(
  updateProgress: (step: string, current?: number, total?: number) => void
): RateLimiter {
  const rateLimiter = new RateLimiter({
    secondsBetweenRequests: 0.25,
    secondaryRateWait: 60,
    maxRetries: 3,
  });

  rateLimiter.onProgress = (message: string) => {
    updateProgress(message);
  };

  return rateLimiter;
}

/**
 * Create rate limit wrapper function
 */
function createWithRateLimit(rateLimiter: RateLimiter, abortController: ImportAbortController) {
  return async function withRateLimit<T>(
    provider: string,
    method: string,
    operation: () => Promise<T>
  ): Promise<T> {
    let attempt = 1;

    while (true) {
      abortController?.throwIfAborted();

      // Throttle before making the request
      await rateLimiter.throttle(provider, method);

      try {
        // Execute the operation
        const result = await operation();
        return result;
      } catch (error: any) {
        // Check if we should retry
        const retryDecision = await rateLimiter.shouldRetry(error, attempt);

        if (!retryDecision.retry) {
          // Don't retry - throw the error
          throw error;
        }

        // Wait with progress updates if delay is significant
        if (retryDecision.delay > 0) {
          await rateLimiter.waitWithProgress(provider, retryDecision.delay);
        }

        attempt++;
      }
    }
  };
}

/**
 * Initialize import context with parsed URL and API connection
 */
async function initializeImportContext(
  repoUrl: string,
  token: string,
  config: ImportConfig,
  userPubkey: string,
  updateProgress: (step: string, current?: number, total?: number) => void,
  abortController: ImportAbortController,
  withRateLimit: ImportContext["withRateLimit"],
  onSignEvent?: (event: Omit<NostrEvent, "id" | "sig" | "pubkey">) => Promise<NostrEvent>,
  onPublishEvent?: (event: NostrEvent) => Promise<void>,
  eventIO?: EventIO
): Promise<Partial<ImportContext>> {
  updateProgress("Parsing repository URL...");
  abortController.throwIfAborted();

  const parsed = parseRepoUrl(repoUrl);
  const platform = parsed.provider;

  updateProgress(`Connecting to ${platform}...`);
  abortController.throwIfAborted();

  if (!token || !token.trim()) {
    throw new Error(
      `Authentication token required for ${platform}. Please add a token in settings.`
    );
  }

  const api = getGitServiceApiFromUrl(repoUrl, token);

  return {
    abortController,
    platform,
    parsed,
    api,
    config,
    userPubkey,
    batchSize: config.relayBatchSize ?? 30,
    batchDelay: config.relayBatchDelay ?? 250,
    eventQueue: [],
    onSignEvent,
    onPublishEvent,
    eventIO,
    withRateLimit,
    updateProgress,
  };
}

// ===== Validation Functions =====

/**
 * Validate token permissions and check repository ownership
 */
async function validateTokenAndOwnership(
  context: ImportContext
): Promise<{ repo: RepoMetadata; isOwner: boolean }> {
  // Step 3: Validate token permissions
  context.updateProgress("Validating token permissions...");
  context.abortController.throwIfAborted();

  const tokenValidation = await context.withRateLimit(context.platform, "GET", () =>
    validateTokenPermissions(context.api, {
      owner: context.parsed.owner,
      repo: context.parsed.repo,
    })
  );

  if (!tokenValidation.valid) {
    throw new Error(`Token validation failed: ${tokenValidation.error || "Invalid token"}`);
  }

  if (!tokenValidation.hasRead) {
    throw new Error("Token does not have read permissions");
  }

  // Step 4: Check repository ownership
  context.updateProgress("Checking repository ownership...");
  context.abortController.throwIfAborted();

  const ownership = await context.withRateLimit(context.platform, "GET", () =>
    checkRepoOwnership(context.api, context.parsed.owner, context.parsed.repo)
  );

  return {
    repo: ownership.repo,
    isOwner: ownership.isOwner,
  };
}

/**
 * Fork repository if needed (mandatory for non-owned repos)
 */
async function ensureForkedRepo(context: ImportContext, isOwner: boolean): Promise<RepoMetadata> {
  if (isOwner) {
    if (!context.finalRepo) {
      throw new Error("Repository metadata is missing");
    }
    return context.finalRepo;
  }

  if (!context.config.forkRepo) {
    throw new Error(
      "Forking is required for repositories you don't own. Please enable 'Fork repo' to proceed."
    );
  }

  context.updateProgress("Creating fork...");
  context.abortController.throwIfAborted();

  // Use user-provided fork name if available, otherwise default to {repo}-imported
  const forkName = context.config.forkName || `${context.parsed.repo}-imported`;
  const forkedRepo = await context.withRateLimit(context.platform, "POST", () =>
    context.api.forkRepo(context.parsed.owner, context.parsed.repo, { name: forkName })
  );

  context.updateProgress(`Fork created: ${forkedRepo.fullName}`);
  return forkedRepo;
}

/**
 * Fetch repository metadata (if not already fetched)
 */
async function fetchRepoMetadata(
  context: ImportContext,
  ownershipRepo: RepoMetadata
): Promise<RepoMetadata> {
  // If we already have the repo from ownership check, we might need to fetch full metadata
  // For now, we'll fetch it if it's the same reference (meaning we didn't fork)
  if (context.finalRepo === ownershipRepo) {
    context.updateProgress("Fetching repository metadata...");
    context.abortController.throwIfAborted();
    return await context.withRateLimit(context.platform, "GET", () =>
      context.api.getRepo(context.parsed.owner, context.parsed.repo)
    );
  }

  return context.finalRepo;
}

// ===== Profile Management Functions =====

/**
 * Ensure a user profile exists in the context
 * Uses provided username and avatarUrl directly (no API call needed)
 */
async function ensureUserProfile(context: ImportContext, username: string, avatarUrl?: string) {
  const profileKey = getProfileMapKey(context.platform, username);
  if (context.userProfiles.has(profileKey)) {
    return;
  }

  // Generate profile directly from available data (no API call needed!)
  // GitHub already provides username and avatarUrl in issues/PRs/comments
  // We don't have the user's full name, but that's okay - it will use username as fallback
  const profile = generatePlatformUserProfile(context.platform, username);

  context.userProfiles.set(profileKey, {
    privkey: profile.privkey,
    pubkey: profile.pubkey,
  });
  context.profileEvents.set(profileKey, profile.profileEvent);
}

// ===== Streaming Fetch and Publish Functions =====

/**
 * Fetch and publish issues in streaming fashion (page-by-page)
 * Processes and publishes each issue immediately, keeping only ID mappings in memory
 */
async function fetchAndPublishIssuesStreaming(
  context: ImportContext
): Promise<{ count: number; statusEventsPublished: number }> {
  context.updateProgress("Fetching and publishing issues...");
  context.abortController.throwIfAborted();

  let page = 1;
  const perPage = 100;
  let totalIssues = 0;
  let statusEventsPublished = 0;
  // Track pages to estimate progress (we don't know total upfront, so we'll gradually progress through the range)
  let totalPages = 1; // Start with 1, will update as we discover more pages

  while (true) {
    context.abortController.throwIfAborted();

    const sinceDate = context.config.sinceDate ? context.config.sinceDate.toISOString() : undefined;

    // Fetch one page of issues
    const pageIssues = await context.withRateLimit(context.platform, "GET", () =>
      context.api.listIssues(context.parsed.owner, context.parsed.repo, {
        per_page: perPage,
        page,
        since: sinceDate,
        state: "all",
      })
    );

    if (pageIssues.length === 0) {
      break;
    }

    // Filter by sinceDate if provided (API might not support it)
    const filteredIssues = context.config.sinceDate
      ? pageIssues.filter((issue) => {
          const issueDate = new Date(issue.createdAt);
          return issueDate >= context.config.sinceDate!;
        })
      : pageIssues;

    // Process and publish each issue immediately
    for (const issue of filteredIssues) {
      context.abortController.throwIfAborted();

      // Generate profile if needed (incremental)
      await ensureUserProfile(context, issue.author.login, issue.author.avatarUrl);

      // Convert single issue to Nostr event
      const issueEventData = convertIssuesToNostrEvents(
        [issue], // Single issue
        context.repoAddr,
        context.platform,
        context.userProfiles,
        context.importTimestamp,
        context.currentTimestamp
      );

      if (issueEventData.length > 0) {
        const [eventData] = issueEventData;

        // Sign issue event
        const signedIssueEvent = signEvent(eventData.event, eventData.privkey);

        // Publish issue event (batched)
        await publishEventBatched(context, signedIssueEvent);

        // Store only ID mapping (lightweight)
        context.issueEventIdMap.set(issue.number, signedIssueEvent.id);
        context.currentTimestamp += 1;
        totalIssues++;
        context.issuesPublished = totalIssues;

        // Generate and publish status events immediately
        const statusEvents = convertIssueStatusesToEvents(
          signedIssueEvent.id,
          issue.state,
          issue.closedAt,
          context.userPubkey,
          context.repoAddr,
          context.importTimestamp,
          context.currentTimestamp
        );

        for (const statusData of statusEvents) {
          context.abortController.throwIfAborted();

          // Sign status event
          let signedStatusEvent: NostrEvent;
          if (context.onSignEvent) {
            signedStatusEvent = await context.onSignEvent(statusData.event);
          } else if (context.eventIO) {
            const result = await context.eventIO.publishEvent(statusData.event);
            if (!result.ok) {
              throw new Error(
                `Failed to publish status event for issue #${issue.number}: ${result.error || "Unknown error"}`
              );
            }
            context.currentTimestamp += 1;
            statusEventsPublished++;
            continue; // EventIO already published it
          } else {
            throw new Error("No signing method available for status events");
          }

          // Publish status event (batched)
          await publishEventBatched(context, signedStatusEvent);

          context.currentTimestamp += 1;
          statusEventsPublished++;
        }

        // Update progress with count of published issues
        context.updateProgress(`Publishing issues... (${totalIssues} published)`, totalIssues);
      }
    }

    // Estimate total pages if this page was full (for progress estimation)
    if (pageIssues.length === perPage) {
      totalPages = page + 1; // Likely more pages ahead
    } else {
      totalPages = page; // This was likely the last page
    }

    page++;
  }

  // Flush any remaining events in the queue
  await flushEventQueue(context);

  return { count: totalIssues, statusEventsPublished };
}

/**
 * Fetch and publish pull requests in streaming fashion (page-by-page)
 * Processes and publishes each PR immediately, keeping only ID mappings in memory
 */
async function fetchAndPublishPRsStreaming(context: ImportContext): Promise<number> {
  context.updateProgress("Fetching and publishing pull requests...");
  context.abortController.throwIfAborted();

  let page = 1;
  const perPage = 100;
  let totalPRs = 0;

  while (true) {
    context.abortController.throwIfAborted();

    const sinceDate = context.config.sinceDate ? context.config.sinceDate.toISOString() : undefined;

    // Fetch one page of PRs
    const pagePrs = await context.withRateLimit(context.platform, "GET", () =>
      context.api.listPullRequests(context.parsed.owner, context.parsed.repo, {
        per_page: perPage,
        page,
        state: "all",
      })
    );

    // Filter by sinceDate if provided
    const filteredPrs = context.config.sinceDate
      ? pagePrs.filter((pr) => {
          const prDate = new Date(pr.createdAt);
          return prDate >= context.config.sinceDate!;
        })
      : pagePrs;

    if (filteredPrs.length === 0) {
      break;
    }

    // Process and publish each PR immediately
    for (const pr of filteredPrs) {
      context.abortController.throwIfAborted();

      // Generate profile if needed (incremental)
      await ensureUserProfile(context, pr.author.login, pr.author.avatarUrl);

      // Convert single PR to Nostr event
      const prEventData = convertPullRequestsToNostrEvents(
        [pr], // Single PR
        context.repoAddr,
        context.platform,
        context.userProfiles,
        context.importTimestamp,
        context.currentTimestamp
      );

      if (prEventData.length > 0) {
        const [eventData] = prEventData;

        // Sign PR event
        const signedPrEvent = signEvent(eventData.event, eventData.privkey);

        // Store PR event ID for comment linking
        context.prEventIdMap.set(pr.number, signedPrEvent.id);

        // Publish PR event (batched)
        await publishEventBatched(context, signedPrEvent);

        context.currentTimestamp += 1;
        totalPRs++;
        context.prsPublished = totalPRs;

        // Update progress with count of published PRs
        context.updateProgress(`Publishing PRs... (${totalPRs} published)`, totalPRs);
      }
    }

    // Check if we should continue
    if (pagePrs.length < perPage) {
      break;
    }

    page++;
  }

  // Flush any remaining events in the queue
  await flushEventQueue(context);

  return totalPRs;
}

/**
 * Fetch and publish comments in streaming fashion (page-by-page)
 * Only processes comments for issues/PRs that were successfully published
 */
async function fetchAndPublishCommentsStreaming(
  context: ImportContext,
  issueNumbers: Set<number>,
  prNumbers: Set<number>
): Promise<number> {
  if (issueNumbers.size === 0 && prNumbers.size === 0) {
    return 0;
  }

  context.updateProgress("Fetching and publishing comments...");
  context.abortController.throwIfAborted();

  // Check if the API supports bulk comment fetching
  const apiWithBulkComments = context.api;
  let totalCommentsPublished = 0;
  const commentEventMap: CommentEventMap = new Map(); // For threading within each issue/PR

  if (apiWithBulkComments.listAllIssueComments) {
    // Use bulk endpoint if available
    const sinceDate = context.config.sinceDate ? context.config.sinceDate.toISOString() : undefined;
    let page = 1;
    const perPage = 100;

    while (true) {
      context.abortController.throwIfAborted();

      // Fetch one page of comments
      const pageComments: Array<Comment & { issueNumber: number; isPullRequest: boolean }> =
        await context.withRateLimit(context.platform, "GET", () =>
          apiWithBulkComments.listAllIssueComments!(context.parsed.owner, context.parsed.repo, {
            per_page: perPage,
            page,
            since: sinceDate,
          })
        );

      if (pageComments.length === 0) {
        break;
      }

      // Filter by sinceDate if provided
      const filteredComments = context.config.sinceDate
        ? pageComments.filter((comment) => {
            const commentDate = new Date(comment.createdAt);
            return commentDate >= context.config.sinceDate!;
          })
        : pageComments;

      // Process and publish each comment immediately
      for (const comment of filteredComments) {
        context.abortController.throwIfAborted();

        // Determine if this is a PR comment or issue comment
        const isPrComment = prNumbers.has(comment.issueNumber);
        const isIssueComment = issueNumbers.has(comment.issueNumber);

        // Only process comments for published issues/PRs
        if (!isPrComment && !isIssueComment) {
          continue;
        }

        // Get parent event ID
        const parentEventId = isPrComment
          ? context.prEventIdMap.get(comment.issueNumber)
          : context.issueEventIdMap.get(comment.issueNumber);

        if (!parentEventId) {
          console.warn(
            `Skipping comment for ${isPrComment ? "PR" : "issue"} #${comment.issueNumber} - parent event ID not found`
          );
          continue;
        }

        // Generate profile if needed
        await ensureUserProfile(context, comment.author.login, comment.author.avatarUrl);

        // Convert single comment to Nostr event
        const convertedComments = convertCommentsToNostrEvents(
          [comment],
          parentEventId,
          context.platform,
          context.userProfiles,
          commentEventMap,
          context.importTimestamp,
          context.currentTimestamp
        );

        if (convertedComments.length > 0) {
          const [convertedComment] = convertedComments;

          // Sign comment event
          const signedCommentEvent = signEvent(convertedComment.event, convertedComment.privkey);

          // Publish comment event (batched)
          await publishEventBatched(context, signedCommentEvent);

          // Store comment event ID for threading (within same issue/PR)
          commentEventMap.set(convertedComment.platformCommentId, signedCommentEvent.id);

          context.currentTimestamp += 1;
          totalCommentsPublished++;
          context.commentsPublished = totalCommentsPublished;
        }
      }

      // Update progress with count of published comments
      context.updateProgress(
        `Publishing comments... (${totalCommentsPublished} published)`,
        totalCommentsPublished
      );

      if (pageComments.length < perPage) {
        break;
      }

      page++;
    }

    // Flush any remaining events in the queue after bulk comments
    await flushEventQueue(context);
  } else {
    // Fallback: fetch comments per issue/PR (less efficient but works)
    // This is a simplified version - in practice, you might want to optimize this further
    for (const issueNumber of issueNumbers) {
      context.abortController.throwIfAborted();

      const issueEventId = context.issueEventIdMap.get(issueNumber);
      if (!issueEventId) continue;

      const sinceDate = context.config.sinceDate
        ? context.config.sinceDate.toISOString()
        : undefined;
      let commentPage = 1;
      const commentsPerPage = 100;

      while (true) {
        context.abortController.throwIfAborted();

        const pageComments = await context.withRateLimit(context.platform, "GET", () =>
          context.api.listIssueComments(context.parsed.owner, context.parsed.repo, issueNumber, {
            per_page: commentsPerPage,
            page: commentPage,
            since: sinceDate,
          })
        );

        if (pageComments.length === 0) {
          break;
        }

        // Filter and publish each comment
        for (const comment of pageComments) {
          if (context.config.sinceDate) {
            const commentDate = new Date(comment.createdAt);
            if (commentDate < context.config.sinceDate!) {
              continue;
            }
          }

          await ensureUserProfile(context, comment.author.login, comment.author.avatarUrl);

          const convertedComments = convertCommentsToNostrEvents(
            [comment],
            issueEventId,
            context.platform,
            context.userProfiles,
            commentEventMap,
            context.importTimestamp,
            context.currentTimestamp
          );

          if (convertedComments.length > 0) {
            const [convertedComment] = convertedComments;
            const signedCommentEvent = signEvent(convertedComment.event, convertedComment.privkey);

            // Publish comment event (batched)
            await publishEventBatched(context, signedCommentEvent);

            commentEventMap.set(convertedComment.platformCommentId, signedCommentEvent.id);
            context.currentTimestamp += 1;
            totalCommentsPublished++;
            context.commentsPublished = totalCommentsPublished;
          }
        }

        if (pageComments.length < commentsPerPage) {
          break;
        }

        commentPage++;
      }

      // Clear commentEventMap after each issue to free memory
      commentEventMap.clear();
    }

    // Similar for PRs
    for (const prNumber of prNumbers) {
      context.abortController.throwIfAborted();

      const prEventId = context.prEventIdMap.get(prNumber);
      if (!prEventId) continue;

      const sinceDate = context.config.sinceDate
        ? context.config.sinceDate.toISOString()
        : undefined;
      let commentPage = 1;
      const commentsPerPage = 100;

      while (true) {
        context.abortController.throwIfAborted();

        const pageComments = await context.withRateLimit(context.platform, "GET", () =>
          context.api.listPullRequestComments(context.parsed.owner, context.parsed.repo, prNumber, {
            per_page: commentsPerPage,
            page: commentPage,
            since: sinceDate,
          })
        );

        if (pageComments.length === 0) {
          break;
        }

        for (const comment of pageComments) {
          if (context.config.sinceDate) {
            const commentDate = new Date(comment.createdAt);
            if (commentDate < context.config.sinceDate!) {
              continue;
            }
          }

          await ensureUserProfile(context, comment.author.login, comment.author.avatarUrl);

          const convertedComments = convertCommentsToNostrEvents(
            [comment],
            prEventId,
            context.platform,
            context.userProfiles,
            commentEventMap,
            context.importTimestamp,
            context.currentTimestamp
          );

          if (convertedComments.length > 0) {
            const [convertedComment] = convertedComments;
            const signedCommentEvent = signEvent(convertedComment.event, convertedComment.privkey);

            // Publish comment event (batched)
            await publishEventBatched(context, signedCommentEvent);

            commentEventMap.set(convertedComment.platformCommentId, signedCommentEvent.id);
            context.currentTimestamp += 1;
            totalCommentsPublished++;
            context.commentsPublished = totalCommentsPublished;
          }
        }

        if (pageComments.length < commentsPerPage) {
          break;
        }

        commentPage++;
      }

      commentEventMap.clear();
    }

    // Flush any remaining events in the queue after fallback comment fetching
    await flushEventQueue(context);
  }

  return totalCommentsPublished;
}

// ===== Event Conversion Functions =====

/**
 * Convert repository metadata to Nostr events
 */
function convertRepoEvents(context: ImportContext): {
  announcement: Omit<NostrEvent, "id" | "sig" | "pubkey">;
  state: Omit<NostrEvent, "id" | "sig" | "pubkey">;
} {
  context.updateProgress("Converting repository metadata...");
  context.abortController.throwIfAborted();

  // Get relays from config (required for repo announcement)
  const relays: string[] = context.config.relays || [];

  if (relays.length === 0) {
    throw new Error("At least one relay is required for repository announcement");
  }

  const repoAnnouncementEventTemplate = convertRepoToNostrEvent(
    context.finalRepo,
    relays,
    context.userPubkey,
    context.importTimestamp
  );

  const repoStateEventTemplate = convertRepoToStateEvent(
    context.finalRepo,
    context.importTimestamp
  );

  return {
    announcement: repoAnnouncementEventTemplate,
    state: repoStateEventTemplate,
  };
}

// ===== Event Publishing Functions =====

/**
 * Sign and publish repository events
 */
async function publishRepoEvents(
  context: ImportContext,
  repoEvents: {
    announcement: Omit<NostrEvent, "id" | "sig" | "pubkey">;
    state: Omit<NostrEvent, "id" | "sig" | "pubkey">;
  }
): Promise<{ announcement: NostrEvent; state: NostrEvent }> {
  context.updateProgress("Publishing repository events...");
  context.abortController.throwIfAborted();

  let signedRepoAnnouncement: NostrEvent;
  let signedRepoState: NostrEvent;

  // Sign repo announcement event using available signer method
  // Note: We need the signed event to get its ID, so we can't use EventIO directly
  if (context.onSignEvent) {
    signedRepoAnnouncement = await context.onSignEvent(repoEvents.announcement);
    signedRepoState = await context.onSignEvent(repoEvents.state);
  } else if (context.eventIO) {
    // EventIO signs internally but doesn't return the signed event
    // We need the event ID, so we can't use EventIO for events that need IDs
    throw new Error(
      "EventIO cannot be used for repo events that need IDs. Please provide onSignEvent callback."
    );
  } else {
    throw new Error("onSignEvent callback is required to sign repo events");
  }

  // Publish signed repo events
  if (context.onPublishEvent) {
    await context.onPublishEvent(signedRepoAnnouncement);
    await context.onPublishEvent(signedRepoState);
  } else if (context.eventIO) {
    // EventIO doesn't accept already-signed events, so we need onPublishEvent
    throw new Error("onPublishEvent callback is required to publish signed events");
  } else {
    throw new Error("Either onPublishEvent callback must be provided to publish events");
  }

  return {
    announcement: signedRepoAnnouncement,
    state: signedRepoState,
  };
}

/**
 * Publish profile events (kind 0) for all platform users
 */
async function publishProfileEvents(context: ImportContext): Promise<void> {
  context.updateProgress(`Publishing ${context.profileEvents.size} user profiles...`);
  context.abortController.throwIfAborted();

  let profileCount = 0;
  for (const [profileKey, profileEvent] of context.profileEvents.entries()) {
    context.abortController.throwIfAborted();
    context.updateProgress(
      `Publishing profile ${++profileCount}/${context.profileEvents.size}...`,
      profileCount,
      context.profileEvents.size
    );

    // Publish profile event (batched)
    await publishEventBatched(context, profileEvent);
  }
}

/**
 * Svelte 5 composable for importing repositories from Git hosting providers
 */
export function useImportRepo(options: UseImportRepoOptions) {
  const { onProgress, onImportCompleted, userPubkey, eventIO, onSignEvent, onPublishEvent } =
    options;

  // Validate that we have a way to sign user events (repo events, status events)
  if (!onSignEvent && !eventIO) {
    throw new Error("Either onSignEvent callback or eventIO must be provided to sign user events");
  }

  let isImporting = $state(false);
  let progress = $state<ImportProgress | undefined>();
  let error = $state<string | null>(null);
  let abortController: ImportAbortController | null = null;

  /**
   * Update progress state and call callback
   */
  function updateProgress(step: string, current?: number, total?: number): void {
    progress = {
      step,
      current,
      total,
      isComplete: false,
    };
    onProgress?.(progress);
  }

  /**
   * Main import function
   *
   * @param repoUrl - Repository URL to import (e.g., "https://github.com/owner/repo")
   * @param token - Authentication token for the Git hosting provider
   * @param config - Import configuration options
   * @returns Import result with events and statistics
   */
  async function importRepository(
    repoUrl: string,
    token: string,
    config: ImportConfig = DEFAULT_IMPORT_CONFIG
  ): Promise<ImportResult> {
    if (isImporting) {
      throw new Error("Import operation already in progress");
    }

    isImporting = true;
    error = null;
    abortController = new ImportAbortController();

    // Create rate limiter and wrapper
    const rateLimiter = createRateLimiter(updateProgress);
    const withRateLimitFn = createWithRateLimit(rateLimiter, abortController);

    try {
      // Initialize context
      const partialContext = await initializeImportContext(
        repoUrl,
        token,
        config,
        userPubkey,
        updateProgress,
        abortController,
        withRateLimitFn,
        onSignEvent,
        onPublishEvent,
        eventIO
      );

      // Complete context initialization
      const context: ImportContext = {
        ...partialContext,
        rateLimiter,
        withRateLimit: withRateLimitFn,
        finalRepo: {} as RepoMetadata, // Will be set below
        repoAddr: "", // Will be set below
        importTimestamp: Math.floor(Date.now() / 1000),
        startTimestamp: 0, // Will be set below
        currentTimestamp: 0, // Will be set below
        userProfiles: new Map(),
        profileEvents: new Map(),
        issueEventIdMap: new Map(),
        prEventIdMap: new Map(),
        commentEventMap: new Map(),
        issuesPublished: 0,
        prsPublished: 0,
        commentsPublished: 0,
      } as ImportContext;

      // Validation & Repository Setup
      const { repo: ownershipRepo, isOwner } = await validateTokenAndOwnership(context);
      
      if (!ownershipRepo) {
        throw new Error("Failed to fetch repository information");
      }
      
      context.finalRepo = ownershipRepo;
      context.finalRepo = await ensureForkedRepo(context, isOwner);
      context.finalRepo = await fetchRepoMetadata(context, ownershipRepo);

      if (!context.finalRepo) {
        throw new Error("Failed to fetch repository metadata");
      }

      // Initialize repo address and timestamps
      const repoName = context.finalRepo.fullName.split("/").pop() || context.finalRepo.name;
      context.repoAddr = `30617:${userPubkey}:${repoName}`;
      context.startTimestamp = context.importTimestamp - 3600; // Start from 1 hour ago
      context.currentTimestamp = context.startTimestamp;

      // Step 1: Convert and publish repo events (unchanged)
      const repoEvents = convertRepoEvents(context);
      const { announcement: signedRepoAnnouncement, state: signedRepoState } =
        await publishRepoEvents(context, repoEvents);

      // Step 2: Stream issues (fetch, process, publish immediately)
      let issuesImported = 0;
      if (config.mirrorIssues) {
        const issueResult = await fetchAndPublishIssuesStreaming(context);
        issuesImported = issueResult.count;
      }

      // Step 3: Stream PRs (fetch, process, publish immediately)
      let prsImported = 0;
      if (config.mirrorPullRequests) {
        prsImported = await fetchAndPublishPRsStreaming(context);
      }

      // Step 4: Stream comments (only for published issues/PRs)
      let commentsImported = 0;
      if (config.mirrorComments) {
        const issueNumbers = new Set(Array.from(context.issueEventIdMap.keys()));
        const prNumbers = new Set(Array.from(context.prEventIdMap.keys()));
        commentsImported = await fetchAndPublishCommentsStreaming(context, issueNumbers, prNumbers);
      }

      // Step 5: Publish profiles (batch at end - small memory footprint)
      await publishProfileEvents(context);

      // Final flush: ensure all queued events are published before completing
      await flushEventQueue(context);

      // Complete
      updateProgress("Import completed successfully!");
      if (progress) {
        progress.isComplete = true;
      }

      // Final validation before returning result
      if (!context.finalRepo) {
        throw new Error("Repository metadata was lost during import");
      }

      const result: ImportResult = {
        announcementEvent: signedRepoAnnouncement as RepoAnnouncementEvent,
        stateEvent: signedRepoState as RepoStateEvent,
        issuesImported,
        commentsImported,
        prsImported,
        profilesCreated: context.userProfiles.size,
        repo: context.finalRepo,
      };

      onImportCompleted?.(result);

      return result;
    } catch (err: unknown) {
      const errorMessage =
        err instanceof ImportAbortedError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      error = errorMessage;

      if (progress) {
        progress.error = errorMessage;
        progress.isComplete = false;
      }

      // Re-throw ImportAbortedError as-is, wrap others
      if (err instanceof ImportAbortedError) {
        throw err;
      }
      throw new Error(errorMessage);
    } finally {
      isImporting = false;
      abortController = null;
    }
  }

  /**
   * Abort the current import operation
   */
  function abortImport(reason?: string): void {
    if (abortController) {
      abortController.abort(reason);
    }
  }

  return {
    importRepository,
    abortImport,
    get isImporting() {
      return isImporting;
    },
    get progress() {
      return progress;
    },
    get error() {
      return error;
    },
  };
}
