<script lang="ts">
  import { useRegistry } from "../../useRegistry";
  import { tokens as tokensStore, type Token } from "../../stores/tokens.js";
  import { onMount } from "svelte";

  const { Button, Card, CardContent } = useRegistry();

  interface Props {
    selectedProvider?: string;
    onProviderChange: (provider: string) => void;
    disabledProviders?: string[];
    relayUrls?: string[];
    onRelayUrlsChange?: (urls: string[]) => void;
    graspServerOptions: string[];
  }
  const {
    selectedProvider,
    onProviderChange,
    disabledProviders,
    relayUrls,
    onRelayUrlsChange,
    graspServerOptions,
  }: Props = $props();

  let tokens = $state<Token[]>([]);
  let graspRelayUrls = $state<string[]>([]);
  let newGraspRelayUrl = $state<string>("");
  let availableProviders = $state<
    {
      id: string;
      name: string;
      host: string;
      icon: string;
      description: string;
      hasToken: boolean;
      disabled?: boolean;
      disabledReason?: string;
    }[]
  >([]);

  // Subscribe to token store changes
  tokensStore.subscribe((t) => {
    tokens = t;
    updateAvailableProviders();
  });

  onMount(async () => {
    // Ensure tokens are loaded
    await tokensStore.waitForInitialization();
    updateAvailableProviders();
  });

  // Keep local input in sync if parent updates relayUrls prop
  $effect(() => {
    const next = (relayUrls ?? []).map((u) => (u || "").trim()).filter(Boolean);
    if (JSON.stringify(graspRelayUrls) !== JSON.stringify(next)) {
      graspRelayUrls = next;
    }
  });

  function updateAvailableProviders() {
    const providers = [
      {
        id: "grasp",
        name: "GRASP Relay",
        host: "nostr-relay",
        icon: "⚡",
        description: "Create decentralized repository on Nostr relay",
        hasToken: true, // GRASP uses Nostr signer, always available
      },
      {
        id: "github",
        name: "GitHub",
        host: "github.com",
        icon: "🐙",
        description: "Create repository on GitHub.com",
        hasToken: tokens.some((t) => t.host === "github.com"),
      },
      {
        id: "gitlab",
        name: "GitLab",
        host: "gitlab.com",
        icon: "🦊",
        description: "Create repository on GitLab.com",
        hasToken: tokens.some((t) => t.host === "gitlab.com"),
      },
      {
        id: "gitea",
        name: "Gitea",
        host: "gitea.io",
        icon: "🍃",
        description: "Create repository on self-hosted Gitea",
        hasToken: tokens.some((t) => t.host.includes("gitea")),
      },
      {
        id: "bitbucket",
        name: "Bitbucket",
        host: "bitbucket.org",
        icon: "🪣",
        description: "Create repository on Bitbucket.org",
        hasToken: tokens.some((t) => t.host === "bitbucket.org"),
      },
    ];

    // Mark providers as disabled if they have name conflicts
    availableProviders = providers.map((provider) => {
      const conflict = (disabledProviders ?? []).includes(provider.id);
      const isGrasp = provider.id === "grasp";
      const isDisabled = isGrasp ? false : conflict;
      return {
        ...provider,
        disabled: isDisabled,
        disabledReason: isDisabled ? "Repository name already exists" : undefined,
        // Keep GRASP selectable regardless of name conflicts; others require token and no conflict
        hasToken: isGrasp ? true : provider.hasToken && !isDisabled,
      };
    });

    // Auto-select first available provider if none selected
    if (!selectedProvider && providers.some((p) => p.hasToken)) {
      const firstAvailable = providers.find((p) => p.hasToken);
      if (firstAvailable) {
        onProviderChange(firstAvailable.id);
      }
    }
  }

  function handleProviderSelect(providerId: string) {
    onProviderChange(providerId);
  }

  function updateRelayUrls(next: string[]) {
    const normalized = next
      .map((u) => (u || "").trim().replace(/\/$/, ""))
      .filter(Boolean);
    graspRelayUrls = normalized;
    onRelayUrlsChange?.(normalized);
  }

  function handleRelayUrlInputChange(index: number, value: string) {
    const next = [...graspRelayUrls];
    next[index] = value;
    updateRelayUrls(next);
  }

  function addRelayUrl(value?: string) {
    const v = (value || "").trim().replace(/\/$/, "");
    const next = [...graspRelayUrls];
    next.push(v);
    updateRelayUrls(next);
  }

  function commitNewRelayUrl() {
    const v = (newGraspRelayUrl || "").trim();
    if (!v) return;
    if (!graspRelayUrls.includes(v.replace(/\/$/, ""))) {
      addRelayUrl(v);
    }
    newGraspRelayUrl = "";
  }

  function removeRelayUrl(index: number) {
    const next = graspRelayUrls.filter((_, i) => i !== index);
    updateRelayUrls(next);
  }

  function isValidRelayUrl(url: string): boolean {
    return url.trim() !== "" && (url.startsWith("wss://") || url.startsWith("ws://"));
  }
</script>

<div class="space-y-6">
  <div class="space-y-2">
    <h3 class="text-lg font-semibold text-foreground">Choose Git Service</h3>
    <p class="text-sm text-muted-foreground">
      Select where you'd like to create your new repository. Only services with configured
      authentication tokens are available.
    </p>
  </div>

  <div class="grid gap-4">
    {#each availableProviders as provider (provider.id)}
      <Card
        class="cursor-pointer transition-all duration-200 hover:shadow-md {selectedProvider ===
        provider.id
          ? 'ring-2 ring-accent border-accent'
          : ''} {!provider.hasToken ? 'opacity-50 cursor-not-allowed' : ''}"
        onclick={() => provider.hasToken && handleProviderSelect(provider.id)}
      >
        <CardContent class="p-4">
          <div class="flex items-center space-x-4">
            <div class="text-2xl">{provider.icon}</div>
            <div class="flex-1">
              <div class="flex items-center space-x-2">
                <h4 class="font-medium text-foreground">{provider.name}</h4>
                {#if selectedProvider === provider.id}
                  <div class="w-2 h-2 bg-accent rounded-full"></div>
                {/if}
                {#if provider.disabled}
                  <span
                    class="text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 px-2 py-1 rounded"
                    >Name Conflict</span
                  >
                {:else if !provider.hasToken}
                  <span class="text-xs bg-muted text-muted-foreground px-2 py-1 rounded"
                    >No Token</span
                  >
                {/if}
              </div>
              <p class="text-sm text-muted-foreground mt-1">{provider.description}</p>
              {#if provider.hasToken && provider.id !== "grasp"}
                <p class="text-xs text-muted-foreground mt-1">
                  Token configured for {provider.host}
                </p>
              {:else if provider.id === "grasp"}
                <p class="text-xs text-muted-foreground mt-1">
                  Uses Nostr signer for authentication
                </p>
              {/if}

              {#if provider.id === "grasp" && selectedProvider === "grasp"}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <!-- Inline GRASP relay URL pills - fieldset used for semantic grouping with event stopping -->
                <fieldset class="mt-3 pt-3 border-t border-border border-x-0 border-b-0 p-0 m-0" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
                  <div class="flex flex-wrap items-center gap-1.5">
                    {#each graspRelayUrls as url, idx (idx)}
                      <span
                        class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-accent/20 text-accent-foreground border border-accent/30 {!isValidRelayUrl(url) ? 'border-red-500 bg-red-500/10' : ''}"
                      >
                        <span class="max-w-[180px] truncate" title={url}>{url.replace(/^wss?:\/\//, '')}</span>
                        <button
                          type="button"
                          class="ml-0.5 hover:text-destructive focus:outline-none"
                          onclick={(e) => { e.stopPropagation(); removeRelayUrl(idx); }}
                          title="Remove"
                        >
                          ✕
                        </button>
                      </span>
                    {/each}

                    <!-- Inline add input -->
                    <div class="inline-flex items-center">
                      <input
                        type="text"
                        class="w-36 px-2 py-0.5 text-xs bg-background border border-input rounded-l-full focus:outline-none focus:ring-1 focus:ring-accent"
                        placeholder="wss://relay..."
                        bind:value={newGraspRelayUrl}
                        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitNewRelayUrl(); } }}
                        onclick={(e) => e.stopPropagation()}
                      />
                      <button
                        type="button"
                        class="px-2 py-0.5 text-xs bg-accent text-accent-foreground rounded-r-full hover:bg-accent/80"
                        onclick={(e) => { e.stopPropagation(); commitNewRelayUrl(); }}
                      >
                        +
                      </button>
                    </div>
                  </div>

                  {#if graspServerOptions.length > 0}
                    <div class="flex flex-wrap gap-1 mt-2">
                      {#each graspServerOptions.filter(opt => !graspRelayUrls.includes(opt.trim().replace(/\/$/, ''))) as opt}
                        <button
                          type="button"
                          class="px-2 py-0.5 text-xs rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground hover:border-accent hover:text-accent"
                          onclick={(e) => {
                            e.stopPropagation();
                            const trimmed = (opt || '').trim().replace(/\/$/, '');
                            if (trimmed && !graspRelayUrls.includes(trimmed)) {
                              updateRelayUrls([...graspRelayUrls, trimmed]);
                            }
                          }}
                          title="Add {opt}"
                        >
                          + {opt.replace(/^wss?:\/\//, '')}
                        </button>
                      {/each}
                    </div>
                  {/if}

                  {#if graspRelayUrls.some((u) => u && !isValidRelayUrl(u))}
                    <p class="text-xs text-destructive mt-1">URLs must start with ws:// or wss://</p>
                  {:else if graspRelayUrls.length === 0}
                    <p class="text-xs text-muted-foreground mt-1">Add at least one relay URL</p>
                  {/if}
                </fieldset>
              {/if}
            </div>
            <div class="flex items-center">
              {#if selectedProvider === provider.id}
                <div class="w-4 h-4 bg-accent rounded-full flex items-center justify-center">
                  <div class="w-2 h-2 bg-accent-foreground rounded-full"></div>
                </div>
              {:else}
                <div class="w-4 h-4 border-2 border-muted-foreground rounded-full"></div>
              {/if}
            </div>
          </div>
        </CardContent>
      </Card>
    {/each}
  </div>

  {#if availableProviders.filter((p) => p.hasToken).length === 0}
    <div class="text-center py-8 space-y-4">
      <div class="text-4xl">🔐</div>
      <div class="space-y-2">
        <h4 class="font-medium text-foreground">No Authentication Tokens Found</h4>
        <p class="text-sm text-muted-foreground max-w-md mx-auto">
          You need to configure authentication tokens for at least one Git service before creating a
          repository. Go to Settings to add your GitHub, GitLab, Gitea, or Bitbucket tokens.
        </p>
      </div>
      <Button variant="outline" size="sm">Go to Settings</Button>
    </div>
  {:else if !selectedProvider}
    <div class="text-center py-4">
      <p class="text-sm text-muted-foreground">Please select a Git service to continue.</p>
    </div>
  {:else if selectedProvider === "grasp"}
    <div class="bg-muted/50 rounded-lg p-4">
      <div class="flex items-center space-x-2">
        <div class="w-2 h-2 bg-green-500 rounded-full"></div>
        <p class="text-sm text-foreground">
          Ready to create repository on <strong>GRASP Relay</strong>
          {#if graspRelayUrls.length > 0}
            <span class="text-muted-foreground">({graspRelayUrls.length} relay{graspRelayUrls.length > 1 ? 's' : ''})</span>
          {/if}
        </p>
      </div>
    </div>
  {:else}
    <div class="bg-muted/50 rounded-lg p-4">
      <div class="flex items-center space-x-2">
        <div class="w-2 h-2 bg-green-500 rounded-full"></div>
        <p class="text-sm text-foreground">
          Ready to create repository on <strong
            >{availableProviders.find((p) => p.id === selectedProvider)?.name}</strong
          >
        </p>
      </div>
    </div>
  {/if}
</div>

<svelte:options runes={true} />
