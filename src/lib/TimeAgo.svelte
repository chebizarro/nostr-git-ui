<script lang="ts">
  import { formatDistanceToNow } from "date-fns";
  const { date, addSuffix = true } = $props();
  let formatted = $state("");

  $effect(() => {
    const currentDate = date;
    formatted = formatDistanceToNow(new Date(currentDate), { addSuffix });
    const interval = setInterval(() => {
      formatted = formatDistanceToNow(new Date(currentDate), { addSuffix });
    }, 60_000);
    return () => clearInterval(interval);
  });
</script>

<span>{formatted}</span>
