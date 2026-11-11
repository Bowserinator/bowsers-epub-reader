<script lang="ts">
  import { app } from '../app/app.svelte';
  import { onBackdrop, trap } from '../app/actions';

  const rows = $derived(app.bookMetadata());
</script>

<div class="overlay" role="presentation" onpointerdown={onBackdrop(() => (app.bookInfoOpen = false))}>
  <div class="dialog info" role="dialog" aria-modal="true" aria-labelledby="bookinfo-h" style="width:min(560px,92vw)" use:trap>
    <h2 id="bookinfo-h">{app.bookTitle}</h2>
    <dl>
      {#each rows as [label, value]}
        <dt class="muted">{label}</dt>
        <dd>{value}</dd>
      {/each}
    </dl>
    <div class="actions"><button class="btn primary" data-autofocus onclick={() => (app.bookInfoOpen = false)}>Close</button></div>
  </div>
</div>

<style>
  .info { display: flex; flex-direction: column; max-height: 80vh; }
  dl { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: grid; align-content: start; grid-template-columns: 110px 1fr; gap: 6px 14px; margin: 0; }
  dt { font-size: 13px; }
  dd { margin: 0; overflow-wrap: anywhere; white-space: pre-line; }
  .actions { flex: none; display: flex; justify-content: flex-end; margin-top: 16px; }
</style>
