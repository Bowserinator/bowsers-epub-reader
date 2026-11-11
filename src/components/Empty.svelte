<script lang="ts">
  import type { Component } from 'svelte';
  let { icon: Icon, text }: { icon: Component<any>; text: string } = $props();
</script>

<div class="empty" role="status">
  <Icon size={32} aria-hidden="true" />
  <div>{text}</div>
</div>
