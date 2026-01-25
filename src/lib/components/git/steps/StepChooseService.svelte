<script lang="ts">
  import ProviderSelectionStep from "../ProviderSelectionStep.svelte";

  interface Props {
    selectedProvider: "github" | "gitlab" | "gitea" | "bitbucket" | "grasp" | null;
    relayUrls?: string[];
    disabledProviders?: string[];
    onProviderChange: (p: "github" | "gitlab" | "gitea" | "bitbucket" | "grasp") => void;
    onRelayUrlsChange?: (urls: string[]) => void;
    graspServerOptions?: string[];
  }

  const __props = $props();
  const selectedProvider = $derived(__props.selectedProvider);
  const relayUrls = $derived(__props.relayUrls);
  const disabledProviders = $derived(__props.disabledProviders ?? []);
  const onProviderChange = $derived(__props.onProviderChange);
  const onRelayUrlsChange = $derived(__props.onRelayUrlsChange);
  const graspServerOptions = $derived(__props.graspServerOptions ?? []);
</script>

<div class="space-y-4 max-h-[40vh] md:max-h-[50vh]">
  <ProviderSelectionStep
    selectedProvider={selectedProvider || undefined}
    onProviderChange={onProviderChange as any}
    disabledProviders={disabledProviders}
    relayUrls={relayUrls || []}
    onRelayUrlsChange={onRelayUrlsChange as any}
    graspServerOptions={graspServerOptions}
  />
</div>
