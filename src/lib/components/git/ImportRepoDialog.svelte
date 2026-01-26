<script lang="ts">
  import {
    X,
    Download,
    AlertCircle,
    CheckCircle2,
    Loader2,
    Calendar,
    GitBranch,
    MessageSquare,
    FileText,
    Globe,
    Trash2,
    Plus,
    ExternalLink,
  } from "@lucide/svelte";
  import {
    useImportRepo,
    type ImportProgress,
    type ImportResult,
  } from "../../hooks/useImportRepo.svelte";
  import { tokens } from "../../stores/tokens.js";
  import {
    parseRepoUrl,
    DEFAULT_RELAYS,
    validateTokenPermissions,
    getGitServiceApiFromUrl,
    checkRepoOwnership,
  } from "@nostr-git/core";
  import { tryTokensForHost } from "../../utils/tokenHelpers.js";
  import { AllTokensFailedError, TokenNotFoundError } from "../../utils/tokenErrors.js";
  import { toast } from "../../stores/toast";
  import type { Token } from "../../stores/tokens.js";
  import type { EventIO, NostrEvent } from "@nostr-git/shared-types";
  import type { ImportConfig } from "@nostr-git/core";

  interface Props {
    pubkey: string;
    onSignEvent?: (event: Omit<NostrEvent, "id" | "sig" | "pubkey">) => Promise<NostrEvent>; // Optional - works with all signers
    eventIO?: EventIO;
    onClose: () => void;
    onPublishEvent?: (event: NostrEvent) => Promise<void>;
    onImportComplete?: (result: ImportResult) => void;
    onNavigateToRepo?: (result: ImportResult) => void; // Optional callback to navigate to the imported repo
    defaultRelays?: string[];
  }

  const {
    pubkey,
    onSignEvent,
    eventIO,
    onClose,
    onPublishEvent,
    onImportComplete,
    onNavigateToRepo,
    defaultRelays = DEFAULT_RELAYS.default.slice(0, 2),
  }: Props = $props();

  // Validate that we have at least one signing method
  if (!onSignEvent && !eventIO) {
    throw new Error("Either onSignEvent callback or eventIO must be provided for signing events");
  }

  // Initialize the useImportRepo hook
  const importState = useImportRepo({
    userPubkey: pubkey,
    onSignEvent,
    eventIO,
    onProgress: (progress) => {
      currentProgress = progress;
    },
    onImportCompleted: (result) => {
      completedResult = result;
      // Ensure currentProgress reflects completion
      if (currentProgress) {
        currentProgress = { ...currentProgress, isComplete: true };
      }
      toast.push({
        message: "Repository imported successfully!",
        variant: "default",
      });
      onImportComplete?.(result);
    },
    onPublishEvent,
  });

  // Step management (1: URL + Token + Date, 2: Preview + Config, 3: Progress)
  let currentStep = $state(1);
  let currentProgress = $state<ImportProgress | undefined>();
  let completedResult = $state<ImportResult | null>(null);

  // Form state - Step 1
  let repoUrl = $state("");
  let selectedHost = $state<string | null>(null);
  let sinceDate = $state<Date | undefined>(undefined);
  let tokenValidated = $state(false);
  let isValidatingToken = $state(false);
  let tokenValidationError = $state<string | undefined>();
  let validatedToken = $state<string | null>(null);
  // Use a regular variable (not $state) to avoid reactivity issues in cleanup
  let validationAbortController: AbortController | null = null;
  // Track which URL/host we're currently validating to prevent redundant calls
  let validatingForUrl: string | null = null;

  // Form state - Step 2
  let repoMetadata = $state<{
    owner: string;
    name: string;
    description?: string;
    htmlUrl: string;
    isOwner: boolean;
  } | null>(null);
  let forkName = $state("");
  let selectedRelays = $state<string[]>([...defaultRelays]);
  let announceRepo = $state(true); // Always enabled
  let forkRepo = $state(false);
  let mirrorIssues = $state(true);
  let mirrorPullRequests = $state(true);
  let mirrorComments = $state(true);

  // UI state
  let validationError = $state<string | undefined>();
  let isCheckingOwnership = $state(false);

  // Token management
  let tokenList = $state<Token[]>([]);
  tokens.subscribe((t) => {
    tokenList = t;
  });

  async function waitForTokens(): Promise<Token[]> {
    return await tokens.waitForInitialization();
  }

  // Detect provider from URL
  $effect(() => {
    if (repoUrl) {
      try {
        const parsed = parseRepoUrl(repoUrl);
        selectedHost = parsed.host;
      } catch {
        selectedHost = null;
      }
    }
  });

  // Validate URL
  function validateUrl(url: string): string | undefined {
    if (!url.trim()) {
      return "Repository URL is required";
    }

    try {
      parseRepoUrl(url);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : "Invalid repository URL format";
    }
  }

  // Validate token for host - tries all tokens until one succeeds
  async function validateToken() {
    if (!selectedHost || !repoUrl) {
      tokenValidationError = "Please enter a valid repository URL first";
      return;
    }

    // Prevent concurrent validations for the same URL
    if (isValidatingToken && validatingForUrl === repoUrl) {
      return;
    }

    // Cancel any previous validation
    if (validationAbortController) {
      validationAbortController.abort();
    }

    const currentController = new AbortController();
    validationAbortController = currentController;
    const abortSignal = currentController.signal;

    isValidatingToken = true;
    validatingForUrl = repoUrl;
    // Don't set tokenValidated = false here - let the reset effect handle it
    // Only set tokenValidated = true when validation succeeds
    tokenValidationError = undefined;
    validatedToken = null;

    try {
      const allTokens = await waitForTokens();

      // Check if validation was aborted
      if (abortSignal.aborted) {
        return;
      }

      // Try to parse the repo URL to test permissions against the actual repo
      let testRepo: { owner: string; repo: string } | undefined;
      try {
        if (repoUrl) {
          const parsed = parseRepoUrl(repoUrl);
          testRepo = { owner: parsed.owner, repo: parsed.repo };
        }
      } catch {
        // URL not fully parseable yet - will validate without test repo
      }

      // Create API URL for provider detection
      const apiUrl = repoUrl || `https://${selectedHost}/test/repo`;

      // Try all tokens until one succeeds
      try {
        const validToken = await tryTokensForHost(
          allTokens,
          selectedHost,
          async (token: string) => {
            // Check if validation was aborted
            if (abortSignal.aborted) {
              throw new Error("Validation aborted");
            }

            // Create API instance and validate token permissions
            const api = getGitServiceApiFromUrl(apiUrl, token);
            const validationResult = await validateTokenPermissions(api, testRepo);

            if (!validationResult.valid) {
              throw new Error(
                validationResult.error || "Token is invalid or has insufficient permissions"
              );
            }

            if (!validationResult.hasRead) {
              throw new Error(
                "Token does not have read permissions. Please ensure your token has the necessary scopes."
              );
            }

            // Token is valid and has read permissions
            return token;
          }
        );

        // Check if validation was aborted before updating state
        if (abortSignal.aborted) {
          return;
        }

        // Store the validated token
        validatedToken = validToken;
        tokenValidated = true;
        tokenValidationError = undefined;
        lastValidatedUrl = repoUrl;
      } catch (err) {
        // Don't update state if validation was aborted
        if (abortSignal.aborted) {
          return;
        }

        if (err instanceof TokenNotFoundError) {
          tokenValidationError = `No token found for ${selectedHost}. Please add a token in settings.`;
        } else if (err instanceof AllTokensFailedError) {
          const errorMessages = err.errors
            .map((e: Error, i: number) => `Token ${i + 1}: ${e.message}`)
            .join("; ");
          tokenValidationError = `All tokens failed for ${selectedHost}. Errors: ${errorMessages}`;
        } else {
          tokenValidationError = err instanceof Error ? err.message : "Failed to validate token";
        }
        // Don't set tokenValidated = false here - it will prevent the effect from re-running
        // The user can manually re-validate if needed
        validatedToken = null;
        lastValidatedUrl = repoUrl; // Mark this URL as attempted (even though it failed)
      }
    } catch (err) {
      // Don't update state if validation was aborted
      if (abortSignal.aborted) {
        return;
      }

      tokenValidationError = err instanceof Error ? err.message : "Failed to validate token";
      // Don't set tokenValidated = false here - it will prevent the effect from re-running
      validatedToken = null;
      lastValidatedUrl = repoUrl; // Mark this URL as attempted (even though it failed)
    } finally {
      // Only reset if this validation wasn't aborted (i.e., it's still the current one)
      if (!abortSignal.aborted && validationAbortController === currentController) {
        isValidatingToken = false;
        validationAbortController = null;
        // Keep validatingForUrl set to prevent re-validation of the same URL
        // It will be reset when the URL changes
      } else if (abortSignal.aborted) {
        // If aborted, still reset isValidatingToken (a new validation may have started)
        isValidatingToken = false;
        // Keep validatingForUrl set
      }
    }
  }

  // Track the last URL we attempted to validate (success or failure) to prevent redundant validations
  let lastValidatedUrl: string | null = null;
  let lastResetUrl: string | null = null;

  // Reset validated token when URL or host changes
  $effect(() => {
    const currentUrl = repoUrl || selectedHost || null;
    if (currentUrl && currentUrl !== lastResetUrl) {
      lastResetUrl = currentUrl;
      // Reset validation state when URL/host changes
      if (validatedToken) {
        tokenValidated = false;
        validatedToken = null;
        tokenValidationError = undefined;
      }
      // Reset tracking variables to allow validation of the new URL
      lastValidatedUrl = null;
      validatingForUrl = null;
    }
  });

  // Auto-validate token when host changes
  $effect(() => {
    if (!selectedHost || !repoUrl || tokenValidated || isValidatingToken) {
      return;
    }

    // Don't validate if we've already attempted validation for this URL
    if (lastValidatedUrl === repoUrl || validatingForUrl === repoUrl) {
      return;
    }

    validateToken();
  });

  // Step 1: Validate and proceed to Step 2
  async function handleStep1Next() {
    const urlError = validateUrl(repoUrl);
    if (urlError) {
      validationError = urlError;
      return;
    }

    if (!tokenValidated) {
      validationError = "Please validate your token first";
      return;
    }

    validationError = undefined;

    // Parse URL and get repo metadata
    try {
      const parsed = parseRepoUrl(repoUrl);

      // Use validated token (should always be set if tokenValidated is true)
      if (!validatedToken) {
        validationError = "Token validation failed. Please validate your token again.";
        return;
      }

      // Get Git service API
      const api = getGitServiceApiFromUrl(repoUrl, validatedToken);

      // Fetch repo metadata and check ownership
      isCheckingOwnership = true;
      try {
        const ownership = await checkRepoOwnership(api, parsed.owner, parsed.repo);

        repoMetadata = {
          owner: parsed.owner,
          name: parsed.repo,
          description: ownership.repo.description,
          htmlUrl: ownership.repo.htmlUrl,
          isOwner: ownership.isOwner,
        };

        forkName = ownership.isOwner ? parsed.repo : `${parsed.repo}-fork`;
        forkRepo = !ownership.isOwner; // Mandatory fork if not owner (checkbox will be disabled)

        currentStep = 2;
      } catch (err) {
        validationError =
          err instanceof Error ? err.message : "Failed to fetch repository information";
      } finally {
        isCheckingOwnership = false;
      }
    } catch (err) {
      validationError = err instanceof Error ? err.message : "Failed to initialize import";
    }
  }

  // Step 2: Validate and start import
  async function handleStep2Next() {
    if (!repoMetadata) {
      validationError = "Repository metadata not available";
      return;
    }

    // Validate relays
    if (selectedRelays.length === 0) {
      validationError = "At least one relay is required";
      return;
    }

    validationError = undefined;

    // Use validated token (should always be set if tokenValidated is true)
    if (!validatedToken) {
      validationError = "Token validation failed. Please validate your token again.";
      return;
    }

    const token = validatedToken;

    // Create import config
    const config: ImportConfig = {
      maxRetries: 3,
      enableProgressTracking: true,
      sinceDate: sinceDate,
      forkRepo: forkRepo && !repoMetadata.isOwner,
      forkName: forkRepo && !repoMetadata.isOwner && forkName.trim() ? forkName.trim() : undefined,
      mirrorIssues,
      mirrorPullRequests,
      mirrorComments,
      relays: selectedRelays,
    };

    // Start import
    currentStep = 3;
    try {
      await importState.importRepository(repoUrl, token, config);
    } catch (err) {
      // Error is handled by the hook and shown in progress
      console.error("Import failed:", err);
    }
  }

  // Relay management
  function addRelay() {
    const newRelay = prompt("Enter relay URL (wss://...):");
    if (newRelay && newRelay.trim()) {
      const trimmed = newRelay.trim();
      if (!selectedRelays.includes(trimmed)) {
        selectedRelays = [...selectedRelays, trimmed];
      }
    }
  }

  function removeRelay(index: number) {
    if (selectedRelays.length > 1) {
      selectedRelays = selectedRelays.filter((_, i) => i !== index);
    }
  }

  // Track if we should close after abort completes
  let shouldCloseAfterAbort = $state(false);

  // Watch for when import completes after abort
  $effect(() => {
    if (shouldCloseAfterAbort && !importState.isImporting) {
      shouldCloseAfterAbort = false;
      onClose();
    }
  });

  // Cleanup: abort import if component unmounts while import is in progress
  $effect(() => {
    return () => {
      // Cleanup function runs when component unmounts
      if (importState.isImporting) {
        importState.abortImport("Component unmounted");
      }
    };
  });

  // Handle explicit close (X button) - will abort if importing
  function handleClose() {
    if (importState.isImporting) {
      // Explicit close during import: abort and close after abort completes
      shouldCloseAfterAbort = true;
      importState.abortImport("User cancelled import");
    } else {
      onClose();
    }
  }

  // Prevent dialog close when importing (backdrop click)
  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget && !importState.isImporting) {
      onClose();
    }
  }

  // Handle keyboard events for accessibility (Escape key)
  function handleBackdropKeydown(event: KeyboardEvent) {
    console.log("🚀 ImportRepoDialog: handleBackdropKeydown called", {
      event,
      importState: importState.isImporting,
    });
    if (event.key === "Escape" && !importState.isImporting) {
      onClose();
    }
  }

  function handleAbort() {
    // Abort and close after abort completes
    shouldCloseAfterAbort = true;
    importState.abortImport("User cancelled import");
  }

  // Computed properties
  const canProceedStep1 = $derived(
    repoUrl.trim() && tokenValidated && !isValidatingToken && !isCheckingOwnership
  );
  const canProceedStep2 = $derived(
    repoMetadata !== null &&
      selectedRelays.length > 0 &&
      (repoMetadata.isOwner || (!repoMetadata.isOwner && forkRepo && forkName.trim()))
  );
  const isProgressComplete = $derived(currentProgress?.isComplete && completedResult !== null);
</script>

<svelte:window onkeydown={handleBackdropKeydown} />

<!-- Import Repository Dialog -->
<div
  class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 isolate"
  role="dialog"
  aria-modal="true"
  aria-labelledby="import-dialog-title"
  aria-busy={importState.isImporting}
  tabindex="-1"
  onclick={handleBackdropClick}
  onkeydown={handleBackdropKeydown}
>
  <div
    class="bg-gray-900 rounded-lg shadow-xl w-full max-w-2xl border border-gray-700 overflow-hidden max-h-[90vh] flex flex-col"
  >
    <!-- Header -->
    <div class="flex items-center justify-between p-6 border-b border-gray-700">
      <div class="flex items-center space-x-3">
        <Download class="w-6 h-6 text-blue-400" />
        <h2 id="import-dialog-title" class="text-xl font-semibold text-white">Import Repository</h2>
      </div>
      {#if !importState.isImporting}
        <button
          type="button"
          onclick={handleClose}
          class="text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="Close dialog"
          title={"Close"}
        >
          <X class="w-5 h-5" />
        </button>
      {/if}
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6 space-y-6">
      <!-- Step 1: URL + Token + Date -->
      {#if currentStep === 1}
        <div class="space-y-4">
          <div>
            <h3 class="text-lg font-medium text-white mb-4">Step 1: Repository URL</h3>

            <!-- URL Input -->
            <div class="mb-4">
              <label for="repo-url" class="block text-sm font-medium text-gray-300 mb-2">
                Repository URL *
              </label>
              <input
                id="repo-url"
                type="text"
                bind:value={repoUrl}
                placeholder="https://github.com/owner/repo"
                class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                aria-invalid={!!validationError}
              />
              {#if validationError}
                <p class="mt-1 text-sm text-red-400 flex items-center gap-1">
                  <AlertCircle class="w-4 h-4" />
                  {validationError}
                </p>
              {/if}
            </div>

            <!-- Token Validation -->
            {#if selectedHost}
              <div class="mb-4">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-sm font-medium text-gray-300">
                    Token Validation for {selectedHost}
                  </span>
                  <button
                    type="button"
                    onclick={validateToken}
                    disabled={isValidatingToken}
                    class="text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isValidatingToken ? "Validating..." : "Revalidate"}
                  </button>
                </div>
                <div class="flex items-center space-x-2">
                  {#if tokenValidated}
                    <CheckCircle2 class="w-5 h-5 text-green-400" />
                    <span class="text-sm text-green-400">
                      Token validated for {selectedHost}
                    </span>
                  {:else if tokenValidationError}
                    <AlertCircle class="w-5 h-5 text-red-400" />
                    <span class="text-sm text-red-400">{tokenValidationError}</span>
                  {:else if isValidatingToken}
                    <Loader2 class="w-5 h-5 text-gray-400 animate-spin" />
                    <span class="text-sm text-gray-400">Validating token...</span>
                  {:else}
                    <AlertCircle class="w-5 h-5 text-yellow-400" />
                    <span class="text-sm text-yellow-400">
                      Click "Revalidate" to check your token
                    </span>
                  {/if}
                </div>
              </div>
            {/if}

            <!-- Date Picker -->
            <div class="mb-4">
              <label
                for="since-date"
                class="flex items-center gap-2 text-sm font-medium text-gray-300 mb-2"
              >
                <Calendar class="w-4 h-4" />
                <span>Only import items after (optional):</span>
              </label>
              <input
                id="since-date"
                type="date"
                value={sinceDate ? sinceDate.toISOString().split("T")[0] : ""}
                onchange={(e) => {
                  const value = (e.target as HTMLInputElement).value;
                  sinceDate = value ? new Date(value) : undefined;
                }}
                class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Leave empty to import all items"
              />
              <p class="mt-1 text-xs text-gray-400">
                Only import issues, comments, and PRs created after this date
              </p>
            </div>

            <!-- Next Button -->
            <div class="flex justify-end">
              <button
                type="button"
                onclick={handleStep1Next}
                disabled={!canProceedStep1 || isCheckingOwnership}
                class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {#if isCheckingOwnership}
                  <Loader2 class="w-4 h-4 animate-spin" />
                  Checking repository...
                {:else}
                  Next: Review & Configure
                {/if}
              </button>
            </div>
          </div>
        </div>

        <!-- Step 2: Preview + Config -->
      {:else if currentStep === 2 && repoMetadata}
        <div class="space-y-4">
          <div>
            <h3 class="text-lg font-medium text-white mb-4">Step 2: Configure Import</h3>

            <!-- Repo Preview -->
            <div class="bg-gray-800 rounded-lg p-4 border border-gray-600 mb-4">
              <div class="flex items-start space-x-3">
                <GitBranch class="w-5 h-5 text-gray-400 mt-0.5" />
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-medium text-white">
                    {repoMetadata.owner}/{repoMetadata.name}
                  </h4>
                  {#if repoMetadata.description}
                    <p class="text-sm text-gray-400 mt-1">{repoMetadata.description}</p>
                  {/if}
                  <a
                    href={repoMetadata.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-sm text-blue-400 hover:text-blue-300 mt-1 inline-flex items-center gap-1"
                  >
                    View on {selectedHost}
                    <ExternalLink class="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>

            <!-- Relay Selection -->
            <div class="mb-4">
              <div class="flex items-center gap-2 mb-2">
                <Globe class="w-4 h-4" />
                <span class="text-sm font-medium text-gray-300">Nostr Relays *</span>
              </div>
              <div class="space-y-2">
                {#each selectedRelays as relay, index}
                  <div class="flex items-center space-x-2">
                    <input
                      type="text"
                      bind:value={selectedRelays[index]}
                      class="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="wss://relay.example.com"
                    />
                    <button
                      type="button"
                      onclick={() => removeRelay(index)}
                      disabled={selectedRelays.length === 1}
                      class="p-2 text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Remove relay"
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                {/each}
                <button
                  type="button"
                  onclick={addRelay}
                  class="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300"
                >
                  <Plus class="w-4 h-4" />
                  Add Relay
                </button>
              </div>
              <p class="mt-1 text-xs text-gray-400">
                Repository metadata will be published to these relays
              </p>
            </div>

            <!-- Confirmation Checkboxes -->
            <div class="mb-4">
              <h4 class="text-sm font-medium text-gray-300 mb-2">Import Options</h4>
              <div class="space-y-3 bg-gray-800 rounded-lg p-4 border border-gray-600">
                <!-- Announce Repo (always enabled) -->
                <label class="flex items-start space-x-3 cursor-not-allowed">
                  <input
                    type="checkbox"
                    checked={announceRepo}
                    disabled
                    class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 cursor-not-allowed"
                  />
                  <div class="flex-1">
                    <span class="text-sm text-white">Announce Repo on Nostr</span>
                    <p class="text-xs text-gray-400 mt-0.5">
                      Repository will be announced on Nostr (always enabled)
                    </p>
                  </div>
                </label>

                <!-- Fork Repo (if not owner) - Mandatory -->
                {#if !repoMetadata.isOwner}
                  <div class="space-y-4">
                    <div class="flex items-start space-x-3">
                      <input
                        type="checkbox"
                        bind:checked={forkRepo}
                        disabled={true}
                        class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                      />
                      <div class="flex-1">
                        <span class="text-sm text-white font-medium">
                          Fork repo to {selectedHost || "platform"} (Required)
                        </span>
                        <p class="text-xs text-gray-400 mt-0.5">
                          You don't own this repository. A fork is required to import it (you'll own
                          the fork and can push changes).
                        </p>
                      </div>
                    </div>
                    <div class="ml-7 space-y-2">
                      <label for="fork-name" class="block text-sm font-medium text-gray-300 mb-2">
                        Fork Name *
                      </label>
                      <input
                        id="fork-name"
                        type="text"
                        bind:value={forkName}
                        placeholder={`imported-${repoMetadata.name}`}
                        class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        aria-invalid={!forkName.trim()}
                        aria-required="true"
                      />
                      {#if !forkName.trim()}
                        <p class="mt-1 text-sm text-red-400 flex items-center gap-1">
                          <AlertCircle class="w-4 h-4" />
                          Fork name is required
                        </p>
                      {/if}
                    </div>
                  </div>
                {/if}

                <!-- Mirror Issues -->
                <label class="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    bind:checked={mirrorIssues}
                    class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                  />
                  <div class="flex-1">
                    <span class="text-sm text-white flex items-center gap-2">
                      <FileText class="w-4 h-4" />
                      Mirror Issues
                    </span>
                    <p class="text-xs text-gray-400 mt-0.5">Import all issues</p>
                  </div>
                </label>

                <!-- Mirror Pull Requests -->
                <label class="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    bind:checked={mirrorPullRequests}
                    class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                  />
                  <div class="flex-1">
                    <span class="text-sm text-white flex items-center gap-2">
                      <GitBranch class="w-4 h-4" />
                      Mirror Pull Requests
                    </span>
                    <p class="text-xs text-gray-400 mt-0.5">Import all pull requests</p>
                  </div>
                </label>

                <!-- Mirror Comments -->
                <label class="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    bind:checked={mirrorComments}
                    disabled={!mirrorIssues && !mirrorPullRequests}
                    class="mt-1 w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <div class="flex-1">
                    <span class="text-sm text-white flex items-center gap-2">
                      <MessageSquare class="w-4 h-4" />
                      Mirror Comments
                    </span>
                    <p class="text-xs text-gray-400 mt-0.5">
                      Import all comments for issues and PRs
                    </p>
                  </div>
                </label>
              </div>
              <p class="text-xs text-gray-400 mt-3">
                Note: For issues and comments, placeholder Nostr accounts will be created on the fly
                with matching names of the original authors.
              </p>
            </div>

            {#if validationError}
              <div class="bg-red-900/50 border border-red-500 rounded-lg p-4">
                <div class="flex items-start space-x-3">
                  <AlertCircle class="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
                  <p class="text-sm text-red-400">{validationError}</p>
                </div>
              </div>
            {/if}

            <!-- Action Buttons -->
            <div class="flex justify-between">
              <button
                type="button"
                onclick={() => (currentStep = 1)}
                disabled={importState.isImporting}
                class="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Back
              </button>
              <button
                type="button"
                onclick={handleStep2Next}
                disabled={!canProceedStep2 || importState.isImporting}
                class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                SET MY REPO FREE
              </button>
            </div>
          </div>
        </div>

        <!-- Step 3: Progress -->
      {:else if currentStep === 3}
        <div class="space-y-4">
          <div>
            <h3 class="text-lg font-medium text-white mb-4">Step 3: Import Progress</h3>

            {#if currentProgress}
              <!-- Current Step Message -->
              <div class="mb-4">
                <p class="text-sm text-gray-300">{currentProgress.step}</p>
              </div>

              <!-- Progress Messages -->
              {#if currentProgress.error}
                <div class="bg-red-900/50 border border-red-500 rounded-lg p-4 mb-4">
                  <div class="flex items-start space-x-3">
                    <AlertCircle class="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
                    <div class="flex-1">
                      <p class="text-sm text-red-400 font-medium">Import Failed</p>
                      <p class="text-sm text-red-300 mt-1">{currentProgress.error}</p>
                    </div>
                  </div>
                </div>
              {:else if currentProgress.isComplete && completedResult}
                <div class="bg-green-900/50 border border-green-500 rounded-lg p-4 mb-4">
                  <div class="flex items-start space-x-3">
                    <CheckCircle2 class="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
                    <div class="flex-1">
                      <p class="text-sm text-green-400 font-medium">Import Completed!</p>
                      <p class="text-sm text-green-300 mt-1">
                        Imported {completedResult.issuesImported} issues,
                        {completedResult.commentsImported} comments,
                        {completedResult.prsImported} PRs, and created{" "}
                        {completedResult.profilesCreated} profiles.
                      </p>
                    </div>
                  </div>
                </div>
              {/if}
            {/if}

            <!-- Abort Button -->
            {#if currentStep === 3 && currentProgress && !currentProgress.isComplete}
              <div class="flex justify-center">
                <button
                  type="button"
                  onclick={handleAbort}
                  class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2"
                >
                  Cancel Import
                </button>
              </div>
            {/if}

            <!-- Action Buttons (when complete) -->
            {#if isProgressComplete}
              <div class="flex justify-between">
                <button
                  type="button"
                  onclick={handleClose}
                  class="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600"
                >
                  Close
                </button>
                {#if onNavigateToRepo && completedResult}
                  <button
                    type="button"
                    onclick={() => {
                      if (completedResult) {
                        onNavigateToRepo(completedResult);
                        handleClose();
                      }
                    }}
                    class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
                  >
                    <ExternalLink class="w-4 h-4" />
                    View Repository
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
