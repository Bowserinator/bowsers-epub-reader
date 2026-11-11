<script lang="ts">
  import { app } from '../app/app.svelte';
  import { placeTooltip } from '../app/actions';
  const h = $derived(app.hover!);
  let w = $state(0), ht = $state(0);
  const pos = $derived(placeTooltip(h.rect, w, ht));
</script>

<div class="popover def" role="tooltip" onpointerenter={() => app.holdHover()} onpointermove={() => app.holdHover()} onpointerleave={(e) => { if (!e.buttons) app.releaseHover(); }} bind:offsetWidth={w} bind:offsetHeight={ht} style="left:{pos.left}px;top:{pos.top}px;visibility:{ht ? 'visible' : 'hidden'}">
  {#if h.loading}
    <span class="muted">Looking up “{h.word}”…</span>
  {:else if h.result?.found}
    {#each h.result.entries.slice(0, 3) as en}
      <div class="entry">
        <div class="hw"><strong>{en.headword}</strong> <span class="muted">{en.dictTitle}</span></div>
        <div class="body">{@html en.html}</div>
      </div>
    {/each}
  {:else if h.error}
    <span class="muted">Lookup failed: {h.error}</span>
  {:else}
    <span class="muted">No definition found</span>
  {/if}
</div>

<style>
  .def { --muted: #7a6f3c; --border: #e6dba0; background: #fff9d6; color: #1a1a1a; max-width: min(360px, calc(100vw - 16px)); max-height: min(260px, calc(100vh - 16px)); overflow: auto; padding: 8px 12px; font-size: 13px; line-height: 1.3; }
  .entry + .entry { border-top: 1px solid var(--border); margin-top: 3px; padding-top: 3px; }
  .hw { margin-bottom: 1px; }
  .body :global(:is(p, ul, ol, dl, dd, blockquote, pre, h1, h2, h3, h4, h5, h6)) { margin: 1px 0; font-size: inherit; }
  .body :global(:is(ul, ol)) { padding-left: 1.2em; }
</style>
