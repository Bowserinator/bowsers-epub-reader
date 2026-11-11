<script lang="ts">
  import { app } from '../app/app.svelte';
  import { onBackdrop, trap } from '../app/actions';
  let value = $state('');
  let err = $state<string | null>(null);
  const scheme = $derived(app.engine?.pageListLabels
    ? 'This book has its own page numbers; enter one of those.'
    : 'This book has no fixed page numbers. Pages are counted from your current font size and window size.');
  async function go() {
    err = await app.goToPage(value);
    if (!err) app.goToOpen = false;
  }
</script>

<div class="overlay" role="presentation" onpointerdown={onBackdrop(() => (app.goToOpen = false))}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="goto-h" style="max-width:min(500px,92vw)" use:trap>
    <h2 id="goto-h">Go to page</h2>
    <p class="muted">{scheme}</p>
    <input type="text" inputmode="numeric" bind:value aria-label="Page" data-autofocus onkeydown={(e) => { if (e.key === 'Enter') go(); }} />
    {#if err}<p role="alert" class="danger-text">{err}</p>{/if}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn" onclick={() => (app.goToOpen = false)}>Cancel</button>
      <button class="btn primary" onclick={go}>Go</button>
    </div>
  </div>
</div>
